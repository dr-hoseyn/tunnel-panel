package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/tunnels"
)

// createTunnelRequest is the wire shape for POST /api/v1/managed-tunnels.
// Every field is re-validated by tunnels.Spec.Validate() before it's used
// for anything -- this struct only describes JSON decoding, it grants no
// trust of its own.
type createTunnelRequest struct {
	ID     string                `json:"id"`
	Core   string                `json:"core"`
	Role   string                `json:"role"`
	Port   int                   `json:"port"`
	Peer   string                `json:"peer"`
	Secret string                `json:"secret"`
	Ports  []tunnels.PortMapping `json:"ports"`
	Extra  map[string]string     `json:"extra"`
}

func (s *Server) handleCreateTunnel(w http.ResponseWriter, r *http.Request) {
	var req createTunnelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	spec := tunnels.Spec{
		ID:     req.ID,
		Role:   tunnels.Role(req.Role),
		Port:   req.Port,
		Peer:   req.Peer,
		Secret: req.Secret,
		Ports:  req.Ports,
		Extra:  req.Extra,
	}
	if err := spec.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	driver, err := tunnels.New(req.Core, spec)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	unlock := s.locks.Lock(spec.ID)
	defer unlock()

	if _, err := s.store.Load(spec.ID); err == nil {
		writeError(w, http.StatusConflict, "a tunnel with this id already exists")
		return
	}

	ctx := r.Context()
	tunnels.ResetProgress(spec.ID)
	if err := deployTunnel(ctx, spec.ID, driver); err != nil {
		log.Printf("deploying tunnel %s: %v", spec.ID, err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	if err := s.store.Save(spec.ID, tunnels.Meta{Core: req.Core, Spec: spec}); err != nil {
		// The tunnel is actually up at this point (config/service/firewall
		// all applied) but we can't persist metadata to operate on it
		// later -- roll the whole thing back rather than leave an orphaned,
		// un-manageable tunnel running.
		log.Printf("saving metadata for tunnel %s failed, rolling back: %v", spec.ID, err)
		_ = driver.Remove(ctx)
		writeError(w, http.StatusInternalServerError, "created the tunnel but failed to persist its metadata; rolled back")
		return
	}

	tunnels.SetStep(spec.ID, "health_check", tunnels.StepRunning, "")
	health, err := driver.Health(ctx)
	if err != nil {
		log.Printf("health check for new tunnel %s: %v", spec.ID, err)
		tunnels.SetStep(spec.ID, "health_check", tunnels.StepFailed, err.Error())
	} else {
		tunnels.SetStep(spec.ID, "health_check", tunnels.StepOK, "")
	}
	tunnels.SetStep(spec.ID, "complete", tunnels.StepOK, "")
	writeJSON(w, http.StatusCreated, health)
}

// deployTunnel runs install -> config -> service -> firewall -> start,
// tearing down whatever already succeeded if a later step fails. A create
// request must never leave a half-applied tunnel behind on this agent --
// the two-server rollback (removing the *other* side too) is the panel
// orchestrator's job, one layer up; this is this agent's half of that
// guarantee.
//
// Each stage's start/end is recorded via tunnels.SetStep so a caller can
// poll GET /api/v1/managed-tunnels/{id}/progress on a separate connection
// while this (synchronous, potentially slow -- Install may download a
// binary) request is still in flight, and see genuine real-time progress
// instead of a single opaque "pending".
func deployTunnel(ctx context.Context, id string, driver tunnels.Driver) error {
	steps := []struct {
		name string
		run  func() error
	}{
		{"install_binary", func() error { return driver.Install(ctx) }},
		{"write_config", driver.WriteConfig},
		{"create_service", driver.CreateService},
		{"configure_firewall", driver.ConfigureFirewall},
		{"start_service", func() error { return driver.Start(ctx) }},
	}
	for i, step := range steps {
		tunnels.SetStep(id, step.name, tunnels.StepRunning, "")
		if err := step.run(); err != nil {
			tunnels.SetStep(id, step.name, tunnels.StepFailed, err.Error())
			if i > 0 { // Install failing leaves nothing on disk yet to remove
				_ = driver.Remove(ctx)
			}
			return fmt.Errorf("%s: %w", step.name, err)
		}
		tunnels.SetStep(id, step.name, tunnels.StepOK, "")
	}
	return nil
}

// loadDriver rebuilds a Driver for an existing tunnel id from its persisted
// Meta -- every request after creation only ever carries an id, not a full
// Spec.
func (s *Server) loadDriver(id string) (tunnels.Driver, error) {
	meta, err := s.store.Load(id)
	if err != nil {
		return nil, err
	}
	return tunnels.New(meta.Core, meta.Spec)
}

func (s *Server) handleStartTunnel(w http.ResponseWriter, r *http.Request) {
	s.handleTunnelAction(w, r, func(ctx context.Context, d tunnels.Driver) error { return d.Start(ctx) })
}

func (s *Server) handleStopTunnel(w http.ResponseWriter, r *http.Request) {
	s.handleTunnelAction(w, r, func(ctx context.Context, d tunnels.Driver) error { return d.Stop(ctx) })
}

func (s *Server) handleRestartTunnel(w http.ResponseWriter, r *http.Request) {
	s.handleTunnelAction(w, r, func(ctx context.Context, d tunnels.Driver) error { return d.Restart(ctx) })
}

func (s *Server) handleTunnelAction(w http.ResponseWriter, r *http.Request, action func(context.Context, tunnels.Driver) error) {
	id := r.PathValue("id")
	if err := tunnels.ValidateTunnelID(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	unlock := s.locks.Lock(id)
	defer unlock()

	driver, err := s.loadDriver(id)
	if err != nil {
		writeDriverLookupError(w, err)
		return
	}
	ctx := r.Context()
	if err := action(ctx, driver); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	health, err := driver.Health(ctx)
	if err != nil {
		log.Printf("health check for tunnel %s: %v", id, err)
	}
	writeJSON(w, http.StatusOK, health)
}

func (s *Server) handleDeleteTunnel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := tunnels.ValidateTunnelID(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	unlock := s.locks.Lock(id)
	defer unlock()

	driver, err := s.loadDriver(id)
	if err != nil {
		writeDriverLookupError(w, err)
		return
	}
	if err := driver.Remove(r.Context()); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := s.store.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTunnelHealth(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := tunnels.ValidateTunnelID(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	unlock := s.locks.Lock(id)
	defer unlock()

	driver, err := s.loadDriver(id)
	if err != nil {
		writeDriverLookupError(w, err)
		return
	}
	health, err := driver.Health(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, health)
}

func (s *Server) handleTunnelLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := tunnels.ValidateTunnelID(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	lines := 200
	if raw := r.URL.Query().Get("lines"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			lines = n
		}
	}

	unlock := s.locks.Lock(id)
	defer unlock()

	driver, err := s.loadDriver(id)
	if err != nil {
		writeDriverLookupError(w, err)
		return
	}
	logLines, err := driver.Logs(r.Context(), lines)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"lines": logLines})
}

// handleTunnelProgress serves real-time deploy progress for a tunnel id
// currently being created (or most recently created) -- see
// internal/tunnels/progress.go. Deliberately has no ValidateTunnelID +
// store lookup requirement the way other handlers do: a caller may poll
// this *while* the create POST is still in flight, before
// s.store.Save has ever run for this id, so there's no persisted Meta to
// look up yet. An unknown/never-deployed id just returns an empty list, not
// a 404 -- polling before the create request has reached its first step at
// all is a normal race, not an error.
func (s *Server) handleTunnelProgress(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := tunnels.ValidateTunnelID(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"steps": tunnels.GetProgress(id)})
}

func writeDriverLookupError(w http.ResponseWriter, err error) {
	if errors.Is(err, tunnels.ErrNotFound) {
		writeError(w, http.StatusNotFound, "tunnel not found")
		return
	}
	writeError(w, http.StatusInternalServerError, err.Error())
}
