// tabshot service worker: long-polls the local daemon for commands and answers
// each with pixels or ok/error. Nothing here returns page text, DOM, cookies or
// URLs — the result objects below are the complete list of what can leave.

const DEFAULTS = { domains: [], port: 47831, token: "" };

async function config() {
  return await chrome.storage.local.get(DEFAULTS);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- poll loop

let polling = false;

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const c = await config();
      if (!c.token) { await sleep(5000); continue; }
      const base = `http://127.0.0.1:${c.port}`;
      const headers = { "X-Tabshot-Token": c.token };
      let r;
      try {
        r = await fetch(`${base}/ext/poll`, { headers });
      } catch (e) {
        await chrome.storage.local.set({ lastError: "daemon not reachable" });
        await sleep(3000);
        continue;
      }
      await chrome.storage.local.set({ lastPoll: Date.now(), lastError: r.ok || r.status === 204 ? "" : `daemon answered ${r.status}` });
      if (r.status === 204) continue;
      if (!r.ok) { await sleep(3000); continue; }
      const cmd = await r.json();
      let res;
      try {
        res = await handle(cmd, c);
      } catch (e) {
        res = { ok: false, error: safeError(e) };
      }
      res.id = cmd.id;
      await fetch(`${base}/ext/result`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(res),
      }).catch(() => {});
    }
  } finally {
    polling = false;
  }
}

// Chrome's own messages can quote page URLs; ours never should.
function safeError(e) {
  const m = String((e && e.message) || e);
  if (/Cannot access|host permission|Extension manifest must request/i.test(m)) {
    return "no host access for that frame — add its domain to the allow list";
  }
  if (/No tab with id|No window with id/i.test(m)) return "the tab went away";
  if (/activeTab/.test(m)) return "tab not shared — click the tabshot icon while that tab is in front, then retry";
  return m.replace(/https?:\/\/\S+/g, "<url>");
}

chrome.runtime.onStartup.addListener(pollLoop);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("poll", { periodInMinutes: 0.5 });
  pollLoop();
});
chrome.alarms.onAlarm.addListener(() => {
  pollLoop();
  sweep().catch(() => {});
});
chrome.runtime.onMessage.addListener(() => { pollLoop(); });
// Clicking the icon on a tab is what lets it be photographed: captureVisibleTab
// accepts only activeTab or <all_urls>, and a host permission for the page is
// not enough. The grant is Chrome's, per tab, and lasts while the tab stays
// on that origin; the badge is the only record of it.
//
// The origin the grant was given on is recorded too (session storage, which an
// extension reload clears exactly as it clears Chrome's grants), because the
// badge cannot say it: when the tab moves to another origin Chrome revokes the
// grant, and a badge left at "on" then promised a capture that failed.
chrome.action.onClicked.addListener(async (tab) => {
  await rememberShare(tab.id, tab.url);
  await chrome.action.setBadgeText({ tabId: tab.id, text: "on" });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#2a7" });
});

// The grant ends when the tab leaves its origin or closes; so does the record.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const shares = await loadShares();
  const origin = shares[tabId];
  if (origin === undefined || originOf(info.url) === origin) return;
  delete shares[tabId];
  await chrome.storage.session.set({ shares });
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch {
    // the tab went away meanwhile
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const shares = await loadShares();
  if (shares[tabId] === undefined) return;
  delete shares[tabId];
  await chrome.storage.session.set({ shares });
});

async function loadShares() {
  const { shares } = await chrome.storage.session.get({ shares: {} });
  return shares || {};
}

async function rememberShare(tabId, url) {
  const shares = await loadShares();
  shares[tabId] = originOf(url);
  await chrome.storage.session.set({ shares });
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
pollLoop();

// A link with target=_blank in one of tabshot's tabs opens a tab inside
// tabshot's window. When it is the same origin as its opener, the opener is
// sent to that URL and the new tab closed: the flow stays in one tab, and a
// click grant on it survives, because activeTab lasts while the tab stays on
// its origin and cannot be copied to another tab. Across origins (a store's
// "buy again" opening the storefront from an account page) the new tab stays,
// and is counted as tabshot's — it is in tabshot's window, not the owner's.
// The owner's own tabs are never folded: tabshot does not act on them.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return;
  const opener = tab.openerTabId;
  (async () => {
    const { opened } = await chrome.storage.session.get({ opened: [] });
    if ((opened || []).includes(opener)) await rememberOpened(tab.id);
  })().catch(() => {});
  const foldIn = async (url) => {
    try {
      const { opened } = await chrome.storage.session.get({ opened: [] });
      if (!(opened || []).includes(opener)) return false;
      const openerTab = await chrome.tabs.get(opener);
      if (originOf(openerTab.url || "") !== originOf(url)) return false;
      await chrome.tabs.update(opener, { url, active: true });
      await chrome.tabs.remove(tab.id);
      return true;
    } catch {
      return false;
    }
  };
  const first = tab.pendingUrl || tab.url;
  if (first && !first.startsWith("about:")) { foldIn(first); return; }
  // Created blank and navigated a moment later: wait for the first real URL.
  const onUpdated = (id, info) => {
    if (id !== tab.id || !info.url || info.url.startsWith("about:")) return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    foldIn(info.url);
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
});

