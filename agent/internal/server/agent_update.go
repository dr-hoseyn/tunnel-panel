package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dr-hoseyn/tunnel-panel/agent/internal/version"
)

// Backs POST /api/v1/agent/update: checks GitHub for a newer tunnel-agent
// release than this process's own version.Version and, if one exists,
// downloads it, sanity-checks it, atomically swaps it in over this agent's
// own binary, and restarts the systemd unit so the new binary takes over.
//
// The GitHub-release lookup is structured as an injectable function
// (releaseFetcher, a field on Server) specifically so tests can fake it and
// never make a real network call -- see agent_update_test.go.

// updateRepo is where release binaries are published (see
// .github/workflows/build-agent.yml's "Attach to release" step).
const updateRepo = "dr-hoseyn/tunnel-panel"

// minUpdatedBinarySize is the smallest a legitimately-downloaded
// tunnel-agent binary could plausibly be. Guards against installing a
// truncated download or an HTML error page (e.g. a 404 that still returned
// HTTP 200 somewhere upstream) that would otherwise pass a bare
// "did the download succeed" check.
const minUpdatedBinarySize = 1 << 20 // 1 MiB

// latestRelease is the subset of a GitHub release the self-update flow
// needs: the tag (compared against version.Version to decide whether an
// update is actually available) and this OS/Arch's asset download URL.
type latestRelease struct {
	Tag         string
	DownloadURL string
}

// releaseFetcher resolves the latest available tunnel-agent release for
// this process's runtime.GOOS/GOARCH.
type releaseFetcher func(ctx context.Context) (*latestRelease, error)

// fetchLatestGitHubRelease is the production releaseFetcher: GitHub's
// releases/latest REST API, which returns the tag and every asset's
// download URL in one call -- unlike tunnels.latestGitHubReleaseTag's
// redirect trick (used by cores whose asset names embed the version), the
// agent's own asset names are fixed ("tunnel-agent-<os>-<arch>"), so what's
// needed here is the tag *and* a specific asset's URL together.
func fetchLatestGitHubRelease(ctx context.Context) (*latestRelease, error) {
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", updateRepo)
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("contacting GitHub: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub returned HTTP %d", resp.StatusCode)
	}
	var payload struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decoding GitHub response: %w", err)
	}
	wantAsset := fmt.Sprintf("tunnel-agent-%s-%s", runtime.GOOS, runtime.GOARCH)
	for _, a := range payload.Assets {
		if a.Name == wantAsset {
			return &latestRelease{Tag: payload.TagName, DownloadURL: a.BrowserDownloadURL}, nil
		}
	}
	return nil, fmt.Errorf("latest release %s has no asset named %q for this agent's OS/architecture", payload.TagName, wantAsset)
}

// releaseTagMatchesVersion compares a GitHub release tag (e.g. "v1.4.0")
// against version.Version. build-agent.yml sets Version directly from the
// release tag_name, so these are normally identical strings; the "v"-
// stripped comparison is just a safety net against a future tagging
// convention change causing a permanent "update available" false positive.
func releaseTagMatchesVersion(tag, ver string) bool {
	return tag == ver || strings.TrimPrefix(tag, "v") == strings.TrimPrefix(ver, "v")
}

// downloadToSibling streams url's body to a new, executable temp file in
// dir and returns its path. dir must be the same directory as this agent's
// own binary so the caller's later os.Rename is guaranteed atomic (rename
// across filesystems/mounts is not). Caller is responsible for removing the
// returned path on any later failure.
func downloadToSibling(ctx context.Context, url, dir string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("downloading %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("downloading %s: HTTP %d", url, resp.StatusCode)
	}
	tmp, err := os.CreateTemp(dir, ".tunnel-agent-update-*")
	if err != nil {
		return "", fmt.Errorf("creating temp file for update: %w", err)
	}
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", fmt.Errorf("writing downloaded binary: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("finalizing downloaded binary: %w", err)
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("making downloaded binary executable: %w", err)
	}
	return tmp.Name(), nil
}

// sanityCheckDownloadedBinary is a structural, non-executing check: the
// download actually completed with plausible content and (on POSIX) is
// marked executable. This deliberately does NOT exec the downloaded binary
// the way binaryRunsOK does for tunnel cores (backhaul/gost/...): unlike
// those, tunnel-agent itself has no safe no-op flag to sanity-run --
// invoked with no -init/-fingerprint flag it tries to bind its real listen
// port and serve traffic for real, which must not happen before the atomic
// swap below has even completed.
func sanityCheckDownloadedBinary(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("downloaded update is missing: %w", err)
	}
	if info.Size() < minUpdatedBinarySize {
		return fmt.Errorf("downloaded update is implausibly small (%d bytes) -- refusing to install", info.Size())
	}
	if runtime.GOOS != "windows" && info.Mode()&0o111 == 0 {
		return fmt.Errorf("downloaded update is not marked executable")
	}
	return nil
}

func (s *Server) handleAgentUpdate(w http.ResponseWriter, r *http.Request) {
	if version.Version == "" || version.Version == "dev" {
		writeError(w, http.StatusNotImplemented, "this agent build has no embedded version (a dev build) -- self-update is not available")
		return
	}

	release, err := s.fetchLatestRelease(r.Context())
	if err != nil {
		log.Printf("checking for agent updates: %v", err)
		writeError(w, http.StatusBadGateway, "checking GitHub for the latest release failed: "+err.Error())
		return
	}
	if releaseTagMatchesVersion(release.Tag, version.Version) {
		writeJSON(w, http.StatusOK, map[string]string{
			"status":          "already up to date",
			"current_version": version.Version,
			"latest_version":  release.Tag,
		})
		return
	}

	self, err := s.selfExecutable()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "locating this agent's own binary: "+err.Error())
		return
	}

	tmpPath, err := downloadToSibling(r.Context(), release.DownloadURL, filepath.Dir(self))
	if err != nil {
		log.Printf("downloading agent update: %v", err)
		writeError(w, http.StatusBadGateway, "downloading the new agent binary failed: "+err.Error())
		return
	}
	if err := sanityCheckDownloadedBinary(tmpPath); err != nil {
		os.Remove(tmpPath)
		log.Printf("agent update sanity check failed: %v", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := os.Rename(tmpPath, self); err != nil {
		os.Remove(tmpPath)
		log.Printf("installing agent update: %v", err)
		writeError(w, http.StatusInternalServerError, "installing the new agent binary failed: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status":           "updated",
		"previous_version": version.Version,
		"new_version":      release.Tag,
	})
	// Same respond-then-act-via-delayed-goroutine pattern as
	// handleAgentRestart: the restart kills the process handling this very
	// request, so it can't happen synchronously before the response above
	// is flushed.
	go func() {
		time.Sleep(300 * time.Millisecond)
		if err := exec.Command("systemctl", "restart", "tunnel-agent.service").Run(); err != nil {
			log.Printf("agent restart after update failed: %v", err)
		}
	}()
}
