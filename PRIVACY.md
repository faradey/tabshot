# tabshot privacy policy

*Last updated: 2026-11-11*

tabshot is a browser extension paired with a command-line program that you run
on your own computer. This policy covers the extension.

## What the extension handles

- **Screenshots of tabs on domains you allow.** When the tabshot program on
  your computer asks for one, the extension captures the visible part of a tab
  on a domain from your allow list and sends the image to that program at
  `http://127.0.0.1` (your own machine).
- **The actions it is asked to perform.** Clicks, typed text, keys, scrolls
  and file names of uploads, carried out in tabs on allowed domains.
- **Session recordings.** Each action above is recorded in the extension with
  a picture of the tab after it, so you can watch back what was done. Text
  typed into password, payment-card or one-time-code fields is kept as its
  length only.
- **Settings.** The allow list, the local port, and the token that pairs the
  extension with the program on your computer.

## Where it goes

- Screenshots and short results (`ok`, an error, whether a tab is open) go only
  to `127.0.0.1` — the tabshot program on the same computer. The extension
  never returns page text, the page's HTML, cookies, URLs or your list of tabs.
- Session recordings and settings stay in the extension's own storage in your
  browser. They are read only by the extension's own pages.
- Nothing is sent to the developer or to any other server. There are no
  analytics, no advertising and no tracking. Data is not sold or shared with
  anyone.

## Your control

- Only domains you put on the allow list are ever touched; Chrome asks you to
  grant access to each.
- Recording can be switched off on the **Recorded sessions** page, where
  sessions can also be deleted one at a time or all together.
- Removing the extension deletes everything it stored.

## Contact

Questions: open an issue at <https://github.com/faradey/tabshot/issues>.
