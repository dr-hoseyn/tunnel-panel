package tunnels

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Shared primitives every core driver builds on: subprocess execution,
// systemd control, firewall rules, binary installation. Every exec.Command
// call here uses an argv slice, never a shell string -- nothing in this
// file (or any driver) ever passes caller-influenced data through /bin/sh.

const execTimeout = 15 * time.Second

func runCommand(ctx context.Context, name string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, execTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, name, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("running %s %v: %w (output: %s)", name, args, err, strings.TrimSpace(out.String()))
	}
	return out.String(), nil
}

func systemctl(ctx context.Context, args ...string) (string, error) {
	return runCommand(ctx, "systemctl", args...)
}

// systemctlIsActive reports whether unit is active, treating "inactive"
// (systemctl's non-zero exit for a stopped-but-known unit) as false rather
// than an error.
func systemctlIsActive(ctx context.Context, unit string) bool {
	out, _ := runCommand(ctx, "systemctl", "is-active", unit)
	return strings.TrimSpace(out) == "active"
}

// systemctlIPBytes reads the systemd IPAccounting counters for unit
// (every driver's generated unit sets IPAccounting=yes) -- gives a real
// traffic-activity signal for Health without any core-specific stats
// support, and without the agent tracking packet counters itself.
func systemctlIPBytes(ctx context.Context, unit string) (rx, tx uint64) {
	out, err := runCommand(ctx, "systemctl", "show", unit, "-p", "IPIngressBytes", "-p", "IPEgressBytes")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "IPIngressBytes="):
			rx, _ = strconv.ParseUint(strings.TrimPrefix(line, "IPIngressBytes="), 10, 64)
		case strings.HasPrefix(line, "IPEgressBytes="):
			tx, _ = strconv.ParseUint(strings.TrimPrefix(line, "IPEgressBytes="), 10, 64)
		}
	}
	return rx, tx
}

// clampJournalLines keeps a caller-supplied line count sane: 0 or negative
// means "use a sensible default" rather than "no output", and an unbounded
// value is capped so a huge/malicious `lines` query param can't turn a log
// fetch into a multi-thousand-line journal dump.
func clampJournalLines(lines int) int {
	if lines <= 0 {
		return 200
	}
	if lines > 2000 {
		return 2000
	}
	return lines
}

// JournalctlLogs runs `journalctl -u <unit> -n <lines> --no-pager` for unit
// (an argv slice, never a shell string -- see this file's header comment)
// and splits its stdout into lines. Exported so both the per-tunnel
// Driver.Logs implementations (see base.go, gost.go) and
// /api/v1/agent/logs (the agent's own unit) share one implementation.
func JournalctlLogs(ctx context.Context, unit string, lines int) ([]string, error) {
	lines = clampJournalLines(lines)
	out, err := runCommand(ctx, "journalctl", "-u", unit, "-n", strconv.Itoa(lines), "--no-pager", "-o", "short-iso")
	if err != nil {
		return nil, err
	}
	var result []string
	for _, line := range strings.Split(out, "\n") {
		if line != "" {
			result = append(result, line)
		}
	}
	return result, nil
}

// portOpen reports whether something is accepting TCP connections on
// 127.0.0.1:port -- a real "is this actually listening" check, not just
// "is the unit active".
func portOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 2*time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// udpPortInUse reports whether something is already bound to port/udp, by
// attempting to bind it ourselves: failure means occupied. UDP has no
// connection handshake to dial the way portOpen does for TCP, so "can we
// grab this port" is the standard way to check "is something listening
// here" for QUIC-based cores (Hysteria2).
func udpPortInUse(port int) bool {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		return true
	}
	_ = conn.Close()
	return false
}

// allowFirewallPort opens port/proto for inbound traffic, preferring ufw
// (matching this project's existing pattern -- see panel/install.sh's "Open
// the agent's port in ufw during install") and falling back to a direct,
// idempotent iptables INPUT ACCEPT rule.
func allowFirewallPort(ctx context.Context, port int, proto string) error {
	if _, err := exec.LookPath("ufw"); err == nil {
		_, err := runCommand(ctx, "ufw", "allow", fmt.Sprintf("%d/%s", port, proto))
		return err
	}
	if _, err := exec.LookPath("iptables"); err == nil {
		portStr := strconv.Itoa(port)
		if _, checkErr := runCommand(ctx, "iptables", "-C", "INPUT", "-p", proto, "--dport", portStr, "-j", "ACCEPT"); checkErr == nil {
			return nil // rule already present
		}
		_, err := runCommand(ctx, "iptables", "-A", "INPUT", "-p", proto, "--dport", portStr, "-j", "ACCEPT")
		return err
	}
	return fmt.Errorf("neither ufw nor iptables found -- cannot open port %d", port)
}

// removeFirewallPort undoes allowFirewallPort. Best-effort and silent on
// "rule not found": Remove() must still succeed even if the rule was never
// applied (e.g. ConfigureFirewall failed earlier in a rolled-back deploy).
func removeFirewallPort(ctx context.Context, port int, proto string) {
	if _, err := exec.LookPath("ufw"); err == nil {
		_, _ = runCommand(ctx, "ufw", "delete", "allow", fmt.Sprintf("%d/%s", port, proto))
		return
	}
	if _, err := exec.LookPath("iptables"); err == nil {
		_, _ = runCommand(ctx, "iptables", "-D", "INPUT", "-p", proto, "--dport", strconv.Itoa(port), "-j", "ACCEPT")
	}
}

