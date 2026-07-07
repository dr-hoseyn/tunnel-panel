// Package tunnelscript shells out to tunnel-manager.sh's non-interactive
// JSON modes. This is the whole point of the Agent's design: tunnel status/
// metrics logic lives in exactly one place (the bash cores), and the Agent
// is a thin, authenticated HTTPS wrapper around it — not a reimplementation.
package tunnelscript

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"time"
)

// Runner executes tunnel-manager.sh <mode> and returns its raw stdout. The
// caller is expected to pass one of the script's machine-readable modes
// ("--metrics-json", "--list-json"); anything else runs the interactive
// panel and will hang until the context times out.
type Runner struct {
	ScriptPath string
	Timeout    time.Duration
}

// Run executes tunnel-manager.sh with the given mode flag and returns its
// stdout. Bash is invoked explicitly rather than exec'ing the script
// directly so this works whether or not the script's execute bit survived
// deployment.
func (r Runner) Run(mode string) ([]byte, error) {
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", r.ScriptPath, mode)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("running %s %s: %w (stderr: %s)", r.ScriptPath, mode, err, stderr.String())
	}
	return stdout.Bytes(), nil
}
