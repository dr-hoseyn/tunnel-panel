package tunnels

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// GOST driver. Deliberately shaped differently from every other core here,
// mirroring ha-tunnel-manager's own core/gost/core.sh (read-only reference,
// see that file's own header comment for why): GOST's native model is ONE
// process loading ONE config built from many independent named services/
// chains, not "one config = one service = one tunnel" the way Backhaul/
// Rathole/Hysteria2 are. So here: one shared gost.service + gost.yaml per
// agent, assembled from small per-tunnel YAML fragments under services.d/
// and chains.d/ (core_gost_rebuild_config's concatenation approach,
// reimplemented natively) -- a GOST *tunnel* is a fragment, not a unit.
// Start/Stop only enable/disable this tunnel's own fragment and restart the
// shared daemon to pick it up; Health/Logs necessarily reflect the shared
// daemon's process state, not this tunnel in isolation -- documented in
// Health's own Detail field rather than pretending otherwise.
//
// Scope note: only a plain two-hop TCP relay chain is implemented (handler/
// listener type "relay", one hop per forwarded port), not GOST's full
// protocol/transport/selector matrix (core/gost/core.sh's
// GOST_HANDLER_TYPES/GOST_TRANSPORT_TYPES) -- the same "common production
// path, not every knob" scoping used for the other three drivers. GOST's
// relay protocol has no pre-shared-secret concept the way Backhaul/Rathole
// do; Spec.Secret is still required for a consistent cross-core creation
// contract but unused by this driver.
func init() {
	Register("gost", newGostDriver)
}

const (
	gostBinaryName  = "gost_bin"
	gostRepo        = "go-gost/gost"
	gostServiceName = "tunnel-agent-gost.service"
)

func gostArchAsset(goarch string) (string, error) {
	switch goarch {
	case "amd64":
		return "linux_amd64", nil
	case "arm64":
		return "linux_arm64", nil
	default:
		return "", fmt.Errorf("unsupported architecture for gost: %s", goarch)
	}
}

type gostDriver struct {
	spec        Spec
	dir         string
	binPath     string
	configPath  string
	servicesDir string
	chainsDir   string
	servicePath string
	// fragmentName is this tunnel's own <id>.yaml basename, shared between
	// services.d and chains.d.
	fragmentName string
}

func newGostDriver(spec Spec) (Driver, error) {
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	dir := filepath.Join(dataDir, "gost")
	return &gostDriver{
		spec:         spec,
		dir:          dir,
		binPath:      filepath.Join(dir, gostBinaryName),
		configPath:   filepath.Join(dir, "gost.yaml"),
		servicesDir:  filepath.Join(dir, "services.d"),
		chainsDir:    filepath.Join(dir, "chains.d"),
		servicePath:  filepath.Join(systemdUnitDir, gostServiceName),
		fragmentName: spec.ID + ".yaml",
	}, nil
}

// portMappings returns the effective set of forwarded ports: spec.Ports if
// given, otherwise a single Remote=Local=spec.Port mapping so the simple
// single-port wizard case works without a separate Ports array.
func (d *gostDriver) portMappings() []PortMapping {
	if len(d.spec.Ports) > 0 {
		return d.spec.Ports
	}
	return []PortMapping{{Remote: d.spec.Port, Local: d.spec.Port}}
}

func (d *gostDriver) Install(ctx context.Context) error {
	if binaryRunsOK(ctx, d.binPath, "-V") {
		return nil
	}
	asset, err := gostArchAsset(runtime.GOARCH)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d.dir, 0o755); err != nil {
		return fmt.Errorf("creating gost directory: %w", err)
	}
	tag, err := latestGitHubReleaseTag(ctx, gostRepo)
	if err != nil {
		return fmt.Errorf("finding latest gost release: %w", err)
	}
	version := strings.TrimPrefix(tag, "v")
	url := fmt.Sprintf("https://github.com/%s/releases/download/%s/gost_%s_%s.tar.gz", gostRepo, tag, version, asset)
	if err := downloadAndExtractTarGz(ctx, url, "gost", d.dir); err != nil {
		return fmt.Errorf("downloading gost: %w", err)
	}
	extracted := filepath.Join(d.dir, "gost")
	if extracted != d.binPath {
		if err := os.Rename(extracted, d.binPath); err != nil {
			return fmt.Errorf("installing gost binary: %w", err)
		}
	}
	if !binaryRunsOK(ctx, d.binPath, "-V") {
		return fmt.Errorf("gost binary failed a basic sanity check (-V) after install")
	}
	return nil
}