// ---------------------------------------------------------------- idle windows
// Every command works in a window of tabshot's own (see ownTab). Left alone
// they hung around for days, so each is remembered with when it was last used
// — by a command, or by the owner bringing it to the front — and once it has
// been idle longer than the options say (an hour by default, 0 for never) it
// is closed. It holds nothing of the owner's: the owner's tabs are never moved
// into it. A window the owner has in front is never closed, idle or not.

const IDLE_DEFAULT_MINUTES = 60;

async function trackedWindows() {
  const { windows } = await chrome.storage.session.get({ windows: {} });
  return windows || {};
}

async function trackWindow(windowId) {
  const windows = await trackedWindows();
  windows[windowId] = { used: Date.now() };
  await chrome.storage.session.set({ windows });
}

async function touchWindow(windowId) {
  const windows = await trackedWindows();
  if (!windows[windowId]) return;
  windows[windowId].used = Date.now();
  await chrome.storage.session.set({ windows });
}

async function untrackWindow(windowId) {
  const windows = await trackedWindows();
  if (!windows[windowId]) return;
  delete windows[windowId];
  await chrome.storage.session.set({ windows });
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) touchWindow(windowId).catch(() => {});
});
chrome.windows.onRemoved.addListener((windowId) => {
  untrackWindow(windowId).catch(() => {});
});

