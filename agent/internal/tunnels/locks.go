package tunnels

import "sync"

// Locks guards per-tunnel operations so two overlapping requests for the
// same tunnel id can never race on the same config/service files. Different
// tunnel ids proceed fully in parallel -- this is a keyed lock, not a
// global one across the whole agent.
type Locks struct {
	mu   sync.Mutex
	byID map[string]*sync.Mutex
}

func NewLocks() *Locks {
	return &Locks{byID: make(map[string]*sync.Mutex)}
}

func (l *Locks) get(tunnelID string) *sync.Mutex {
	l.mu.Lock()
	defer l.mu.Unlock()
	m, ok := l.byID[tunnelID]
	if !ok {
		m = &sync.Mutex{}
		l.byID[tunnelID] = m
	}
	return m
}

// Lock acquires the lock for tunnelID and returns a function that releases
// it: `defer locks.Lock(id)()`. Entries are intentionally never removed
// (a VPS manages at most a few dozen tunnels, so the map stays tiny for the
// life of the process) -- simpler and safer than trying to garbage-collect
// a mutex that might be about to be re-acquired.
func (l *Locks) Lock(tunnelID string) func() {
	m := l.get(tunnelID)
	m.Lock()
	return m.Unlock
}
