package tunnels

import "testing"

func TestValidateTunnelID(t *testing.T) {
	valid := []string{"a", "iran-germany-1", "9tunnel", "backhaul-abc123"}
	for _, id := range valid {
		if err := ValidateTunnelID(id); err != nil {
			t.Errorf("expected %q to be valid, got error: %v", id, err)
		}
	}

	invalid := []string{
		"",
		"-leading-dash",
		"Uppercase",
		"has space",
		"has/slash",
		"has.dot",
		"has_underscore",
		"../traversal",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 49 chars, one over the limit
	}
	for _, id := range invalid {
		if err := ValidateTunnelID(id); err == nil {
			t.Errorf("expected %q to be invalid, got no error", id)
		}
	}
}

func TestValidatePort(t *testing.T) {
	for _, p := range []int{1, 22, 443, 8443, 65535} {
		if err := ValidatePort(p); err != nil {
			t.Errorf("expected port %d to be valid, got %v", p, err)
		}
	}
	for _, p := range []int{0, -1, 65536, 100000} {
		if err := ValidatePort(p); err == nil {
			t.Errorf("expected port %d to be invalid, got no error", p)
		}
	}
}

func TestValidateHostname(t *testing.T) {
	valid := []string{"example.com", "sub.example.com", "1.2.3.4", "::1", "localhost"}
	for _, h := range valid {
		if err := ValidateHostname(h); err != nil {
			t.Errorf("expected %q to be valid, got %v", h, err)
		}
	}
	invalid := []string{"", "has space.com", "has/slash.com", "-leading-dash.com"}
	for _, h := range invalid {
		if err := ValidateHostname(h); err == nil {
			t.Errorf("expected %q to be invalid, got no error", h)
		}
	}
}

func TestValidatePeerAddr(t *testing.T) {
	valid := []string{"1.2.3.4:443", "example.com:8443"}
	for _, a := range valid {
		if err := ValidatePeerAddr(a); err != nil {
			t.Errorf("expected %q to be valid, got %v", a, err)
		}
	}
	invalid := []string{"1.2.3.4", "1.2.3.4:", "1.2.3.4:not-a-port", "1.2.3.4:99999"}
	for _, a := range invalid {
		if err := ValidatePeerAddr(a); err == nil {
			t.Errorf("expected %q to be invalid, got no error", a)
		}
	}
}

func TestValidateFilename(t *testing.T) {
	valid := []string{"config.toml", "meta.json", "a", "backup-2026-07-09.json"}
	for _, f := range valid {
		if err := ValidateFilename(f); err != nil {
			t.Errorf("expected %q to be valid, got %v", f, err)
		}
	}
	invalid := []string{"", ".", "..", "../etc/passwd", "a/b", `a\b`}
	for _, f := range invalid {
		if err := ValidateFilename(f); err == nil {
			t.Errorf("expected %q to be invalid, got no error", f)
		}
	}
}

func TestSafeJoin(t *testing.T) {
	if _, err := SafeJoin("/data/tunnels", "my-tunnel"); err != nil {
		t.Errorf("expected a normal join to succeed, got %v", err)
	}
	if _, err := SafeJoin("/data/tunnels", "../../etc/passwd"); err == nil {
		t.Error("expected a traversal attempt to be rejected, got no error")
	}
	if _, err := SafeJoin("/data/tunnels", ".."); err == nil {
		t.Error("expected joining '..' to be rejected, got no error")
	}
}

func TestSpecValidate(t *testing.T) {
	base := Spec{ID: "tunnel1", Secret: "s3cret"}

	server := base
	server.Role = RoleServer
	server.Port = 443
	if err := server.Validate(); err != nil {
		t.Errorf("expected a valid server spec to pass, got %v", err)
	}

	client := base
	client.Role = RoleClient
	client.Peer = "1.2.3.4:443"
	if err := client.Validate(); err != nil {
		t.Errorf("expected a valid client spec to pass, got %v", err)
	}

	cases := []struct {
		name string
		spec Spec
	}{
		{"server without port", Spec{ID: "t", Secret: "s", Role: RoleServer}},
		{"client without peer", Spec{ID: "t", Secret: "s", Role: RoleClient}},
		{"client with invalid peer", Spec{ID: "t", Secret: "s", Role: RoleClient, Peer: "not-a-peer"}},
		{"empty secret", Spec{ID: "t", Role: RoleServer, Port: 443}},
		{"invalid role", Spec{ID: "t", Secret: "s", Role: "bogus"}},
		{"invalid id", Spec{ID: "../etc", Secret: "s", Role: RoleServer, Port: 443}},
		{"invalid port mapping", Spec{ID: "t", Secret: "s", Role: RoleServer, Port: 443, Ports: []PortMapping{{Remote: 0, Local: 80}}}},
	}
	for _, c := range cases {
		if err := c.spec.Validate(); err == nil {
			t.Errorf("%s: expected an error, got none", c.name)
		}
	}
}