async function sweep() {
  const { idleMinutes } = await chrome.storage.local.get({ idleMinutes: IDLE_DEFAULT_MINUTES });
  const minutes = Number(idleMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const cutoff = Date.now() - minutes * 60000;

  for (const [key, entry] of Object.entries(await trackedWindows())) {
    if (entry.used >= cutoff) continue;
    const windowId = Number(key);
    let win;
    try {
      win = await chrome.windows.get(windowId);
    } catch {
      await untrackWindow(windowId);
      continue;
    }
    if (win.focused) {
      await touchWindow(windowId);
      continue;
    }
    await chrome.windows.remove(windowId);
    await untrackWindow(windowId);
  }
}

// ---------------------------------------------------------------- commands

async function handle(cmd, c) {
  if (cmd.action === "status" && !cmd.domain) {
    return { ok: true, allowed: c.domains };
  }
  const domain = String(cmd.domain || "").toLowerCase();
  if (!domain) return { ok: false, error: "no domain given" };
  if (!allowed(domain, c.domains)) {
    return { ok: false, error: `domain ${domain} is not on the allow list` };
  }
  const find = () => chrome.tabs.query({ url: [`*://${domain}/*`, `*://*.${domain}/*`] });
  if (cmd.action === "open") {
    return await open(cmd, domain, await find(), c.domains);
  }
  let tabs = await find();
  if (cmd.action === "status") {
    return { ok: true, open: tabs.length > 0, tabs: tabs.length };
  }
  // A navigation can pass through another host on its way (a sign-in hop
  // between two subdomains of one site), and for that second or two no tab is
  // on the domain asked for. Seen 2026-09-28: right after a back arrow, two
  // commands in a row answered "no open tab" for both the host the page left
  // and the one it was going to, and the parent domain found the tab a moment
  // later; the intermediate host was never seen, since URLs never leave the
  // extension. So while any tab is loading, wait a little before saying none
  // is open.
  for (let i = 0; !tabs.length && i < 12; i++) {
    if (!(await chrome.tabs.query({ status: "loading" })).length) break;
    await sleep(250);
    tabs = await find();
  }
  if (!tabs.length) {
    // A click can carry tabshot's own tab to another allowed host (Partners →
    // Manage listing → Edit lands on apps.shopify.com). Asked for the old host,
    // the bare "no open tab" sent a session looking for a closed window for
    // four rounds (2026-10-09) while the editor sat open one domain over. The
    // hosts named here are on the allow list, so nothing leaves that the
    // caller did not already name.
    const elsewhere = await ownHosts(c.domains);
    if (elsewhere.length) {
      return { ok: false, error: `no open tab for ${domain} — tabshot's window is on ${elsewhere.join(", ")}: retry with --domain ${elsewhere[0]}` };
    }
    return { ok: false, error: `no open tab for ${domain}` };
  }

  let tab;
  const own = await ownTabs(tabs);
  if (own.length) {
    tab = await retry(async () => front(pickTab(own)));
  } else {
    const source = await sourceTab(tabs);
    if (!source) {
      return { ok: false, error: `tab not shared — click the tabshot icon on the ${domain} tab (again if it moved to another site), then retry` };
    }
    const r = await openWindow(source.url, c.domains);
    if (r.error) return { ok: false, error: r.error };
    tab = r.tab;
  }
  const out = { ok: true };
  const before = hostOf(tab);

  switch (cmd.action) {
    case "shot":
      break;
    case "click": {
      const p = await resolvePoint(tab.id, num(cmd.x), num(cmd.y));
      // A click that navigates lands on a page that is "complete" before it
      // draws: `click --shot` on a back arrow to the Partners listing overview
      // gave the bare header (2026-10-10). Comparing tab.url after the click
      // did not catch it: the URL changes only when the navigation commits,
      // and settle() returns at once if loading has not started yet, so the
      // check still saw the old URL. So the navigation itself is watched —
      // a top-frame load or a history push — from just before the click.
      const nav = watchNavigation(tab.id);
      const hit = await exec(tab.id, p.frameId, pageClick, [p.x, p.y]);
      if (!hit) { nav.stop(); return { ok: false, error: "nothing at that point" }; }
      await settle(tab.id);
      if (nav.stop()) {
        await sleep(200);
        await waitComplete(tab.id, 30000);
        await quiet(tab.id);
      }
      break;
    }
    case "type": {
      let frameId;
      if (cmd.x != null && cmd.y != null) {
        const p = await resolvePoint(tab.id, num(cmd.x), num(cmd.y));
        await exec(tab.id, p.frameId, pageClick, [p.x, p.y]);
        await sleep(100);
        frameId = p.frameId;
      } else {
        frameId = await resolveFocus(tab.id);
      }
      const typed = await exec(tab.id, frameId, pageType, [String(cmd.text ?? ""), !!cmd.replace]);
      if (!typed) return { ok: false, error: "no editable element has focus (or no option of a select matches) — give --at X,Y" };
      await settle(tab.id);
      break;
    }
    case "key": {
      const frameId = await resolveFocus(tab.id);
      await exec(tab.id, frameId, pageKey, [String(cmd.key || "Enter")]);
      await settle(tab.id);
      break;
    }
    case "scroll": {
      const vp = await exec(tab.id, 0, pageMeasure, []);
      const x = cmd.x != null ? num(cmd.x) : Math.floor(vp.w / 2);
      const y = cmd.y != null ? num(cmd.y) : Math.floor(vp.h / 2);
      const p = await resolvePoint(tab.id, x, y);
      await exec(tab.id, p.frameId, pageScroll, [p.x, p.y, num(cmd.dx), num(cmd.dy)]);
      await sleep(250);
      break;
    }
    case "refresh":
      await chrome.tabs.reload(tab.id);
      await sleep(300);
      await waitComplete(tab.id, 30000);
      // "complete" comes before an app page draws anything: `refresh --shot`
      // on a Partners listing gave the bare header (2026-10-10), the same
      // empty frame `open` gave before it learned to wait. Same wait here.
      await quiet(tab.id);
      break;
    case "resize": {
      out.viewport = await resize(tab, num(cmd.w), num(cmd.h));
      break;
    }
    case "upload": {
      const files = Array.isArray(cmd.files) ? cmd.files : [];
      if (!files.length) return { ok: false, error: "no files given" };
      const p = await resolvePoint(tab.id, num(cmd.x), num(cmd.y));
      const r = await exec(tab.id, p.frameId, pageUpload, [p.x, p.y, files]);
      if (!r || r.error) return { ok: false, error: (r && r.error) || "the page did not take the files" };
      out.files = r.files;
      out.via = r.via;
      await settle(tab.id);
      break;
    }
    default:
      return { ok: false, error: `unknown action ${cmd.action}` };
  }

  // Say when the action carried the page to another host, so the next command
  // names the right --domain. Off the allow list, say only that, and take no
  // picture of a page nobody allowed.
  tab = await chrome.tabs.get(tab.id);
  const after = hostOf(tab);
  if (after && after !== before) {
    if (!allowed(after, c.domains)) {
      out.note = LEFT_ALLOW_LIST;
      return out;
    }
    out.note = `the page moved to ${after} — use --domain ${after} from here`;
  }

  if (cmd.action === "shot" || cmd.shot) {
    tab = await chrome.tabs.get(tab.id);
    if (!(await canCapture(tab))) {
      // The action itself has happened; only the picture is missing.
      if (cmd.action === "shot") return { ok: false, error: NEEDS_CLICK };
      out.note = NEEDS_CLICK;
      return out;
    }
    Object.assign(out, await capture(tab, cmd.zoom, cmd.width != null ? num(cmd.width) : 0));
  }
  return out;
}

const NEEDS_CLICK = "tabshot opened the page in a window of its own — click the tabshot icon there (or turn on \"Capture without a click\"), then retry";

// `open`: bring an allow-listed page up on request, without the owner opening
// the tab first. The URL comes in from the command line and is checked here
// against the allow list by its own host, like a domain is; nothing about the
// page goes back out. It goes to tabshot's own tab on that domain if there is
// one, so repeated calls do not pile up windows; else into a new window.
async function open(cmd, domain, tabs, allowList) {
  let target;
  try {
    target = new URL(String(cmd.url || ""));
  } catch {
    return { ok: false, error: "open needs an http(s) URL" };
  }
  if (!/^https?:$/.test(target.protocol)) return { ok: false, error: "open needs an http(s) URL" };
  if (target.hostname.toLowerCase() !== domain) return { ok: false, error: "the URL's host is not the domain given" };

  let tab;
  const own = await ownTabs(tabs);
  if (own.length) {
    tab = await retry(async () => front(pickTab(own)));
    await chrome.tabs.update(tab.id, { url: target.href });
    await sleep(300);
    await waitComplete(tab.id, 30000);
    await quiet(tab.id);
    tab = await chrome.tabs.get(tab.id);
    if (!onAllowList(tab, allowList)) return { ok: true, note: LEFT_ALLOW_LIST };
  } else {
    const r = await openWindow(target.href, allowList);
    if (r.error) return { ok: true, note: r.error };
    tab = r.tab;
  }

  const out = { ok: true };
  if (cmd.shot) {
    if (!(await canCapture(tab))) {
      out.note = NEEDS_CLICK;
      return out;
    }
    Object.assign(out, await capture(tab, null, cmd.width != null ? num(cmd.width) : 0));
  }
  return out;
}

const LEFT_ALLOW_LIST = "the page left the allow list (a sign-in redirect?) — log in there in the browser, then retry";

// Every command works in a window of tabshot's own, never in the owner's. It
// used to move the owner's tab out into a window for its screenshot, which
// tore it out of the owner's tab strip and left their window rearranged; now
// the owner's tab is read for its URL and nothing else, and the page is loaded
// again in tabshot's window. The cost is the page's in-memory state — a form
// half filled in the owner's tab is not in tabshot's copy; the sign-in is,
// since cookies are the browser's, not the tab's.
//
// Which of the owner's tabs may lend its URL: one whose icon was clicked and
// which is still on the origin it was clicked on; with "Capture without a
// click" on (<all_urls>) any tab on the domain, clicked ones first. With none
// the command stops before opening anything.
async function sourceTab(tabs) {
  const clicked = await clickedTabs(tabs);
  if (clicked.length) return pickTab(clicked);
  if (tabs.length && (await chrome.permissions.contains({ origins: ["<all_urls>"] }))) return pickTab(tabs);
  return null;
}

// A new window on the URL, unfocused, so the owner's own window keeps its
// place; remembered as tabshot's, and closed by sweep() once idle.
async function openWindow(url, allowList) {
  const win = await chrome.windows.create({ url, focused: false, state: "normal" });
  let tab = win.tabs[0];
  await rememberOpened(tab.id);
  await trackWindow(win.id);
  await sleep(300);
  await waitComplete(tab.id, 30000);
  await quiet(tab.id);
  tab = await chrome.tabs.get(tab.id);
  // A redirect can end on a host off the allow list (a sign-in page on
  // another domain): the command says so rather than act there, and does not
  // say where — URLs never leave.
  if (!onAllowList(tab, allowList)) return { error: LEFT_ALLOW_LIST };
  return { tab };
}

function onAllowList(tab, allowList) {
  const host = hostOf(tab);
  return !!host && allowed(host, allowList);
}

function hostOf(tab) {
  try {
    return new URL(tab.url || tab.pendingUrl || "").hostname.toLowerCase();
  } catch {
    return "";
  }
}

// The allow-listed hosts tabshot's own tabs are on now, most recent first.
async function ownHosts(allowList) {
  const own = await ownTabs(await chrome.tabs.query({}));
  const hosts = [];
  for (const t of [...own].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))) {
    const h = hostOf(t);
    if (h && allowed(h, allowList) && !hosts.includes(h)) hosts.push(h);
  }
  return hosts;
}

