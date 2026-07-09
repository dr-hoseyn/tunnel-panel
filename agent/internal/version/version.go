// Package version holds build-time metadata injected via -ldflags -X (see
// .github/workflows/build-agent.yml), with safe defaults for local
// `go build`/`go run` during development where no ldflags are passed.
package version

import "runtime"

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

// Info is what /api/v1/agent/info reports -- lets the panel detect an
// incompatible or outdated agent and record OS/arch/supported drivers per
// server without any tunnel-manager.sh involvement.
type Info struct {
	Version   string   `json:"version"`
	Commit    string   `json:"commit"`
	BuildDate string   `json:"build_date"`
	OS        string   `json:"os"`
	Arch      string   `json:"arch"`
	Drivers   []string `json:"supported_drivers"`
}

// Current builds an Info snapshot for this running agent, given the tunnel
// core drivers it has registered.
func Current(drivers []string) Info {
	return Info{
		Version:   Version,
		Commit:    Commit,
		BuildDate: BuildDate,
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
		Drivers:   drivers,
	}
}
