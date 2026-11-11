# Chrome Web Store submission

Everything the developer dashboard asks for, ready to paste. Build the
package with `bin/package-extension.sh` (add `--no-debugger` for the build
without the `debugger` permission; then skip that justification below).

## Store listing tab

**Category:** Developer Tools
**Language:** English

**Summary** (from the manifest, ≤132 characters):
Lets a local CLI photograph allow-listed tabs and click, type, scroll in them. Never hands over page text, cookies or URLs.

**Description:**

```
tabshot lets a program on your own computer — a script, or a coding assistant running in your terminal — look at one of your browser tabs and act on it, without ever handing it the page itself.

Pixels in, coordinates out. The command line can receive:
• a PNG of the tab's visible area (or a zoomed crop of it)
• "ok" or an error
• whether a tab for a domain is open

It cannot receive page text, the page's HTML, cookies, form values, URLs, your list of tabs, or anything from a domain you have not allowed. There is no "evaluate" and no "get text" — the protocol has no way to ask.

What it can do in an allowed tab: click at a point, type text, press keys, scroll, refresh, resize the viewport, and hand local files to a file field. Your sign-ins stay in your browser, so it works on admin panels and dashboards you are already logged in to.

How it works
• You run the free, open-source tabshot command-line program (github.com/faradey/tabshot). It listens on 127.0.0.1 only and creates a token.
• Paste the token into the extension's options and list the domains it may touch. Chrome asks you to grant access to exactly those domains.
• Click the tabshot icon on a tab to share it. Commands run in a separate, unfocused window tabshot opens itself — your own tab is never moved.

Every command is recorded in the extension with a picture of the tab after it, so you can watch back what was done or download it as a video. Recordings never leave your browser; text typed into password and card fields is kept as its length only.

Requires the tabshot command-line program on the same computer. Without it the extension does nothing.
```

**Graphics:**
- Store icon: `extension/icons/icon128.png` (128×128, 96×96 artwork with padding)
- Small promo tile: `store/promo-small.png` (440×280)
- Screenshots (1280×800, 24-bit PNG), in this order:
  1. `store/screenshots/1-terminal.png` — the CLI transcript beside the PNG it got back
  2. `store/screenshots/2-sessions.png` — the recorded session, paused on a click
  3. `store/screenshots/3-options.png` — options with an example allow list

  All three come from a real run: the packaged extension in Chrome for Testing,
  driven by the CLI through a separate daemon, on a demo admin page (a fictional
  shop served locally under `admin.example.com`). To regenerate after a UI
  change: `npm install --prefix store/screenshots/src`, then
  `node store/screenshots/src/shoot.mjs` (options are in the script's header).

**Homepage URL:** https://github.com/faradey/tabshot
**Support URL:** https://github.com/faradey/tabshot/issues

## Privacy practices tab

**Single purpose:**
Let a program on the user's own computer take screenshots of, and click, type and scroll in, browser tabs on domains the user has allowed — returning only images and success/failure, never page content.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | Chrome's `captureVisibleTab` requires it: clicking the toolbar icon on a tab is how the user shares that tab for screenshots. |
| `tabs` | To find the tab on the domain a command names, open tabshot's own window on that tab's URL, and notice when a tab leaves the allowed domain. URLs are compared inside the extension and never sent out. |
| `scripting` | To dispatch the requested click, typing, key press, scroll or file hand-over inside the page at the given coordinates. The injected functions return only numbers and booleans. |
| `storage` | Settings (allow list, local port, token) and which tabs the user shared. |
| `alarms` | Restarts the poll to the local program after Chrome suspends the service worker, and closes tabshot's own idle windows. |
| `webNavigation` | To deliver clicks into the right iframe (embedded apps, payment fields) and to wait for a navigation caused by a click to finish before the next screenshot. |
| `debugger` | Off by default, behind the "Capture covered windows" option. When on and a normal capture fails or returns a stale frame because the window is covered, it attaches to that one allowed tab, sends only `Page.captureScreenshot`, and detaches. Chrome does not allow `debugger` as an optional permission. |
| Host `http://127.0.0.1/*` | The extension talks only to the tabshot program on the user's own computer. |
| Optional hosts `*://*/*` | Requested per domain, at runtime, for exactly the domains the user types into the allow list; removed when a domain is removed. |
| Optional `<all_urls>` | Only if the user ticks "Capture without a click": `captureVisibleTab` accepts `<all_urls>` as the alternative to a click. The extension still acts only on the allow list. |

**Remote code:** No, I am not using remote code. (All scripts are in the package; injected functions are local functions passed to `chrome.scripting.executeScript`.)

**Data usage** — tick:
- [x] Website content (screenshots of allowed tabs)
- [x] User activity (the clicks, keys and text the user's own program asks for are recorded locally)

Certify all three: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/faradey/tabshot/blob/main/PRIVACY.md

## Test instructions (Distribution → "Test instructions" for the reviewer)

```
The extension needs its open-source companion program on the same machine; without it, it does nothing.

1. Install Go 1.24+, then: go install github.com/faradey/tabshot@latest
2. Run: tabshot serve      (listens on 127.0.0.1:47831, creates a token)
3. In another terminal: tabshot token   — copy the printed token.
4. Open the extension's options: paste the token, put "example.com" in Allowed domains, Save, accept Chrome's prompt.
5. Open https://example.com in a tab and click the tabshot toolbar icon on it (badge shows "on").
6. Run: tabshot shot --domain example.com --out shot.png   → prints "ok" and saves a screenshot.
7. Run: tabshot click --domain example.com --shot after.png 100 200
8. Options page → "Recorded sessions" shows both steps with pictures.
```
