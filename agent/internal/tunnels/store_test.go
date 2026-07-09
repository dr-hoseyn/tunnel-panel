package tunnels

import (
	"errors"
	"testing"
)

func TestStoreSaveLoadDelete(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	meta := Meta{Core: "backhaul", Spec: Spec{ID: "t1", Role: RoleServer, Port: 443, Secret: "s"}}
	if err := store.Save("t1", meta); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := store.Load("t1")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Core != "backhaul" || loaded.Spec.Port != 443 {
		t.Errorf("loaded metadata does not match saved: %+v", loaded)
	}

	ids, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(ids) != 1 || ids[0] != "t1" {
		t.Errorf("expected List() to return [t1], got %v", ids)
	}

	if err := store.Delete("t1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := store.Load("t1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound after Delete, got %v", err)
	}
}

func TestStoreLoadMissingReturnsErrNotFound(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if _, err := store.Load("never-created"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestStoreRejectsInvalidTunnelID(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := store.Save("../escape", Meta{}); err == nil {
		t.Error("expected Save with a path-traversal id to be rejected")
	}
	if _, err := store.TunnelDir("has/slash"); err == nil {
		t.Error("expected TunnelDir with a slash in the id to be rejected")
	}
}

func TestStoreListIgnoresUnrelatedEntries(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := store.Save("valid-id", Meta{Core: "backhaul"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	ids, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(ids) != 1 || ids[0] != "valid-id" {
		t.Errorf("expected only the saved tunnel id, got %v", ids)
	}
}
