package server

import (
	"log"
	"net/http"
	"os/exec"
	"time"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/authtoken"
	"github.com/dr-hoseyn/tunnel-panel/agent/internal/tunnels"
	"github.com/dr-hoseyn/tunnel-panel/agent/internal/version"
)

func (s *Server) handleAgentInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, version.Current(tunnels.SupportedCores()))
}

// handleTokenRotate replaces the stored bearer token hash atomically and
// swaps it into the running Server's in-memory copy so every subsequent
// request (including the response to *this* one) needs the new token. The
// old token stops working the instant this returns -- the caller (the
// panel) must persist the returned token before this response is done
// being read, or it locks itself out of this agent.
func (s *Server) handleTokenRotate(w http.ResponseWriter, _ *http.Request) {
	if s.tokenPath == "" {
		writeError(w, http.StatusNotImplemented, "token rotation is not configured for this agent instance")
		return
	}
	newToken, err := authtoken.Generate()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "generating new token")
		return
	}
	if err := authtoken.SaveHash(s.tokenPath, newToken); err != nil {
		log.Printf("rotating token: %v", err)
		writeError(w, http.StatusInternalServerError, "saving new token")
		return
	}
	s.tokenMu.Lock()
	s.tokenHash = authtoken.Hash(newToken)
	s.tokenMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]string{"token": newToken})
}

// handleAgentRestart responds first, then restarts the agent's own systemd
// unit from a short-delayed goroutine -- it can't restart synchronously and
// still deliver this response, since the restart kills the process
// currently handling the request.
func (s *Server) handleAgentRestart(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "restarting"})
	go func() {
		time.Sleep(300 * time.Millisecond)
		if err := exec.Command("systemctl", "restart", "tunnel-agent.service").Run(); err != nil {
			log.Printf("agent self-restart failed: %v", err)
		}
	}()
}
