// Plain JS (no bundler) keeps the installer tiny.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open: openUrl } = window.__TAURI__.opener ?? {};
const SITE = "https://statslock.io";
const list = document.getElementById("list");
const q = document.getElementById("q");
let liveError = null, pollTimer = null;
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
  if (!meta) return "No data yet — connect to the internet once.";
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

function render() {
  q.style.display = tab === "meta" ? "" : "none";
  list.innerHTML = tab === "live" ? renderLive() : tab === "me" ? renderMe() : renderMeta();
}

async function pollLive() {
  if (me && gameRunning && !document.hidden) {
    try {
      const r = await fetch(`${SITE}/api/public/companion/live?account_id=${me}`);
      if (!r.ok) { liveError = `Live lookup failed (${r.status}). Retrying…`; }
      else { liveError = null; live = await r.json(); const self = live.players?.find((p) => p.me); if (self?.name) profile = { name: self.name, rank_tier: self.rank_tier, sub_rank: self.sub_rank, wins: self.wins, losses: self.losses }; saveProfile(); }
    } catch { liveError = "Can't reach statslock.io — check your internet. Retrying…"; }
    render();
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLive, gameRunning ? 30_000 : 60_000);
}

document.querySelector("nav").addEventListener("click", (e) => {
  const t = e.target?.dataset?.tab; if (!t) return;
  tab = t; document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t)); render();
});
list.addEventListener("click", async (e) => {
  const url = e.target?.dataset?.url;
  if (url) { e.preventDefault(); if (openUrl) await openUrl(url); else await invoke("open_url", { url }).catch(() => {}); return; }
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

(async function load() {
  me = await invoke("steam_account_id").catch(() => null);
  gameRunning = await invoke("game_running").catch(() => false);
  document.getElementById("status").textContent = gameRunning ? "Deadlock running · F8" : "Waiting for Deadlock… · F8";
  meta = await invoke("get_meta").catch(() => null);
  if (!gameRunning) tab = "me", document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === "me"));
  render();
  if (!meta) setTimeout(load, 3000); else pollLive();
})();
