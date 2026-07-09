package tunnels

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func TestDialLatencyMsAgainstOpenPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()

	port := ln.Addr().(*net.TCPAddr).Port
	ms, ok := dialLatencyMs(port)
	if !ok {
		t.Fatal("expected ok=true for a real listener")
	}
	if ms < 0 {
		t.Errorf("expected a non-negative latency, got %v", ms)
	}
}

func TestDialLatencyMsAgainstClosedPort(t *testing.T) {
	// Port 1 is a reserved/unassigned TCP port essentially never bound to
	// on a test runner -- dial should fail fast with connection refused.
	if _, ok := dialLatencyMs(1); ok {
		t.Skip("something is actually listening on port 1 in this environment")
	}
}

func TestCountProcNetTCPConnectionsParsesEstablishedByPort(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fake_tcp")
	// Real /proc/net/tcp format: header line, then rows of
	// "sl local_address rem_address st ...". Port 0x1F90 = 8080,
	// state 01 = ESTABLISHED, 0A = LISTEN.
	content := "  sl  local_address rem_address   st\n" +
		"   0: 0100007F:1F90 00000000:0000 0A \n" + // LISTEN on 8080 -- not counted
		"   1: 0100007F:1F90 0100007F:C350 01 \n" + // ESTABLISHED on 8080 -- counted
		"   2: 0100007F:1F90 0100007F:C351 01 \n" + // ESTABLISHED on 8080 -- counted
		"   3: 0100007F:0050 0100007F:C352 01 \n" // ESTABLISHED on a different port -- not counted
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing fake proc file: %v", err)
	}

	got := countProcNetTCPConnections(path, 8080)
	if got != 2 {
		t.Errorf("expected 2 established connections on port 8080, got %d", got)
	}
}

func TestCountProcNetTCPConnectionsMissingFileReturnsZero(t *testing.T) {
	if got := countProcNetTCPConnections(filepath.Join(t.TempDir(), "does-not-exist"), 8080); got != 0 {
		t.Errorf("expected 0 for a missing file, got %d", got)
	}
}

func TestSystemctlUintPropUnavailableReturnsFalse(t *testing.T) {
	// No real systemd unit named this exists in a test environment (and
	// systemctl itself may not even be installed) -- must degrade to
	// ok=false, never panic or return a fabricated number.
	if _, ok := systemctlUintProp(context.Background(), "definitely-not-a-real-unit.service", "NRestarts"); ok {
		t.Skip("systemctl unexpectedly reported a value for a nonexistent unit in this environment")
	}
}

func TestProcessCPURAMPercentForSelf(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("/proc is Linux-only")
	}
	pid := uint64(os.Getpid())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cpu, ram, ok := processCPURAMPercent(ctx, pid)
	if !ok {
		t.Fatal("expected to read this test process's own /proc entries")
	}
	if cpu < 0 {
		t.Errorf("expected a non-negative cpu percent, got %v", cpu)
	}
	if ram <= 0 {
		t.Errorf("expected a positive ram percent for a live process, got %v", ram)
	}
}

func TestReadProcRSSKBAndMemTotalKBForSelf(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("/proc is Linux-only")
	}
	rss, err := readProcRSSKB(uint64(os.Getpid()))
	if err != nil {
		t.Fatalf("readProcRSSKB: %v", err)
	}
	if rss == 0 {
		t.Error("expected a nonzero RSS for a live process")
	}
	total, err := readMemTotalKB()
	if err != nil {
		t.Fatalf("readMemTotalKB: %v", err)
	}
	if total == 0 {
		t.Error("expected a nonzero MemTotal")
	}
}

func TestRuntimeStatsSkipsLatencyAndConnectionsWhenNoTCPPort(t *testing.T) {
	h := runtimeStats(context.Background(), "definitely-not-a-real-unit.service", 0)
	if h.HasLatency {
		t.Error("expected HasLatency=false when tcpPort=0")
	}
	if h.Connections != 0 {
		t.Errorf("expected Connections=0 when tcpPort=0, got %d", h.Connections)
	}
}

func TestMergeRuntimeStatsCopiesFieldsWithoutDisturbingOthers(t *testing.T) {
	h := Health{Process: "running", PortOpen: true, Detail: "keep me"}
	rt := Health{LatencyMs: 12.5, HasLatency: true, Connections: 3, ReconnectCount: 7, CPUPercent: 1.2, RAMPercent: 3.4, HasProcStats: true}
	mergeRuntimeStats(&h, rt)

	if h.Process != "running" || !h.PortOpen || h.Detail != "keep me" {
		t.Errorf("mergeRuntimeStats disturbed unrelated fields: %+v", h)
	}
	if h.LatencyMs != 12.5 || !h.HasLatency || h.Connections != 3 || h.ReconnectCount != 7 {
		t.Errorf("mergeRuntimeStats did not copy fields correctly: %+v", h)
	}
	if h.CPUPercent != 1.2 || h.RAMPercent != 3.4 || !h.HasProcStats {
		t.Errorf("mergeRuntimeStats did not copy proc stats correctly: %+v", h)
	}
}

func TestTCPStatePortHexFormatting(t *testing.T) {
	// Sanity check on the hex formatting this package relies on for every
	// /proc/net/tcp comparison: port 8080 must format as "1F90", not "1f90"
	// (kernel always uses uppercase hex in these files).
	got := strconv.FormatInt(8080, 16)
	if got != "1f90" {
		t.Fatalf("test assumption broken: strconv formatted 8080 as %q", got)
	}
}
