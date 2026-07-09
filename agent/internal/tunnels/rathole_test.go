package tunnels

import (
	"os"
	"strings"
	"testing"
)

func TestRatholeArchAsset(t *testing.T) {
	cases := map[string]bool{"amd64": true, "arm64": true, "riscv64": false}
	for arch, wantOK := range cases {
		_, err := ratholeArchAsset(arch)
		if gotOK := err == nil; gotOK != wantOK {
			t.Errorf("ratholeArchAsset(%q): got ok=%v, want ok=%v (err=%v)", arch, gotOK, wantOK, err)
		}
	}
}

func TestRatholeWriteConfigServerRole(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	spec := Spec{
		ID:     "iran-germany-rathole",
		Role:   RoleServer,
		Port:   2333,
		Secret: "shared-token",
		Ports:  []PortMapping{{Remote: 8080, Local: 8080}},
	}
	driver, err := newRatholeDriver(spec)
	if err != nil {
		t.Fatalf("newRatholeDriver: %v", err)
	}
	rd := driver.(*ratholeDriver)
	if err := rd.WriteConfig(); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}
	data, err := os.ReadFile(rd.configPath)
	if err != nil {
		t.Fatalf("reading generated config: %v", err)
	}
	config := string(data)
	for _, want := range []string{
		`[server]`,
		`bind_addr = ":2333"`,
		`default_token = "shared-token"`,
		`[server.services.svc8080]`,
		`bind_addr = "0.0.0.0:8080"`,
	} {
		if !strings.Contains(config, want) {
			t.Errorf("expected config to contain %q, got:\n%s", want, config)
		}
	}
	if strings.Contains(config, "[client]") {
		t.Errorf("server-role config should not contain [client], got:\n%s", config)
	}
}

func TestRatholeWriteConfigClientRole(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	spec := Spec{
		ID:     "germany-side-rathole",
		Role:   RoleClient,
		Peer:   "1.2.3.4:2333",
		Secret: "shared-token",
	}
	driver, err := newRatholeDriver(spec)
	if err != nil {
		t.Fatalf("newRatholeDriver: %v", err)
	}
	rd := driver.(*ratholeDriver)
	if err := rd.WriteConfig(); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}
	data, err := os.ReadFile(rd.configPath)
	if err != nil {
		t.Fatalf("reading generated config: %v", err)
	}
	config := string(data)
	for _, want := range []string{`[client]`, `remote_addr = "1.2.3.4:2333"`, `default_token = "shared-token"`} {
		if !strings.Contains(config, want) {
			t.Errorf("expected config to contain %q, got:\n%s", want, config)
		}
	}
}
