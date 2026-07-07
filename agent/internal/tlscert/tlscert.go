// Package tlscert generates and loads a self-signed TLS certificate for the
// agent's HTTPS listener. Same trust model the bash side already uses for
// Backhaul/Hysteria2/TUIC: a self-signed cert per server, no CA involved —
// the panel pins this cert's fingerprint on first connect (trust-on-first-
// use) rather than validating against a public CA chain.
package tlscert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LoadOrGenerate returns a tls.Certificate loaded from certPath/keyPath,
// generating and persisting a new self-signed one (365-day validity, ECDSA
// P-256) if either file is missing.
func LoadOrGenerate(certPath, keyPath string) (tls.Certificate, error) {
	if _, err := os.Stat(certPath); err == nil {
		if _, err := os.Stat(keyPath); err == nil {
			return tls.LoadX509KeyPair(certPath, keyPath)
		}
	}
	return generate(certPath, keyPath)
}

// FingerprintSHA256 returns the cert's SHA-256 fingerprint as a colon-
// separated uppercase hex string (the format panels/browsers conventionally
// display, and the format the panel should show the operator to verify
// out-of-band when registering a new server).
func FingerprintSHA256(certPath string) (string, error) {
	pemBytes, err := os.ReadFile(certPath)
	if err != nil {
		return "", fmt.Errorf("reading cert: %w", err)
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return "", fmt.Errorf("no PEM block found in %s", certPath)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", fmt.Errorf("parsing cert: %w", err)
	}
	sum := sha256.Sum256(cert.Raw)
	return sha256HexColon(sum[:]), nil
}

func sha256HexColon(sum []byte) string {
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}

func generate(certPath, keyPath string) (tls.Certificate, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generating key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generating serial: %w", err)
	}
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "tunnel-agent"},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("creating certificate: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(certPath), 0o700); err != nil {
		return tls.Certificate{}, fmt.Errorf("creating cert dir: %w", err)
	}

	certOut, err := os.OpenFile(certPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("opening cert file: %w", err)
	}
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes}); err != nil {
		certOut.Close()
		return tls.Certificate{}, fmt.Errorf("writing cert: %w", err)
	}
	if err := certOut.Close(); err != nil {
		return tls.Certificate{}, fmt.Errorf("closing cert file: %w", err)
	}

	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("opening key file: %w", err)
	}
	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		keyOut.Close()
		return tls.Certificate{}, fmt.Errorf("marshaling key: %w", err)
	}
	if err := pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes}); err != nil {
		keyOut.Close()
		return tls.Certificate{}, fmt.Errorf("writing key: %w", err)
	}
	if err := keyOut.Close(); err != nil {
		return tls.Certificate{}, fmt.Errorf("closing key file: %w", err)
	}

	return tls.LoadX509KeyPair(certPath, keyPath)
}
