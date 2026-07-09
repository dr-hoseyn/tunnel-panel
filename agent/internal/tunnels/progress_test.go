package tunnels

import "testing"

func TestProgressRecordsStepsInOrder(t *testing.T) {
	ResetProgress("p1")
	SetStep("p1", "install_binary", StepRunning, "")
	SetStep("p1", "install_binary", StepOK, "")
	SetStep("p1", "write_config", StepRunning, "")
	SetStep("p1", "write_config", StepFailed, "disk full")

	steps := GetProgress("p1")
	if len(steps) != 4 {
		t.Fatalf("expected 4 recorded steps, got %d: %+v", len(steps), steps)
	}
	if steps[0].Step != "install_binary" || steps[0].Status != StepRunning {
		t.Errorf("unexpected first step: %+v", steps[0])
	}
	if steps[3].Step != "write_config" || steps[3].Status != StepFailed || steps[3].Message != "disk full" {
		t.Errorf("unexpected last step: %+v", steps[3])
	}
}

func TestProgressUnknownIDReturnsEmptyNotNil(t *testing.T) {
	steps := GetProgress("never-seen-before")
	if steps == nil {
		t.Error("expected an empty slice, got nil")
	}
	if len(steps) != 0 {
		t.Errorf("expected no steps, got %d", len(steps))
	}
}

func TestResetProgressClearsPriorSteps(t *testing.T) {
	SetStep("p2", "install_binary", StepOK, "")
	if len(GetProgress("p2")) == 0 {
		t.Fatal("expected at least one step before reset")
	}
	ResetProgress("p2")
	if len(GetProgress("p2")) != 0 {
		t.Errorf("expected progress to be cleared after ResetProgress, got %+v", GetProgress("p2"))
	}
}

func TestProgressIsolatedPerTunnelID(t *testing.T) {
	ResetProgress("p3")
	ResetProgress("p4")
	SetStep("p3", "install_binary", StepOK, "")
	if len(GetProgress("p4")) != 0 {
		t.Error("expected tunnel p4's progress to be unaffected by steps recorded for p3")
	}
}
