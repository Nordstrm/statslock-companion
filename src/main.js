// Plain JS (no bundler) keeps the installer tiny.
// Requires "withGlobalTauri": true in tauri.conf.json.
const T = window.__TAURI__;
if (!T?.core) { document.getElementById("list").innerHTML = '<div class="card err">App bridge not available. Please reinstall the latest Statslock Companion.</div>'; throw new Error("no __TAURI__"); }
const { invoke } = T.core;
const { listen } = T.event;
const SITE = "https://statslock.io";
const list = document.getElementById("list");
const q = document.getElementById("q");
let liveError = null, pollTimer = null;
let metaError = null, settings = { hotkey: "F8", opacity: 0.94 }, listening = false, settingsMsg = "";
let meta = null, me = null, live = null, tab = "live", gameRunning = false, profile = null;
// Local cache: your public profile summary is stored on this PC so the app opens instantly.
const PROFILE_KEY = "statslock.profile.v1";
try { profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null"); } catch { profile = null; }
const saveProfile = () => { try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...profile, saved_at: Date.now() })); } catch {} };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const names = (v) => (Array.isArray(v) ? v.slice(0, 6).map((x) => (typeof x === "string" ? x : x?.name ?? x?.hero_name ?? "")).filter(Boolean) : []);
const chips = (arr) => arr.map((n) => `<span class="chip">${esc(n)}</span>`).join("") || '<span class="row">No data yet</span>';
const rank = (p) => (p.rank_tier ? `${esc(p.rank_tier)}${p.sub_rank ? " " + p.sub_rank : ""}` : "Unranked / unknown");
const wr = (w, l) => { const g = (w ?? 0) + (l ?? 0); if (!g) return '<span class="muted">No games recorded</span>'; const r = (100 * w) / g; return `<span class="${r >= 50 ? "wr-good" : "wr-bad"}">${r.toFixed(0)}% WR</span> <span class="muted">(${g})</span>`; };
const link = (url, label) => `<a class="link" href="${esc(url)}" data-url="${esc(url)}">${label}</a>`;
const heroMeta = (id) => meta?.heroes?.find((h) => h.hero_id === id);

function playerCard(p) {
  const h = heroMeta(p.hero_id);
  return `<div class="card player ${p.ally ? "ally" : "enemy"}">
    ${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="" />` : '<div class="avatar"></div>'}
    <div><div><b>${esc(p.name ?? "Unknown player")}</b>${p.me ? ' <span class="muted">(you)</span>' : ""}</div>
      <div class="row" style="justify-content:flex-start">${esc(p.hero_name)} · ${rank(p)}</div>
      <div class="row" style="justify-content:flex-start">${p.name ? wr(p.wins, p.losses) : '<span class="muted">Not on Statslock yet</span>'}${h?.win_rate != null ? ` · hero ${Number(h.win_rate).toFixed(1)}%` : ""}</div></div>
    ${link(p.profile_url, "Profile")}
  </div>`;
}

function renderLive() {
  if (!gameRunning && !live?.in_match) return `<div class="card">Start Deadlock and join a match — both teams will show here.<br><span class="muted">Only matches listed by the public Deadlock API can be found, so some games may not appear.</span></div>`;
  if (!me) return `<div class="card">Couldn't find your Steam account. Make sure Steam is running.</div>`;
  if (liveError) return `<div class="card">${esc(liveError)}</div>`;
  if (!live) return `<div class="card">Looking for your match…</div>`;
  if (!live.in_match) return `<div class="card">No live match found for you yet. Checking every 30 seconds.<br><span class="muted">Only matches listed by the public Deadlock API can be found.</span></div>`;
  const enemies = live.players.filter((p) => !p.ally), allies = live.players.filter((p) => p.ally);
  return `<div class="row"><span>Match ${esc(live.match_id)}${live.match_mode ? " · " + esc(live.match_mode) : ""}</span>${link(`${SITE}/match/${live.match_id}`, "Open")}</div>
    <div class="team" style="color:var(--enemy)">Enemy team</div>${enemies.map(playerCard).join("")}
    <div class="team" style="color:var(--ally)">Your team</div>${allies.map(playerCard).join("")}`;
}

function renderMe() {
  if (!me) return `<div class="card">Couldn't find your Steam account. Make sure Steam is running.</div>`;
  const p = profile;
  return `<div class="card"><div class="row"><h3 style="color:var(--fg)">${esc(p?.name ?? "Your profile")}</h3>${link(`${SITE}/player/${me}`, "Full profile")}</div>
    ${p ? `<div class="row" style="justify-content:flex-start">${rank(p)} · ${wr(p.wins, p.losses)}</div>` : '<div class="muted">Open your full profile once to load your stats.</div>'}
    <div class="row" style="justify-content:flex-start;margin-top:6px">Account ID: ${esc(me)}</div></div>`;
}

function renderMeta() {
  if (!meta) return `<div class="card">${metaError ? `<span class="err">${esc(metaError)}</span><br>` : "Downloading meta builds…<br>"}<button class="code" data-action="reload">Retry</button></div>`;
  const term = q.value.trim().toLowerCase();
  const heroes = meta.heroes.filter((h) => !term || h.hero_name.toLowerCase().includes(term)).slice(0, term ? 10 : 44);
  return heroes.map((h) => {
    const builds = meta.builds.filter((b) => b.hero_id === h.hero_id).slice(0, 3);
    return `<div class="card">
      <div class="row"><h3 style="color:var(--fg)">${esc(h.hero_name)}</h3><span>${h.win_rate != null ? Number(h.win_rate).toFixed(1) + "% WR" : ""} ${h.tier ? "· Tier " + esc(h.tier) : ""}</span></div>
      ${h.power_spike_tag ? `<div class="row">Power spike: ${esc(h.power_spike_tag)}</div>` : ""}
      <h4>Core items</h4>${chips(names(h.popular_items))}
      <h4>Weak against</h4>${chips(names(h.counters_weak_to))}
      <h4>Community build IDs</h4>${builds.map((b) => `<div class="row"><span>${esc(b.title)} — ${esc(b.author_name)}</span><button class="code" data-id="${esc(b.game_build_id)}">${esc(b.game_build_id)}</button></div>`).join("") || '<span class="row">None yet</span>'}
    </div>`;
  }).join("");
}

