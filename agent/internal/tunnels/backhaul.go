package tunnels

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Backhaul driver. Ported from ha-tunnel-manager's core/backhaul/core.sh
// (read-only reference, not modified/shelled out to):
//   - download_and_extract_backhaul (:688) -- binary source/arch mapping
//   - generate_toml_config (:1161) -- TOML shape
//   - create_systemd_service (:1351) -- unit shape
//
// Scope note: the bash source supports many advanced modes (TUN/IPX kernel
// tunneling, MUX framing, custom TLS certs, UDP accept tuning...) via a
// large interactive prompt flow. This driver implements the common,
// production path a wizard-driven "create a tunnel" flow actually needs --
// listener/dialer, transport type, token auth, port forwarding -- not every
// exotic knob. Extending it (e.g. wss + a managed TLS cert) is additive:
// new fields on Spec.Extra and new branches in WriteConfig, not a redesign.
func init() {
	Register("backhaul", newBackhaulDriver)
}

const (
	backhaulBinaryName     = "backhaul_premium"
	backhaulPrimaryURLFmt  = "http://en.backhaul-dev.com:2095/backhaul_premium_%s.tar.gz"
	backhaulFallbackURLFmt = "http://ir.backhaul-dev.com:2095/backhaul_premium_%s.tar.gz"
)

type backhaulDriver struct {
	baseDriver
	binPath    string
	configPath string
}

func newBackhaulDriver(spec Spec) (Driver, error) {
	base, err := newBaseDriver(spec)
	if err != nil {
		return nil, err
	}
	return &backhaulDriver{
		baseDriver: base,
		binPath:    filepath.Join(binariesDir("backhaul"), backhaulBinaryName),
		configPath: filepath.Join(base.tunnelDir, "config.toml"),
	}, nil
}

func backhaulArchSuffix() (string, error) {
	return backhaulArchSuffixFor(runtime.GOARCH)
}

// backhaulArchSuffixFor is split out from backhaulArchSuffix so the mapping
// itself is table-testable without needing to vary GOARCH (a compile-time
// constant) in a test binary.
func backhaulArchSuffixFor(goarch string) (string, error) {
	switch goarch {
	case "amd64":
		return "amd64", nil
	case "arm64":
		return "arm64", nil
	default:
		return "", fmt.Errorf("unsupported architecture for backhaul: %s", goarch)
	}
}

func (d *backhaulDriver) Install(ctx context.Context) error {
	if binaryRunsOK(ctx, d.binPath, "-v") {
		return nil
	}
	arch, err := backhaulArchSuffix()
	if err != nil {
		return err
	}
	binDir := binariesDir("backhaul")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("creating backhaul binary directory: %w", err)
	}
	var lastErr error
	for _, urlFmt := range []string{backhaulPrimaryURLFmt, backhaulFallbackURLFmt} {
		url := fmt.Sprintf(urlFmt, arch)
		if err := downloadAndExtractTarGz(ctx, url, backhaulBinaryName, binDir); err != nil {
			lastErr = err
			continue
		}
		lastErr = nil
		break
	}
	if lastErr != nil {
		return fmt.Errorf("downloading backhaul: %w", lastErr)
	}
	if !binaryRunsOK(ctx, d.binPath, "-v") {
		return fmt.Errorf("backhaul binary failed a basic sanity check (-v) after install")
	}
	return nil
}

func (d *backhaulDriver) WriteConfig() error {
	if err := os.MkdirAll(d.tunnelDir, 0o700); err != nil {
		return fmt.Errorf("creating tunnel directory: %w", err)
	}
	var b strings.Builder
	if d.spec.Role == RoleServer {
		fmt.Fprintf(&b, "[listener]\nbind_addr = \":%d\"\n\n", d.spec.Port)
	} else {
		fmt.Fprintf(&b, "[dialer]\nremote_addr = %q\ndial_timeout = 10\nretry_interval = 3\n\n", d.spec.Peer)
	}

	transport := d.spec.Extra["transport"]
	if transport == "" {
		transport = "tcp"
	}
	fmt.Fprintf(&b, "[transport]\ntype = %q\nnodelay = true\n\n", transport)

	b.WriteString("[security]\n")
	fmt.Fprintf(&b, "token = %q\n\n", d.spec.Secret)

	b.WriteString("[tuning]\nauto_tuning = true\n\n")
	b.WriteString("[logging]\nlog_level = \"info\"\n")

	if d.spec.Role == RoleServer {
		b.WriteString("\n[ports]\nmapping = [\n")
		for _, p := range d.spec.Ports {
			fmt.Fprintf(&b, "    \"%d=%d\",\n", p.Remote, p.Local)
		}
		b.WriteString("]\n")
	}

	if err := os.WriteFile(d.configPath, []byte(b.String()), 0o600); err != nil {
		return fmt.Errorf("writing backhaul config: %w", err)
	}
	return nil
}

func (d *backhaulDriver) CreateService() error {
	return d.writeUnitAndEnable(
		fmt.Sprintf("tunnel-agent Backhaul tunnel %s", d.spec.ID),
		fmt.Sprintf("%s -c %s", d.binPath, d.configPath),
	)
}

func (d *backhaulDriver) ConfigureFirewall() error {
	if d.spec.Role != RoleServer {
		return nil // client role dials out -- nothing to open inbound
	}
	if err := allowFirewallPort(context.Background(), d.spec.Port, "tcp"); err != nil {
		return err
	}
	for _, p := range d.spec.Ports {
		if err := allowFirewallPort(context.Background(), p.Remote, "tcp"); err != nil {
			return err
		}
	}
	return nil
}

func (d *backhaulDriver) Health(ctx context.Context) (Health, error) {
	h := Health{Process: "stopped"}
	if systemctlIsActive(ctx, d.serviceName) {
		h.Process = "running"
	}
	if d.spec.Role == RoleServer {
		h.PortOpen = portOpen(d.spec.Port)
	} else {
		h.PortOpen = h.Process == "running"
	}
	h.RxBytes, h.TxBytes = systemctlIPBytes(ctx, d.serviceName)
	h.Traffic = h.RxBytes > 0 || h.TxBytes > 0
	switch {
	case h.Process != "running":
		h.Detail = "systemd unit is not active"
	case d.spec.Role == RoleServer && !h.PortOpen:
		h.Detail = "process is running but its bind port is not accepting connections"
	}
	return h, nil
}

func (d *backhaulDriver) Remove(ctx context.Context) error {
	if d.spec.Role == RoleServer {
		removeFirewallPort(ctx, d.spec.Port, "tcp")
		for _, p := range d.spec.Ports {
			removeFirewallPort(ctx, p.Remote, "tcp")
		}
	}
	return d.removeServiceAndDir(ctx)
}
