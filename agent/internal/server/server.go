// Package server implements the Agent's HTTP API surface. Started as a
// small, fixed set of read-only endpoints (health, metrics, tunnel
// listing); now also exposes a deliberately narrow, allowlisted set of
// mutating endpoints for tunnels *this agent itself created* (see
// internal/tunnels) -- every field is schema-validated before it ever
// reaches a driver, every subprocess call uses an argv slice, and there is
// still no generic "run this command" endpoint. tunnel_handlers.go and
// admin_handlers.go hold the newer handlers; this file holds the original
// read-only ones plus the shared plumbing (auth, routing, JSON helpers).
package server

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/authtoken"
	"github.com/dr-hoseyn/tunnel-panel/agent/internal/tunnels"
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
	tokenMu   sync.RWMutex
	tokenHash string
	// tokenPath is where the token hash is persisted -- only needed for
	// /api/v1/token/rotate to write a new one; empty in tests that don't
	// exercise rotation.
	tokenPath string
	runner    CommandRunner
	store     *tunnels.Store
	locks     *tunnels.Locks
	mux       *http.ServeMux

	// fetchLatestRelease/selfExecutable back /api/v1/agent/update (see
	// agent_update.go). Both default to the real implementation in New,
	// but are plain struct fields (not exported, no constructor param) so
	// tests in this package can substitute a fake and never reach the real
	// GitHub API or touch this test binary's own executable.
	fetchLatestRelease releaseFetcher
	selfExecutable     func() (string, error)
}

// New builds a Server. tokenHash is the SHA-256 hex digest of the bearer
// token every authenticated request must present (see authtoken.Verify).
// tokenPath is where that hash lives on disk, rewritten by token rotation.
// store persists metadata for agent-native tunnels (see internal/tunnels)
// across requests -- every operation after creation only ever carries an id.
func New(tokenHash, tokenPath string, runner CommandRunner, store *tunnels.Store) *Server {
	s := &Server{
		tokenHash:          tokenHash,
		tokenPath:          tokenPath,
		runner:             runner,
		store:              store,
		locks:              tunnels.NewLocks(),
		mux:                http.NewServeMux(),
		fetchLatestRelease: fetchLatestGitHubRelease,
		selfExecutable:     os.Executable,
	}
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

	s.mux.Handle("GET /api/v1/agent/info", s.auth(http.HandlerFunc(s.handleAgentInfo)))

	// Agent-native tunnels this agent creates/manages itself (see
	// internal/tunnels) -- deliberately namespaced away from
	// /api/v1/tunnels above, which stays a read-only proxy of whatever
	// tunnel-manager.sh has configured on this box. Different resources,
	// different paths.
	s.mux.Handle("POST /api/v1/managed-tunnels", s.auth(http.HandlerFunc(s.handleCreateTunnel)))
	s.mux.Handle("POST /api/v1/managed-tunnels/{id}/start", s.auth(http.HandlerFunc(s.handleStartTunnel)))
	s.mux.Handle("POST /api/v1/managed-tunnels/{id}/stop", s.auth(http.HandlerFunc(s.handleStopTunnel)))
	s.mux.Handle("POST /api/v1/managed-tunnels/{id}/restart", s.auth(http.HandlerFunc(s.handleRestartTunnel)))
	s.mux.Handle("DELETE /api/v1/managed-tunnels/{id}", s.auth(http.HandlerFunc(s.handleDeleteTunnel)))
	s.mux.Handle("GET /api/v1/managed-tunnels/{id}/health", s.auth(http.HandlerFunc(s.handleTunnelHealth)))
	s.mux.Handle("GET /api/v1/managed-tunnels/{id}/logs", s.auth(http.HandlerFunc(s.handleTunnelLogs)))
	s.mux.Handle("GET /api/v1/managed-tunnels/{id}/progress", s.auth(http.HandlerFunc(s.handleTunnelProgress)))

	s.mux.Handle("POST /api/v1/token/rotate", s.auth(http.HandlerFunc(s.handleTokenRotate)))
	s.mux.Handle("POST /api/v1/agent/restart", s.auth(http.HandlerFunc(s.handleAgentRestart)))
	s.mux.Handle("POST /api/v1/agent/stop", s.auth(http.HandlerFunc(s.handleAgentStop)))
	s.mux.Handle("GET /api/v1/agent/logs", s.auth(http.HandlerFunc(s.handleAgentLogs)))
	s.mux.Handle("GET /api/v1/agent/cores", s.auth(http.HandlerFunc(s.handleAgentCores)))
	s.mux.Handle("POST /api/v1/agent/update", s.auth(http.HandlerFunc(s.handleAgentUpdate)))

	// Per-core admin actions (see core_admin.go): verify is read-only and
	// scoped to one core (cheaper than re-checking every core the way GET
	// /api/v1/agent/cores does); reinstall/rollback mutate that core's
	// shared binary on disk.
	s.mux.Handle("GET /api/v1/agent/cores/{core}/verify", s.auth(http.HandlerFunc(s.handleCoreVerify)))
	s.mux.Handle("POST /api/v1/agent/cores/{core}/reinstall", s.auth(http.HandlerFunc(s.handleCoreReinstall)))
	s.mux.Handle("POST /api/v1/agent/cores/{core}/rollback", s.auth(http.HandlerFunc(s.handleCoreRollback)))
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
		s.tokenMu.RLock()
		hash := s.tokenHash
		s.tokenMu.RUnlock()
		if !authtoken.Verify(hash, token) {
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
