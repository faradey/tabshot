// The viewer for what recorder.js wrote: a list of sessions, a player that
// shows each step's frame with where it clicked and what it typed, deletion,
// and an export of the same playback as a .webm made in this page.

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const ctx = canvas.getContext("2d");

let db = null;
let session = null; // the selected session record
let steps = [];     // its steps, oldest first
let images = [];    // ImageBitmap (or null) per step
let cur = 0;
let playing = false;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("tabshot-sessions", 1);
    // The service worker creates the stores; opening here before it ever ran
    // creates them the same way.
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
      d.createObjectStore("steps", { keyPath: "id", autoIncrement: true }).createIndex("session", "session");
      d.createObjectStore("frames", { keyPath: "id", autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

function mb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
function when(t) { return new Date(t).toLocaleString(); }
function dur(ms) { const m = Math.round(ms / 60000); return m < 1 ? "<1 min" : m + " min"; }

async function renderList() {
  const all = (await req(db.transaction("sessions").objectStore("sessions").getAll())).sort((a, b) => b.startedAt - a.startedAt);
  const list = $("list");
  list.textContent = "";
  if (!all.length) { list.innerHTML = '<div class="empty">Nothing recorded yet.</div>'; return; }
  const total = all.reduce((n, s) => n + (s.bytes || 0), 0);
  const head = document.createElement("div");
  head.className = "sess meta";
  head.style.cursor = "default";
  head.textContent = `${all.length} session(s), ${mb(total)}`;
  list.append(head);
  for (const s of all) {
    const el = document.createElement("div");
    el.className = "sess" + (session && session.id === s.id ? " sel" : "");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = (s.name || `#${s.id}`) + (s.closed ? "" : " (recording)");
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${when(s.startedAt)} · ${dur(s.lastAt - s.startedAt)} · ${s.steps} steps · ${mb(s.bytes || 0)}${s.domains && s.domains.length ? " · " + s.domains.join(", ") : ""}${s.caller ? " · " + s.caller : ""}`;
    el.append(name, meta);
    el.onclick = () => select(s.id);
    list.append(el);
  }
}

async function select(id) {
  playing = false;
  session = await req(db.transaction("sessions").objectStore("sessions").get(id));
  steps = (await req(db.transaction("steps").objectStore("steps").index("session").getAll(id))).sort((a, b) => a.t - b.t);
  images.forEach((b) => b && b.close && b.close());
  images = await Promise.all(steps.map(async (st) => {
    if (!st.frame) return null;
    const f = await req(db.transaction("frames").objectStore("frames").get(st.frame));
    return f ? await createImageBitmap(f.blob) : null;
  }));
  const first = images.find(Boolean);
  if (first) { canvas.width = first.width; canvas.height = first.height; }
  cur = 0;
  renderSteps();
  draw(0, 1);
  renderList();
}

function label(st) {
  const p = st.x != null ? ` @${st.x},${st.y}` : "";
  switch (st.action) {
    case "click": return `click${p}`;
    case "type": return `type${p} "${st.text}"`;
    case "key": return `key ${st.key}`;
    case "scroll": return `scroll ${st.dx},${st.dy}${p}`;
    case "open": return `open ${st.url}`;
    case "upload": return `upload${p} ${(st.files || []).join(", ")}`;
    case "resize": return `resize ${st.w}×${st.h}`;
    default: return st.action;
  }
}

function renderSteps() {
  const box = $("steps");
  box.textContent = "";
  if (!steps.length) { box.innerHTML = '<div class="empty">This session has no steps.</div>'; return; }
  steps.forEach((st, i) => {
    const el = document.createElement("div");
    el.className = "step" + (i === cur ? " cur" : "") + (st.ok ? "" : " err");
    const t = new Date(st.t).toLocaleTimeString();
    el.textContent = `${String(i + 1).padStart(3)}  ${t}  ${st.domain.padEnd(18)} ${label(st)}${st.error ? "  — " + st.error : ""}`;
    el.onclick = () => { playing = false; cur = i; draw(i, 1); highlight(); };
    box.append(el);
  });
}

function highlight() {
  [...$("steps").children].forEach((el, i) => el.classList.toggle("cur", i === cur));
  const el = $("steps").children[cur];
  if (el) el.scrollIntoView({ block: "nearest" });
  $("pos").textContent = steps.length ? `${cur + 1} / ${steps.length}` : "";
}

// The frame a step should be shown over: before the action, that is the last
// frame of an earlier step; after it, its own.
function frameBefore(i) { for (let j = i - 1; j >= 0; j--) if (images[j]) return images[j]; return images[i]; }
function frameAfter(i) { for (let j = i; j >= 0; j--) if (images[j]) return images[j]; return null; }

// Draws step i at phase p in [0,1]: the first part shows the page before the
// action with the click marked, the rest the page after it.
function draw(i, p) {
  const st = steps[i];
  if (!st) { ctx.fillStyle = "#111"; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
  const pointed = st.x != null && (st.action === "click" || st.action === "type" || st.action === "upload" || st.action === "scroll");
  const img = pointed && p < 0.45 ? frameBefore(i) : frameAfter(i);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (pointed && st.vw) {
    const k = canvas.width / st.vw;
    const x = st.x * k, y = st.y * k;
    const r = 18 + 14 * Math.min(1, p / 0.45);
    ctx.lineWidth = 4;
    ctx.strokeStyle = `rgba(255,60,60,${p < 0.45 ? 0.95 : 0.5})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(255,60,60,0.9)";
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
  }
  // Caption bar.
  const text = `${i + 1}/${steps.length}  ${st.domain}  ${label(st)}${st.error ? "  — " + st.error : ""}`;
  const fs = Math.max(14, Math.round(canvas.width / 70));
  ctx.font = `${fs}px -apple-system, sans-serif`;
  const h = fs * 2;
  ctx.fillStyle = st.ok ? "rgba(0,0,0,0.72)" : "rgba(140,0,0,0.8)";
  ctx.fillRect(0, canvas.height - h, canvas.width, h);
  ctx.fillStyle = "#fff";
  ctx.fillText(text.length > 160 ? text.slice(0, 157) + "…" : text, fs * 0.7, canvas.height - h * 0.32);
}

// How long a step stays on screen: its real gap to the next one, squeezed
// into 0.8–3 s so a long pause does not stall the film.
function stepMs(i, speed) {
  const gap = i + 1 < steps.length ? steps[i + 1].t - steps[i].t : 1500;
  return Math.max(800, Math.min(3000, gap)) / speed;
}

async function play(onFrame) {
  playing = true;
  $("play").textContent = "❚❚ Pause";
  const speed = parseFloat($("speed").value) || 1;
  for (; cur < steps.length && playing; cur++) {
    highlight();
    const ms = stepMs(cur, speed);
    const t0 = performance.now();
    for (;;) {
      const p = Math.min(1, (performance.now() - t0) / ms);
      draw(cur, p);
      if (onFrame) onFrame();
      if (p >= 1 || !playing) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
  if (cur >= steps.length) cur = steps.length - 1;
  playing = false;
  $("play").textContent = "▶ Play";
}

$("play").onclick = () => {
  if (!steps.length) return;
  if (playing) { playing = false; return; }
  if (cur >= steps.length - 1) cur = 0;
  play();
};
$("prev").onclick = () => { playing = false; cur = Math.max(0, cur - 1); draw(cur, 1); highlight(); };
$("next").onclick = () => { playing = false; cur = Math.min(steps.length - 1, cur + 1); draw(cur, 1); highlight(); };

$("export").onclick = async () => {
  if (!steps.length) return;
  playing = false;
  await new Promise((r) => setTimeout(r, 50));
  const stream = canvas.captureStream(30);
  const type = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => { rec.onstop = r; });
  $("export").disabled = true;
  $("export").textContent = "Recording…";
  rec.start(1000);
  cur = 0;
  await play();
  rec.stop();
  await done;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
  const stamp = new Date(session.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  a.download = `tabshot-${stamp}${session.name ? "-" + session.name.replace(/[^\w.-]+/g, "_").slice(0, 40) : ""}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  $("export").disabled = false;
  $("export").textContent = "Download .webm";
};

async function deleteSession(id) {
  const st = await req(db.transaction("steps").objectStore("steps").index("session").getAll(id));
  const tx = db.transaction(["steps", "frames", "sessions"], "readwrite");
  for (const s of st) {
    tx.objectStore("steps").delete(s.id);
    if (s.frame) tx.objectStore("frames").delete(s.frame);
  }
  tx.objectStore("sessions").delete(id);
  await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
  const { recCurrents } = await chrome.storage.local.get({ recCurrents: {} });
  for (const [k, v] of Object.entries(recCurrents || {})) if (v === id) delete recCurrents[k];
  await chrome.storage.local.set({ recCurrents });
}

$("delete").onclick = async () => {
  if (!session || !confirm(`Delete session ${session.name || "#" + session.id} (${session.steps} steps)?`)) return;
  await deleteSession(session.id);
  session = null; steps = []; images = [];
  renderSteps(); draw(0, 1);
  renderList();
};

$("deleteAll").onclick = async () => {
  const all = await req(db.transaction("sessions").objectStore("sessions").getAll());
  if (!all.length || !confirm(`Delete all ${all.length} sessions?`)) return;
  const tx = db.transaction(["steps", "frames", "sessions"], "readwrite");
  tx.objectStore("steps").clear();
  tx.objectStore("frames").clear();
  tx.objectStore("sessions").clear();
  await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
  await chrome.storage.local.set({ recCurrents: {} });
  session = null; steps = []; images = [];
  renderSteps(); draw(0, 1);
  renderList();
};

$("recording").onchange = (e) => chrome.storage.local.set({ recording: e.target.checked });

(async () => {
  db = await open();
  const { recording } = await chrome.storage.local.get({ recording: true });
  $("recording").checked = recording !== false;
  await renderList();
  const first = $("list").querySelector(".sess:not(.meta)");
  if (first) first.click();
})();
