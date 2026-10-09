# tabshot

A screenshot-only bridge between a command line and **one tab of your everyday
browser**. An assistant (or a script) running on the machine can ask for a
picture of an allow-listed tab and act on it by coordinates — click, type,
scroll, refresh — while the page itself never leaves the browser.

What the command line **can** receive:

- a PNG of the tab's viewport (or a zoomed crop of it)
- `ok` / an error
- whether a tab for a domain is open, and how many

What it **cannot** receive, by the shape of the protocol rather than by
policy: page text, the DOM, cookies, form values, URLs, the list of other
tabs, or anything from a domain not on the allow list. The extension's
result objects are the whole list above; there is no "evaluate" and no
"get text".

Why not remote debugging: the DevTools protocol hands over everything —
every cookie, every tab, arbitrary script. This is the opposite end of that
trade: pixels in, coordinates out, and the login sessions that are already in
your browser stay there.

## How it works

```
tabshot shot --domain admin.example.com --out page.png
      │  POST /cmd (127.0.0.1, token)
      ▼
tabshot serve  ──── long-poll ────►  extension (service worker)
      ▲                                    │  finds the tab for the domain
      └──────── PNG / ok ──────────────────┘  captures, clicks, types in it
```

- **`tabshot serve`** listens on `127.0.0.1:47831`, creates a token on first
  run (`~/.config/tabshot/token`, mode 0600) and queues commands.
- **The extension** polls the daemon, refuses any domain not in its allow
  list, and works in a window of its own: the first command for a domain
  opens one, unfocused, on the URL of your tab there, and later commands
  reuse it. Your tab is read for its URL and nothing else — it is never
  moved, so your tab strip stays as you left it and your browsing never
  appears in a frame.
- **Every other subcommand** posts one command and prints the answer.

The allow list lives in the extension's options and is also exactly the set
of host permissions the extension holds: adding a domain prompts Chrome,
removing one gives the permission back.

## Install

