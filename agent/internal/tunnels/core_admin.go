package tunnels

import (
	"context"
	"errors"
	"fmt"
	"os"
)

// Backs the per-core admin actions the panel's cores table exposes
// (verify/reinstall/rollback), alongside GET /api/v1/agent/cores
// (corebinaries.go) which stays the read-only "what's installed right now"
// view. Every function here validates core against the same Driver registry
// New()/SupportedCores() use (via isRegisteredCore) before touching a path
// derived from it -- core arrives from an HTTP path segment
// (/api/v1/agent/cores/{core}/...), so it gets the same "never trust a
// caller-supplied string in a filesystem path" treatment as every other
// caller-influenced value in this package (see validate.go's header
// comment).

// ErrNoPreviousVersion is returned by RollbackCore when core has no
// "<binary>.previous" backup to restore -- either it has never been
// reinstalled through this admin path, or a previous rollback already
// consumed the backup. The HTTP layer maps this to a 4xx, not a 500: this
// is an ordinary, expected outcome of clicking Rollback on a core that
// doesn't have one, not a system failure.
var ErrNoPreviousVersion = errors.New("no previous version available")

func isRegisteredCore(core string) bool {
	_, ok := registry[core]
	return ok
}

// reinstallSpec builds a throwaway Spec good enough to satisfy
// Spec.Validate() and get a real Driver back from New(core, ...), purely so
// ReinstallCore can call that Driver's own Install method. Never passed to
// WriteConfig/CreateService/Start/anything else, and Install itself only
// ever touches each core's shared binariesDir(core) (see backhaul.go/
// rathole.go/hysteria2.go/gost.go's own Install implementations) -- never a
// per-tunnel path derived from Spec.ID -- so this placeholder ID/Peer/
// Secret are never persisted or acted on anywhere.
func reinstallSpec(core string) Spec {
	return Spec{
		ID:     "core-admin-reinstall-" + core,
		Role:   RoleClient,
		Peer:   "127.0.0.1:1",
		Secret: "core-admin-reinstall",
	}
}

// VerifyCore re-runs the same install-health check GET /api/v1/agent/cores
// runs for every core, scoped to just this one -- lets the panel's per-row
// "Verify" button re-check a single core without paying for every other
// core's version-flag subprocess too, and gives it its own distinct
// request/response independent of the table's own refresh.
func VerifyCore(ctx context.Context, core string) (CoreBinaryReport, error) {
	if !isRegisteredCore(core) {
		return CoreBinaryReport{}, &UnknownCoreError{Core: core}
	}
	return reportForCore(ctx, core), nil
}

// ReinstallCore forces a fresh download+install of core's binary via its
// registered Driver, even if the currently installed one already passes
// binaryRunsOK. Driver.Install (see driver.go) is intentionally idempotent
// for every normal deploy path -- skip re-downloading a binary that already
// works, so every tunnel create/start doesn't re-fetch it -- so getting
// past that early return needs a separate, admin-only path rather than a
// Driver interface change that would affect every tunnel's lifecycle.
//
// Mechanics: if a binary already exists at the core's live path, it is
// renamed to a sibling "<binary>.previous" *before* Install runs. That
// rename (a) makes the live path disappear, so each driver's own
// `if binaryRunsOK(ctx, d.binPath, ...) { return nil }` guard no longer
// fires and a real download happens, and (b) doubles as the one-level
// backup RollbackCore later swaps back in -- it overwrites any older
// .previous, so only the most recently replaced version is ever
// recoverable, not a full history (see RollbackCore's own doc comment for
// why that scope limit is acceptable here).
//
// Renaming a binary out from under processes currently running it is safe
// on Linux: an already-open executable file keeps its inode alive after
// being unlinked/renamed, so any tunnel service currently running this
// core keeps running unaffected by this call -- the same assumption
// agent_update.go's self-update already relies on for the agent's own
// binary. What this function deliberately does NOT do is restart anything
// that uses this core. Backhaul/Rathole/Hysteria2 each reference the
// shared binary path directly from their own per-tunnel systemd unit's
// ExecStart; GOST additionally funnels every GOST tunnel on the agent
// through one shared daemon process (see gost.go's header comment for that
// tradeoff). Either way, a process already running keeps using the old
// binary's memory image until *something* restarts it -- left as a
// separate, explicit step (the existing per-tunnel restart endpoints, or a
// human on the box) rather than this call silently bouncing every tunnel
// using this core as a side effect of what looks like a targeted, single-
// core action. The panel is expected to say so in its confirmation prompt.
func ReinstallCore(ctx context.Context, core string) (CoreBinaryReport, error) {
	if !isRegisteredCore(core) {
		return CoreBinaryReport{}, &UnknownCoreError{Core: core}
	}
	path, _ := binaryPathFor(core)
	previousPath := previousPathFor(core)

	hadExisting := false
	if _, err := os.Stat(path); err == nil {
		hadExisting = true
		if err := os.Rename(path, previousPath); err != nil {
			return CoreBinaryReport{}, fmt.Errorf("backing up existing %s binary before reinstall: %w", core, err)
		}
	}

	driver, err := New(core, reinstallSpec(core))
	if err != nil {
		return CoreBinaryReport{}, err
	}
	if err := driver.Install(ctx); err != nil {
		// Best-effort restore so a failed reinstall doesn't leave the agent
		// with no working binary for a core that had one moments ago.
		if hadExisting {
			_ = os.Rename(previousPath, path)
		}
		return CoreBinaryReport{}, fmt.Errorf("reinstalling %s: %w", core, err)
	}

	return reportForCore(ctx, core), nil
}

// RollbackCore swaps a core's binary back to whatever is saved in
// "<binary>.previous" (see ReinstallCore's doc comment for how it gets
// there). It is a genuine two-way swap, not a one-shot restore: whatever
// was live immediately before the rollback is itself saved into .previous
// afterward, so calling RollbackCore a second time returns to where you
// started. That still only ever remembers one prior version, not an
// arbitrary history -- an intentional, documented scope limit: a real
// version history would need a separate directory of timestamped binaries,
// which nothing in this codebase currently needs. Returns
// ErrNoPreviousVersion, not a fabricated success, if there is nothing to
// roll back to.
//
// Same "does not restart anything using this core" caveat as ReinstallCore
// applies here -- see that function's doc comment.
func RollbackCore(ctx context.Context, core string) (CoreBinaryReport, error) {
	if !isRegisteredCore(core) {
		return CoreBinaryReport{}, &UnknownCoreError{Core: core}
	}
	path, _ := binaryPathFor(core)
	previousPath := previousPathFor(core)

	if _, err := os.Stat(previousPath); err != nil {
		return CoreBinaryReport{}, ErrNoPreviousVersion
	}

	stagingPath := path + ".rollback-tmp"
	hadLive := false
	if _, err := os.Stat(path); err == nil {
		hadLive = true
		if err := os.Rename(path, stagingPath); err != nil {
			return CoreBinaryReport{}, fmt.Errorf("staging current %s binary before rollback: %w", core, err)
		}
	}

	if err := os.Rename(previousPath, path); err != nil {
		if hadLive {
			_ = os.Rename(stagingPath, path) // put it back the way it was
		}
		return CoreBinaryReport{}, fmt.Errorf("restoring previous %s binary: %w", core, err)
	}

	if hadLive {
		// The rollback itself already succeeded (path now holds the restored
		// binary) by this point -- losing the ability to swap back a second
		// time on a failure here is unfortunate but not worth reporting the
		// whole call as failed over.
		_ = os.Rename(stagingPath, previousPath)
	}

	return reportForCore(ctx, core), nil
}
