# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

tabshot is a screenshot-only bridge between a local CLI and allow-listed tabs of the user's everyday Chrome: pixels in, coordinates out. Go CLI/daemon (stdlib only, no `go.sum`) plus an unpacked MV3 extension in `extension/`. `README.md` is the user-facing spec, including measured limits — read its **Limits** section before changing capture, focus or typing behaviour.

## Build and run

```sh
go build -o tabshot .        # binary is gitignored
go vet ./...
tabshot serve                # daemon on 127.0.0.1:47831, creates ~/.config/tabshot/token (0600)
tabshot reload               # extension reloads itself from disk after a change to extension/*.js
tabshot status [--domain D]
bin/package-extension.sh [--no-debugger]   # Chrome Web Store zip → dist/; checks description ≤132 chars and icons
```

- Store submission texts (listing, permission justifications, reviewer test steps) live in `store/LISTING.md`; privacy policy in `PRIVACY.md`. A new permission or a new kind of data leaving the extension must be reflected in both. Icons are rendered from `store/*.svg` with `rsvg-convert`.

- **Rebuilding on macOS while the daemon runs from that binary: `rm tabshot` first, then `go build -o tabshot .`** Overwriting in place keeps the inode and macOS kills the restarted daemon with `OS_REASON_CODESIGNING` (launchd: `spawn failed`, port closed).
- There are no automated tests. Verify against a real Chrome: load `extension/` unpacked, paste the token in options, allow a domain, click the toolbar icon on the tab (badge `on`), then drive it with `tabshot shot|click|type|...`.
- `tabshot reload` needs a live extension; one stuck mid-command never sees it — reload from `chrome://extensions` then. Reloading drops every activeTab grant and forgets tabshot's windows.
- CLI flags go before positional arguments (Go `flag` package).

## Architecture

Three processes, one JSON command per round trip:

```
CLI (internal/client) --POST /cmd--> daemon (internal/daemon) <--GET /ext/poll (long-poll)-- extension service worker
                       <--result----                          --POST /ext/result--------->
```

- **Daemon** (`internal/daemon/daemon.go`) is a dumb queue: it assigns an `id`, queues the command body, matches the result by `id`, and never inspects contents. All endpoints except `/health` require `X-Tabshot-Token`. Poll hangs 25 s (under the MV3 30 s idle kill). If the extension polled before but is momentarily idle, `/cmd` waits up to 15 s for the next poll; if it has never polled, it refuses at once. Command and result bodies are capped at 64 MB (uploads travel inside the command; CLI caps files at 40 MB before base64).
- **Client** (`internal/client/client.go`) builds the command from flags, posts it, prints `ok`/`note:`/error and writes the PNG. Every command carries a `caller` (walks parent processes up to one named `claude`, `TABSHOT_CALLER` overrides) so the extension keeps one session recording per agent session. New actions must be added in three places: the `switch` in `main.go`, `client.Run`, and `handle()` in `background.js`.
- **Extension** (`extension/background.js`):
  - `pollLoop()` — single loop; each command is wrapped in `within(..., 55000)` and recording in `within(..., 15000)` so no promise can stall polling (a hang there once made every later command "extension is not connected"). Recording runs *after* the result is posted.
  - `handle()` — the dispatcher. Checks the allow list, finds tabs for the domain, and acts in **tabshot's own window**: the user's clicked ("shared") tab only lends its URL; `openWindow()` opens an unfocused copy and later commands reuse it (`ownTabs`). The user's tab is never moved or focused. Idle own windows are swept by an alarm (`sweep()`).
  - Capture: `captureVisibleTab` needs an activeTab grant (icon click, tracked per origin in session storage) or the optional `<all_urls>` ("Capture without a click"). All captures share one pacer (Chrome fails a 3rd capture within a second). A frame identical to the previous one after an action is flagged stale; with "Capture covered windows" on, it is retaken via `chrome.debugger` `Page.captureScreenshot`.
  - `page*` functions at the bottom are serialised into the tab via `chrome.scripting.executeScript` (`exec()`): they cannot reference anything outside their own body and must return only numbers/booleans/iframe host — never page text. `resolvePoint()`/`resolveFocus()` walk nested iframes (max 6) and map coordinates into the target frame.
  - After an action, if the tab's host changed: allowed host → `note: the page moved to …`; off the allow list → note only, no screenshot.
- `extension/recorder.js` (imported by the service worker) stores sessions/steps/JPEG frames in IndexedDB `tabshot-sessions`; `sessions.html/js` is the viewer and .webm exporter; `options.html/js` holds token, port, allow list (which is also the set of host permissions requested/removed) and the two opt-in switches.

## Invariants (the point of the project)

- Nothing returned to the daemon may contain page text, DOM, cookies, URLs or the tab list. Result objects in `handle()` are the complete list of what leaves. Error strings go through `safeError()`, which strips URLs from Chrome's messages.
- Every domain-bearing action is checked against `c.domains` in the extension, not only by Chrome permissions.
- `open` derives the domain from the URL's own host (the CLI rejects a `--domain` that disagrees).
- Typed text into password/card/OTP fields is recorded as length only (`recSecret`).

## Conventions

- Comments explain *why* and cite dated measurements (e.g. "measured 2026-10-15 on react-select"); keep that style when adding behaviour that works around a browser quirk, and record new measured limits in the README's **Limits** section.
- Commit subjects are short, imperative, often prefixed with the command they touch (`click: …`, `open --shot: …`, `type --replace: …`).