func (d *gostDriver) WriteConfig() error {
	if err := os.MkdirAll(d.servicesDir, 0o755); err != nil {
		return fmt.Errorf("creating gost services directory: %w", err)
	}
	if err := os.MkdirAll(d.chainsDir, 0o755); err != nil {
		return fmt.Errorf("creating gost chains directory: %w", err)
	}

	mappings := d.portMappings()
	var services strings.Builder

	if d.spec.Role == RoleServer {
		// Terminal hop: listen on the exit-facing port, forward straight to
		// the real target on this box's loopback. No chain -- this is the
		// destination the client role's chain hop dials into.
		for i, p := range mappings {
			fmt.Fprintf(&services, "- name: %s-%d\n", d.spec.ID, i)
			fmt.Fprintf(&services, "  addr: \"0.0.0.0:%d\"\n", p.Remote)
			services.WriteString("  handler:\n    type: relay\n")
			services.WriteString("  listener:\n    type: relay\n")
			services.WriteString("  forwarder:\n    nodes:\n")
			fmt.Fprintf(&services, "    - name: %s-%d-target\n", d.spec.ID, i)
			fmt.Fprintf(&services, "      addr: \"127.0.0.1:%d\"\n", p.Local)
		}
		if err := os.WriteFile(filepath.Join(d.servicesDir, d.fragmentName), []byte(services.String()), 0o600); err != nil {
			return fmt.Errorf("writing gost service fragment: %w", err)
		}
		_ = os.Remove(filepath.Join(d.chainsDir, d.fragmentName)) // server role never has a chain of its own
		return nil
	}

	// Client role: listen on the public-facing local port, relay through a
	// chain hop that dials the destination's matching Remote port.
	peerHost, _, err := net.SplitHostPort(d.spec.Peer)
	if err != nil {
		return fmt.Errorf("invalid peer address: %w", err)
	}
	transport := d.spec.Extra["transport"]
	if transport == "" {
		transport = "tcp"
	}

	var chains strings.Builder
	for i, p := range mappings {
		chainName := fmt.Sprintf("%s-chain-%d", d.spec.ID, i)

		fmt.Fprintf(&services, "- name: %s-%d\n", d.spec.ID, i)
		fmt.Fprintf(&services, "  addr: \"0.0.0.0:%d\"\n", p.Local)
		services.WriteString("  handler:\n    type: relay\n")
		fmt.Fprintf(&services, "    chain: %s\n", chainName)
		services.WriteString("  listener:\n    type: relay\n")

		fmt.Fprintf(&chains, "- name: %s\n", chainName)
		chains.WriteString("  hops:\n")
		fmt.Fprintf(&chains, "  - name: %s-hop0\n", chainName)
		chains.WriteString("    nodes:\n")
		fmt.Fprintf(&chains, "    - name: %s-hop0-node0\n", chainName)
		fmt.Fprintf(&chains, "      addr: \"%s:%d\"\n", peerHost, p.Remote)
		// %q, not %s: transport comes from Extra["transport"] (a
		// create-tunnel request field), and this is the same "structural
		// quoting is the real guard, charset validation is defense in
		// depth" reasoning as hysteria2.go's WriteConfig.
		fmt.Fprintf(&chains, "      connector:\n        type: %q\n", transport)
		fmt.Fprintf(&chains, "      dialer:\n        type: %q\n", transport)
	}

	if err := os.WriteFile(filepath.Join(d.servicesDir, d.fragmentName), []byte(services.String()), 0o600); err != nil {
		return fmt.Errorf("writing gost service fragment: %w", err)
	}
	if err := os.WriteFile(filepath.Join(d.chainsDir, d.fragmentName), []byte(chains.String()), 0o600); err != nil {
		return fmt.Errorf("writing gost chain fragment: %w", err)
	}
	return nil
}

func (d *gostDriver) CreateService() error {
	if _, err := os.Stat(d.servicePath); err == nil {
		return nil // shared daemon unit already exists from an earlier GOST tunnel on this agent
	}
	unit := renderSystemdUnit(unitSpec{
		Description: "tunnel-agent GOST relay daemon",
		ExecStart:   fmt.Sprintf("%s -C %s", d.binPath, d.configPath),
	})
	if err := os.WriteFile(d.servicePath, []byte(unit), 0o644); err != nil {
		return fmt.Errorf("writing gost systemd unit: %w", err)
	}
	if _, err := systemctl(context.Background(), "daemon-reload"); err != nil {
		return err
	}
	_, err := systemctl(context.Background(), "enable", gostServiceName)
	return err
}

func (d *gostDriver) ConfigureFirewall() error {
	ctx := context.Background()
	for _, p := range d.portMappings() {
		port := p.Remote
		if d.spec.Role == RoleClient {
			port = p.Local
		}
		if err := allowFirewallPort(ctx, port, "tcp"); err != nil {
			return err
		}
	}
	return nil
}

