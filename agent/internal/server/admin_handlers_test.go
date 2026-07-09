package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/authtoken"
	"github.com/dr-hoseyn/tunnel-panel/agent/internal/tunnels"
	"github.com/dr-hoseyn/tunnel-panel/agent/internal/version"
)

func TestAgentInfoReturnsSupportedDrivers(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/info", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var info version.Info
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if info.OS == "" || info.Arch == "" {
		t.Errorf("expected OS/Arch to be populated, got %+v", info)
	}
	if info.GoVersion == "" {
		t.Errorf("expected GoVersion to be populated, got %+v", info)
	}
	if info.UptimeSeconds < 0 {
		t.Errorf("expected a non-negative uptime, got %d", info.UptimeSeconds)
	}
	found := false
	for _, d := range info.Drivers {
		if d == "faketest" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected supported_drivers to include %q, got %v", "faketest", info.Drivers)
	}
}

func TestAgentInfoRequiresAuth(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/info", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestTokenRotateIssuesWorkingNewToken(t *testing.T) {
	s, oldToken := newTestServer(fakeRunner{}, "correct-token")

	req := httptest.NewRequest(http.MethodPost, "/api/v1/token/rotate", nil)
	req.Header.Set("Authorization", "Bearer "+oldToken)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if body.Token == "" || body.Token == oldToken {
		t.Fatalf("expected a new, non-empty token, got %q", body.Token)
	}

	// The old token must stop working immediately.
	reqOld := httptest.NewRequest(http.MethodGet, "/api/v1/agent/info", nil)
	reqOld.Header.Set("Authorization", "Bearer "+oldToken)
	recOld := httptest.NewRecorder()
	s.Handler().ServeHTTP(recOld, reqOld)
	if recOld.Code != http.StatusUnauthorized {
		t.Errorf("expected the old token to be rejected after rotation, got %d", recOld.Code)
	}

	// The new token must work.
	reqNew := httptest.NewRequest(http.MethodGet, "/api/v1/agent/info", nil)
	reqNew.Header.Set("Authorization", "Bearer "+body.Token)
	recNew := httptest.NewRecorder()
	s.Handler().ServeHTTP(recNew, reqNew)
	if recNew.Code != http.StatusOK {
		t.Errorf("expected the new token to be accepted, got %d", recNew.Code)
	}

	// And it should have actually been persisted to disk, not just held
	// in memory.
	persistedHash, err := authtoken.LoadHash(s.tokenPath)
	if err != nil {
		t.Fatalf("reading persisted token hash: %v", err)
	}
	if persistedHash != authtoken.Hash(body.Token) {
		t.Errorf("persisted token hash does not match the returned token")
	}
}

func TestTokenRotateWithoutConfiguredPath(t *testing.T) {
	hash := authtoken.Hash("correct-token")
	store, err := tunnels.NewStore(testStoreDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	s := New(hash, "", fakeRunner{}, store)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/token/rotate", nil)
	req.Header.Set("Authorization", "Bearer correct-token")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("expected 501 when no token path is configured, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAgentRestartRespondsBeforeRestarting(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/restart", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAgentStopRespondsBeforeStopping(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/stop", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if body["status"] != "stopping" {
		t.Errorf("expected status=stopping, got %v", body)
	}
}

func TestAgentStopRequiresAuth(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/stop", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestAgentLogsRequiresAuth(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/logs", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestAgentLogsRoutesAndRespondsWithJSON(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/logs?lines=50", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	// journalctl isn't available in this sandboxed test environment (see
	// backhaul_test.go's header comment on why real subprocess-shelling
	// code isn't unit tested) -- what matters here is that the route is
	// wired up and fails cleanly with a JSON error, not a specific
	// journalctl exit code, which varies by host.
	if rec.Code != http.StatusOK && rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 200 or 502, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
}

func TestAgentCoresRequiresAuth(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/cores", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestAgentCoresReportsKnownCores(t *testing.T) {
	s, token := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/agent/cores", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Cores []tunnels.CoreBinaryReport `json:"cores"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	found := map[string]bool{}
	for _, c := range body.Cores {
		found[c.Core] = true
		if c.Status == "" {
			t.Errorf("expected a non-empty status for core %q", c.Core)
		}
	}
	for _, want := range []string{"backhaul", "gost", "hysteria2", "rathole"} {
		if !found[want] {
			t.Errorf("expected core %q in the response, got %v", want, body.Cores)
		}
	}
}
