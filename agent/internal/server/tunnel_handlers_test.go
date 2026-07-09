package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/tunnels"
)

// fakeDriver lets the HTTP layer be exercised end-to-end (create, start,
// stop, restart, health, logs, delete) without touching real systemd,
// firewalls, or a network download -- none of which are available or
// appropriate in this test environment. Registered under "faketest" so it
// never shadows the real "backhaul" driver also registered in this process.
type fakeDriver struct {
	installErr error
	removed    bool
}

func (d *fakeDriver) Install(context.Context) error { return d.installErr }
func (d *fakeDriver) WriteConfig() error            { return nil }
func (d *fakeDriver) CreateService() error          { return nil }
func (d *fakeDriver) ConfigureFirewall() error      { return nil }
func (d *fakeDriver) Start(context.Context) error   { return nil }
func (d *fakeDriver) Stop(context.Context) error    { return nil }
func (d *fakeDriver) Restart(context.Context) error { return nil }
func (d *fakeDriver) Health(context.Context) (tunnels.Health, error) {
	return tunnels.Health{Process: "running", PortOpen: true}, nil
}
func (d *fakeDriver) Logs(context.Context, int) ([]string, error) {
	return []string{"line one", "line two"}, nil
}
func (d *fakeDriver) Remove(context.Context) error { d.removed = true; return nil }

func init() {
	tunnels.Register("faketest", func(spec tunnels.Spec) (tunnels.Driver, error) {
		d := &fakeDriver{}
		if spec.Extra["fail_at"] == "install" {
			d.installErr = errors.New("simulated install failure")
		}
		return d, nil
	})
}

func createTestTunnel(t *testing.T, s *Server, token, id string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"id":     id,
		"core":   "faketest",
		"role":   "server",
		"port":   443,
		"secret": "s3cret",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/managed-tunnels", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestCreateTunnelHappyPath(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")

	rec := createTestTunnel(t, s, token, "tunnel-one")
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var health tunnels.Health
	if err := json.Unmarshal(rec.Body.Bytes(), &health); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if health.Process != "running" {
		t.Errorf("expected process=running, got %q", health.Process)
	}
}

func TestCreateTunnelRecordsRealTimeProgress(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")

	rec := createTestTunnel(t, s, token, "tunnel-progress")
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/managed-tunnels/tunnel-progress/progress", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	progRec := httptest.NewRecorder()
	s.Handler().ServeHTTP(progRec, req)
	if progRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", progRec.Code, progRec.Body.String())
	}

	var body struct {
		Steps []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(progRec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}

	wantSteps := []string{"install_binary", "write_config", "create_service", "configure_firewall", "start_service", "health_check", "complete"}
	seen := map[string]bool{}
	for _, s := range body.Steps {
		seen[s.Step] = true
	}
	for _, want := range wantSteps {
		if !seen[want] {
			t.Errorf("expected progress to include step %q, got %+v", want, body.Steps)
		}
	}
	// Every step should have reached "ok" (the fake driver never fails).
	for _, s := range body.Steps {
		if s.Status == "failed" {
			t.Errorf("did not expect any failed step, got %+v", s)
		}
	}
}

func TestTunnelProgressForUnknownIDReturnsEmptyNotError(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/managed-tunnels/never-created/progress", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 (empty progress, not a 404) for an id with no in-flight deploy, got %d", rec.Code)
	}
}

func TestCreateTunnelRejectsInvalidSpec(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	body, _ := json.Marshal(map[string]any{"id": "bad id with spaces", "core": "faketest", "role": "server", "port": 443, "secret": "s"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/managed-tunnels", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an invalid spec, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreateTunnelUnknownCore(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	body, _ := json.Marshal(map[string]any{"id": "t1", "core": "does-not-exist", "role": "server", "port": 443, "secret": "s"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/managed-tunnels", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an unknown core, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreateTunnelDuplicateIDConflicts(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	if rec := createTestTunnel(t, s, token, "dup-id"); rec.Code != http.StatusCreated {
		t.Fatalf("first create: expected 201, got %d", rec.Code)
	}
	rec := createTestTunnel(t, s, token, "dup-id")
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for a duplicate id, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreateTunnelRollsBackOnDeployFailure(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	body, _ := json.Marshal(map[string]any{
		"id": "will-fail", "core": "faketest", "role": "server", "port": 443, "secret": "s",
		"extra": map[string]string{"fail_at": "install"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/managed-tunnels", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when deploy fails, got %d: %s", rec.Code, rec.Body.String())
	}

	// Nothing should have been persisted -- a subsequent health check must
	// 404, not find a half-created tunnel.
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/managed-tunnels/will-fail/health", nil)
	req2.Header.Set("Authorization", "Bearer "+token)
	rec2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after a rolled-back create, got %d", rec2.Code)
	}
}

func TestTunnelLifecycle(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	if rec := createTestTunnel(t, s, token, "lifecycle-1"); rec.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	do := func(method, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		return rec
	}

	for _, action := range []string{"start", "stop", "restart"} {
		rec := do(http.MethodPost, "/api/v1/managed-tunnels/lifecycle-1/"+action)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: expected 200, got %d: %s", action, rec.Code, rec.Body.String())
		}
	}

	if rec := do(http.MethodGet, "/api/v1/managed-tunnels/lifecycle-1/health"); rec.Code != http.StatusOK {
		t.Errorf("health: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	rec := do(http.MethodGet, "/api/v1/managed-tunnels/lifecycle-1/logs?lines=50")
	if rec.Code != http.StatusOK {
		t.Fatalf("logs: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var logs struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &logs); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if len(logs.Lines) != 2 {
		t.Errorf("expected 2 log lines from the fake driver, got %v", logs.Lines)
	}

	if rec := do(http.MethodDelete, "/api/v1/managed-tunnels/lifecycle-1"); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: expected 204, got %d: %s", rec.Code, rec.Body.String())
	}

	if rec := do(http.MethodGet, "/api/v1/managed-tunnels/lifecycle-1/health"); rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 after delete, got %d", rec.Code)
	}
}

func TestTunnelActionOnUnknownIDReturns404(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/managed-tunnels/does-not-exist/start", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestManagedTunnelRoutesRequireAuth(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "correct-token")
	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodPost, "/api/v1/managed-tunnels", bytes.NewReader([]byte("{}"))),
		httptest.NewRequest(http.MethodPost, "/api/v1/managed-tunnels/x/start", nil),
		httptest.NewRequest(http.MethodGet, "/api/v1/managed-tunnels/x/health", nil),
		httptest.NewRequest(http.MethodGet, "/api/v1/managed-tunnels/x/logs", nil),
		httptest.NewRequest(http.MethodDelete, "/api/v1/managed-tunnels/x", nil),
	} {
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: expected 401 with no auth, got %d", req.Method, req.URL.Path, rec.Code)
		}
	}
}
