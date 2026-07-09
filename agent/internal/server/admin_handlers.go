package server

import (
	"errors"
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

// handleCoreVerify re-checks one core's binary on demand -- see
// tunnels.VerifyCore's doc comment for why this is a separate, cheaper
// action distinct from handleAgentCores' "check every core" response.
func (s *Server) handleCoreVerify(w http.ResponseWriter, r *http.Request) {
	report, err := tunnels.VerifyCore(r.Context(), r.PathValue("core"))
	if err != nil {
		writeCoreActionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// handleCoreReinstall forces a fresh download+install of one core's binary
// -- see tunnels.ReinstallCore's doc comment for the mechanics and what it
// deliberately does not handle (restarting services using this core).
// Synchronous (unlike handleAgentRestart/handleAgentStop/handleAgentUpdate's
// respond-then-act pattern): nothing here kills the process handling this
// request, so there's no reason to defer it to a goroutine -- the caller
// just waits out the download like it already does for
// POST /api/v1/agent/update.
func (s *Server) handleCoreReinstall(w http.ResponseWriter, r *http.Request) {
	report, err := tunnels.ReinstallCore(r.Context(), r.PathValue("core"))
	if err != nil {
		log.Printf("reinstalling core %s: %v", r.PathValue("core"), err)
		writeCoreActionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// handleCoreRollback swaps one core's binary back to its saved
// ".previous" version -- see tunnels.RollbackCore's doc comment. Returns a
// 4xx (via writeCoreActionError) rather than a fabricated 200 when there is
// nothing to roll back to.
func (s *Server) handleCoreRollback(w http.ResponseWriter, r *http.Request) {
	report, err := tunnels.RollbackCore(r.Context(), r.PathValue("core"))
	if err != nil {
		if !errors.Is(err, tunnels.ErrNoPreviousVersion) {
			log.Printf("rolling back core %s: %v", r.PathValue("core"), err)
		}
		writeCoreActionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// writeCoreActionError maps the small set of errors VerifyCore/
// ReinstallCore/RollbackCore can return to the right HTTP status: an
// unrecognized core name or "nothing to roll back to" are ordinary client
// errors (4xx), not agent failures -- everything else (a failed download,
// a filesystem rename failing) is reported as a 502, matching how every
// other Driver-action failure in this package is surfaced (see
// tunnel_handlers.go's handleTunnelAction).
func writeCoreActionError(w http.ResponseWriter, err error) {
	var unknownCore *tunnels.UnknownCoreError
	switch {
	case errors.As(err, &unknownCore):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, tunnels.ErrNoPreviousVersion):
		writeError(w, http.StatusNotFound, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}
