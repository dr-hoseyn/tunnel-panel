package tunnels

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestBinaryStatusNotInstalled(t *testing.T) {
	status := BinaryStatus(context.Background(), filepath.Join(t.TempDir(), "does-not-exist"), "--version")
	if status != StatusNotInstalled {
		t.Errorf("expected %q, got %q", StatusNotInstalled, status)
	}
}

func TestBinaryStatusBroken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "garbage")
	if err := os.WriteFile(path, []byte("not a real executable"), 0o755); err != nil {
		t.Fatalf("writing garbage file: %v", err)
	}
	status := BinaryStatus(context.Background(), path, "--version")
	if status != StatusBroken {
		t.Errorf("expected %q, got %q", StatusBroken, status)
	}
}

func TestBinaryStatusHealthy(t *testing.T) {
	// Use the real `go` binary as a stand-in for "a binary that actually
	// runs" -- guaranteed present (we're running under `go test`) and
	// cross-platform, unlike trying to exec a real core binary here.
	goPath, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go toolchain not on PATH -- can't exercise a real working binary")
	}
	status := BinaryStatus(context.Background(), goPath, "version")
	if status != StatusHealthy {
		t.Errorf("expected %q, got %q", StatusHealthy, status)
	}
}

func TestCoreBinaryReportsIncludesEveryKnownCore(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	reports := CoreBinaryReports(context.Background())
	found := map[string]CoreBinaryReport{}
	for _, r := range reports {
		found[r.Core] = r
	}
	for _, want := range []string{"backhaul", "gost", "hysteria2", "rathole"} {
		r, ok := found[want]
		if !ok {
			t.Errorf("expected a report for core %q, got %v", want, reports)
			continue
		}
		if r.Status != StatusNotInstalled {
			t.Errorf("expected %q to be not-installed in a fresh data dir, got %q", want, r.Status)
		}
		if r.Path == "" {
			t.Errorf("expected a non-empty path for core %q", want)
		}
	}
}

func TestCoreBinaryReportsDetectsInstalledBinary(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	path, _ := binaryPathFor("rathole")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("creating binary dir: %v", err)
	}
	if err := os.WriteFile(path, []byte("not a real executable"), 0o755); err != nil {
		t.Fatalf("writing fake binary: %v", err)
	}

	reports := CoreBinaryReports(context.Background())
	for _, r := range reports {
		if r.Core == "rathole" {
			if r.Status != StatusBroken {
				t.Errorf("expected rathole to be reported broken, got %q", r.Status)
			}
			return
		}
	}
	t.Fatal("expected a report for rathole")
}
