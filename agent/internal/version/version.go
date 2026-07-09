// Package version holds build-time metadata injected via -ldflags -X (see
// .github/workflows/build-agent.yml), with safe defaults for local
// `go build`/`go run` during development where no ldflags are passed.
package version

import (
	"runtime"
	"time"
)

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

// startedAt defaults to package-load time (effectively process start) so
// uptime is always sane even if SetStartTime is never called (e.g. in
// tests); main.go overrides it with the precise value captured at the very
// top of main() via SetStartTime, before flag parsing/listener setup can
// eat any measurable time.
var startedAt = time.Now()

// SetStartTime records when the agent process actually started. Call once,
// before serving any request -- see main.go.
func SetStartTime(t time.Time) {
	startedAt = t
}

// Info is what /api/v1/agent/info reports -- lets the panel detect an
// incompatible or outdated agent and record OS/arch/supported drivers per
// server without any tunnel-manager.sh involvement.
type Info struct {
	Version       string   `json:"version"`
	Commit        string   `json:"commit"`
	BuildDate     string   `json:"build_date"`
	OS            string   `json:"os"`
	Arch          string   `json:"arch"`
	GoVersion     string   `json:"go_version"`
	UptimeSeconds int64    `json:"uptime_seconds"`
	Drivers       []string `json:"supported_drivers"`
}

// Current builds an Info snapshot for this running agent, given the tunnel
// core drivers it has registered.
func Current(drivers []string) Info {
	return Info{
		Version:       Version,
		Commit:        Commit,
		BuildDate:     BuildDate,
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		GoVersion:     runtime.Version(),
		UptimeSeconds: int64(time.Since(startedAt).Seconds()),
		Drivers:       drivers,
	}
}
