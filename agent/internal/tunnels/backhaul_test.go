package tunnels

import (
	"os"
	"strings"
	"testing"
)

// Only WriteConfig is unit-tested here: Install/CreateService/
// ConfigureFirewall/Start/Stop/Restart/Health/Logs/Remove all shell out to a
// real network download, systemctl, or ufw/iptables, none of which are
// available in this sandboxed test environment (see the plan's stated
// verification limits) or appropriate for a fast unit test even where they
// are. WriteConfig is pure file I/O and is the part most likely to
// regress silently, so it's the part worth pinning down here.

func TestBackhaulArchSuffix(t *testing.T) {
	cases := map[string]bool{"amd64": true, "arm64": true, "386": false, "mips": false}
	for arch, wantOK := range cases {
		_, err := backhaulArchSuffixFor(arch)
		gotOK := err == nil
		if gotOK != wantOK {
			t.Errorf("backhaulArchSuffixFor(%q): got ok=%v, want ok=%v (err=%v)", arch, gotOK, wantOK, err)
		}
	}
}

func TestBackhaulWriteConfigServerRole(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	spec := Spec{
		ID:     "iran-germany",
		Role:   RoleServer,
		Port:   443,
		Secret: "s3cret-token",
		Ports:  []PortMapping{{Remote: 8080, Local: 8080}, {Remote: 2222, Local: 22}},
	}
	driver, err := newBackhaulDriver(spec)
	if err != nil {
		t.Fatalf("newBackhaulDriver: %v", err)
	}
	bd := driver.(*backhaulDriver)
	if err := bd.WriteConfig(); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}

	data, err := os.ReadFile(bd.configPath)
	if err != nil {
		t.Fatalf("reading generated config: %v", err)
	}
	config := string(data)

	for _, want := range []string{
		`[listener]`,
		`bind_addr = ":443"`,
		`token = "s3cret-token"`,
		`"8080=8080"`,
		`"2222=22"`,
		`[ports]`,
	} {
		if !strings.Contains(config, want) {
			t.Errorf("expected generated config to contain %q, got:\n%s", want, config)
		}
	}
	if strings.Contains(config, "[dialer]") {
		t.Errorf("server-role config should not contain a [dialer] section, got:\n%s", config)
	}
}

func TestBackhaulWriteConfigClientRole(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	spec := Spec{
		ID:     "germany-side",
		Role:   RoleClient,
		Peer:   "1.2.3.4:443",
		Secret: "s3cret-token",
	}
	driver, err := newBackhaulDriver(spec)
	if err != nil {
		t.Fatalf("newBackhaulDriver: %v", err)
	}
	bd := driver.(*backhaulDriver)
	if err := bd.WriteConfig(); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}

	data, err := os.ReadFile(bd.configPath)
	if err != nil {
		t.Fatalf("reading generated config: %v", err)
	}
	config := string(data)

	for _, want := range []string{
		`[dialer]`,
		`remote_addr = "1.2.3.4:443"`,
		`token = "s3cret-token"`,
	} {
		if !strings.Contains(config, want) {
			t.Errorf("expected generated config to contain %q, got:\n%s", want, config)
		}
	}
	if strings.Contains(config, "[listener]") || strings.Contains(config, "[ports]") {
		t.Errorf("client-role config should not contain [listener]/[ports] sections, got:\n%s", config)
	}
}

func TestNewBackhaulDriverRejectsInvalidSpec(t *testing.T) {
	if _, err := newBackhaulDriver(Spec{ID: "../escape", Role: RoleServer, Port: 443, Secret: "s"}); err == nil {
		t.Error("expected an invalid spec to be rejected at construction time")
	}
}
