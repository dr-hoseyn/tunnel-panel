package tunnels

import "fmt"

// unitSpec is the small set of fields that actually differ between cores'
// systemd units -- everything else (restart policy, resource limits,
// journal logging, IPAccounting for the Health traffic signal) is identical
// across every driver in this package, so it's written once here instead of
// being duplicated in each core file.
type unitSpec struct {
	Description string
	ExecStart   string
}

// renderSystemdUnit builds a unit file's contents. ExecStart is always
// built from paths this package itself controls (its own binary/config
// paths under dataDir, never a raw value from an HTTP request) -- see
// exec.go's header comment on argv-only execution; the same discipline
// applies here even though systemd (not this process) parses this line.
func renderSystemdUnit(spec unitSpec) string {
	return fmt.Sprintf(`[Unit]
Description=%s
After=network.target

[Service]
Type=simple
User=root
ExecStart=%s
Restart=always
RestartSec=3
LimitNOFILE=1048576
IPAccounting=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`, spec.Description, spec.ExecStart)
}
