package tunnels

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Rathole driver. Ported from ha-tunnel-manager's core/rathole/core.sh
// (read-only reference):
//   - core_rathole_install (:27) -- rathole-org/rathole GitHub releases, zip
//   - core_rathole_generate_config (:135) -- TOML shape
//   - core_rathole_create_service (:168) -- unit shape (-s server / -c client)
//
// Scope note: only the "tcp" transport is implemented, matching the bash
// reference's own current scope (its own comment: tls/noise are a future
// case branch, not implemented there either). Rathole ties one port number
// to one named service block on both sides (no remap) -- PortMapping.Remote
// is used as that port; PortMapping.Local is unused for this core.
func init() {
	Register("rathole", newRatholeDriver)
}

const (
	ratholeBinaryName = "rathole_bin"
	ratholeRepo       = "rathole-org/rathole"
)

func ratholeArchAsset(goarch string) (string, error) {
	switch goarch {
	case "amd64":
		return "rathole-x86_64-unknown-linux-gnu.zip", nil
	case "arm64":
		return "rathole-aarch64-unknown-linux-musl.zip", nil
	default:
		return "", fmt.Errorf("unsupported architecture for rathole: %s", goarch)
	}
}

type ratholeDriver struct {
	baseDriver
	binPath    string
	configPath string
}

func newRatholeDriver(spec Spec) (Driver, error) {
	base, err := newBaseDriver(spec)
	if err != nil {
		return nil, err
	}
	return &ratholeDriver{
		baseDriver: base,
		binPath:    filepath.Join(binariesDir("rathole"), ratholeBinaryName),
		configPath: filepath.Join(base.tunnelDir, "config.toml"),
	}, nil
}

func (d *ratholeDriver) Install(ctx context.Context) error {
	if binaryRunsOK(ctx, d.binPath, "--help") {
		return nil
	}
	asset, err := ratholeArchAsset(runtime.GOARCH)
	if err != nil {
		return err
	}
	binDir := binariesDir("rathole")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("creating rathole binary directory: %w", err)
	}
	url := fmt.Sprintf("https://github.com/%s/releases/latest/download/%s", ratholeRepo, asset)
	if err := downloadAndExtractZip(ctx, url, "rathole", binDir); err != nil {
		return fmt.Errorf("downloading rathole: %w", err)
	}
	extracted := filepath.Join(binDir, "rathole")
	if extracted != d.binPath {
		if err := os.Rename(extracted, d.binPath); err != nil {
			return fmt.Errorf("installing rathole binary: %w", err)
		}
	}
	if !binaryRunsOK(ctx, d.binPath, "--help") {
		return fmt.Errorf("rathole binary failed a basic sanity check (--help) after install")
	}
	return nil
}

func (d *ratholeDriver) WriteConfig() error {
	if err := os.MkdirAll(d.tunnelDir, 0o700); err != nil {
		return fmt.Errorf("creating tunnel directory: %w", err)
	}
	section := "client"
	if d.spec.Role == RoleServer {
		section = "server"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "[%s]\n", section)
	if d.spec.Role == RoleServer {
		fmt.Fprintf(&b, "bind_addr = \":%d\"\n", d.spec.Port)
	} else {
		fmt.Fprintf(&b, "remote_addr = %q\n", d.spec.Peer)
	}
	fmt.Fprintf(&b, "default_token = %q\n", d.spec.Secret)

	for _, p := range d.spec.Ports {
		fmt.Fprintf(&b, "\n[%s.services.svc%d]\n", section, p.Remote)
		if d.spec.Role == RoleServer {
			fmt.Fprintf(&b, "bind_addr = \"0.0.0.0:%d\"\n", p.Remote)
		} else {
			fmt.Fprintf(&b, "local_addr = \"127.0.0.1:%d\"\n", p.Remote)
		}
	}

	if err := os.WriteFile(d.configPath, []byte(b.String()), 0o600); err != nil {
		return fmt.Errorf("writing rathole config: %w", err)
	}
	return nil
}

func (d *ratholeDriver) CreateService() error {
	flag := "-c"
	if d.spec.Role == RoleServer {
		flag = "-s"
	}
	return d.writeUnitAndEnable(
		fmt.Sprintf("tunnel-agent Rathole tunnel %s", d.spec.ID),
		fmt.Sprintf("%s %s %s", d.binPath, flag, d.configPath),
	)
}

func (d *ratholeDriver) ConfigureFirewall() error {
	if d.spec.Role != RoleServer {
		return nil
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

func (d *ratholeDriver) Health(ctx context.Context) (Health, error) {
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

func (d *ratholeDriver) Remove(ctx context.Context) error {
	if d.spec.Role == RoleServer {
		removeFirewallPort(ctx, d.spec.Port, "tcp")
		for _, p := range d.spec.Ports {
			removeFirewallPort(ctx, p.Remote, "tcp")
		}
	}
	return d.removeServiceAndDir(ctx)
}
