package authtoken

import (
	"path/filepath"
	"testing"
)

func TestGenerateProducesDistinctTokens(t *testing.T) {
	a, err := Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	b, err := Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if a == b {
		t.Fatalf("two calls to Generate produced the same token")
	}
	if len(a) != 64 { // 32 bytes hex-encoded
		t.Fatalf("expected a 64-char hex token, got %d chars: %q", len(a), a)
	}
}

func TestVerifyRoundTrip(t *testing.T) {
	token, err := Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	hash := Hash(token)
	if !Verify(hash, token) {
		t.Fatalf("Verify rejected the correct token")
	}
	if Verify(hash, "wrong-token") {
		t.Fatalf("Verify accepted an incorrect token")
	}
	if Verify(hash, "") {
		t.Fatalf("Verify accepted an empty token")
	}
	if Verify("", token) {
		t.Fatalf("Verify accepted against an empty stored hash")
	}
}

func TestSaveAndLoadHash(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "token.hash")

	token, err := Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if err := SaveHash(path, token); err != nil {
		t.Fatalf("SaveHash: %v", err)
	}
	loaded, err := LoadHash(path)
	if err != nil {
		t.Fatalf("LoadHash: %v", err)
	}
	if loaded != Hash(token) {
		t.Fatalf("loaded hash %q does not match Hash(token) %q", loaded, Hash(token))
	}
	if !Verify(loaded, token) {
		t.Fatalf("Verify failed against the loaded hash")
	}
}

func TestSaveHashNeverWritesRawToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token.hash")
	token := "super-secret-raw-token-value"
	if err := SaveHash(path, token); err != nil {
		t.Fatalf("SaveHash: %v", err)
	}
	loaded, err := LoadHash(path)
	if err != nil {
		t.Fatalf("LoadHash: %v", err)
	}
	if loaded == token {
		t.Fatalf("the raw token was written to disk verbatim")
	}
}
