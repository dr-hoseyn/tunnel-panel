package tunnels

import (
	"testing"
	"time"
)

func TestLocksSerializesSameTunnelID(t *testing.T) {
	locks := NewLocks()
	order := make(chan string, 2)

	unlockFirst := locks.Lock("tunnel-a")
	go func() {
		unlockSecond := locks.Lock("tunnel-a")
		order <- "second"
		unlockSecond()
	}()

	// Give the goroutine a chance to block on the lock we're still holding.
	time.Sleep(50 * time.Millisecond)
	order <- "first"
	unlockFirst()

	first := <-order
	second := <-order
	if first != "first" || second != "second" {
		t.Errorf("expected the second acquirer to wait for the first to unlock, got order %q then %q", first, second)
	}
}

func TestLocksDoesNotSerializeDifferentTunnelIDs(t *testing.T) {
	locks := NewLocks()
	done := make(chan struct{})

	unlockA := locks.Lock("tunnel-a")
	go func() {
		// Must be able to acquire a different tunnel's lock immediately,
		// without waiting for tunnel-a's lock (held above) to release.
		unlockB := locks.Lock("tunnel-b")
		unlockB()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("locking a different tunnel id blocked on an unrelated tunnel's lock")
	}
	unlockA()
}
