package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/version"
)

// withVersion temporarily overrides version.Version for the duration of a
// test -- handleAgentUpdate's dev-build guard checks it directly, so tests
// that need to get past that guard have to set a real-looking version.
func withVersion(t *testing.T, v string) {
	t.Helper()
	original := version.Version
	version.Version = v
	t.Cleanup(func() { version.Version = original })
}

func TestReleaseTagMatchesVersion(t *testing.T) {
	cases := []struct {
		tag, ver string
		want     bool
	}{
		{"v1.2.3", "v1.2.3", true},
		{"v1.2.3", "1.2.3", true},
		{"1.2.3", "v1.2.3", true},
		{"v1.2.3", "v1.2.4", false},
		{"", "", true},
	}
	for _, c := range cases {
		if got := releaseTagMatchesVersion(c.tag, c.ver); got != c.want {
			t.Errorf("releaseTagMatchesVersion(%q, %q) = %v, want %v", c.tag, c.ver, got, c.want)
		}
	}
}

func TestSanityCheckDownloadedBinaryTooSmall(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tiny")
	if err := os.WriteFile(path, []byte("not a real binary"), 0o755); err != nil {
		t.Fatalf("writing test file: %v", err)
	}
	if err := sanityCheckDownloadedBinary(path); err == nil {
		t.Error("expected an error for an implausibly small file")
	}
}

func TestSanityCheckDownloadedBinaryMissing(t *testing.T) {
	if err := sanityCheckDownloadedBinary(filepath.Join(t.TempDir(), "does-not-exist")); err == nil {
		t.Error("expected an error for a missing file")
	}
}

func TestSanityCheckDownloadedBinaryPlausible(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "plausible")
	payload := bytes.Repeat([]byte{0x7f}, minUpdatedBinarySize+1)
	if err := os.WriteFile(path, payload, 0o755); err != nil {
		t.Fatalf("writing test file: %v", err)
	}
	if err := sanityCheckDownloadedBinary(path); err != nil {
		t.Errorf("expected a plausibly-sized, executable file to pass, got: %v", err)
	}
}

func TestSanityCheckDownloadedBinaryNotExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable-bit check does not apply on windows")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "not-executable")
	payload := bytes.Repeat([]byte{0x7f}, minUpdatedBinarySize+1)
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		t.Fatalf("writing test file: %v", err)
	}
	if err := sanityCheckDownloadedBinary(path); err == nil {
		t.Error("expected an error for a non-executable file")
	}
}

func TestDownloadToSibling(t *testing.T) {
	payload := []byte("fake binary content")
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))
	defer ts.Close()

	dir := t.TempDir()
	path, err := downloadToSibling(context.Background(), ts.URL, dir)
	if err != nil {
		t.Fatalf("downloadToSibling: %v", err)
	}
	defer os.Remove(path)

	if filepath.Dir(path) != dir {
		t.Errorf("expected the temp file to live in %q, got %q", dir, path)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading downloaded file: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("expected downloaded content %q, got %q", payload, got)
	}
}

func TestDownloadToSiblingHTTPError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	if _, err := downloadToSibling(context.Background(), ts.URL, t.TempDir()); err == nil {
		t.Error("expected an error for a non-200 download response")
	}
}

func TestAgentUpdateRequiresAuth(t *testing.T) {
	s, _ := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/update", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestAgentUpdateRefusesOnDevBuild(t *testing.T) {
	// version.Version defaults to "dev" outside of a real ldflags build --
	// exactly the case this guard exists for.
	withVersion(t, "dev")
	s, token := newTestServer(fakeRunner{}, "correct-token")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/update", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("expected 501 on a dev build, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAgentUpdateAlreadyUpToDate(t *testing.T) {
	withVersion(t, "v1.0.0")
	s, token := newTestServer(fakeRunner{}, "correct-token")
	s.fetchLatestRelease = func(ctx context.Context) (*latestRelease, error) {
		return &latestRelease{Tag: "v1.0.0", DownloadURL: "https://example.invalid/should-not-be-fetched"}, nil
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/update", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if body["status"] != "already up to date" {
		t.Errorf("expected status='already up to date', got %v", body)
	}
}

func TestAgentUpdateFetchFails(t *testing.T) {
	withVersion(t, "v1.0.0")
	s, token := newTestServer(fakeRunner{}, "correct-token")
	s.fetchLatestRelease = func(ctx context.Context) (*latestRelease, error) {
		return nil, errors.New("simulated GitHub outage")
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/update", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAgentUpdateSanityCheckFailsLeavesOriginalInPlace(t *testing.T) {
	withVersion(t, "v1.0.0")
	s, token := newTestServer(fakeRunner{}, "correct-token")

	selfDir := t.TempDir()
	selfPath := filepath.Join(selfDir, "tunnel-agent")
	original := []byte("original binary content")
	if err := os.WriteFile(selfPath, original, 0o755); err != nil {
		t.Fatalf("seeding original binary: %v", err)
	}
	s.selfExecutable = func() (string, error) { return selfPath, nil }

	// Too small to pass sanityCheckDownloadedBinary.
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("way too small to be a real agent binary"))
	}))
	defer ts.Close()
	s.fetchLatestRelease = func(ctx context.Context) (*latestRelease, error) {
		return &latestRelease{Tag: "v2.0.0", DownloadURL: ts.URL}, nil
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/update", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d: %s", rec.Code, rec.Body.String())
	}

	got, err := os.ReadFile(selfPath)
	if err != nil {
		t.Fatalf("reading self path after failed update: %v", err)
	}
	if !bytes.Equal(got, original) {
		t.Error("expected the original binary to be left untouched after a failed sanity check")
	}
}

func TestAgentUpdateHappyPathSwapsBinary(t *testing.T) {
	withVersion(t, "v1.0.0")
	s, token := newTestServer(fakeRunner{}, "correct-token")

	selfDir := t.TempDir()
	selfPath := filepath.Join(selfDir, "tunnel-agent")
	if err := os.WriteFile(selfPath, []byte("old binary content"), 0o755); err != nil {
		t.Fatalf("seeding original binary: %v", err)
	}
	s.selfExecutable = func() (string, error) { return selfPath, nil }

	newContent := bytes.Repeat([]byte{0x7f}, minUpdatedBinarySize+1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(newContent)
	}))
	defer ts.Close()
	s.fetchLatestRelease = func(ctx context.Context) (*latestRelease, error) {
		return &latestRelease{Tag: "v2.0.0", DownloadURL: ts.URL}, nil
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/update", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if body["status"] != "updated" || body["new_version"] != "v2.0.0" {
		t.Errorf("unexpected response body: %v", body)
	}

	got, err := os.ReadFile(selfPath)
	if err != nil {
		t.Fatalf("reading self path after update: %v", err)
	}
	if !bytes.Equal(got, newContent) {
		t.Error("expected the binary at selfPath to be replaced with the downloaded content")
	}
}
