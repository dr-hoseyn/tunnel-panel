package tunnels

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// fakeInstallDriver lets ReinstallCore be exercised without a real network
// download -- its Install just does whatever the test wants (write a fake
// binary, fail, ...), same reasoning as tunnel_handlers_test.go's fakeDriver
// in the server package.
type fakeInstallDriver struct {
	onInstall func(ctx context.Context) error
}

func (d *fakeInstallDriver) Install(ctx context.Context) error {
	if d.onInstall != nil {
		return d.onInstall(ctx)
	}
	return nil
}
func (d *fakeInstallDriver) WriteConfig() error                     { return nil }
func (d *fakeInstallDriver) CreateService() error                   { return nil }
func (d *fakeInstallDriver) ConfigureFirewall() error               { return nil }
func (d *fakeInstallDriver) Start(context.Context) error            { return nil }
func (d *fakeInstallDriver) Stop(context.Context) error             { return nil }
func (d *fakeInstallDriver) Restart(context.Context) error          { return nil }
func (d *fakeInstallDriver) Health(context.Context) (Health, error) { return Health{}, nil }
func (d *fakeInstallDriver) Logs(context.Context, int) ([]string, error) {
	return nil, nil
}
func (d *fakeInstallDriver) Remove(context.Context) error { return nil }

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("creating dir for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}

func TestVerifyCoreUnknownCore(t *testing.T) {
	_, err := VerifyCore(context.Background(), "no-such-core-verify-test")
	var unknownErr *UnknownCoreError
	if !errors.As(err, &unknownErr) {
		t.Fatalf("expected *UnknownCoreError, got %T: %v", err, err)
	}
}

func TestVerifyCoreReturnsFreshReport(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	report, err := VerifyCore(context.Background(), "backhaul")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if report.Core != "backhaul" {
		t.Errorf("expected core %q, got %q", "backhaul", report.Core)
	}
	if report.Status != StatusNotInstalled {
		t.Errorf("expected not-installed in a fresh data dir, got %q", report.Status)
	}
	if report.HasPrevious {
		t.Errorf("expected no previous version in a fresh data dir")
	}
}

func TestReinstallCoreUnknownCore(t *testing.T) {
	_, err := ReinstallCore(context.Background(), "no-such-core-reinstall-test")
	var unknownErr *UnknownCoreError
	if !errors.As(err, &unknownErr) {
		t.Fatalf("expected *UnknownCoreError, got %T: %v", err, err)
	}
}

func TestReinstallCoreForcesFreshInstallAndBacksUpOldBinary(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	const core = "reinstall-happy-core"
	installCount := 0
	Register(core, func(spec Spec) (Driver, error) {
		return &fakeInstallDriver{onInstall: func(ctx context.Context) error {
			installCount++
			path, _ := binaryPathFor(core)
			writeFile(t, path, "new-version")
			return nil
		}}, nil
	})

	path, _ := binaryPathFor(core)
	writeFile(t, path, "old-version")

	report, err := ReinstallCore(context.Background(), core)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if installCount != 1 {
		t.Fatalf("expected Install to be called exactly once, got %d", installCount)
	}
	if report.Core != core {
		t.Errorf("expected core %q, got %q", core, report.Core)
	}
	if !report.HasPrevious {
		t.Errorf("expected HasPrevious=true after reinstalling over an existing binary")
	}
	if got := readFile(t, path); got != "new-version" {
		t.Errorf("expected the live binary to be the freshly installed one, got %q", got)
	}
	if got := readFile(t, previousPathFor(core)); got != "old-version" {
		t.Errorf("expected .previous to hold the pre-reinstall binary, got %q", got)
	}
}

func TestReinstallCoreWithNoExistingBinaryStillInstalls(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	const core = "reinstall-fresh-core"
	Register(core, func(spec Spec) (Driver, error) {
		return &fakeInstallDriver{onInstall: func(ctx context.Context) error {
			path, _ := binaryPathFor(core)
			writeFile(t, path, "first-install")
			return nil
		}}, nil
	})

	report, err := ReinstallCore(context.Background(), core)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if report.HasPrevious {
		t.Errorf("expected HasPrevious=false: there was nothing installed before this reinstall")
	}
	path, _ := binaryPathFor(core)
	if got := readFile(t, path); got != "first-install" {
		t.Errorf("expected the freshly installed binary, got %q", got)
	}
	if _, err := os.Stat(previousPathFor(core)); !os.IsNotExist(err) {
		t.Errorf("expected no .previous file to have been created")
	}
}

func TestReinstallCoreRestoresOriginalOnInstallFailure(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	const core = "reinstall-failing-core"
	Register(core, func(spec Spec) (Driver, error) {
		return &fakeInstallDriver{onInstall: func(ctx context.Context) error {
			return errors.New("simulated install failure")
		}}, nil
	})

	path, _ := binaryPathFor(core)
	writeFile(t, path, "still-good")

	_, err := ReinstallCore(context.Background(), core)
	if err == nil {
		t.Fatal("expected an error when Install fails")
	}
	if got := readFile(t, path); got != "still-good" {
		t.Errorf("expected the original binary to be restored after a failed reinstall, got %q", got)
	}
	if _, statErr := os.Stat(previousPathFor(core)); !os.IsNotExist(statErr) {
		t.Errorf("expected no leftover .previous file after a restored failed reinstall")
	}
}

func TestRollbackCoreUnknownCore(t *testing.T) {
	_, err := RollbackCore(context.Background(), "no-such-core-rollback-test")
	var unknownErr *UnknownCoreError
	if !errors.As(err, &unknownErr) {
		t.Fatalf("expected *UnknownCoreError, got %T: %v", err, err)
	}
}

func TestRollbackCoreNoPreviousVersionReturnsTypedError(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	_, err := RollbackCore(context.Background(), "rathole")
	if !errors.Is(err, ErrNoPreviousVersion) {
		t.Fatalf("expected ErrNoPreviousVersion, got %v", err)
	}
}

func TestRollbackCoreSwapsBinariesBothWays(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	path, _ := binaryPathFor("rathole")
	writeFile(t, path, "current")
	writeFile(t, previousPathFor("rathole"), "previous")

	report, err := RollbackCore(context.Background(), "rathole")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := readFile(t, path); got != "previous" {
		t.Errorf("expected the live binary to become the old .previous content, got %q", got)
	}
	if got := readFile(t, previousPathFor("rathole")); got != "current" {
		t.Errorf("expected .previous to now hold what was live before rollback, got %q", got)
	}
	if !report.HasPrevious {
		t.Errorf("expected HasPrevious=true: rollback should preserve a symmetric swap-back option")
	}

	// Rolling back a second time should return to the original state.
	report2, err := RollbackCore(context.Background(), "rathole")
	if err != nil {
		t.Fatalf("unexpected error on second rollback: %v", err)
	}
	if got := readFile(t, path); got != "current" {
		t.Errorf("expected a second rollback to restore the original live content, got %q", got)
	}
	_ = report2
}

func TestRollbackCoreWithNoLiveBinaryConsumesThePrevious(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	path, _ := binaryPathFor("hysteria2")
	writeFile(t, previousPathFor("hysteria2"), "previous-only")

	report, err := RollbackCore(context.Background(), "hysteria2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := readFile(t, path); got != "previous-only" {
		t.Errorf("expected the live binary to be the restored one, got %q", got)
	}
	if report.HasPrevious {
		t.Errorf("expected HasPrevious=false: there was nothing live to save back into .previous")
	}
	if _, statErr := os.Stat(previousPathFor("hysteria2")); !os.IsNotExist(statErr) {
		t.Errorf("expected .previous to be consumed, not left behind")
	}
}