```sh
go install github.com/faradey/tabshot@latest   # or: go build -o tabshot .
tabshot serve &                                 # keep it running (a launchd/systemd unit works)
tabshot token --copy                            # macOS; `tabshot token` prints it elsewhere
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
the `extension/` directory. Open the extension's options, paste the token,
list the allowed domains, Save (Chrome asks for host access to those domains).

Then **share the tab**: open the page you want photographed and click the
tabshot icon in the toolbar once — the badge turns to `on`. That click is
Chrome's own `activeTab` grant, which is what `captureVisibleTab` demands; a
host permission for the page is not enough. It lasts while the tab stays on
that origin and dies with the tab or the browser, so after a restart it is one
click again. Reloading the extension ends every grant too.

The extension records which origin each click was on. When the tab moves to
another site (a back arrow that leaves the page, a login redirect) Chrome ends
the grant, and the badge goes off with it instead of promising a capture that
would fail. With no shared tab, commands answer "tab not shared" and open
nothing.

**The click lends the URL, not the tab.** Commands run in tabshot's own
window, opened on the URL of the tab you clicked; your tab stays where it is.
The sign-in comes along (cookies are the browser's), the page's in-memory
state does not — a form half filled in your tab is empty in tabshot's copy.
Chrome's click grant belongs to the tab it was given in, so a screenshot in
tabshot's window needs either one more click on the icon **there**, or
**"Capture without a click"** (below), which needs none at all. Clicks and
typing work without either.

A link that opens a new tab (`target=_blank`) in tabshot's window: when the
new tab is the **same origin** as the one that opened it, the extension sends
the opener there instead and closes the new one, so the flow stays in one tab
and a click grant on it survives. Across origins (an account page opening the
storefront) the new tab stays in tabshot's window and counts as tabshot's.

```sh
tabshot status                          # extension: connected; allowed: ...
tabshot status --domain admin.example.com
```

For an app embedded in another site's page (an iframe), list **both** domains:
the page's and the app's. Clicks that land inside the iframe are delivered
into it, and that needs host access to the iframe's origin too.

## Commands

```
tabshot shot    --domain D [--out F] [--width N | --full] [--zoom X,Y,W,H]
tabshot click   --domain D X Y
tabshot type    --domain D [--at X,Y] [--replace] "text"
tabshot key     --domain D Enter|Tab|Escape|Backspace|ArrowDown|...
tabshot scroll  --domain D DX DY [--at X,Y]
tabshot refresh --domain D
tabshot resize  --domain D W H
tabshot open    --url URL [--shot F]
tabshot status  [--domain D]
```

- `open` brings a page up on request, so nobody has to open the tab first.
  The URL's host is the domain, checked against the allow list like any
  other. It goes to tabshot's own tab on that domain, so repeated calls do
  not pile up windows; else into a new window that opens without focus. No
  tab of yours is needed or touched. A page opened this way takes clicks and
  typing (host access is enough for those); a screenshot of it needs a click
  on the icon in that window or **"Capture without a click"** — without
  either, `open` says so instead of failing. A redirect off the allow list (a
  sign-in page elsewhere) is reported without saying where it went. The URL
  goes into the browser; nothing about the page comes back but pixels, as
  everywhere else.
- **tabshot tidies up its own windows.** Each is remembered with when it was
  last used — by a command, or by you bringing it to the front — and closed
  after an hour idle (the options page sets the minutes; 0 keeps them for
  ever). A window you have in front is never closed. A tab of tabshot's that
  you drag into a window of yours becomes yours: commands stop using it, and
  it is not closed. Windows made before an extension reload are forgotten
  with it and are yours to close.

- Coordinates are CSS pixels of the viewport. A screenshot is **downscaled
  to 800 px wide by default** — for a reader that pays per pixel (a model
  does: roughly `width × height / 750` tokens per image) that is a quarter of
  the cost of a 1600 px frame, and on a Shopify-admin-density page every
  label was still legible at that width when this default was chosen; 640 px
  was the edge. The output line says the factor: `viewport X = imageX/0.5`.
  `--width N` picks another width, `--full` keeps the viewport size — use it
  for pictures that will be published. On a HiDPI screen the capture is
  brought down to the CSS grid first, so `--full` of a 1600×900 viewport is a
  1600×900 file.
- `--zoom` saves a region at the screen's native resolution, for reading
  small targets. The output line says how to map its pixels back.
- `--shot F` on any action takes a screenshot after it, saving a round trip.
- `resize` sets the **viewport** (not the window) to exactly `W×H`.
- `type` inserts text into whatever has focus, or into what `--at` clicks
  first. On a `<select>` it picks the option the text names (label, then
  value, exact before prefix) — keys cannot do that, because a native select's
  type-ahead ignores synthetic events and its popup belongs to the OS.
  `key Enter` submits the focused form; `key Tab` moves focus.
  `--replace` selects the field's whole content first, so the text replaces
  it rather than landing at the caret — synthetic keys cannot select all, and
  emptying a filled field one Backspace at a time from wherever the click left
  the caret is not reliable.
- Flags come before positional arguments.

## Limits

- Only what the viewport shows is captured. Full-page captures would need the
  debugger API, which is the access this tool exists to avoid.
- The tab's window must not be minimised, and must not be **completely**
  covered by other windows either: Chrome stops painting a fully occluded
  window, and `shot` then answers `Failed to capture tab: image readback
  failed` while clicks and typing still land. Another desktop is fine;
  partly visible is fine. Measured 2026-09-19 on macOS through a checkout.
  Not every covered window stops, though: on 2026-10-09 a window `open`
  had just made, at the bottom of the window stack and exactly under
  another Chrome window of the same size, gave three current frames in a
  row (a navigation and a scroll both visible). Treat that as luck, not a
  property.
- **A shot can be a stale frame.** Same cause, other symptom: three shots
  in a row showed a form with two fields empty while the page had them
  filled and rates loaded — Chrome handed back the last frame it had
  painted. If a picture contradicts the `ok` of the actions before it, make
  the window visible and shoot again before acting on the picture.
- **A tab mid-redirect is on neither host.** A navigation that hops through
  another subdomain (a sign-in bounce) leaves no tab on the domain asked for
  for a second or two. While any tab is still loading, a command waits up to
  3 s for one to appear before answering `no open tab`; `status` never waits.
- Synthetic events: file pickers, drag and drop, and `alert()` dialogs cannot
  be driven. A native `<select>` is the exception — `type` picks its option
  by name, see above.
- Sites that require trusted input for a particular control will ignore the
  click. Most web apps do not.
- **`type` announces a commit, not only an insert.** Measured 2026-09-18 on
  a hosted checkout (React): with `input` alone the text showed in the field
  while the page's validation reported it empty — email, last name, street
  and city, while first name, postal code and phone were accepted. So every
  insert is followed by `change`, `blur` and `focusout` as events, without
  moving focus. A form that reads the field only on a real focus change is
  still outside what synthetic events can do.
- **Sibling iframes are told apart by position.** The card fields of a
  hosted checkout are side-by-side iframes on one host; the parent reports
  the clicked iframe's exact `src` and its index among the document's
  same-host iframes, and the frame is found by the src when unique, else as
  the n-th same-host frame in frame-id order — Chrome numbers frames as it
  creates them, which for iframes written into the page together is DOM
  order. A page that inserts such iframes out of order defeats this, and
  then the old refusal returns.
- Anything on screen is in the picture — that is the point, and the reason
  the allow list is per domain.

## Security model in one paragraph

Trust is per machine: whoever can read `~/.config/tabshot/token` can drive
the allow-listed tabs, which is the same set of people who can run the CLI.
The daemon binds to loopback only. The extension asks for `activeTab`,
`tabs`, `scripting`, `storage`, `alarms`, `webNavigation` and host access to
exactly the allow list; no `cookies`, no `debugger`, no `webRequest`. By
default no `<all_urls>` either, and a tab can be photographed only after you
clicked the icon on it. **"Capture without a click"** in the options is the
one exception, and it is yours to switch: it asks Chrome for `<all_urls>` —
the only other thing `captureVisibleTab` accepts — so any tab on an allowed
domain can be photographed without a click, and a move between two allowed
domains no longer ends it. Chrome then lists the extension as able to read and
change data on all websites; what it acts on is still the allow list, checked
by the extension's code rather than by Chrome. Unticking gives the access back.
`scripting` means the extension's own code can see the DOM of an allowed tab —
it is that code, not the manifest, that refuses to pass any of it on, and it
is short enough to read: `extension/background.js`.

## Licence

MIT.
