// Regenerates the Chrome Web Store screenshots (store/screenshots/*.png) from a
// real run: the extension in this repo, loaded into Chrome for Testing, driven
// by the tabshot CLI through a second daemon on its own port. The owner's
// Chrome and daemon are never touched. The page it drives is a fictional shop
// admin (site/), served locally and reached as admin.example.com through
// --host-resolver-rules.
//
//   npm install
//   node shoot.mjs [--chrome PATH] [--tabshot BIN] [--out DIR] [--port N]
//
// --chrome   Chrome for Testing or Chromium; branded Chrome ignores
//            --load-extension. Default: the newest one in Playwright's cache.
// --tabshot  the CLI binary (default: tabshot on PATH)
// --out      where the three PNGs go (default: store/screenshots)
// --port     the throwaway daemon's port (default 47899)
//
// The CLI and the throwaway daemon share the token in ~/.config/tabshot.
import { chromium } from "playwright-core";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SRC = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(SRC, "../../..");
const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

function defaultChrome() {
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split("-")[1] - +a.split("-")[1]) : [];
  for (const b of builds) {
    for (const p of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-linux/chrome",
    ]) {
      const full = path.join(cache, b, p);
      if (fs.existsSync(full)) return full;
    }
  }
  return "";
}

const CHROME = opt("chrome", defaultChrome());
const TABSHOT = opt("tabshot", "tabshot");
const DEST = path.resolve(opt("out", path.resolve(SRC, "..")));
const PORT = Number(opt("port", "47899"));
const WEB = 8765;
const HOST = "admin.example.com";
if (!CHROME) {
  console.error("no Chrome for Testing found — pass --chrome PATH (npx playwright install chromium puts one in the cache)");
  process.exit(2);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "tabshot-shots-"));
const OUT = path.join(WORK, "out");
const EXT = path.join(WORK, "ext");
const PROFILE = path.join(WORK, "profile");
fs.mkdirSync(OUT);
fs.mkdirSync(DEST, { recursive: true });
fs.cpSync(path.join(REPO, "extension"), EXT, { recursive: true });
// The test profile cannot click the toolbar icon or answer a permission
// prompt, so the copy holds <all_urls> outright ("Capture without a click").
const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
mf.host_permissions.push("<all_urls>");
fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify(mf, null, 2));

