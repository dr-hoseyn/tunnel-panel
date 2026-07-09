package tunnels

import (
	"context"
	"os"
	"path/filepath"
	"sort"
)

// Supports GET /api/v1/agent/cores: for every registered core, report
// whether its binary is actually present on disk and, if so, whether it
// passes the same harmless sanity invocation each driver's own Install
// already runs (see binaryRunsOK in exec.go). Deliberately coarse --
// "installed and healthy" vs "installed but broken" vs "not installed" --
// rather than a parsed semver: each core's --version/-V/--help output has
// its own format, and parsing five ad-hoc version strings reliably isn't
// worth the fragility for what the panel actually needs, which is "can this
// core actually be used right now".

// CoreBinaryStatus is the coarse installed/healthy signal for one core's
// binary.
type CoreBinaryStatus string

const (
	StatusNotInstalled CoreBinaryStatus = "not installed"
	StatusHealthy      CoreBinaryStatus = "installed and healthy"
	StatusBroken       CoreBinaryStatus = "installed but broken"
)

// coreBinaryChecks maps each core name to its binary's expected filename
// (inside binariesDir(core)) and the flag that invokes a harmless
// version/help query -- mirrors exactly the private *BinaryName consts and
// binaryRunsOK call each driver file already uses in its own Install, kept
// here as the one place that needs to know all of them at once.
var coreBinaryChecks = map[string]struct {
	binaryName string
	versionArg string
}{
	"backhaul":  {backhaulBinaryName, "-v"},
	"gost":      {gostBinaryName, "-V"},
	"hysteria2": {hysteria2BinaryName, "version"},
	"rathole":   {ratholeBinaryName, "--help"},
}

// CoreBinaryReport is one core's installed-binary status, as reported by
// GET /api/v1/agent/cores.
type CoreBinaryReport struct {
	Core   string           `json:"core"`
	Path   string           `json:"path"`
	Status CoreBinaryStatus `json:"status"`
}

// binaryPathFor resolves where core's binary is expected to live and which
// flag sanity-checks it. A core with no known check (e.g. a test-only core
// registered under a name this package doesn't recognize) falls back to a
// best-guess "<core>_bin --version" -- enough to still correctly report
// not-installed/installed for it, just without a core-specific version
// flag.
func binaryPathFor(core string) (path, versionArg string) {
	check, ok := coreBinaryChecks[core]
	if !ok {
		return filepath.Join(binariesDir(core), core+"_bin"), "--version"
	}
	return filepath.Join(binariesDir(core), check.binaryName), check.versionArg
}

// BinaryStatus reports whether the binary at path is present and, if so,
// whether it passes binaryRunsOK.
func BinaryStatus(ctx context.Context, path, versionArg string) CoreBinaryStatus {
	if _, err := os.Stat(path); err != nil {
		return StatusNotInstalled
	}
	if binaryRunsOK(ctx, path, versionArg) {
		return StatusHealthy
	}
	return StatusBroken
}

// CoreBinaryReports builds one CoreBinaryReport per registered core, sorted
// by name for a stable response -- SupportedCores() itself iterates a map
// and has no defined order.
func CoreBinaryReports(ctx context.Context) []CoreBinaryReport {
	cores := SupportedCores()
	sort.Strings(cores)
	reports := make([]CoreBinaryReport, 0, len(cores))
	for _, core := range cores {
		path, versionArg := binaryPathFor(core)
		reports = append(reports, CoreBinaryReport{
			Core:   core,
			Path:   path,
			Status: BinaryStatus(ctx, path, versionArg),
		})
	}
	return reports
}
