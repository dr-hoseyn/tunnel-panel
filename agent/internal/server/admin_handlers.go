package server

import (
	"log"
	"net/http"
	"os/exec"
	"strconv"
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

// handleAgentStop responds first, then stops the agent's own systemd unit
// from a short-delayed goroutine -- same reasoning as handleAgentRestart:
// the response can't be delivered after the process handling it is gone.
//
// Unlike restart, systemd does NOT bring the unit back on its own after
// this: the agent will not respond to anything else -- including a future
// restart/update/stop request from the panel -- until something starts it
// again (systemctl start, run manually on the box, or a reboot if the unit
// happens to be re-triggered some other way). That is the intended
// behavior of "stop a service", not a bug to work around here; the panel's
// UI is responsible for making that consequence clear before this is
// confirmed.
func (s *Server) handleAgentStop(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "stopping"})
	go func() {
		time.Sleep(300 * time.Millisecond)
		if err := exec.Command("systemctl", "stop", "tunnel-agent.service").Run(); err != nil {
			log.Printf("agent self-stop failed: %v", err)
		}
	}()
}

// handleAgentLogs returns this agent's own recent journal output --
// distinct from /api/v1/managed-tunnels/{id}/logs (per-tunnel), this is the
// tunnel-agent.service unit's own log, useful for diagnosing the agent
// itself (crash loops, failed installs, auth errors) from the panel without
// needing SSH access to the box.
func (s *Server) handleAgentLogs(w http.ResponseWriter, r *http.Request) {
	lines := 200
	if raw := r.URL.Query().Get("lines"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			lines = n
		}
	}
	logLines, err := tunnels.JournalctlLogs(r.Context(), "tunnel-agent.service", lines)
	if err != nil {
		log.Printf("fetching agent logs: %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"lines": logLines})
}

// handleAgentCores reports, for every tunnel core this agent build
// supports, whether that core's binary is installed and passes a basic
// sanity check -- lets the panel show real install/health state per core
// without the operator needing to SSH in and check by hand.
func (s *Server) handleAgentCores(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string][]tunnels.CoreBinaryReport{"cores": tunnels.CoreBinaryReports(r.Context())})
}
