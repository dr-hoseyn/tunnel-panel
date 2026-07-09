package tunnels

import (
	"context"
	"errors"
	"testing"
)

type nopDriver struct{ receivedSpec Spec }

func (d *nopDriver) Install(context.Context) error               { return nil }
func (d *nopDriver) WriteConfig() error                          { return nil }
func (d *nopDriver) CreateService() error                        { return nil }
func (d *nopDriver) ConfigureFirewall() error                    { return nil }
func (d *nopDriver) Start(context.Context) error                 { return nil }
func (d *nopDriver) Stop(context.Context) error                  { return nil }
func (d *nopDriver) Restart(context.Context) error               { return nil }
func (d *nopDriver) Health(context.Context) (Health, error)      { return Health{Process: "running"}, nil }
func (d *nopDriver) Logs(context.Context, int) ([]string, error) { return nil, nil }
func (d *nopDriver) Remove(context.Context) error                { return nil }

func TestRegisterAndNew(t *testing.T) {
	var captured Spec
	Register("registry-test-core", func(spec Spec) (Driver, error) {
		captured = spec
		return &nopDriver{receivedSpec: spec}, nil
	})

	spec := Spec{ID: "t1", Role: RoleServer, Port: 443, Secret: "s"}
	driver, err := New("registry-test-core", spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if driver == nil {
		t.Fatal("expected a non-nil driver")
	}
	if captured.ID != "t1" || captured.Port != 443 {
		t.Errorf("factory did not receive the spec unchanged: %+v", captured)
	}
}

func TestNewUnknownCore(t *testing.T) {
	_, err := New("no-such-core-registered", Spec{ID: "t1"})
	if err == nil {
		t.Fatal("expected an error for an unregistered core")
	}
	var unknownErr *UnknownCoreError
	if !errors.As(err, &unknownErr) {
		t.Fatalf("expected *UnknownCoreError, got %T: %v", err, err)
	}
	if unknownErr.Core != "no-such-core-registered" {
		t.Errorf("expected Core to be %q, got %q", "no-such-core-registered", unknownErr.Core)
	}
}

func TestSupportedCoresIncludesRegisteredBackhaul(t *testing.T) {
	// backhaul.go's init() registers "backhaul" as part of this package
	// loading -- confirms self-registration actually wires up, not just
	// that Register/New work for a synthetic name.
	found := false
	for _, name := range SupportedCores() {
		if name == "backhaul" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected SupportedCores() to include %q, got %v", "backhaul", SupportedCores())
	}
}
