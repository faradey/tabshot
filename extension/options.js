const $ = (id) => document.getElementById(id);

function normalise(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim().toLowerCase();
    if (!line) continue;
    line = line.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "").replace(/^\./, "");
    if (/^[a-z0-9.-]+$/.test(line) && !out.includes(line)) out.push(line);
  }
  return out;
}

function origins(domains) {
  return domains.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
}

async function load() {
  const c = await chrome.storage.local.get({ domains: [], port: 47831, token: "", lastPoll: 0, lastError: "" });
  $("domains").value = c.domains.join("\n");
  $("port").value = c.port;
  $("token").value = c.token;
  $("noclick").checked = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  const granted = await chrome.permissions.getAll();
  const missing = c.domains.filter((d) => !granted.origins.includes(`*://${d}/*`));
  let s = c.lastPoll ? `Last contact with the daemon: ${new Date(c.lastPoll).toLocaleTimeString()}.` : "Never reached the daemon yet.";
  if (c.lastError) s += ` Last error: ${c.lastError}`;
  if (missing.length) s += ` Host access not yet granted for: ${missing.join(", ")} — press Save.`;
  $("state").textContent = s;
}

$("save").addEventListener("click", async () => {
  const domains = normalise($("domains").value);
  const port = parseInt($("port").value, 10) || 47831;
  const token = $("token").value.trim();
  const before = (await chrome.storage.local.get({ domains: [] })).domains;

  // Host access is exactly the allow list: ask for the new domains, drop the
  // removed ones. Both must happen inside this click — Chrome only shows the
  // permission prompt from a user gesture.
  const wanted = origins(domains);
  if (wanted.length) {
    const ok = await chrome.permissions.request({ origins: wanted });
    if (!ok) {
      $("state").textContent = "Host access was not granted; nothing saved.";
      return;
    }
  }
  const gone = before.filter((d) => !domains.includes(d));
  if (gone.length) await chrome.permissions.remove({ origins: origins(gone) }).catch(() => {});

  await chrome.storage.local.set({ domains, port, token, lastError: "" });
  $("domains").value = domains.join("\n");
  chrome.runtime.sendMessage({ type: "config-changed" }).catch(() => {});
  await load();
  $("state").textContent += " Saved.";
});

// The prompt must come from this click, so the toggle asks (or gives back) at
// once rather than on Save.
$("noclick").addEventListener("change", async (e) => {
  const on = e.target.checked;
  try {
    if (on) {
      const ok = await chrome.permissions.request({ origins: ["<all_urls>"] });
      if (!ok) e.target.checked = false;
    } else {
      await chrome.permissions.remove({ origins: ["<all_urls>"] });
    }
  } catch (err) {
    e.target.checked = !on;
    $("state").textContent = `Could not change the access: ${err.message}`;
    return;
  }
  await load();
  $("state").textContent += e.target.checked ? " Capturing without a click." : " A click on the icon is needed again.";
});

load();
