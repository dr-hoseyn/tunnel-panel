// Package server implements the Agent's HTTP API surface. Deliberately a
// small, fixed set of read-only endpoints for phase 1 — health, metrics,
// tunnel listing. No generic "run this command" endpoint exists yet: an
// agent capable of executing arbitrary remote commands is the highest-value
// attack target in the whole system, and it needs a properly designed
// command allowlist and audit trail before it ships, not a rushed one.
package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/authtoken"
)

// CommandRunner executes a tunnel-manager.sh JSON mode ("--metrics-json" or
// "--list-json") and returns its raw stdout. Abstracted behind an interface
// so the HTTP layer can be unit-tested without a real tunnel-manager.sh or
// root environment — see server_test.go's fakeRunner.
type CommandRunner interface {
	Run(mode string) ([]byte, error)
}

// Server holds the Agent's HTTP handlers and their dependencies.
type Server struct {
	tokenHash string
	runner    CommandRunner
	mux       *http.ServeMux
}

// New builds a Server. tokenHash is the SHA-256 hex digest of the bearer
// token every authenticated request must present (see authtoken.Verify).
func New(tokenHash string, runner CommandRunner) *Server {
	s := &Server{tokenHash: tokenHash, runner: runner, mux: http.NewServeMux()}
	s.routes()
	return s
}

// Handler returns the Server's http.Handler, ready to pass to http.Server.
func (s *Server) Handler() http.Handler {
	return s.mux
}

func (s *Server) routes() {
	s.mux.HandleFunc("/api/v1/health", s.handleHealth)
	s.mux.Handle("/api/v1/metrics", s.auth(http.HandlerFunc(s.handleMetrics)))
	s.mux.Handle("/api/v1/tunnels", s.auth(http.HandlerFunc(s.handleTunnels)))
}

// auth wraps a handler so it only runs when the request carries a valid
// "Authorization: Bearer <token>" header, checked in constant time.
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, prefix) {
			writeError(w, http.StatusUnauthorized, "missing or malformed Authorization header")
			return
		}
		token := strings.TrimPrefix(h, prefix)
		if !authtoken.Verify(s.tokenHash, token) {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	s.proxyJSONMode(w, "--metrics-json")
}

func (s *Server) handleTunnels(w http.ResponseWriter, _ *http.Request) {
	s.proxyJSONMode(w, "--list-json")
}

// proxyJSONMode runs a tunnel-manager.sh JSON mode and forwards its stdout
// verbatim as the response body — the JSON schema is single-sourced in
// bash, this layer doesn't re-encode or reinterpret it.
func (s *Server) proxyJSONMode(w http.ResponseWriter, mode string) {
	out, err := s.runner.Run(mode)
	if err != nil {
		log.Printf("running %s: %v", mode, err)
		writeError(w, http.StatusBadGateway, "underlying tunnel-manager command failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
