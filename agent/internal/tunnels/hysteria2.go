package tunnels

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/tlscert"
)

// Hysteria2 driver. Ported from ha-tunnel-manager's core/hysteria2/core.sh
// (read-only reference):
//   - core_hysteria2_download_binary (:43) -- apernet/hysteria releases, raw binary asset
//   - core_hysteria2_generate_server_config/_generate_client_config (:203/:226) -- YAML shape
//   - core_hysteria2_create_service (:261) -- unit shape (server/client subcommand)
//
// Runs over QUIC/UDP, not TCP -- firewall and "is it listening" checks
// differ from every other core here accordingly (see ConfigureFirewall/
// Health). Per the bash source's own convention (core/README.md), the
// forwarded-port config lives on the *client* role, not the server role --
// the opposite of Backhaul/Rathole. The server needs a TLS certificate; a
// self-signed one is generated once and shared across every Hysteria2
// tunnel on this agent (reusing internal/tlscert, the same package the
// agent uses for its own HTTPS listener) -- same trust model the bash
// reference uses (a single shared cert_files/cert.crt), and clients always
// connect with `insecure: true` since there's no in-panel channel to move a
// server's cert fingerprint to a separate VPS's client config automatically.
func init() {
	Register("hysteria2", newHysteria2Driver)
}

const (
	hysteria2BinaryName    = "hysteria2_bin"
	hysteria2ReleaseURLFmt = "https://github.com/apernet/hysteria/releases/latest/download/%s"
)

func hysteria2ArchAsset(goarch string) (string, error) {
	switch goarch {
	case "amd64":
		return "hysteria-linux-amd64", nil
	case "arm64":
		return "hysteria-linux-arm64", nil
	default:
		return "", fmt.Errorf("unsupported architecture for hysteria2: %s", goarch)
	}
}

type hysteria2Driver struct {
	baseDriver
	binPath    string
	configPath string
	certPath   string
	keyPath    string
}

func newHysteria2Driver(spec Spec) (Driver, error) {
	base, err := newBaseDriver(spec)
	if err != nil {
		return nil, err
	}
	certDir := filepath.Join(dataDir, "certs", "hysteria2")
	return &hysteria2Driver{
		baseDriver: base,
		binPath:    filepath.Join(binariesDir("hysteria2"), hysteria2BinaryName),
		configPath: filepath.Join(base.tunnelDir, "config.yaml"),
		certPath:   filepath.Join(certDir, "cert.pem"),
		keyPath:    filepath.Join(certDir, "key.pem"),
	}, nil
}

func (d *hysteria2Driver) Install(ctx context.Context) error {
	if binaryRunsOK(ctx, d.binPath, "version") {
		return nil
	}
	asset, err := hysteria2ArchAsset(runtime.GOARCH)
	if err != nil {
		return err
	}
	binDir := binariesDir("hysteria2")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("creating hysteria2 binary directory: %w", err)
	}
	url := fmt.Sprintf(hysteria2ReleaseURLFmt, asset)
	if err := downloadBinary(ctx, url, binDir, hysteria2BinaryName); err != nil {
		return fmt.Errorf("downloading hysteria2: %w", err)
	}
	if !binaryRunsOK(ctx, d.binPath, "version") {
		return fmt.Errorf("hysteria2 binary failed a basic sanity check (version) after install")
	}
	return nil
}

