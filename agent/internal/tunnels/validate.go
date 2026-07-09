package tunnels

import (
	"fmt"
	"net"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// This file is the one guard standing between "value from an HTTP request
// body" and "argv passed to exec.Command / a path on disk / a systemd unit
// name" -- every field of Spec goes through one of these before a driver
// ever touches the filesystem or a subprocess. Deliberately allowlist-based
// (reject anything outside a known-safe charset) rather than trying to
// escape/quote a shell string, because no driver in this package ever
// builds a shell string in the first place -- every exec.Command call uses
// an argv slice.

var tunnelIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

// ValidateTunnelID rejects anything unsafe to embed directly into a
// filesystem path or systemd unit name: lowercase alnum + dash only,
// 1-48 chars, must start with an alnum (so it can never start with "-" and
// be mistaken for a flag by anything that later globs/iterates these ids).
func ValidateTunnelID(id string) error {
	if !tunnelIDPattern.MatchString(id) {
		return fmt.Errorf("invalid tunnel id %q: must be 1-48 lowercase letters, digits, or dashes, starting with a letter or digit", id)
	}
	return nil
}

// ValidatePort rejects anything outside the valid TCP/UDP port range.
func ValidatePort(port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("invalid port %d: must be between 1 and 65535", port)
	}
	return nil
}

var hostnamePattern = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$`)

// ValidateHostname accepts a bare hostname or IP literal -- no scheme, no
// path, no port. Deliberately conservative: only what net.Dial itself needs.
func ValidateHostname(host string) error {
	if host == "" {
		return fmt.Errorf("hostname must not be empty")
	}
	if net.ParseIP(host) != nil {
		return nil
	}
	if !hostnamePattern.MatchString(host) {
		return fmt.Errorf("invalid hostname %q", host)
	}
	return nil
}

// ValidatePeerAddr validates a "host:port" pair as used for Spec.Peer.
func ValidatePeerAddr(addr string) error {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid peer address %q: expected host:port", addr)
	}
	if err := ValidateHostname(host); err != nil {
		return err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return fmt.Errorf("invalid port in peer address %q", addr)
	}
	return ValidatePort(port)
}

var filenamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)

// ValidateFilename rejects path separators, traversal segments, and
// anything outside a conservative charset -- for any value that becomes
// (part of) a filename under the agent's own data directory.
func ValidateFilename(name string) error {
	if name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return fmt.Errorf("invalid filename %q", name)
	}
	if !filenamePattern.MatchString(name) {
		return fmt.Errorf("invalid filename %q: must be alnum/dot/dash/underscore only", name)
	}
	return nil
}

// SafeJoin joins base and name, then verifies the result is still lexically
// within base. Defense in depth alongside ValidateFilename/ValidateTunnelID
// at every call site that builds a path from a caller-influenced value, in
// case a validator's allowlist is ever loosened without re-auditing every
// caller.
func SafeJoin(base, name string) (string, error) {
	joined := filepath.Join(base, name)
	baseClean := filepath.Clean(base)
	if joined != baseClean && !strings.HasPrefix(joined, baseClean+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q escapes base directory %q", name, base)
	}
	return joined, nil
}

// Validate checks every field of Spec relevant to its Role, so a driver's
// Install/WriteConfig never has to re-derive "is this actually safe to use".
func (s Spec) Validate() error {
	if err := ValidateTunnelID(s.ID); err != nil {
		return err
	}
	switch s.Role {
	case RoleServer:
		if err := ValidatePort(s.Port); err != nil {
			return fmt.Errorf("server role: %w", err)
		}
	case RoleClient:
		if s.Peer == "" {
			return fmt.Errorf("client role requires a peer address")
		}
		if err := ValidatePeerAddr(s.Peer); err != nil {
			return err
		}
	default:
		return fmt.Errorf("invalid role %q: must be %q or %q", s.Role, RoleServer, RoleClient)
	}
	if s.Secret == "" {
		return fmt.Errorf("secret must not be empty")
	}
	for _, p := range s.Ports {
		if err := ValidatePort(p.Remote); err != nil {
			return fmt.Errorf("port mapping remote: %w", err)
		}
		if err := ValidatePort(p.Local); err != nil {
			return fmt.Errorf("port mapping local: %w", err)
		}
	}
	return nil
}