// captureVisibleTab takes activeTab (a click on the icon in that tab) or
// <all_urls>. A tab tabshot opened has no click behind it until the owner
// gives one there.
async function canCapture(tab) {
  const shares = await loadShares();
  if (shares[tab.id] !== undefined && shares[tab.id] === originOf(tab.url || "")) return true;
  return await chrome.permissions.contains({ origins: ["<all_urls>"] });
}

// Tabs whose icon was clicked and which are still on that origin.
async function clickedTabs(tabs) {
  const shares = await loadShares();
  return tabs.filter((t) => shares[t.id] !== undefined && shares[t.id] === originOf(t.url || ""));
}

// tabshot's own tabs: made by it, and still in a window it made. One the owner
// dragged into a window of theirs has become theirs. Kept in session storage
// (an extension reload or a browser restart forgets them; the windows then
// stay with the owner).
async function ownTabs(tabs) {
  const { opened } = await chrome.storage.session.get({ opened: [] });
  const windows = await trackedWindows();
  return tabs.filter((t) => (opened || []).includes(t.id) && windows[t.windowId]);
}

async function rememberOpened(tabId) {
  const { opened } = await chrome.storage.session.get({ opened: [] });
  await chrome.storage.session.set({ opened: [...(opened || []).filter((id) => id !== tabId), tabId] });
}