func (d *gostDriver) rebuildConfig() error {
	var b strings.Builder
	b.WriteString("services:\n")
	if err := appendYAMLFragments(&b, d.servicesDir); err != nil {
		return err
	}
	b.WriteString("chains:\n")
	if err := appendYAMLFragments(&b, d.chainsDir); err != nil {
		return err
	}
	return os.WriteFile(d.configPath, []byte(b.String()), 0o600)
}

func appendYAMLFragments(b *strings.Builder, dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue // skips *.yaml.disabled too -- exactly the point
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return err
		}
		b.Write(data)
	}
	return nil
}

func (d *gostDriver) enableFragment() error {
	if err := renameIfExists(filepath.Join(d.servicesDir, d.fragmentName+".disabled"), filepath.Join(d.servicesDir, d.fragmentName)); err != nil {
		return err
	}
	return renameIfExists(filepath.Join(d.chainsDir, d.fragmentName+".disabled"), filepath.Join(d.chainsDir, d.fragmentName))
}

func (d *gostDriver) disableFragment() error {
	if err := renameIfExists(filepath.Join(d.servicesDir, d.fragmentName), filepath.Join(d.servicesDir, d.fragmentName+".disabled")); err != nil {
		return err
	}
	return renameIfExists(filepath.Join(d.chainsDir, d.fragmentName), filepath.Join(d.chainsDir, d.fragmentName+".disabled"))
}

func renameIfExists(oldPath, newPath string) error {
	if _, err := os.Stat(oldPath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return os.Rename(oldPath, newPath)
}

func (d *gostDriver) Start(ctx context.Context) error {
	if err := d.enableFragment(); err != nil {
		return err
	}
	if err := d.rebuildConfig(); err != nil {
		return err
	}
	_, err := systemctl(ctx, "restart", gostServiceName)
	return err
}

func (d *gostDriver) Stop(ctx context.Context) error {
	if err := d.disableFragment(); err != nil {
		return err
	}
	if err := d.rebuildConfig(); err != nil {
		return err
	}
	_, err := systemctl(ctx, "restart", gostServiceName)
	return err
}

func (d *gostDriver) Restart(ctx context.Context) error {
	if err := d.rebuildConfig(); err != nil {
		return err
	}
	_, err := systemctl(ctx, "restart", gostServiceName)
	return err
}

func (d *gostDriver) Health(ctx context.Context) (Health, error) {
	h := Health{Process: "stopped"}
	if systemctlIsActive(ctx, gostServiceName) {
		h.Process = "running"
	}
	mappings := d.portMappings()
	checkPort := 0
	if len(mappings) > 0 {
		checkPort = mappings[0].Remote
		if d.spec.Role == RoleClient {
			checkPort = mappings[0].Local
		}
		h.PortOpen = portOpen(checkPort)
	}
	h.RxBytes, h.TxBytes = systemctlIPBytes(ctx, gostServiceName)
	h.Traffic = h.RxBytes > 0 || h.TxBytes > 0
	// NRestarts/CPU/RAM below are for the shared gost.service, same caveat
	// as the traffic figures -- not this tunnel alone.
	mergeRuntimeStats(&h, runtimeStats(ctx, gostServiceName, checkPort))
	switch {
	case h.Process != "running":
		h.Detail = "the shared gost.service is not active (affects every GOST tunnel on this agent, not just this one)"
	case !h.PortOpen:
		h.Detail = "the shared daemon is running but this tunnel's port is not accepting connections -- it may be stopped"
	default:
		h.Detail = "traffic figures are for the whole shared GOST daemon, not this tunnel alone"
	}
	return h, nil
}

func (d *gostDriver) Logs(ctx context.Context, lines int) ([]string, error) {
	// Necessarily every GOST tunnel's log lines interleaved -- there is one
	// shared process, and therefore one shared journal stream.
	return journalctlLogs(ctx, gostServiceName, lines)
}

func (d *gostDriver) Remove(ctx context.Context) error {
	_ = os.Remove(filepath.Join(d.servicesDir, d.fragmentName))
	_ = os.Remove(filepath.Join(d.servicesDir, d.fragmentName+".disabled"))
	_ = os.Remove(filepath.Join(d.chainsDir, d.fragmentName))
	_ = os.Remove(filepath.Join(d.chainsDir, d.fragmentName+".disabled"))

	if err := d.rebuildConfig(); err != nil {
		return err
	}
	if systemctlIsActive(ctx, gostServiceName) {
		if _, err := systemctl(ctx, "restart", gostServiceName); err != nil {
			return err
		}
	}

	for _, p := range d.portMappings() {
		port := p.Remote
		if d.spec.Role == RoleClient {
			port = p.Local
		}
		removeFirewallPort(ctx, port, "tcp")
	}
	return nil
}
