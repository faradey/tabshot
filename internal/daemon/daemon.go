// Package daemon is the queue between the CLI and the extension.
//
// The extension long-polls GET /ext/poll and answers on POST /ext/result; the
// CLI posts one command to /cmd and waits for its result. The daemon never
// looks inside a command or a result — it matches ids and moves bytes.
package daemon

import (
	"crypto/subtle"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// pollWait is how long one /ext/poll hangs before answering 204. Under the
// MV3 idle limit of 30 s so the service worker is never killed mid-request.
const pollWait = 25 * time.Second

type pending struct {
	id   string
	body []byte
}

type Daemon struct {
	token string

	mu       sync.Mutex
	queue    []pending
	wake     chan struct{}
	waiting  map[string]chan json.RawMessage
	lastPoll time.Time
	polling  int
}

func New(token string) *Daemon {
	return &Daemon{
		token:   token,
		wake:    make(chan struct{}, 1),
		waiting: map[string]chan json.RawMessage{},
	}
}

// Run is `tabshot serve`.
func Run(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	port := fs.Int("port", DefaultPort, "port to listen on (127.0.0.1 only)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	token, err := EnsureToken()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	d := New(token)
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(*port))
	srv := &http.Server{Addr: addr, Handler: d.Handler()}
	p, _ := TokenPath()
	log.Printf("tabshot daemon on http://%s — token in %s", addr, p)
	if err := srv.ListenAndServe(); err != nil {
		log.Print(err)
		return 1
	}
	return 0
}

func (d *Daemon) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", d.health)
	mux.HandleFunc("GET /ext/poll", d.auth(d.poll))
	mux.HandleFunc("POST /ext/result", d.auth(d.result))
	mux.HandleFunc("POST /cmd", d.auth(d.cmd))
	return mux
}

func (d *Daemon) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Tabshot-Token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(d.token)) != 1 {
			http.Error(w, "bad token", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// Connected says whether an extension poll is open right now, or was a moment
// ago (between two polls there is a gap of a few milliseconds).
func (d *Daemon) connected() (bool, time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.polling > 0 || time.Since(d.lastPoll) < 3*time.Second, d.lastPoll
}

func (d *Daemon) health(w http.ResponseWriter, _ *http.Request) {
	ok, last := d.connected()
	d.mu.Lock()
	n := len(d.queue)
	d.mu.Unlock()
	writeJSON(w, map[string]any{
		"extension_connected": ok,
		"extension_last_poll": last.Format(time.RFC3339),
		"queued":              n,
	})
}

func (d *Daemon) poll(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	d.polling++
	d.lastPoll = time.Now()
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		d.polling--
		d.lastPoll = time.Now()
		d.mu.Unlock()
	}()

	deadline := time.After(pollWait)
	for {
		d.mu.Lock()
		if len(d.queue) > 0 {
			p := d.queue[0]
			d.queue = d.queue[1:]
			d.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.Write(p.body)
			return
		}
		d.mu.Unlock()
		select {
		case <-d.wake:
		case <-deadline:
			w.WriteHeader(http.StatusNoContent)
			return
		case <-r.Context().Done():
			return
		}
	}
}

func (d *Daemon) result(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<20)).Decode(&raw); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var head struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &head); err != nil || head.ID == "" {
		http.Error(w, "result without id", http.StatusBadRequest)
		return
	}
	d.mu.Lock()
	ch, ok := d.waiting[head.ID]
	delete(d.waiting, head.ID)
	d.mu.Unlock()
	if !ok {
		http.Error(w, "nobody is waiting for "+head.ID, http.StatusGone)
		return
	}
	ch <- raw
	w.WriteHeader(http.StatusNoContent)
}

// cmd takes {"action": ..., ...} plus an optional "timeout" (seconds) and
// answers with the extension's result verbatim, or {"ok": false, "error": ...}.
func (d *Daemon) cmd(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	timeout := 60 * time.Second
	if t, ok := body["timeout"].(float64); ok && t > 0 {
		timeout = time.Duration(t * float64(time.Second))
	}
	delete(body, "timeout")

	if ok, last := d.connected(); !ok {
		msg := "extension is not connected to this daemon"
		if !last.IsZero() {
			msg += fmt.Sprintf(" (last poll %s ago)", time.Since(last).Round(time.Second))
		} else {
			msg += " (it has never polled — is it installed, and is the token pasted into its options?)"
		}
		writeJSON(w, map[string]any{"ok": false, "error": msg})
		return
	}

	id := newID()
	body["id"] = id
	enc, err := json.Marshal(body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ch := make(chan json.RawMessage, 1)
	d.mu.Lock()
	d.waiting[id] = ch
	d.queue = append(d.queue, pending{id: id, body: enc})
	d.mu.Unlock()
	select {
	case d.wake <- struct{}{}:
	default:
	}

	select {
	case res := <-ch:
		w.Header().Set("Content-Type", "application/json")
		w.Write(res)
	case <-time.After(timeout):
		d.mu.Lock()
		delete(d.waiting, id)
		for i, p := range d.queue {
			if p.id == id {
				d.queue = append(d.queue[:i], d.queue[i+1:]...)
				break
			}
		}
		d.mu.Unlock()
		writeJSON(w, map[string]any{"ok": false, "error": fmt.Sprintf("no answer from the extension within %s", timeout)})
	case <-r.Context().Done():
		d.mu.Lock()
		delete(d.waiting, id)
		d.mu.Unlock()
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

var idSeq uint64
var idMu sync.Mutex

func newID() string {
	idMu.Lock()
	idSeq++
	n := idSeq
	idMu.Unlock()
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), n)
}
