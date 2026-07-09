package tunnels

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Meta is the minimal persisted record letting the agent reconstruct a
// Driver for an existing tunnel id on every request after creation
// (start/stop/restart/health/logs/delete) without the panel having to
// resend the full Spec each time. Mirrors ha-tunnel-manager's own
// write_tunnel_meta/read_tunnel_meta pattern (core/README.md) for the same
// reason, just re-implemented natively here rather than shelling out to it.
type Meta struct {
	Core string `json:"core"`
	Spec Spec   `json:"spec"`
}

// Store persists one Meta per tunnel as <dir>/<id>/meta.json. A directory
// per tunnel (rather than one flat file) so a driver's own generated
// config/cert files can live alongside it without name collisions between
// tunnels.
type Store struct {
	dir string
}

// NewStore creates (if needed) and returns a Store rooted at dir.
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating tunnel store directory: %w", err)
	}
	return &Store{dir: dir}, nil
}

// TunnelDir returns (and does not create) the per-tunnel working directory
// a driver should write its config/certs/etc into.
func (s *Store) TunnelDir(id string) (string, error) {
	if err := ValidateTunnelID(id); err != nil {
		return "", err
	}
	return SafeJoin(s.dir, id)
}

func (s *Store) metaPath(id string) (string, error) {
	tunnelDir, err := s.TunnelDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(tunnelDir, "meta.json"), nil
}

// Save persists meta for id, creating the tunnel's directory if needed.
func (s *Store) Save(id string, meta Meta) error {
	tunnelDir, err := s.TunnelDir(id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(tunnelDir, 0o700); err != nil {
		return fmt.Errorf("creating tunnel directory: %w", err)
	}
	path, err := s.metaPath(id)
	if err != nil {
		return err
	}
	data, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("encoding tunnel metadata: %w", err)
	}
	// Write-to-temp-then-rename: a crash mid-write must never leave a
	// truncated meta.json that later fails to unmarshal on read.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("writing tunnel metadata: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("finalizing tunnel metadata: %w", err)
	}
	return nil
}

// ErrNotFound is returned by Load when no metadata exists for the given id.
var ErrNotFound = fmt.Errorf("tunnel not found")

// Load reads back a previously Saved Meta for id.
func (s *Store) Load(id string) (Meta, error) {
	path, err := s.metaPath(id)
	if err != nil {
		return Meta{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Meta{}, ErrNotFound
		}
		return Meta{}, fmt.Errorf("reading tunnel metadata: %w", err)
	}
	var meta Meta
	if err := json.Unmarshal(data, &meta); err != nil {
		return Meta{}, fmt.Errorf("decoding tunnel metadata: %w", err)
	}
	return meta, nil
}

// Delete removes id's entire working directory (metadata, generated config,
// certs, ...). Not an error if it never existed.
func (s *Store) Delete(id string) error {
	tunnelDir, err := s.TunnelDir(id)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(tunnelDir); err != nil {
		return fmt.Errorf("removing tunnel directory: %w", err)
	}
	return nil
}

// List returns every tunnel id with saved metadata.
func (s *Store) List() ([]string, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("listing tunnels: %w", err)
	}
	ids := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if ValidateTunnelID(e.Name()) != nil {
			continue
		}
		ids = append(ids, e.Name())
	}
	return ids, nil
}
