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
chrome.alarms.onAlarm.addListener(pollLoop);
chrome.runtime.onMessage.addListener(() => { pollLoop(); });
// Clicking the icon on a tab is what lets it be photographed: captureVisibleTab
// accepts only activeTab or <all_urls>, and a host permission for the page is
// not enough. The grant is Chrome's, per tab, and lasts while the tab stays
// on that origin; the badge is the only record of it.
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.action.setBadgeText({ tabId: tab.id, text: "on" });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#2a7" });
});
pollLoop();

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
  const tabs = await chrome.tabs.query({ url: [`*://${domain}/*`, `*://*.${domain}/*`] });
  if (cmd.action === "status") {
    return { ok: true, open: tabs.length > 0, tabs: tabs.length };
  }
  if (!tabs.length) return { ok: false, error: `no open tab for ${domain}` };

  let tab = await retry(() => isolate(pickTab(tabs)));
  const out = { ok: true };

  switch (cmd.action) {
    case "shot":
      break;
    case "click": {
      const p = await resolvePoint(tab.id, num(cmd.x), num(cmd.y));
      const hit = await exec(tab.id, p.frameId, pageClick, [p.x, p.y]);
      if (!hit) return { ok: false, error: "nothing at that point" };
      await settle(tab.id);
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
      const typed = await exec(tab.id, frameId, pageType, [String(cmd.text ?? "")]);
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
      break;
    case "resize": {
      out.viewport = await resize(tab, num(cmd.w), num(cmd.h));
      break;
    }
    default:
      return { ok: false, error: `unknown action ${cmd.action}` };
  }

  if (cmd.action === "shot" || cmd.shot) {
    tab = await chrome.tabs.get(tab.id);
    Object.assign(out, await capture(tab, cmd.zoom, cmd.width != null ? num(cmd.width) : 0));
  }
  return out;
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
// shared tab gets a window of its own: the owner keeps browsing elsewhere and
// nothing else can appear in the frame.
async function isolate(tab) {
  const win = await chrome.windows.get(tab.windowId, { populate: true });
  if (win.tabs.length > 1) {
    await chrome.windows.create({ tabId: tab.id, focused: false, state: "normal" });
    tab = await chrome.tabs.get(tab.id);
  } else {
    if (win.state === "minimized") await chrome.windows.update(win.id, { state: "normal", focused: false });
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
  }
  await sleep(150);
  return tab;
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

async function settle(tabId) {
  await sleep(300);
  await waitComplete(tabId, 15000);
  await sleep(200);
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

function pageType(text) {
  const el = document.activeElement;
  if (!el) return false;
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
    set.call(el, (el.value || "") + text);
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
