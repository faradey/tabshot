package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DefaultPort is where the daemon listens on 127.0.0.1 unless --port says otherwise.
const DefaultPort = 47831

// ConfigDir is ~/.config/tabshot (or $XDG_CONFIG_HOME/tabshot).
func ConfigDir() (string, error) {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "tabshot"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "tabshot"), nil
}

// TokenPath is the file that holds the shared secret between the daemon, the
// CLI and the extension. Anything on this machine that can read it can drive
// the tab; that is the same trust as being able to run the CLI at all.
func TokenPath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "token"), nil
}

// ReadToken returns the token, or an error saying the daemon has never run.
func ReadToken() (string, error) {
	p, err := TokenPath()
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("no token at %s — run `tabshot serve` once to create it", p)
	}
	if err != nil {
		return "", err
	}
	t := strings.TrimSpace(string(b))
	if t == "" {
		return "", fmt.Errorf("token file %s is empty", p)
	}
	return t, nil
}

// EnsureToken creates the token on first run and returns it.
func EnsureToken() (string, error) {
	if t, err := ReadToken(); err == nil {
		return t, nil
	}
	p, err := TokenPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return "", err
	}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	t := hex.EncodeToString(raw)
	if err := os.WriteFile(p, []byte(t+"\n"), 0o600); err != nil {
		return "", err
	}
	return t, nil
}