// binaryRunsOK is the install sanity check every driver uses after
// downloading/extracting a core binary: it exists and doesn't immediately
// fail when asked for its version.
func binaryRunsOK(ctx context.Context, path string, versionArg string) bool {
	if _, err := os.Stat(path); err != nil {
		return false
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return exec.CommandContext(cctx, path, versionArg).Run() == nil
}

// downloadAndExtractTarGz downloads a .tar.gz from url, finds the entry
// named wantFile inside it, and atomically writes it to destDir/wantFile
// (mode 0755). Pure stdlib (archive/tar + compress/gzip) -- no shelling out
// to `tar`, keeping the agent's zero-third-party-dependency posture.
func downloadAndExtractTarGz(ctx context.Context, url, wantFile, destDir string) error {
	body, err := httpGet(ctx, url)
	if err != nil {
		return err
	}
	defer body.Close()
	gz, err := gzip.NewReader(body)
	if err != nil {
		return fmt.Errorf("reading gzip stream from %s: %w", url, err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("archive from %s did not contain %q", url, wantFile)
		}
		if err != nil {
			return fmt.Errorf("reading archive from %s: %w", url, err)
		}
		if filepath.Base(hdr.Name) != wantFile || hdr.Typeflag != tar.TypeReg {
			continue
		}
		return writeExtractedFile(tr, destDir, wantFile)
	}
}

// downloadAndExtractZip is downloadAndExtractTarGz's zip-archive
// counterpart (Rathole ships as .zip, not .tar.gz).
func downloadAndExtractZip(ctx context.Context, url, wantFile, destDir string) error {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("downloading %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading %s: HTTP %d", url, resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading %s: %w", url, err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("reading zip archive from %s: %w", url, err)
	}
	for _, f := range zr.File {
		if filepath.Base(f.Name) != wantFile || f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("opening %s in archive: %w", wantFile, err)
		}
		defer rc.Close()
		return writeExtractedFile(rc, destDir, wantFile)
	}
	return fmt.Errorf("archive from %s did not contain %q", url, wantFile)
}

// downloadBinary downloads a single, non-archived binary from url straight
// to destDir/wantFile (mode 0755), atomically. Used by cores (Hysteria2)
// that publish a raw binary release asset rather than a tar.gz/zip.
func downloadBinary(ctx context.Context, url, destDir, wantFile string) error {
	body, err := httpGet(ctx, url)
	if err != nil {
		return err
	}
	defer body.Close()
	return writeExtractedFile(body, destDir, wantFile)
}

func writeExtractedFile(r io.Reader, destDir, wantFile string) error {
	tmp := filepath.Join(destDir, "."+wantFile+".tmp")
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return fmt.Errorf("writing %s: %w", wantFile, err)
	}
	if _, err := io.Copy(out, r); err != nil {
		out.Close()
		os.Remove(tmp)
		return fmt.Errorf("extracting %s: %w", wantFile, err)
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("finalizing %s: %w", wantFile, err)
	}
	dest := filepath.Join(destDir, wantFile)
	if err := os.Rename(tmp, dest); err != nil {
		return fmt.Errorf("installing %s: %w", wantFile, err)
	}
	return nil
}

// latestGitHubReleaseTag resolves a repo's latest release tag via the
// redirect GitHub's own /releases/latest page issues -- the same technique
// the bash reference uses via `curl -w '%{url_effective}'`, just read from
// the Location header directly instead of following the redirect. No
// GitHub API token needed. Used by cores (GOST) whose release asset
// filenames embed the version number, so the simpler
// releases/latest/download/<asset> shortcut the other drivers use doesn't
// apply.
func latestGitHubReleaseTag(ctx context.Context, repo string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, fmt.Sprintf("https://github.com/%s/releases/latest", repo), nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("resolving latest release for %s: %w", repo, err)
	}
	defer resp.Body.Close()
	loc := resp.Header.Get("Location")
	if loc == "" {
		return "", fmt.Errorf("no redirect returned from releases/latest for %s (got HTTP %d)", repo, resp.StatusCode)
	}
	idx := strings.LastIndex(loc, "/")
	if idx < 0 || idx == len(loc)-1 {
		return "", fmt.Errorf("could not parse a tag from redirect location %q", loc)
	}
	return loc[idx+1:], nil
}

func httpGet(ctx context.Context, url string) (io.ReadCloser, error) {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("downloading %s: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		return nil, fmt.Errorf("downloading %s: HTTP %d", url, resp.StatusCode)
	}
	return &cancelOnCloseBody{ReadCloser: resp.Body, cancel: cancel}, nil
}

// cancelOnCloseBody releases the context timeout set up by httpGet once
// the caller is done reading, instead of leaking it until the deadline.
type cancelOnCloseBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelOnCloseBody) Close() error {
	defer b.cancel()
	return b.ReadCloser.Close()
}