func (d *hysteria2Driver) WriteConfig() error {
	if err := os.MkdirAll(d.tunnelDir, 0o700); err != nil {
		return fmt.Errorf("creating tunnel directory: %w", err)
	}
	obfsPassword := d.spec.Extra["obfs_password"]
	var b strings.Builder

	// Every interpolated string below uses %q (YAML double-quoted scalars use
	// the same backslash-escaping rules as Go string literals for the ASCII
	// control characters that matter here), not raw %s -- Extra map values
	// (sni, obfs_password) come from the create-tunnel request and are only
	// charset-validated at the Go boundary by ValidateYAMLSafe (see
	// validate.go); %q is the second, structural layer that guarantees a
	// value can never inject an extra YAML key/line no matter what gets
	// past that allowlist.
	if d.spec.Role == RoleServer {
		if _, err := tlscert.LoadOrGenerate(d.certPath, d.keyPath); err != nil {
			return fmt.Errorf("preparing TLS certificate: %w", err)
		}
		fmt.Fprintf(&b, "listen: :%d\n\n", d.spec.Port)
		b.WriteString("tls:\n")
		fmt.Fprintf(&b, "  cert: %q\n", d.certPath)
		fmt.Fprintf(&b, "  key: %q\n\n", d.keyPath)
		b.WriteString("auth:\n  type: password\n")
		fmt.Fprintf(&b, "  password: %q\n", d.spec.Secret)
	} else {
		fmt.Fprintf(&b, "server: %q\n\n", d.spec.Peer)
		fmt.Fprintf(&b, "auth: %q\n\n", d.spec.Secret)
		b.WriteString("tls:\n")
		if sni := d.spec.Extra["sni"]; sni != "" {
			fmt.Fprintf(&b, "  sni: %q\n", sni)
		}
		b.WriteString("  insecure: true\n")
	}

	if obfsPassword != "" {
		b.WriteString("\nobfs:\n  type: salamander\n  salamander:\n")
		fmt.Fprintf(&b, "    password: %q\n", obfsPassword)
	}

	if d.spec.Role == RoleClient && len(d.spec.Ports) > 0 {
		b.WriteString("\ntcpForwarding:\n")
		for _, p := range d.spec.Ports {
			fmt.Fprintf(&b, "  - listen: 0.0.0.0:%d\n", p.Local)
			fmt.Fprintf(&b, "    remote: 127.0.0.1:%d\n", p.Remote)
		}
	}

	if err := os.WriteFile(d.configPath, []byte(b.String()), 0o600); err != nil {
		return fmt.Errorf("writing hysteria2 config: %w", err)
	}
	return nil
}

func (d *hysteria2Driver) CreateService() error {
	subCmd := "client"
	if d.spec.Role == RoleServer {
		subCmd = "server"
	}
	return d.writeUnitAndEnable(
		fmt.Sprintf("tunnel-agent Hysteria2 tunnel %s", d.spec.ID),
		fmt.Sprintf("%s %s -c %s", d.binPath, subCmd, d.configPath),
	)
}

func (d *hysteria2Driver) ConfigureFirewall() error {
	if d.spec.Role != RoleServer {
		return nil
	}
	return allowFirewallPort(context.Background(), d.spec.Port, "udp")
}

func (d *hysteria2Driver) Health(ctx context.Context) (Health, error) {
	h := Health{Process: "stopped"}
	if systemctlIsActive(ctx, d.serviceName) {
		h.Process = "running"
	}
	if d.spec.Role == RoleServer {
		h.PortOpen = udpPortInUse(d.spec.Port)
	} else {
		h.PortOpen = h.Process == "running"
	}
	h.RxBytes, h.TxBytes = systemctlIPBytes(ctx, d.serviceName)
	h.Traffic = h.RxBytes > 0 || h.TxBytes > 0
	// UDP has no TCP handshake to dial/count, so latency/connections stay
	// unset here (tcpPort=0) -- reconnects and CPU/RAM are still real and
	// protocol-independent.
	mergeRuntimeStats(&h, runtimeStats(ctx, d.serviceName, 0))
	switch {
	case h.Process != "running":
		h.Detail = "systemd unit is not active"
	case d.spec.Role == RoleServer && !h.PortOpen:
		h.Detail = "process is running but its UDP listen port is not bound"
	}
	return h, nil
}

func (d *hysteria2Driver) Remove(ctx context.Context) error {
	if d.spec.Role == RoleServer {
		removeFirewallPort(ctx, d.spec.Port, "udp")
	}
	// The TLS cert under certs/hysteria2/ is shared across every Hysteria2
	// tunnel on this agent (see the package doc comment) -- deliberately
	// not removed here, only this tunnel's own config/service.
	return d.removeServiceAndDir(ctx)
}
