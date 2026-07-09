package tunnels

import (
	"context"
	"os"
	"path/filepath"
)

// baseDriver holds the fields and behavior identical across every core's
// Driver implementation -- Start/Stop/Restart/Logs are pure systemctl/
// journalctl calls against a unit name, with no core-specific variation.
// Each core embeds this and only implements what actually differs: Install,
// WriteConfig, CreateService, ConfigureFirewall, Health, Remove.
type baseDriver struct {
	spec        Spec
	tunnelDir   string
	serviceName string
	servicePath string
}

// newBaseDriver validates spec and derives the paths/names shared by every
// core: the tunnel's own working directory and its systemd unit, always
// prefixed "tunnel-agent-" so it can never collide with anything
// tunnel-manager.sh has configured on the same box.
func newBaseDriver(spec Spec) (baseDriver, error) {
	if err := spec.Validate(); err != nil {
		return baseDriver{}, err
	}
	tunnelDir, err := SafeJoin(filepath.Join(dataDir, "tunnels"), spec.ID)
	if err != nil {
		return baseDriver{}, err
	}
	serviceName := "tunnel-agent-" + spec.ID + ".service"
	return baseDriver{
		spec:        spec,
		tunnelDir:   tunnelDir,
		serviceName: serviceName,
		servicePath: filepath.Join(systemdUnitDir, serviceName),
	}, nil
}

func (b baseDriver) Start(ctx context.Context) error {
	_, err := systemctl(ctx, "start", b.serviceName)
	return err
}

func (b baseDriver) Stop(ctx context.Context) error {
	_, err := systemctl(ctx, "stop", b.serviceName)
	return err
}

func (b baseDriver) Restart(ctx context.Context) error {
	_, err := systemctl(ctx, "restart", b.serviceName)
	return err
}

func (b baseDriver) Logs(ctx context.Context, lines int) ([]string, error) {
	return JournalctlLogs(ctx, b.serviceName, lines)
}

// writeUnitAndEnable is the create-service tail every core shares once it
// has its own ExecStart line: write the unit, reload, enable -- but not
// start, which stays a separate, explicit Start() call.
func (b baseDriver) writeUnitAndEnable(description, execStart string) error {
	unit := renderSystemdUnit(unitSpec{Description: description, ExecStart: execStart})
	if err := os.WriteFile(b.servicePath, []byte(unit), 0o644); err != nil {
		return err
	}
	if _, err := systemctl(context.Background(), "daemon-reload"); err != nil {
		return err
	}
	_, err := systemctl(context.Background(), "enable", b.serviceName)
	return err
}

// removeServiceAndDir is the remove-tail every core shares: disable+stop
// the unit, delete it, reload, delete the tunnel's own directory. Firewall
// cleanup is core-specific (different ports/protocols) and stays in each
// driver's own Remove.
func (b baseDriver) removeServiceAndDir(ctx context.Context) error {
	_, _ = systemctl(ctx, "disable", "--now", b.serviceName)
	_ = os.Remove(b.servicePath)
	_, _ = systemctl(ctx, "daemon-reload")
	return os.RemoveAll(b.tunnelDir)
}
