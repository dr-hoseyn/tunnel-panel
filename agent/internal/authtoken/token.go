// Package authtoken handles the agent's bearer-token authentication: a
// single shared secret generated once at install time, hashed at rest, and
// checked in constant time on every authenticated request. The raw token is
// shown exactly once (at generation) and never written to disk or logged.
package authtoken

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Generate returns a new random 32-byte token, hex-encoded.
func Generate() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generating token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// Hash returns the SHA-256 hex digest of a token, for storage/comparison.
func Hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// SaveHash writes the token's hash to path, creating parent directories as
// needed. The raw token itself is never written to disk.
func SaveHash(path, token string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("creating token dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(Hash(token)+"\n"), 0o600); err != nil {
		return fmt.Errorf("writing token hash: %w", err)
	}
	return nil
}

// LoadHash reads a previously saved token hash from path.
func LoadHash(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading token hash: %w", err)
	}
	return strings.TrimSpace(string(b)), nil
}

// Verify reports whether the supplied token matches the stored hash, using
// a constant-time comparison so response timing can't be used to guess the
// token byte-by-byte.
func Verify(storedHash, suppliedToken string) bool {
	if storedHash == "" || suppliedToken == "" {
		return false
	}
	suppliedHash := Hash(suppliedToken)
	return subtle.ConstantTimeCompare([]byte(storedHash), []byte(suppliedHash)) == 1
}