// Chrome refuses tab and window edits for a moment after a drag or a window
// move ("Tabs cannot be edited right now"); that is a wait, not a failure.
async function retry(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 4 || !/cannot be edited right now/i.test(String(e && e.message))) throw e;
      await sleep(500);
    }
  }
}

const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("expected a number");
  return Math.round(n);
};

function allowed(domain, list) {
  return list.some((d) => domain === d || domain.endsWith("." + d));
}

// The most recently used matching tab; the active one wins a tie.
function pickTab(tabs) {
  return [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || (b.active ? 1 : 0) - (a.active ? 1 : 0))[0];
}

// captureVisibleTab photographs whatever tab is showing in a window, so the
// tab is made the showing one in its window — tabshot's window, where a
// target=_blank may have added a second tab.
async function front(tab) {
  const win = await chrome.windows.get(tab.windowId);
  if (win.state === "minimized") await chrome.windows.update(win.id, { state: "normal", focused: false });
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
  await touchWindow(tab.windowId);
  await sleep(150);
  return await chrome.tabs.get(tab.id);
}

// ---------------------------------------------------------------- screenshot

async function capture(tab, zoom, width) {
  const vp = await exec(tab.id, 0, pageMeasure, []);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = bmp.width / vp.w; // real capture scale (device pixel ratio, in practice)

  let sx = 0, sy = 0, sw = vp.w, sh = vp.h, ow = vp.w, oh = vp.h, scale = 1;
  if (!zoom && width > 0 && width < vp.w) {
    // Smaller than the viewport: fewer tokens per frame for whoever reads it.
    scale = width / vp.w;
    ow = width;
    oh = Math.round(vp.h * scale);
  }
  if (zoom) {
    sx = clamp(num(zoom.x), 0, vp.w - 1);
    sy = clamp(num(zoom.y), 0, vp.h - 1);
    sw = clamp(num(zoom.w), 1, vp.w - sx);
    sh = clamp(num(zoom.h), 1, vp.h - sy);
    scale = k;
    ow = Math.round(sw * scale);
    oh = Math.round(sh * scale);
  }
  const canvas = new OffscreenCanvas(ow, oh);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, sx * k, sy * k, sw * k, sh * k, 0, 0, ow, oh);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return {
    png: await toBase64(blob),
    viewport: { w: vp.w, h: vp.h, dpr: vp.dpr },
    image: { w: ow, h: oh, scale, origin: { x: sx, y: sy } },
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------- frames

async function exec(tabId, frameId, func, args) {
  const target = { tabId };
  if (frameId != null) target.frameIds = [frameId];
  const [r] = await chrome.scripting.executeScript({ target, func, args });
  return r && r.result;
}

// Walk from the top frame down through whichever iframe sits under the point,
// converting the point into that frame's coordinates. Frames are matched by
// the host of the iframe's src against the frame's url; that is enough for one
// embedded app per page, which is the case this exists for.
async function resolvePoint(tabId, x, y) {
  let frameId = 0;
  for (let depth = 0; depth < 6; depth++) {
    const hit = await exec(tabId, frameId, pageHitTest, [x, y]);
    if (!hit || hit.kind !== "frame") return { frameId, x, y };
    frameId = await childFrame(tabId, frameId, hit);
    x -= hit.left;
    y -= hit.top;
  }
  throw new Error("iframes nested too deep");
}

async function resolveFocus(tabId) {
  let frameId = 0;
  for (let depth = 0; depth < 6; depth++) {
    const f = await exec(tabId, frameId, pageFocusedFrame, []);
    if (!f) return frameId;
    frameId = await childFrame(tabId, frameId, f);
  }
  return frameId;
}

// Find the tab frame behind an iframe the parent described (the `describe`
// inside pageHitTest). Three tries, from certain to heuristic: the exact src,
// then the host when only one frame has it, then — sibling card fields, all
// on one host — the n-th same-host frame in creation order, which is the
// order Chrome hands out frame ids and, for iframes written into the page
// together, the DOM order the parent counted in.
async function childFrame(tabId, parentId, want) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const kids = frames.filter((f) => f.parentFrameId === parentId && f.url && !f.url.startsWith("about:"));
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
  if (want.url) {
    const exact = kids.filter((f) => f.url === want.url);
    if (exact.length === 1) return exact[0].frameId;
  }
  let match = kids.filter((f) => hostOf(f.url) === want.host);
  if (match.length === 0 && kids.length === 1) match = kids;
  if (match.length > 1 && Number.isInteger(want.index) && want.index >= 0) {
    match = [...match].sort((a, b) => a.frameId - b.frameId);
    if (want.index < match.length) return match[want.index].frameId;
  }
  if (match.length !== 1) throw new Error("the point is inside an iframe this extension cannot tell apart from its siblings");
  return match[0].frameId;
}

