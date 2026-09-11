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
  return m.replace(/https?:\/\/\S+/g, "<url>");
}

chrome.runtime.onStartup.addListener(pollLoop);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("poll", { periodInMinutes: 0.5 });
  pollLoop();
});
chrome.alarms.onAlarm.addListener(pollLoop);
chrome.runtime.onMessage.addListener(() => { pollLoop(); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
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

  let tab = await isolate(pickTab(tabs));
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
      if (!typed) return { ok: false, error: "no editable element has focus — give --at X,Y" };
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
    Object.assign(out, await capture(tab, cmd.zoom));
  }
  return out;
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

async function capture(tab, zoom) {
  const vp = await exec(tab.id, 0, pageMeasure, []);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = bmp.width / vp.w; // real capture scale (device pixel ratio, in practice)

  let sx = 0, sy = 0, sw = vp.w, sh = vp.h, ow = vp.w, oh = vp.h, scale = 1;
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
    frameId = await childFrame(tabId, frameId, hit.host);
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
    frameId = await childFrame(tabId, frameId, f.host);
  }
  return frameId;
}

async function childFrame(tabId, parentId, host) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const kids = frames.filter((f) => f.parentFrameId === parentId && f.url && !f.url.startsWith("about:"));
  let match = kids.filter((f) => { try { return new URL(f.url).host === host; } catch { return false; } });
  if (match.length === 0 && kids.length === 1) match = kids;
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

function pageHitTest(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { kind: "none" };
  if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
    const r = el.getBoundingClientRect();
    let host = "";
    try { host = new URL(el.src, location.href).host; } catch {}
    return { kind: "frame", host, left: r.left + el.clientLeft, top: r.top + el.clientTop };
  }
  return { kind: "el" };
}

function pageFocusedFrame() {
  const el = document.activeElement;
  if (el && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
    let host = "";
    try { host = new URL(el.src, location.href).host; } catch {}
    return { host };
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
  const focusable = el.closest("input, textarea, select, button, a, [tabindex], [contenteditable]") || el;
  if (typeof focusable.focus === "function") focusable.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent("pointerup", { ...ptr, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...base, button: 0, buttons: 0, detail: 1 }));
  return true;
}

function pageType(text) {
  const el = document.activeElement;
  if (!el) return false;
  const editable = el.isContentEditable
    || (el.tagName === "TEXTAREA")
    || (el.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(el.type));
  if (!editable) return false;
  // execCommand inserts through the editing pipeline, so frameworks that
  // listen for `input` (React included) see it as if typed.
  if (document.execCommand("insertText", false, text)) return true;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value").set;
  set.call(el, (el.value || "") + text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
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
