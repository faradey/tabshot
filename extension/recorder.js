// Session recording: every command tabshot carries out is written down — what
// it was, where it clicked, what it typed — with a picture of the tab after it,
// so the owner can later watch what was done as a screencast. Everything lives
// in this extension's IndexedDB and is read only by sessions.html, a page of the
// extension itself; nothing here goes back to the daemon or the command line.
//
// One frame per step, taken after the action: the frame before step N is the
// frame after step N-1, so a second picture per step would double the storage
// and show nothing new.
//
// Sessions split on silence (decided 2026-10-15): a step more than SPLIT_MINUTES
// after the previous one opens a new session, and so does `tabshot session
// start NAME`, which also names it. `session stop` closes the current one; the
// next step opens a fresh, unnamed one. All of it per caller: the CLI says which
// agent session sent each command, and each has its own recording. Nothing is thrown away automatically
// except past STORE_LIMIT, where the oldest closed sessions go first.

const REC_DB = "tabshot-sessions";
const SPLIT_MINUTES = 15;
const STORE_LIMIT = 500 * 1024 * 1024;
const FRAME_WIDTH = 1280;

function recDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(REC_DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
      const steps = db.createObjectStore("steps", { keyPath: "id", autoIncrement: true });
      steps.createIndex("session", "session");
      db.createObjectStore("frames", { keyPath: "id", autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function recReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function recSettings() {
  const { recording } = await chrome.storage.local.get({ recording: true });
  return { on: recording !== false };
}

// Each caller — one session of a coding agent, as the CLI identifies it — has
// its own open recording: several drive tabshot at once, and one shared
// recording interleaved their steps (2026-10-15).
async function currents() {
  const { recCurrents } = await chrome.storage.local.get({ recCurrents: {} });
  return recCurrents || {};
}

async function setCurrent(caller, id) {
  const all = await currents();
  if (id) all[caller] = id; else delete all[caller];
  await chrome.storage.local.set({ recCurrents: all });
}

// The caller's open session, or a new one when there is none or it went quiet.
async function currentSession(db, now, name, caller) {
  const id = (await currents())[caller] || 0;
  let s = id ? await recReq(db.transaction("sessions").objectStore("sessions").get(id)) : null;
  if (s && !name && now - s.lastAt <= SPLIT_MINUTES * 60000) return s;
  if (s) {
    s.closed = true;
    await recReq(db.transaction("sessions", "readwrite").objectStore("sessions").put(s));
  }
  s = { name: name || "", caller, startedAt: now, lastAt: now, steps: 0, bytes: 0, domains: [], closed: false };
  s.id = await recReq(db.transaction("sessions", "readwrite").objectStore("sessions").add(s));
  await setCurrent(caller, s.id);
  return s;
}

// `tabshot session start [NAME]` / `stop`. Answered like any other command.
async function sessionCommand(cmd) {
  const db = await recDb();
  const now = Date.now();
  const caller = String(cmd.caller || "unknown");
  if (cmd.op === "start") {
    const s = await currentSession(db, now, String(cmd.name || "").slice(0, 200) || `session ${new Date(now).toLocaleString()}`, caller);
    return { ok: true, note: `recording into session #${s.id}${s.name ? ` "${s.name}"` : ""}` };
  }
  if (cmd.op === "stop") {
    const id = (await currents())[caller] || 0;
    if (!id) return { ok: true, note: "no session open" };
    const s = await recReq(db.transaction("sessions").objectStore("sessions").get(id));
    if (s) { s.closed = true; await recReq(db.transaction("sessions", "readwrite").objectStore("sessions").put(s)); }
    await setCurrent(caller, 0);
    return { ok: true, note: `session #${id} closed — ${s ? s.steps : 0} step(s)` };
  }
  return { ok: false, error: `unknown session op ${cmd.op} — start or stop` };
}

// What a step says about itself. Typed text is kept so the screencast can say
// what was entered, except where the field was a secret (pageType reports it)
// — then only its length. Uploaded files are named, never kept.
function describeStep(cmd, res, secret) {
  const s = { action: cmd.action, domain: cmd.domain || "", ok: !!res.ok };
  if (cmd.x != null) s.x = Number(cmd.x);
  if (cmd.y != null) s.y = Number(cmd.y);
  if (cmd.action === "type") s.text = secret ? `•••••• (${String(cmd.text || "").length})` : String(cmd.text || "");
  if (cmd.action === "key") s.key = String(cmd.key || "");
  if (cmd.action === "scroll") { s.dx = Number(cmd.dx) || 0; s.dy = Number(cmd.dy) || 0; }
  if (cmd.action === "resize") { s.w = Number(cmd.w) || 0; s.h = Number(cmd.h) || 0; }
  if (cmd.action === "open") s.url = String(cmd.url || "");
  if (cmd.action === "upload" && Array.isArray(cmd.files)) s.files = cmd.files.map((f) => String(f.name || "file"));
  if (!res.ok) s.error = String(res.error || "");
  if (res.note) s.note = String(res.note);
  return s;
}

// The picture, as a JPEG no wider than FRAME_WIDTH. Errors are swallowed: a
// step without a frame is still worth having.
async function recFrame(tab) {
  try {
    if (!tab || !(await canCapture(tab))) return null;
    const dataUrl = await captureTab(tab.windowId, "jpeg");
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, FRAME_WIDTH / bmp.width);
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
    // The viewport in CSS pixels, so the player can put a click where it was.
    const vp = await exec(tab.id, 0, pageMeasure, []).catch(() => null);
    return { blob, w, h, vw: vp ? vp.w : 0, vh: vp ? vp.h : 0 };
  } catch {
    return null;
  }
}

async function recordStep(cmd, res, tab, secret) {
  if (!cmd || !cmd.action || cmd.action === "status" || cmd.action === "session") return;
  if (!(await recSettings()).on) return;
  const db = await recDb();
  const now = Date.now();
  const s = await currentSession(db, now, "", String(cmd.caller || "unknown"));
  const step = { session: s.id, t: now, ...describeStep(cmd, res, secret) };
  const frame = await recFrame(tab);
  if (frame) {
    step.frame = await recReq(db.transaction("frames", "readwrite").objectStore("frames").add({ blob: frame.blob, w: frame.w, h: frame.h }));
    step.vw = frame.vw;
    step.vh = frame.vh;
    s.bytes += frame.blob.size;
  }
  await recReq(db.transaction("steps", "readwrite").objectStore("steps").add(step));
  s.steps += 1;
  s.lastAt = now;
  if (step.domain && !s.domains.includes(step.domain)) s.domains.push(step.domain);
  await recReq(db.transaction("sessions", "readwrite").objectStore("sessions").put(s));
  await recTrim(db, s.id);
}

// Over the limit, the oldest sessions go first — never one still being written.
async function recTrim(db, keep) {
  const all = await recReq(db.transaction("sessions").objectStore("sessions").getAll());
  const open = new Set(Object.values(await currents()));
  let total = all.reduce((n, s) => n + (s.bytes || 0), 0);
  for (const s of all.sort((a, b) => a.startedAt - b.startedAt)) {
    if (total <= STORE_LIMIT) break;
    if (s.id === keep || open.has(s.id)) continue;
    total -= s.bytes || 0;
    await recDeleteSession(db, s.id);
  }
}

async function recDeleteSession(db, id) {
  const steps = await recReq(db.transaction("steps").objectStore("steps").index("session").getAll(id));
  const tx = db.transaction(["steps", "frames", "sessions"], "readwrite");
  for (const st of steps) {
    tx.objectStore("steps").delete(st.id);
    if (st.frame) tx.objectStore("frames").delete(st.frame);
  }
  tx.objectStore("sessions").delete(id);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}
