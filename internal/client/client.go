// Package client is every subcommand except serve: build one command, post it
// to the daemon, print the answer, save the PNG if there is one.
package client

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/faradey/tabshot/internal/daemon"
)

type result struct {
	OK       bool     `json:"ok"`
	Error    string   `json:"error"`
	PNG      string   `json:"png"`
	Open     *bool    `json:"open"`
	Tabs     *int     `json:"tabs"`
	Allowed  []string `json:"allowed"`
	Viewport *struct {
		W   int     `json:"w"`
		H   int     `json:"h"`
		DPR float64 `json:"dpr"`
	} `json:"viewport"`
	Image *struct {
		W      int     `json:"w"`
		H      int     `json:"h"`
		Scale  float64 `json:"scale"`
		Origin struct {
			X int `json:"x"`
			Y int `json:"y"`
		} `json:"origin"`
	} `json:"image"`
}

// Token is `tabshot token [--copy]`.
func Token(args []string) int {
	fs := flag.NewFlagSet("token", flag.ContinueOnError)
	cp := fs.Bool("copy", false, "copy to the clipboard instead of printing (macOS pbcopy)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	t, err := daemon.ReadToken()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if !*cp {
		fmt.Println(t)
		return 0
	}
	if runtime.GOOS != "darwin" {
		fmt.Fprintln(os.Stderr, "--copy uses pbcopy and needs macOS")
		return 1
	}
	c := exec.Command("pbcopy")
	c.Stdin = strings.NewReader(t)
	if err := c.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println("token copied to the clipboard — paste it into the extension's options")
	return 0
}

