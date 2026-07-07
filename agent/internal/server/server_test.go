package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/authtoken"
)

type fakeRunner struct {
	out map[string][]byte
	err map[string]error
}

func (f fakeRunner) Run(mode string) ([]byte, error) {
	if err, ok := f.err[mode]; ok {
		return nil, err
	}
	return f.out[mode], nil
}

func newTestServer(runner CommandRunner, token string) (*Server, string) {
	hash := authtoken.Hash(token)
	return New(hash, runner), token
}

func TestHealthRequiresNoAuth(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "irrelevant-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("expected status=ok, got %v", body)
	}
}

func TestMetricsRejectsMissingAuth(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with no Authorization header, got %d", rec.Code)
	}
}

func TestMetricsRejectsWrongToken(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong token, got %d", rec.Code)
	}
}

func TestMetricsRejectsMalformedAuthHeader(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.Header.Set("Authorization", "correct-token") // missing "Bearer " prefix
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with malformed header, got %d", rec.Code)
	}
}

func TestMetricsProxiesRunnerOutputVerbatim(t *testing.T) {
	want := []byte(`{"hostname":"vps1","cpu_percent":"12"}`)
	runner := fakeRunner{out: map[string][]byte{"--metrics-json": want}}
	s, token := newTestServer(runner, "correct-token")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != string(want) {
		t.Fatalf("expected body to be forwarded verbatim: got %q want %q", rec.Body.String(), want)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("expected Content-Type application/json, got %q", ct)
	}
}

func TestTunnelsProxiesRunnerOutputVerbatim(t *testing.T) {
	want := []byte(`{"tunnels":[{"engine":"backhaul","name":"iran1234","role":"server","active":true}]}`)
	runner := fakeRunner{out: map[string][]byte{"--list-json": want}}
	s, token := newTestServer(runner, "correct-token")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/tunnels", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != string(want) {
		t.Fatalf("expected body to be forwarded verbatim: got %q want %q", rec.Body.String(), want)
	}
}

func TestMetricsReturnsBadGatewayWhenScriptFails(t *testing.T) {
	runner := fakeRunner{err: map[string]error{"--metrics-json": errors.New("tunnel-manager.sh: command not found")}}
	s, token := newTestServer(runner, "correct-token")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when the underlying script fails, got %d", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON error response: %v", err)
	}
	if body["error"] == "" {
		t.Fatalf("expected a non-empty error message, got %v", body)
	}
}

func TestUnknownRouteReturns404(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "token")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/does-not-exist", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for an unknown route, got %d", rec.Code)
	}
}
