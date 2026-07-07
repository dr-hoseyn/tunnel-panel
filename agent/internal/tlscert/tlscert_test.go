package tlscert

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestLoadOrGenerateCreatesThenReuses(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "agent.crt")
	keyPath := filepath.Join(dir, "agent.key")

	if _, err := os.Stat(certPath); err == nil {
		t.Fatalf("cert already exists before first call")
	}

	cert1, err := LoadOrGenerate(certPath, keyPath)
	if err != nil {
		t.Fatalf("LoadOrGenerate (first call): %v", err)
	}
	if _, err := os.Stat(certPath); err != nil {
		t.Fatalf("cert file was not created: %v", err)
	}
	if _, err := os.Stat(keyPath); err != nil {
		t.Fatalf("key file was not created: %v", err)
	}

	firstCertBytes, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatalf("reading cert: %v", err)
	}

	cert2, err := LoadOrGenerate(certPath, keyPath)
	if err != nil {
		t.Fatalf("LoadOrGenerate (second call): %v", err)
	}
	secondCertBytes, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatalf("reading cert after second call: %v", err)
	}
	if string(firstCertBytes) != string(secondCertBytes) {
		t.Fatalf("second call regenerated the cert instead of reusing the existing one")
	}
	if len(cert1.Certificate) == 0 || len(cert2.Certificate) == 0 {
		t.Fatalf("loaded certificate has no DER-encoded chain")
	}
}

func TestFingerprintFormat(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "agent.crt")
	keyPath := filepath.Join(dir, "agent.key")

	if _, err := LoadOrGenerate(certPath, keyPath); err != nil {
		t.Fatalf("LoadOrGenerate: %v", err)
	}
	fp, err := FingerprintSHA256(certPath)
	if err != nil {
		t.Fatalf("FingerprintSHA256: %v", err)
	}
	// 32 bytes as uppercase hex pairs joined by ':' = 32*2 + 31 = 95 chars.
	matched, err := regexp.MatchString(`^([0-9A-F]{2}:){31}[0-9A-F]{2}$`, fp)
	if err != nil {
		t.Fatalf("regexp error: %v", err)
	}
	if !matched {
		t.Fatalf("fingerprint %q does not match the expected colon-separated uppercase hex format", fp)
	}
}

func TestFingerprintStableAcrossCalls(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "agent.crt")
	keyPath := filepath.Join(dir, "agent.key")
	if _, err := LoadOrGenerate(certPath, keyPath); err != nil {
		t.Fatalf("LoadOrGenerate: %v", err)
	}
	fp1, err := FingerprintSHA256(certPath)
	if err != nil {
		t.Fatalf("FingerprintSHA256 (1): %v", err)
	}
	fp2, err := FingerprintSHA256(certPath)
	if err != nil {
		t.Fatalf("FingerprintSHA256 (2): %v", err)
	}
	if fp1 != fp2 {
		t.Fatalf("fingerprint changed between calls on the same cert: %q vs %q", fp1, fp2)
	}
}