// Run is every tab command.
func Run(cmd string, args []string) int {
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	domain := fs.String("domain", "", "domain whose tab to act on (required)")
	port := fs.Int("port", daemon.DefaultPort, "daemon port")
	timeout := fs.Float64("timeout", 60, "seconds to wait for the extension")
	out := fs.String("out", "", "shot: file to write (default tabshot-<time>.png)")
	shot := fs.String("shot", "", "take a screenshot after the action and write it here")
	zoom := fs.String("zoom", "", "shot: X,Y,W,H region of the viewport, saved at device resolution")
	width := fs.Int("width", 800, "downscale the screenshot to this width; 0 or --full keeps the viewport size")
	full := fs.Bool("full", false, "screenshot at viewport size (for pictures that will be published)")
	at := fs.String("at", "", "type/scroll: X,Y point to act at")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	pos := fs.Args()

	body := map[string]any{"action": cmd, "timeout": *timeout}
	if *domain != "" {
		body["domain"] = *domain
	} else if cmd != "status" {
		fmt.Fprintln(os.Stderr, "--domain is required")
		return 2
	}

	need := func(n int) bool {
		if len(pos) != n {
			fmt.Fprintf(os.Stderr, "%s takes %d positional argument(s), got %d\n", cmd, n, len(pos))
			return false
		}
		return true
	}
	pt := func(s string) (int, int, bool) {
		xy := strings.Split(s, ",")
		if len(xy) != 2 {
			fmt.Fprintf(os.Stderr, "expected X,Y, got %q\n", s)
			return 0, 0, false
		}
		x, e1 := strconv.Atoi(strings.TrimSpace(xy[0]))
		y, e2 := strconv.Atoi(strings.TrimSpace(xy[1]))
		if e1 != nil || e2 != nil {
			fmt.Fprintf(os.Stderr, "expected integer X,Y, got %q\n", s)
			return 0, 0, false
		}
		return x, y, true
	}
	ints := func(ss ...string) ([]int, bool) {
		r := make([]int, len(ss))
		for i, s := range ss {
			n, err := strconv.Atoi(s)
			if err != nil {
				fmt.Fprintf(os.Stderr, "expected an integer, got %q\n", s)
				return nil, false
			}
			r[i] = n
		}
		return r, true
	}

	switch cmd {
	case "status", "refresh":
		if !need(0) {
			return 2
		}
	case "shot":
		if !need(0) {
			return 2
		}
		if *zoom != "" {
			f := strings.Split(*zoom, ",")
			if len(f) != 4 {
				fmt.Fprintln(os.Stderr, "--zoom wants X,Y,W,H")
				return 2
			}
			v, ok := ints(f...)
			if !ok {
				return 2
			}
			body["zoom"] = map[string]int{"x": v[0], "y": v[1], "w": v[2], "h": v[3]}
		}
	case "click":
		if !need(2) {
			return 2
		}
		v, ok := ints(pos...)
		if !ok {
			return 2
		}
		body["x"], body["y"] = v[0], v[1]
	case "type":
		if !need(1) {
			return 2
		}
		body["text"] = pos[0]
	case "key":
		if !need(1) {
			return 2
		}
		body["key"] = pos[0]
	case "scroll":
		if !need(2) {
			return 2
		}
		v, ok := ints(pos...)
		if !ok {
			return 2
		}
		body["dx"], body["dy"] = v[0], v[1]
	case "resize":
		if !need(2) {
			return 2
		}
		v, ok := ints(pos...)
		if !ok {
			return 2
		}
		body["w"], body["h"] = v[0], v[1]
	}
	if *at != "" {
		x, y, ok := pt(*at)
		if !ok {
			return 2
		}
		body["x"], body["y"] = x, y
	}
	if *shot != "" {
		body["shot"] = true
	}
	if *width > 0 && !*full {
		body["width"] = *width
	}

	res, err := post(*port, body, time.Duration(*timeout*float64(time.Second))+5*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	if !res.OK {
		if res.Error == "" {
			res.Error = "extension answered without a reason"
		}
		fmt.Fprintln(os.Stderr, "error:", res.Error)
		return 1
	}

	switch cmd {
	case "status":
		if res.Open != nil {
			n := 0
			if res.Tabs != nil {
				n = *res.Tabs
			}
			if *res.Open {
				fmt.Printf("tab for %s: open (%d)\n", *domain, n)
			} else {
				fmt.Printf("tab for %s: not open\n", *domain)
			}
		} else {
			fmt.Println("extension: connected")
			if len(res.Allowed) > 0 {
				fmt.Println("allowed:", strings.Join(res.Allowed, " "))
			} else {
				fmt.Println("allowed: (none — add domains in the extension's options)")
			}
		}
	default:
		fmt.Println("ok")
	}

	if res.PNG != "" {
		file := *shot
		if cmd == "shot" {
			file = *out
			if file == "" {
				file = "tabshot-" + time.Now().Format("150405") + ".png"
			}
		}
		raw, err := base64.StdEncoding.DecodeString(res.PNG)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error: bad png from extension:", err)
			return 1
		}
		if err := os.WriteFile(file, raw, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			return 1
		}
		line := fmt.Sprintf("saved %s", file)
		if res.Image != nil {
			line += fmt.Sprintf(" %dx%d", res.Image.W, res.Image.H)
			switch {
			case res.Image.Scale < 1:
				line += fmt.Sprintf(" — downscaled: viewport X = imageX/%.4g, Y = imageY/%.4g", res.Image.Scale, res.Image.Scale)
			case res.Image.Scale != 1:
				line += fmt.Sprintf(" — zoom of %d,%d at %gx: viewport X = %d + imageX/%g, Y = %d + imageY/%g",
					res.Image.Origin.X, res.Image.Origin.Y, res.Image.Scale,
					res.Image.Origin.X, res.Image.Scale, res.Image.Origin.Y, res.Image.Scale)
			}
		}
		if res.Viewport != nil {
			line += fmt.Sprintf("; viewport %dx%d dpr %g", res.Viewport.W, res.Viewport.H, res.Viewport.DPR)
		}
		fmt.Println(line)
	} else if res.Viewport != nil && cmd == "resize" {
		fmt.Printf("viewport %dx%d dpr %g\n", res.Viewport.W, res.Viewport.H, res.Viewport.DPR)
	}
	return 0
}

func post(port int, body map[string]any, wait time.Duration) (*result, error) {
	token, err := daemon.ReadToken()
	if err != nil {
		return nil, err
	}
	enc, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/cmd", port), bytes.NewReader(enc))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Tabshot-Token", token)
	c := &http.Client{Timeout: wait}
	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("daemon not reachable on 127.0.0.1:%d — is `tabshot serve` running? (%v)", port, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var b bytes.Buffer
		b.ReadFrom(resp.Body)
		return nil, fmt.Errorf("daemon answered %s: %s", resp.Status, strings.TrimSpace(b.String()))
	}
	var r result
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("unreadable answer from daemon: %v", err)
	}
	return &r, nil
}
