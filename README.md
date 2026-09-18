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
  list, finds the most recently used tab on that domain, moves it into a
  window of its own (so your browsing in other windows never appears in a
  frame), and answers.
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
click again.

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
tabshot type    --domain D [--at X,Y] "text"
tabshot key     --domain D Enter|Tab|Escape|Backspace|ArrowDown|...
tabshot scroll  --domain D DX DY [--at X,Y]
tabshot refresh --domain D
tabshot resize  --domain D W H
tabshot status  [--domain D]
```

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
- Flags come before positional arguments.

## Limits

- Only what the viewport shows is captured. Full-page captures would need the
  debugger API, which is the access this tool exists to avoid.
- The tab's window must not be minimised. It may be on another desktop or
  behind other windows.
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
exactly the allow list; no `cookies`, no `debugger`, no `webRequest`, no
`<all_urls>`. A tab can be photographed only after you clicked the icon on it.
`scripting` means the extension's own code can see the DOM of an allowed tab —
it is that code, not the manifest, that refuses to pass any of it on, and it
is short enough to read: `extension/background.js`.

## Licence

MIT.