// Notes whether the tab's top frame starts a navigation or pushes history
// state; stop() removes the listeners and says whether either happened.
function watchNavigation(tabId) {
  let moved = false;
  const onNav = (d) => { if (d.tabId === tabId && d.frameId === 0) moved = true; };
  chrome.webNavigation.onBeforeNavigate.addListener(onNav);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onNav);
  return {
    stop() {
      chrome.webNavigation.onBeforeNavigate.removeListener(onNav);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(onNav);
      return moved;
    },
  };
}

async function settle(tabId) {
  await sleep(300);
  await waitComplete(tabId, 15000);
  await sleep(200);
}

// A freshly loaded app page is "complete" long before it shows anything: the
// first shot of a Partners listing opened in tabshot's window was the empty
// frame with only the header (2026-10-09). So after a load, wait for the page
// to go quiet: no DOM mutation and no finished request for 1.5 s, 8 s at most.
// 500 ms was measured too short on the same page: it sat as a skeleton,
// unchanged, while its API call ran, and drew the form 0.4–1.1 s after a
// 500 ms quiet had already been called.
async function quiet(tabId) {
  try {
    await exec(tabId, 0, pageQuiet, [1500, 8000]);
  } catch {
    // a page that cannot be scripted is photographed as it is
  }
}

async function waitComplete(tabId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return;
    await sleep(100);
  }
}

async function resize(tab, w, h) {
  for (let i = 0; i < 3; i++) {
    const m = await exec(tab.id, 0, pageMeasure, []);
    if (m.w === w && m.h === h) break;
    await chrome.windows.update(tab.windowId, {
      state: "normal",
      width: w + (m.outerW - m.w),
      height: h + (m.outerH - m.h),
    });
    await sleep(250);
  }
  const m = await exec(tab.id, 0, pageMeasure, []);
  return { w: m.w, h: m.h, dpr: m.dpr };
}

// ---------------------------------------------------------------- in-page code
// Each of these is serialised into the tab. They return numbers, booleans and
// the host of an iframe's src — never text from the page.