function renderSettings() {
  return `<div class="card"><h3>Overlay hotkey</h3>
    <div class="row"><span>Press to show / hide in game</span><button class="key ${listening ? "listening" : ""}" data-action="hotkey">${listening ? "Press keys…" : esc(settings.hotkey)}</button></div>
    <div class="row" style="justify-content:flex-start;margin-top:4px">${listening ? "Press Esc to cancel." : "Click, then press a key or combo (e.g. Ctrl+Shift+S)."}</div>
    ${settingsMsg ? `<div class="err" style="margin-top:4px">${esc(settingsMsg)}</div>` : ""}
    <button class="code" data-action="reset-hotkey" style="margin-top:6px">Reset to F8</button></div>
  <div class="card"><h3>Background opacity</h3><input type="range" id="opacity" min="50" max="100" value="${Math.round(settings.opacity * 100)}" /></div>
  <div class="card"><h3>Opening the overlay</h3><div class="muted">Use your hotkey, double-click the tray icon, or right-click it → Show.</div></div>`;
}

function render() {
  q.style.display = tab === "meta" ? "" : "none";
  list.innerHTML = tab === "live" ? renderLive() : tab === "me" ? renderMe() : tab === "settings" ? renderSettings() : renderMeta();
}
function setTab(t) { tab = t; document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t)); render(); }
function applyOpacity() { document.documentElement.style.setProperty("--op", settings.opacity); }
function updateStatus() { document.getElementById("status").textContent = `${gameRunning ? "Deadlock running" : "Waiting for Deadlock…"} · ${settings.hotkey}`; }

const KEYMAP = { " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
async function saveHotkey(combo) {
  try { settings.hotkey = await invoke("set_hotkey", { hotkey: combo }); settingsMsg = ""; }
  catch (e) { settingsMsg = String(e); }
  listening = false; updateStatus(); render();
}
window.addEventListener("keydown", (e) => {
  if (!listening) return;
  e.preventDefault();
  if (e.key === "Escape") { listening = false; render(); return; }
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  let key = KEYMAP[e.key] ?? (e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  saveHotkey([...mods, key].join("+"));
});
list.addEventListener("input", (e) => {
  if (e.target.id !== "opacity") return;
  settings.opacity = Number(e.target.value) / 100; applyOpacity();
  invoke("set_opacity", { opacity: settings.opacity }).catch(() => {});
});
document.getElementById("close").addEventListener("click", () => invoke("hide_overlay").catch(() => {}));

async function pollLive() {
  if (me && gameRunning && !document.hidden) {
    try {
      { liveError = null; live = await invoke("get_live", { accountId: me }); const self = live.players?.find((p) => p.me); if (self?.name) profile = { name: self.name, rank_tier: self.rank_tier, sub_rank: self.sub_rank, wins: self.wins, losses: self.losses }; saveProfile(); }
    } catch (e) { liveError = String(e); }
    render();
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLive, gameRunning ? 30_000 : 60_000);
}

document.querySelector("nav").addEventListener("click", (e) => {
  const t = e.target?.closest("button")?.dataset?.tab; if (t) setTab(t);
});
list.addEventListener("click", async (e) => {
  const action = e.target?.dataset?.action;
  if (action === "hotkey") { listening = true; settingsMsg = ""; render(); return; }
  if (action === "reset-hotkey") return saveHotkey("F8");
  if (action === "reload") { metaError = null; render(); await invoke("reload_meta").catch(() => {}); return loadMeta(); }
  const url = e.target?.dataset?.url;
  if (url) { e.preventDefault(); await invoke("open_url", { url }).catch(() => {}); return; }
  const id = e.target?.dataset?.id;
  if (!id) return;
  await navigator.clipboard.writeText(id);
  e.target.textContent = "Copied!";
  setTimeout(() => (e.target.textContent = id), 1200);
});
q.addEventListener("input", render);
listen("game-state", (e) => {
  gameRunning = !!e.payload; if (!gameRunning) live = null;
  document.getElementById("status").textContent = gameRunning ? "Deadlock running · F8" : "Waiting for Deadlock… · F8";
  render();
  if (gameRunning) pollLive(); // look up the match right away, not after the next timer
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && gameRunning) pollLive(); });

async function loadMeta() {
  const r = await invoke("get_meta").catch((e) => ({ data: null, error: String(e) }));
  meta = r?.data ?? null; metaError = r?.error ?? null;
  render();
}

(async function init() {
  settings = await invoke("get_settings").catch(() => settings);
  applyOpacity();
  [me, gameRunning] = await Promise.all([invoke("steam_account_id").catch(() => null), invoke("game_running").catch(() => false)]);
  updateStatus();
  setTab(gameRunning ? "live" : "me");
  await loadMeta();
  listen("meta-updated", loadMeta);
  listen("game-state", (ev) => { gameRunning = !!ev.payload; live = null; updateStatus(); if (gameRunning) setTab("live"); pollLive(); });
  listen("open-tab", (ev) => setTab(ev.payload));
  listen("overlay-shown", () => { if (gameRunning) pollLive(); });
  pollLive();
})();
