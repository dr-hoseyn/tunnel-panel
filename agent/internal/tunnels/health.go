package tunnels

import (
	"context"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// runtimeStats gathers the metrics every driver's Health() merges in on top
// of its own process-state/port-reachability checks: TCP dial latency and
// active connection count (both real-time, protocol-appropriate for TCP
// cores), systemd's own restart counter (a real "unexpected disconnect"
// signal -- every unit this package creates sets Restart=always, so a
// restart only ever happens when the process actually died), and a short
// dual-sample CPU/RAM reading for the unit's current main process. All of
// it is read directly from systemd/procfs -- nothing here is estimated or
// randomized.
//
// tcpPort is 0 for callers with no single TCP port to dial/count against
// (Hysteria2's UDP listeners) -- latency/connections are simply left unset
// in that case rather than measuring something misleading.
func runtimeStats(ctx context.Context, unit string, tcpPort int) Health {
	var h Health

	if tcpPort > 0 {
		if ms, ok := dialLatencyMs(tcpPort); ok {
			h.LatencyMs = ms
			h.HasLatency = true
		}
		h.Connections = tcpConnectionCount(tcpPort)
	}

	if restarts, ok := systemctlUintProp(ctx, unit, "NRestarts"); ok {
		h.ReconnectCount = restarts
	}

	if pid, ok := systemctlUintProp(ctx, unit, "MainPID"); ok && pid > 0 {
		if cpu, ram, ok := processCPURAMPercent(ctx, pid); ok {
			h.CPUPercent = cpu
			h.RAMPercent = ram
			h.HasProcStats = true
		}
	}

	return h
}

// mergeRuntimeStats copies runtimeStats' fields into an already-populated
// Health (which every driver builds first from its own process/port/traffic
// checks) without disturbing anything driver-specific.
func mergeRuntimeStats(h *Health, rt Health) {
	h.LatencyMs = rt.LatencyMs
	h.HasLatency = rt.HasLatency
	h.Connections = rt.Connections
	h.ReconnectCount = rt.ReconnectCount
	h.CPUPercent = rt.CPUPercent
	h.RAMPercent = rt.RAMPercent
	h.HasProcStats = rt.HasProcStats
}

// dialLatencyMs times a real TCP handshake to 127.0.0.1:port. ok=false (not
// a zero/placeholder value) if nothing answers, so callers never show a
// fake "0ms" for an unreachable port.
func dialLatencyMs(port int) (ms float64, ok bool) {
	start := time.Now()
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 2*time.Second)
	if err != nil {
		return 0, false
	}
	_ = conn.Close()
	return float64(time.Since(start).Microseconds()) / 1000, true
}

// systemctlUintProp reads one numeric "systemctl show -p <prop> --value"
// property. Used for both NRestarts and MainPID -- both are populated by
// systemd for every unit type this package generates, no core-specific
// support required.
func systemctlUintProp(ctx context.Context, unit, prop string) (uint64, bool) {
	out, err := runCommand(ctx, "systemctl", "show", unit, "-p", prop, "--value")
	if err != nil {
		return 0, false
	}
	v, err := strconv.ParseUint(strings.TrimSpace(out), 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// tcpConnectionCount counts ESTABLISHED TCP connections whose local port is
// port, reading /proc/net/tcp[6] directly -- the same source `ss`/`netstat`
// read from, without shelling out to either.
func tcpConnectionCount(port int) int {
	return countProcNetTCPConnections("/proc/net/tcp", port) + countProcNetTCPConnections("/proc/net/tcp6", port)
}

const tcpStateEstablished = "01"

func countProcNetTCPConnections(path string, port int) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	portHex := strings.ToUpper(strconv.FormatInt(int64(port), 16))
	count := 0
	lines := strings.Split(string(data), "\n")
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		localParts := strings.Split(fields[1], ":")
		if len(localParts) != 2 || localParts[1] != portHex {
			continue
		}
		if fields[3] != tcpStateEstablished {
			continue
		}
		count++
	}
	return count
}

// linuxClockTicksPerSec is USER_HZ, the unit /proc/<pid>/stat's utime/stime
// fields are counted in. 100 on effectively every Linux distribution this
// agent targets (x86_64/arm64 default); reading the true value requires
// cgo's sysconf(_SC_CLK_TCK), which this project deliberately avoids to
// keep its zero-third-party-dependency, pure-stdlib posture.
const linuxClockTicksPerSec = 100.0

// processCPURAMPercent takes two /proc/<pid>/stat CPU-tick samples a short
// interval apart to compute a real short-window CPU percent, plus a
// single-sample RSS-based RAM percent. ok=false if pid's /proc entries
// aren't readable (process gone, or a permissions issue).
func processCPURAMPercent(ctx context.Context, pid uint64) (cpuPercent, ramPercent float64, ok bool) {
	t0, err := readProcCPUTicks(pid)
	if err != nil {
		return 0, 0, false
	}
	const sampleWindow = 150 * time.Millisecond
	select {
	case <-time.After(sampleWindow):
	case <-ctx.Done():
		return 0, 0, false
	}
	t1, err := readProcCPUTicks(pid)
	if err != nil {
		return 0, 0, false
	}

	deltaTicks := float64(0)
	if t1 > t0 {
		deltaTicks = float64(t1 - t0)
	}
	cpuPercent = (deltaTicks / linuxClockTicksPerSec) / sampleWindow.Seconds() * 100

	rssKB, err := readProcRSSKB(pid)
	if err != nil {
		return cpuPercent, 0, true
	}
	totalKB, err := readMemTotalKB()
	if err != nil || totalKB == 0 {
		return cpuPercent, 0, true
	}
	ramPercent = float64(rssKB) / float64(totalKB) * 100
	return cpuPercent, ramPercent, true
}

// readProcCPUTicks reads /proc/<pid>/stat's utime+stime fields (14th/15th,
// after the parenthesized comm field which may itself contain spaces).
func readProcCPUTicks(pid uint64) (uint64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	// comm is the second field, wrapped in parens and possibly containing
	// spaces/other parens -- split on the last ")" to skip past it safely.
	line := string(data)
	closeParen := strings.LastIndex(line, ")")
	if closeParen < 0 || closeParen+2 >= len(line) {
		return 0, fmt.Errorf("unexpected /proc/%d/stat format", pid)
	}
	fields := strings.Fields(line[closeParen+2:])
	// After splitting off "pid (comm) ", state is field[0], and utime/stime
	// are fields[11] and fields[12] (fields 14/15 overall).
	if len(fields) < 13 {
		return 0, fmt.Errorf("unexpected /proc/%d/stat field count", pid)
	}
	utime, err := strconv.ParseUint(fields[11], 10, 64)
	if err != nil {
		return 0, err
	}
	stime, err := strconv.ParseUint(fields[12], 10, 64)
	if err != nil {
		return 0, err
	}
	return utime + stime, nil
}

// readProcRSSKB reads /proc/<pid>/status' VmRSS line (already in kB).
func readProcRSSKB(pid uint64) (uint64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		return strconv.ParseUint(fields[1], 10, 64)
	}
	return 0, fmt.Errorf("VmRSS not found in /proc/%d/status", pid)
}

// readMemTotalKB reads /proc/meminfo's MemTotal line (already in kB).
func readMemTotalKB() (uint64, error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		return strconv.ParseUint(fields[1], 10, 64)
	}
	return 0, fmt.Errorf("MemTotal not found in /proc/meminfo")
}