function pageQuiet(quietMs, maxMs) {
  return new Promise((resolve) => {
    let timer;
    const again = () => { clearTimeout(timer); timer = setTimeout(done, quietMs); };
    const dom = new MutationObserver(again);
    let net = null;
    const done = () => {
      dom.disconnect();
      if (net) net.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve(true);
    };
    dom.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    try {
      net = new PerformanceObserver(again);
      net.observe({ type: "resource" });
    } catch {
      net = null;
    }
    timer = setTimeout(done, quietMs);
    const cap = setTimeout(done, maxMs);
  });
}

function pageMeasure() {
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    outerW: window.outerWidth,
    outerH: window.outerHeight,
    dpr: window.devicePixelRatio,
  };
}

// The two page-side functions below each carry their own copy of
// `describe`: executeScript ships one function and nothing it refers to.
// What it returns is what childFrame() needs to find the iframe among the
// tab's frames — the src, its host, and the iframe's position among the
// document's iframes of the same host in DOM order, which is what tells
// sibling card fields apart.
function pageHitTest(x, y) {
  const describe = (el) => {
    let host = "";
    let url = "";
    try { url = new URL(el.src, location.href).href; host = new URL(url).host; } catch {}
    const siblings = [...document.querySelectorAll("iframe, frame")].filter((f) => {
      try { return new URL(f.src, location.href).host === host; } catch { return false; }
    });
    return { host, url, index: siblings.indexOf(el) };
  };
  const el = document.elementFromPoint(x, y);
  if (!el) return { kind: "none" };
  if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
    const r = el.getBoundingClientRect();
    return { kind: "frame", ...describe(el), left: r.left + el.clientLeft, top: r.top + el.clientTop };
  }
  return { kind: "el" };
}

function pageFocusedFrame() {
  const describe = (el) => {
    let host = "";
    let url = "";
    try { url = new URL(el.src, location.href).href; host = new URL(url).host; } catch {}
    const siblings = [...document.querySelectorAll("iframe, frame")].filter((f) => {
      try { return new URL(f.src, location.href).host === host; } catch { return false; }
    });
    return { host, url, index: siblings.indexOf(el) };
  };
  const el = document.activeElement;
  if (el && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
    return describe(el);
  }
  return null;
}

function pageClick(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  const ptr = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerover", ptr));
  el.dispatchEvent(new MouseEvent("mouseover", base));
  el.dispatchEvent(new PointerEvent("pointermove", ptr));
  el.dispatchEvent(new MouseEvent("mousemove", base));
  el.dispatchEvent(new PointerEvent("pointerdown", { ...ptr, button: 0, buttons: 1 }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0, buttons: 1 }));
  // A click on a field's padding or label should still land the caret in it.
  const focusable = el.closest("input, textarea, select, button, a, [tabindex], [contenteditable]")
    || el.querySelector("input, textarea, [contenteditable]")
    || el;
  if (typeof focusable.focus === "function") focusable.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent("pointerup", { ...ptr, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...base, button: 0, buttons: 0, detail: 1 }));
  return true;
}

