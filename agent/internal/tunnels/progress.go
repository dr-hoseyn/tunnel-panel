package tunnels

import (
	"sync"
	"time"
)

// Package-level, in-memory, real-time progress tracking for an in-flight
// tunnel deploy. POST /api/v1/managed-tunnels is one synchronous HTTP call
// that runs install -> write config -> create service -> configure
// firewall -> start -> health check on the agent side; without this, the
// panel has no way to observe those sub-steps individually -- only "the
// whole request is still pending" or "it finished". A caller (the panel)
// can poll GET /api/v1/managed-tunnels/{id}/progress on a separate
// connection while the create POST is still in flight and see each real
// step as it happens, not a simulated/fake breakdown.
//
// Deliberately in-memory, not persisted: this is transient, sub-second-to-
// low-minutes progress for one in-flight operation, not history (the panel
// already has its own durable Deployment.steps for that). Lost on agent
// restart, which only matters for an operation that was itself interrupted
// by that restart.

type StepStatus string

const (
	StepRunning StepStatus = "running"
	StepOK      StepStatus = "ok"
	StepFailed  StepStatus = "failed"
)

type ProgressStep struct {
	Step      string     `json:"step"`
	Status    StepStatus `json:"status"`
	Timestamp time.Time  `json:"timestamp"`
	Message   string     `json:"message,omitempty"`
}

type progressState struct {
	mu    sync.Mutex
	steps []ProgressStep
}

var progressByTunnel sync.Map // tunnelID -> *progressState

// ResetProgress clears any prior progress for id and should be called once
// at the start of a new operation on that tunnel id, so a poller can't see
// stale steps from a previous create/delete.
func ResetProgress(id string) {
	progressByTunnel.Store(id, &progressState{})
}

// SetStep records a step transition for id. Called by the HTTP layer
// (tunnel_handlers.go) around each real stage of deployTunnel, not by the
// drivers themselves -- keeps this package's driver implementations free of
// progress-reporting concerns, which aren't part of the Driver contract.
func SetStep(id, step string, status StepStatus, message string) {
	value, _ := progressByTunnel.LoadOrStore(id, &progressState{})
	state := value.(*progressState)
	state.mu.Lock()
	defer state.mu.Unlock()
	state.steps = append(state.steps, ProgressStep{Step: step, Status: status, Timestamp: time.Now(), Message: message})
}

// GetProgress returns every step recorded for id since the last
// ResetProgress, oldest first. Returns an empty (not nil) slice if id has
// no recorded progress -- callers can distinguish "no progress yet" from
// "unknown id" using the store's own tunnel-metadata lookup, not this.
func GetProgress(id string) []ProgressStep {
	value, ok := progressByTunnel.Load(id)
	if !ok {
		return []ProgressStep{}
	}
	state := value.(*progressState)
	state.mu.Lock()
	defer state.mu.Unlock()
	out := make([]ProgressStep, len(state.steps))
	copy(out, state.steps)
	return out
}
