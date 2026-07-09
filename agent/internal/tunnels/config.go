package tunnels

import "path/filepath"

// dataDir is the agent's base data directory (e.g. /etc/tunnel-agent), set
// once at startup by main.go via SetDataDir before any request is served.
// A package-level var rather than threading it through every Factory call:
// the agent has exactly one data directory for its whole process lifetime,
// same as tokenPath/certPath in main.go today.
var dataDir = "/etc/tunnel-agent"

// systemdUnitDir is overridable only by tests -- production always uses the
// real systemd unit search path.
var systemdUnitDir = "/etc/systemd/system"

// SetDataDir configures the base directory every driver in this package
// writes tunnel configs/binaries under. Must be called once at startup,
// before serving any request.
func SetDataDir(dir string) {
	dataDir = dir
}

// binariesDir is where a core's downloaded binary is cached, shared across
// every tunnel using that core (the binary itself isn't per-tunnel state).
func binariesDir(core string) string {
	return filepath.Join(dataDir, "bin", core)
}
