package tunnels

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGostArchAsset(t *testing.T) {
	cases := map[string]bool{"amd64": true, "arm64": true, "arm": false}
	for arch, wantOK := range cases {
		_, err := gostArchAsset(arch)
		if gotOK := err == nil; gotOK != wantOK {
			t.Errorf("gostArchAsset(%q): got ok=%v, want ok=%v (err=%v)", arch, gotOK, wantOK, err)
		}
	}
}

func TestGostWriteConfigServerRole(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	spec := Spec{ID: "germany-side-gost", Role: RoleServer, Port: 9000, Secret: "unused-by-gost"}
	driver, err := newGostDriver(spec)
	if err != nil {
		t.Fatalf("newGostDriver: %v", err)
	}
	gd := driver.(*gostDriver)
	if err := gd.WriteConfig(); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(gd.servicesDir, gd.fragmentName))
	if err != nil {
		t.Fatalf("reading service fragment: %v", err)
	}
	fragment := string(data)
	for _, want := range []string{`addr: "0.0.0.0:9000"`, "type: relay", `addr: "127.0.0.1:9000"`} {
		if !strings.Contains(fragment, want) {
			t.Errorf("expected service fragment to contain %q, got:\n%s", want, fragment)
		}
	}

	if _, err := os.Stat(filepath.Join(gd.chainsDir, gd.fragmentName)); err == nil {
		t.Error("server-role should not write a chain fragment")
	}
}

func TestGostWriteConfigClientRole(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	spec := Spec{
		ID:     "iran-side-gost",
		Role:   RoleClient,
		Peer:   "5.6.7.8:9000",
		Secret: "unused-by-gost",
		Ports:  []PortMapping{{Remote: 9000, Local: 443}},
	}
	driver, err := newGostDriver(spec)
	if err != nil {
		t.Fatalf("newGostDriver: %v", err)
	}
	gd := driver.(*gostDriver)
	if err := gd.WriteConfig(); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}

	svcData, err := os.ReadFile(filepath.Join(gd.servicesDir, gd.fragmentName))
	if err != nil {
		t.Fatalf("reading service fragment: %v", err)
	}
	svc := string(svcData)
	for _, want := range []string{`addr: "0.0.0.0:443"`, "chain:"} {
		if !strings.Contains(svc, want) {
			t.Errorf("expected service fragment to contain %q, got:\n%s", want, svc)
		}
	}

	chainData, err := os.ReadFile(filepath.Join(gd.chainsDir, gd.fragmentName))
	if err != nil {
		t.Fatalf("reading chain fragment: %v", err)
	}
	chain := string(chainData)
	for _, want := range []string{`addr: "5.6.7.8:9000"`, `type: "tcp"`} {
		if !strings.Contains(chain, want) {
			t.Errorf("expected chain fragment to contain %q, got:\n%s", want, chain)
		}
	}
}

func TestGostRebuildConfigConcatenatesFragmentsAndSkipsDisabled(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	spec := Spec{ID: "t1", Role: RoleServer, Port: 1000, Secret: "s"}
	driver, err := newGostDriver(spec)
	if err != nil {
		t.Fatalf("newGostDriver: %v", err)
	}
	gd := driver.(*gostDriver)
	if err := gd.WriteConfig(); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}

	// A second tunnel's disabled fragment sitting alongside it must not be
	// concatenated into the rebuilt config.
	if err := os.WriteFile(filepath.Join(gd.servicesDir, "t2.yaml.disabled"), []byte("- name: t2-should-not-appear\n"), 0o600); err != nil {
		t.Fatalf("writing fixture: %v", err)
	}

	if err := gd.rebuildConfig(); err != nil {
		t.Fatalf("rebuildConfig: %v", err)
	}
	data, err := os.ReadFile(gd.configPath)
	if err != nil {
		t.Fatalf("reading rebuilt config: %v", err)
	}
	config := string(data)
	if !strings.Contains(config, "services:") || !strings.Contains(config, "chains:") {
		t.Errorf("expected top-level services:/chains: keys, got:\n%s", config)
	}
	if !strings.Contains(config, "0.0.0.0:1000") {
		t.Errorf("expected the enabled fragment's content in the rebuilt config, got:\n%s", config)
	}
	if strings.Contains(config, "t2-should-not-appear") {
		t.Errorf("disabled fragment must not be included in the rebuilt config, got:\n%s", config)
	}
}

func TestGostEnableDisableFragment(t *testing.T) {
	SetDataDir(t.TempDir())
	defer SetDataDir("/etc/tunnel-agent")

	spec := Spec{ID: "t1", Role: RoleServer, Port: 1000, Secret: "s"}
	driver, err := newGostDriver(spec)
	if err != nil {
		t.Fatalf("newGostDriver: %v", err)
	}
	gd := driver.(*gostDriver)
	if err := gd.WriteConfig(); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}

	enabledPath := filepath.Join(gd.servicesDir, gd.fragmentName)
	disabledPath := enabledPath + ".disabled"

	if err := gd.disableFragment(); err != nil {
		t.Fatalf("disableFragment: %v", err)
	}
	if _, err := os.Stat(enabledPath); err == nil {
		t.Error("expected the fragment to be renamed away after disableFragment")
	}
	if _, err := os.Stat(disabledPath); err != nil {
		t.Error("expected a .disabled fragment to exist after disableFragment")
	}

	if err := gd.enableFragment(); err != nil {
		t.Fatalf("enableFragment: %v", err)
	}
	if _, err := os.Stat(enabledPath); err != nil {
		t.Error("expected the fragment to be restored after enableFragment")
	}
	if _, err := os.Stat(disabledPath); err == nil {
		t.Error("expected the .disabled fragment to be gone after enableFragment")
	}
}