const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const token = fs.readFileSync(path.join(cfg, "tabshot/token"), "utf8").trim();
const procs = [
  spawn(TABSHOT, ["serve", "--port", String(PORT)], { stdio: "ignore" }),
  spawn("python3", ["-m", "http.server", String(WEB), "--bind", "127.0.0.1", "--directory", path.join(SRC, "site")], { stdio: "ignore" }),
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transcript = [];

// Async on purpose: Playwright must keep answering Chrome while the CLI runs.
// A navigation starts a new renderer that waits for Playwright to release it,
// and a blocked event loop (execFileSync) left a click hanging for 55 s.
async function cli(args, show = true) {
  const out = (await new Promise((resolve, reject) => execFile(TABSHOT, [args[0], "--port", String(PORT), ...args.slice(1)], {
    cwd: OUT, env: { ...process.env, TABSHOT_CALLER: "terminal" }, encoding: "utf8",
  }, (e, so, se) => (e ? reject(new Error(`tabshot ${args.join(" ")}: ${se || e.message}`)) : resolve(so))))).trim();
  if (show) transcript.push({ cmd: "tabshot " + args.join(" "), out });
  console.log("$ tabshot", args.join(" "), "\n" + out);
  return out;
}

let ctx;
try {
  await sleep(800);
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    viewport: null,
    args: [
      "--headless=new",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${WEB}`,
      "--window-size=1280,900",
      // The default headless screen is 800×600, too small for a 1280×800 viewport.
      "--screen-info={0,0 2560x1600}",
    ],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
  await sw.evaluate(async ([token, port, host]) => {
    await chrome.storage.local.set({ token, port, domains: [host] });
  }, [token, PORT, HOST]);
  let connected = false;
  for (let i = 0; i < 40 && !connected; i++) {
    try {
      connected = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).extension_connected;
    } catch { /* daemon still starting */ }
    if (!connected) await sleep(500);
  }
  if (!connected) throw new Error(`the extension never reached the daemon on port ${PORT}`);

  // Coordinates of the targets, measured in a plain page at the same viewport.
  const probe = await ctx.newPage();
  await probe.setViewportSize({ width: 1280, height: 800 });
  const center = (sel) => probe.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return `${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}`;
  }, sel);
  await probe.goto(`http://${HOST}/orders.html`);
  const o1042 = await center("#o1042");
  await probe.goto(`http://${HOST}/order-1042.html`);
  const refundBtn = await center("#refundBtn");
  await probe.evaluate(() => document.getElementById("refund").classList.remove("hidden"));
  const amount = await center("#amount");
  const reason = await center("#reason");
  const issue = await center("#issue");
  await probe.close();
  const xy = (p) => p.split(",");

  await cli(["session", "start", "Refund order #1042"], false);
  await cli(["open", `--url=http://${HOST}/orders.html`]);
  await cli(["resize", `--domain=${HOST}`, "1280", "800"], false);
  await cli(["shot", `--domain=${HOST}`, "--out=orders.png"]);
  await cli(["click", `--domain=${HOST}`, ...xy(o1042)]);
  await cli(["click", `--domain=${HOST}`, ...xy(refundBtn)]);
  await cli(["type", `--domain=${HOST}`, `--at=${amount}`, "48.00"]);
  await cli(["type", `--domain=${HOST}`, `--at=${reason}`, "Arrived damaged"]);
  await cli(["click", `--domain=${HOST}`, "--shot=refunded.png", ...xy(issue)]);
  await sleep(2500); // the last step's frame is written after the answer
  await cli(["session", "stop"], false);

  // 2. The recorded session, paused on the last click with its marker.
  const sp = await ctx.newPage();
  await sp.setViewportSize({ width: 1280, height: 800 });
  await sp.goto(`chrome-extension://${id}/sessions.html`);
  await sp.waitForFunction(() => typeof steps !== "undefined" && steps.length > 0);
  await sleep(500);
  await sp.evaluate(() => {
    let i = steps.length - 1;
    while (i > 0 && steps[i].action !== "click") i--;
    cur = i; draw(i, 0.3); highlight();
  });
  await sp.screenshot({ path: path.join(DEST, "2-sessions.png") });

  // 3. Options with the example allow list, at the default port.
  await sw.evaluate(async () => { await chrome.storage.local.set({ port: 47831, lastError: "" }); });
  const op = await ctx.newPage();
  await op.setViewportSize({ width: 1280, height: 800 });
  await op.goto(`chrome-extension://${id}/options.html`);
  await sleep(500);
  await op.evaluate(() => {
    document.body.style.zoom = "1.2";
    document.body.style.margin = "20px auto";
    // The test copy holds <all_urls>; a fresh install has this off.
    document.getElementById("noclick").checked = false;
    const fade = document.createElement("div");
    fade.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:120px;background:linear-gradient(#fff0,#fff 85%)";
    document.body.append(fade);
  });
  await op.screenshot({ path: path.join(DEST, "3-options.png") });

  // 1. The transcript beside the PNG the CLI saved.
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pretty = (cmd) => cmd.replace(/--([a-z]+)=(\S+)/g, "--$1 $2").replace(/ (Arrived damaged)$/, ' "$1"');
  const lines = transcript
    .map(({ cmd, out }) => `<div class="c"><span class="p">$</span> ${esc(pretty(cmd))}</div>` +
      out.split("\n").map((l) => `<div class="o">${esc(l.replace(/; viewport.*$/, ""))}</div>`).join(""))
    .join("");
  const img = fs.readFileSync(path.join(OUT, "refunded.png")).toString("base64");
  const card = await ctx.newPage();
  await card.setViewportSize({ width: 1280, height: 800 });
  await card.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; width: 1280px; height: 800px; background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; overflow: hidden; }
    h1 { font-size: 34px; margin: 52px 0 8px 56px; color: #fff; letter-spacing: -.01em; }
    .sub { margin: 0 0 36px 56px; font-size: 18px; color: #94a3b8; }
    .row { display: flex; gap: 32px; padding: 0 56px; align-items: flex-start; }
    .term { width: 540px; background: #020617; border: 1px solid #1e293b; border-radius: 12px; overflow: hidden; flex: none; }
    .bar { height: 32px; background: #1e293b; display: flex; gap: 8px; align-items: center; padding: 0 14px; }
    .bar i { width: 12px; height: 12px; border-radius: 50%; background: #475569; display: block; }
    .body { padding: 14px 16px 18px; font: 13.5px/1.55 ui-monospace, Menlo, monospace; }
    .c { color: #f8fafc; margin-top: 7px; }
    .c:first-child { margin-top: 0; }
    .p { color: #34d399; }
    .o { color: #94a3b8; white-space: pre-wrap; }
    .shot { flex: 1; }
    .shot img { width: 100%; border-radius: 10px; border: 1px solid #1e293b; display: block; }
    .cap { margin-top: 12px; font-size: 15px; color: #94a3b8; }
    .cap b { color: #e2e8f0; font-weight: 600; }
  </style></head><body>
    <h1>Your terminal asks. The browser answers with pixels.</h1>
    <div class="sub">Click, type and screenshot in allow-listed tabs. Page text, cookies and URLs never leave the browser.</div>
    <div class="row">
      <div class="term"><div class="bar"><i></i><i></i><i></i></div><div class="body">${lines}</div></div>
      <div class="shot"><img src="data:image/png;base64,${img}"><div class="cap"><b>refunded.png</b> — all the command line gets back: a picture and “ok”.</div></div>
    </div>
  </body></html>`);
  await card.screenshot({ path: path.join(DEST, "1-terminal.png") });
  console.log(`screenshots in ${DEST}`);
} finally {
  if (ctx) await ctx.close().catch(() => {});
  for (const p of procs) p.kill();
  fs.rmSync(WORK, { recursive: true, force: true });
}