function pageType(text, replace) {
  const el = document.activeElement;
  if (!el) return false;
  // --replace: select what the field holds so the insertion below replaces
  // it through the same editing pipeline. Synthetic keys cannot select all
  // (no default action), and a Backspace per character from wherever the
  // click left the caret cannot empty a filled field reliably.
  if (replace && el.tagName !== "SELECT") {
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (typeof el.select === "function") {
      el.select();
    }
  }
  // A native <select> takes no text: synthetic key events never reach its
  // type-ahead and its popup is a window of the OS, not of the page. So text
  // typed at a select picks the option it names — by label first, then by
  // value, exact before prefix — and announces it the way a user's pick is
  // announced, `input` then `change`, which is what frameworks listen for.
  if (el.tagName === "SELECT") {
    const want = text.trim().toLowerCase();
    const options = [...el.options];
    const match = options.find((o) => o.text.trim().toLowerCase() === want)
      || options.find((o) => o.value.trim().toLowerCase() === want)
      || options.find((o) => o.text.trim().toLowerCase().startsWith(want));
    if (!match) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    set.call(el, match.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  const editable = el.isContentEditable
    || (el.tagName === "TEXTAREA")
    || (el.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(el.type));
  if (!editable) return false;
  // execCommand inserts through the editing pipeline, so frameworks that
  // listen for `input` (React included) see it as if typed.
  if (!document.execCommand("insertText", false, text)) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value").set;
    set.call(el, replace ? text : (el.value || "") + text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // A keystroke's commit is more than `input`: forms that validate what they
  // hold read the field on `change` and on the blur that follows, and a form
  // built that way reported fields typed here as empty while showing the
  // text (measured on a hosted checkout, 2026-09-18). So the commit is
  // announced too — `change`, then `focusout`/`blur` as events only, so the
  // caret stays where the next `key` expects it.
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new FocusEvent("blur", { bubbles: false, composed: true }));
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
  return true;
}

function pageKey(key) {
  const el = document.activeElement || document.body;
  const codes = { Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete",
    ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", " ": "Space" };
  const init = { key, code: codes[key] || key, bubbles: true, cancelable: true, composed: true, view: window };
  const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keypress", init));
  // Synthetic keys carry no default action, so the two that matter are done by hand.
  if (proceed && key === "Enter" && el.form && el.tagName !== "TEXTAREA") {
    if (typeof el.form.requestSubmit === "function") el.form.requestSubmit(); else el.form.submit();
  }
  if (proceed && key === "Backspace" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    document.execCommand("delete", false);
  }
  if (proceed && key === "Tab") {
    const all = [...document.querySelectorAll("input, textarea, select, button, a[href], [tabindex]:not([tabindex='-1']), [contenteditable]")]
      .filter((e) => !e.disabled && e.getClientRects().length);
    const i = all.indexOf(el);
    const next = all[(i + 1) % all.length];
    if (next) next.focus();
  }
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
}

// Files go into the page the way the file dialog would put them there: a
// DataTransfer's FileList assigned to the <input type=file> and announced with
// `input` and `change`, which is what React and plain listeners both read. The
// input is found from the point — the element there, the input its <label>
// controls, or the one file input inside the nearest ancestor that has any
// (the hidden input behind a drop zone). Open shadow roots are walked both
// ways, since web-component drop zones keep their input inside one. With no
// input around the point the files are dropped on it instead, as a drag from
// the desktop would. Nothing about the page comes back: a count and which of
// the two ways was used.
function pageUpload(x, y, files) {
  const isFile = (n) => !!n && n.tagName === "INPUT" && String(n.type).toLowerCase() === "file";
  const inputsIn = (root) => {
    const found = [];
    const walk = (node) => {
      for (const el of node.querySelectorAll("*")) {
        if (isFile(el)) found.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    if (isFile(root)) found.push(root);
    if (root.shadowRoot) walk(root.shadowRoot);
    walk(root);
    return found;
  };
  const up = (n) => {
    if (n.parentElement) return n.parentElement;
    const r = n.getRootNode();
    return r instanceof ShadowRoot ? r.host : null;
  };

  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el) return { error: "nothing at that point" };

  let list;
  try {
    list = files.map((f) => {
      const bin = atob(String(f.data || ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], String(f.name || "file"), { type: String(f.type || ""), lastModified: Date.now() });
    });
  } catch {
    return { error: "the files arrived unreadable" };
  }
  const dt = new DataTransfer();
  for (const f of list) dt.items.add(f);

  let input = isFile(el) ? el : null;
  if (!input) {
    const label = el.closest && el.closest("label");
    if (label && isFile(label.control)) input = label.control;
  }
  // Climb a few levels only: far enough to reach the hidden input of the drop
  // zone under the point, not so far that the page's one unrelated file field
  // is taken for it.
  for (let n = el, depth = 0; !input && n && n !== document.body && n !== document.documentElement && depth < 8; n = up(n), depth++) {
    const found = inputsIn(n);
    if (found.length === 1) input = found[0];
    else if (found.length > 1) return { error: `${found.length} file fields around that point — aim closer to the one you mean` };
  }

  if (input) {
    if (input.disabled) return { error: "the file field there is disabled" };
    if (list.length > 1 && !input.multiple) return { error: "that file field takes one file — upload them one at a time" };
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { via: "input", files: list.length };
  }

  const drag = (type) => new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt });
  el.dispatchEvent(drag("dragenter"));
  el.dispatchEvent(drag("dragover"));
  el.dispatchEvent(drag("drop"));
  return { via: "drop", files: list.length };
}

function pageScroll(x, y, dx, dy) {
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement && el !== document.body) {
    const s = getComputedStyle(el);
    const canY = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight;
    const canX = /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth;
    if ((dy && canY) || (dx && canX)) { el.scrollBy(dx, dy); return true; }
    el = el.parentElement;
  }
  window.scrollBy(dx, dy);
  return true;
}
