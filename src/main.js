// Plain JS (no bundler) keeps the installer tiny.
// Requires "withGlobalTauri": true in tauri.conf.json.
// Two windows share this file: "overlay" (compact, in game, hotkey) and "main" (normal app window).
const T = window.__TAURI__;
if (!T?.core) { document.getElementById("list").innerHTML = '<div class="card err">App bridge not available. Please reinstall the latest Statslock Companion.</div>'; throw new Error("no __TAURI__"); }
const { invoke } = T.core;
const { listen } = T.event;
const LABEL = (() => { try { return T.window.getCurrentWindow().label; } catch { return "overlay"; } })();
const OVERLAY = LABEL === "overlay";
document.body.classList.add(OVERLAY ? "is-overlay" : "is-main");
const SITE = "https://statslock.io";
const list = document.getElementById("list");
const q = document.getElementById("q");
let liveError = null, pollTimer = null;
let metaError = null, settings = { hotkey: "F8", opacity: 0.94 }, listening = false, settingsMsg = "";
let meta = null, me = null, live = null, tab = "live", gameRunning = false, profile = null;
let buildHero = 0, buildSort = "likes", buildView = "all", laneFoe = 0;
const LAST_KEY = "statslock.last-match.v1";
let lastMatch = (() => { try { const v = JSON.parse(localStorage.getItem(LAST_KEY) || "null"); return v && Date.now() - v.ended < 6 * 3600_000 ? v : null; } catch { return null; } })();

// Local storage on this PC: profile summary + your saved builds.
const PROFILE_KEY = "statslock.profile.v1", SAVED_KEY = "statslock.saved-builds.v1";
const readJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
profile = readJson(PROFILE_KEY, null);
let saved = readJson(SAVED_KEY, []);
const saveProfile = () => { try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...profile, saved_at: Date.now() })); } catch {} };
const persistSaved = () => { try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); } catch {} };
window.addEventListener("storage", (e) => { if (e.key === SAVED_KEY) { saved = readJson(SAVED_KEY, []); render(); } });

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const names = (v) => (Array.isArray(v) ? v.slice(0, 6).map((x) => (typeof x === "string" ? x : x?.name ?? x?.hero_name ?? "")).filter(Boolean) : []);
const chips = (arr) => arr.map((n) => `<span class="chip">${esc(n)}</span>`).join("") || '<span class="row">No data yet</span>';
const rank = (p) => (p.rank_tier ? `${esc(p.rank_tier)}${p.sub_rank ? " " + p.sub_rank : ""}` : "Unranked / unknown");
const wr = (w, l) => { const g = (w ?? 0) + (l ?? 0); if (!g) return '<span class="muted">No games recorded</span>'; const r = (100 * w) / g; return `<span class="${r >= 50 ? "wr-good" : "wr-bad"}">${r.toFixed(0)}% WR</span> <span class="muted">(${g})</span>`; };
const link = (url, label) => `<a class="link" href="${esc(url)}" data-url="${esc(url)}">${label}</a>`;
const heroMeta = (id) => meta?.heroes?.find((h) => h.hero_id === id);
const heroName = (id) => meta?.hero_art?.[id]?.name ?? heroMeta(id)?.hero_name ?? `Hero ${id}`;
const heroImg = (id, cls = "hero") => { const u = meta?.hero_art?.[id]?.img; return u ? `<img class="${cls}" src="${esc(u)}" alt="" loading="lazy" />` : `<div class="${cls}"></div>`; };
const itemName = (name) => { const t = String(name).toLowerCase(); const e = Object.entries(meta?.items ?? {}).find(([, v]) => v.name.toLowerCase() === t); return e ? Number(e[0]) : null; };

/** Item artwork tile with a coloured category border; falls back to the name when no art. */
function icon(id, extra = "") {
  const it = meta?.items?.[id];
  if (!it) return "";
  const tip = esc(it.name + (extra ? ` — ${extra}` : ""));
  return `<span class="item ${esc(it.slot)}" title="${tip}">${it.img ? `<img src="${esc(it.img)}" alt="${esc(it.name)}" loading="lazy" />` : `<span>${esc(it.name.slice(0, 3))}</span>`}</span>`;
}
const icons = (ids, label) => (ids?.length ? `<div class="items">${ids.map((i) => icon(i)).join("")}</div>` : `<div class="muted">${label ?? "No data yet"}</div>`);
const heroBuild = (id) => meta?.hero_builds?.[id] ?? null;

/** Combine per-enemy counter items: items that help against several enemies rise to the top. */
function teamCounters(enemyIds) {
  const m = new Map();
  for (const hid of enemyIds) for (const c of heroBuild(hid)?.counters ?? []) {
    const s = m.get(c.id) ?? { id: c.id, lift: 0, vs: [], games: 0 };
    s.lift += c.lift; s.games += c.games; s.vs.push(heroName(hid)); m.set(c.id, s);
  }
  return [...m.values()].sort((a, b) => b.vs.length - a.vs.length || b.lift - a.lift).slice(0, 6);
}
function countersBlock(enemyIds) {
  const top = teamCounters(enemyIds);
  if (!top.length) return `<div class="muted">Counter items appear after the next daily stats refresh.</div>`;
  return `<div class="counters">${top.map((c) => `<div class="counter">${icon(c.id)}<div><b>${esc(meta.items[c.id]?.name)}</b><div class="muted">vs ${c.vs.map(esc).join(", ")} · +${(c.lift / c.vs.length).toFixed(1)}% WR</div></div></div>`).join("")}</div>
    <div class="muted small">From recorded matches: owners of the item won more often against these heroes than average (20+ games each).</div>`;
}

function playerCard(p) {
  const h = heroMeta(p.hero_id);
  return `<div class="card player ${p.ally ? "ally" : "enemy"}">
    ${heroImg(p.hero_id)}
    <div><div><b>${esc(p.name ?? "Unknown player")}</b>${p.me ? ' <span class="muted">(you)</span>' : ""}</div>
      <div class="row" style="justify-content:flex-start">${esc(p.hero_name)} · ${rank(p)}</div>
      <div class="row" style="justify-content:flex-start">${p.name ? wr(p.wins, p.losses) : '<span class="muted">Not on Statslock yet</span>'}${h?.win_rate != null ? ` · hero ${Number(h.win_rate).toFixed(1)}%` : ""}</div></div>
    ${link(p.profile_url, "Profile")}
  </div>`;
}

function myBuildBlock(heroId) {
  const b = heroBuild(heroId);
  const community = communityFor(heroId).slice(0, 3);
  return `<div class="card"><div class="row"><h3>${heroImg(heroId, "hero sm")} Your build · ${esc(heroName(heroId))}</h3>${link(`${SITE}/builds?hero=${heroId}`, "Builds")}</div>
    <h4>Starting items</h4>${icons(b?.starter, "No starter data yet")}
    <h4>Meta build (final 9)</h4>${icons(b?.base, "Meta build appears after the next daily stats refresh")}
    ${b?.games ? `<div class="muted small">${b.games} recorded games · ${b.winRate.toFixed(1)}% WR</div>` : ""}
    ${skillBlock(heroId)}
    ${community.length ? `<h4>Community build IDs</h4>${community.map(buildRow).join("")}` : ""}</div>`;
}

/** Ability leveling order: the highest-WR popular order from the hero page, shown as 16 numbered steps. */
function skillBlock(heroId) {
  const s = meta?.skill_orders?.[heroId];
  if (!s) return "";
  const ab = meta?.abilities?.[heroId] ?? {};
  const legend = [1, 2, 3, 4].map((n) => `<span class="chip"><b>${n}</b> ${esc(ab[n] ?? "Ability " + n)}</span>`).join("");
  return `<h4>Skill order</h4><div class="skills">${s.path.map((n, i) => `<span class="skill s${n}" title="Level ${i + 1}: ${esc(ab[n] ?? "Ability " + n)}">${n}</span>`).join("")}</div>
    <div class="items" style="flex-wrap:wrap;gap:4px;margin-top:4px">${legend}</div>
    <div class="muted small">${s.matches.toLocaleString()} games · ${s.winRate.toFixed(1)}% WR</div>`;
}

/** Lane duel: pick the enemy you're laning against; shows items that beat that hero specifically. */
function laneBlock(enemies) {
  const chooser = enemies.map((p) => `<button class="code${laneFoe === p.hero_id ? " on" : ""}" data-lane="${p.hero_id}" title="Laning against ${esc(p.hero_name)}">${heroImg(p.hero_id, "hero xs")}</button>`).join("");
  if (!laneFoe) return `<div class="card"><h3>Lane duel</h3><div class="muted">Who are you laning against?</div><div class="items" style="flex-wrap:wrap">${chooser}</div></div>`;
  const h = heroMeta(laneFoe), c = heroBuild(laneFoe)?.counters ?? [];
  return `<div class="card"><h3>Lane duel · ${esc(heroName(laneFoe))}</h3><div class="items" style="flex-wrap:wrap">${chooser}</div>
    <div class="muted small">${h?.win_rate != null ? `Hero ${Number(h.win_rate).toFixed(1)}% WR` : ""}${h?.power_spike_tag ? ` · strongest ${esc(h.power_spike_tag)}` : ""}</div>
    <h4>Items that beat ${esc(heroName(laneFoe))}</h4>${c.length ? `<div class="counters">${c.slice(0, 4).map((x) => `<div class="counter">${icon(x.id)}<div><b>${esc(meta.items[x.id]?.name)}</b><div class="muted">+${x.lift.toFixed(1)}% WR · ${x.games} games</div></div></div>`).join("")}</div>` : '<div class="muted">Not enough recorded games yet.</div>'}
    ${h?.counters_weak_to?.length ? `<h4>Struggles against</h4><div>${chips(names(h.counters_weak_to))}</div>` : ""}</div>`;
}

function recapBlock() {
  if (!lastMatch?.id) return "";
  return `<div class="card"><div class="row"><h3>${lastMatch.hero ? heroImg(lastMatch.hero, "hero sm") : ""} Last match ended</h3><button class="code" data-action="dismiss-recap">✕</button></div>
    <div class="muted">Your grade, lane souls and full scoreboard are on Statslock once the match is published (usually a few minutes).</div>
    <div class="row" style="margin-top:6px"><span></span>${link(`${SITE}/match/${lastMatch.id}`, "Open match recap")}</div></div>`;
}

function renderLive() {
  if (!gameRunning && !live?.in_match) return `${recapBlock()}<div class="card">Start Deadlock and join a match — both teams, counter items and your build will show here.<br><span class="muted">Only matches listed by the public Deadlock API can be found, so some games may not appear.</span></div>`;
  if (!me) return `<div class="card">Couldn't find your Steam account. Make sure Steam is running.</div>`;
  if (liveError) return `<div class="card">${esc(liveError)}</div>`;
  if (!live) return `<div class="card">Looking for your match…</div>`;
  if (!live.in_match) return `${recapBlock()}<div class="card">No live match found for you yet. Checking every 30 seconds.<br><span class="muted">Only matches listed by the public Deadlock API can be found.</span></div>`;
  const enemies = live.players.filter((p) => !p.ally), allies = live.players.filter((p) => p.ally);
  const self = live.players.find((p) => p.me);
  return `<div class="row"><span>Match ${esc(live.match_id)}${live.match_mode ? " · " + esc(live.match_mode) : ""}</span>${link(`${SITE}/match/${live.match_id}`, "Open")}</div>
    ${laneBlock(enemies)}
    <div class="card"><h3>Best items vs this enemy team</h3>${countersBlock(enemies.map((p) => p.hero_id))}</div>
    ${self ? myBuildBlock(self.hero_id) : ""}
    <div class="team" style="color:var(--enemy)">Enemy team</div>${enemies.map(playerCard).join("")}
    <div class="team" style="color:var(--ally)">Your team</div>${allies.map(playerCard).join("")}`;
}

function renderMe() {
  if (!me) return `<div class="card">Couldn't find your Steam account. Make sure Steam is running.</div>`;
  const p = profile;
  return `<div class="card"><div class="row"><h3 style="color:var(--fg)">${esc(p?.name ?? "Your profile")}</h3>${link(`${SITE}/player/${me}`, "Full profile")}</div>
    ${p ? `<div class="row" style="justify-content:flex-start">${rank(p)} · ${wr(p.wins, p.losses)}</div>` : '<div class="muted">Your stats appear after your first tracked match. Open your full profile to load them now.</div>'}
    <div class="row" style="justify-content:flex-start;margin-top:6px">Account ID: ${esc(me)}</div></div>
    <div class="card"><h3>Saved builds</h3><div class="muted">${saved.length} saved on this PC. ${saved.length ? "" : "Press ☆ on any build to save it."}</div><button class="code" data-tab-go="builds" style="margin-top:6px">Open builds</button></div>`;
}

function renderMeta() {
  if (!meta) return metaMissing();
  const term = q.value.trim().toLowerCase();
  const heroes = meta.heroes.filter((h) => !term || h.hero_name.toLowerCase().includes(term)).slice(0, term ? 10 : 44);
  return heroes.map((h) => {
    const b = heroBuild(h.hero_id);
    const core = b?.spikes?.slice(0, 6) ?? names(h.popular_items).map(itemName).filter(Boolean);
    return `<div class="card">
      <div class="row"><h3 style="color:var(--fg)">${heroImg(h.hero_id, "hero sm")} ${esc(h.hero_name)}</h3><span>${h.win_rate != null ? Number(h.win_rate).toFixed(1) + "% WR" : ""} ${h.tier ? "· Tier " + esc(h.tier) : ""}</span></div>
      ${h.power_spike_tag ? `<div class="row">Power spike: ${esc(h.power_spike_tag)}</div>` : ""}
      <h4>Core power spikes</h4>${icons(core)}
      ${b?.base?.length ? `<h4>Meta build (final 9)</h4>${icons(b.base)}` : ""}
      <h4>Best items against ${esc(h.hero_name)}</h4>${icons(b?.counters?.map((c) => c.id), "Appears after the next daily stats refresh")}
      <h4>Weak against</h4>${chips(names(h.counters_weak_to))}
      <div class="row" style="margin-top:6px"><span></span><button class="code" data-hero-builds="${h.hero_id}">Community builds</button></div>
    </div>`;
  }).join("");
}

// ---------- Community builds: search, sort, save locally, copy in-game build ID ----------
const buildItems = (b) => {
  const secs = Array.isArray(b.item_sections) ? b.item_sections : [];
  const ids = secs.length ? secs.flatMap((s) => s.items ?? []) : ["early", "mid", "late"].flatMap((k) => b.build_order?.[k] ?? []);
  return [...new Set(ids)];
};
const communityFor = (heroId) => (meta?.builds ?? []).filter((b) => b.hero_id === heroId && b.game_build_id);
const isSaved = (id) => saved.some((s) => s.id === id);
function buildRow(b) {
  return `<div class="row"><span>${esc(b.title)} — ${esc(b.author_name ?? "Unknown")}</span><button class="code" data-id="${esc(b.game_build_id)}" title="Copy in-game build ID">${esc(b.game_build_id)}</button></div>`;
}
function buildCard(b) {
  const items = buildItems(b);
  return `<div class="card">
    <div class="row"><h3 style="color:var(--fg)">${heroImg(b.hero_id, "hero sm")} ${esc(b.title)}</h3><button class="star ${isSaved(b.id) ? "on" : ""}" data-save="${esc(b.id)}" title="${isSaved(b.id) ? "Remove from saved" : "Save build"}">${isSaved(b.id) ? "★" : "☆"}</button></div>
    <div class="row" style="justify-content:flex-start">${esc(heroName(b.hero_id))} · by ${esc(b.author_name ?? "Unknown")} · ♥ ${b.likes ?? 0}</div>
    ${items.length ? `<div class="items" style="margin-top:6px">${items.slice(0, 16).map((i) => icon(i)).join("")}</div>` : ""}
    <div class="row" style="margin-top:6px">${b.game_build_id ? `<button class="code" data-id="${esc(b.game_build_id)}" title="Copy, then paste into the in-game build browser">Copy ID ${esc(b.game_build_id)}</button>` : '<span class="muted">No in-game ID</span>'}${link(`${SITE}/builds/${b.id}`, "Open")}</div>
  </div>`;
}
function renderBuilds() {
  if (!meta) return metaMissing();
  const term = q.value.trim().toLowerCase();
  const heroes = [...meta.heroes].sort((a, b) => a.hero_name.localeCompare(b.hero_name));
  let rows = buildView === "saved" ? saved.map((s) => meta.builds.find((b) => b.id === s.id) ?? s) : meta.builds;
  if (buildHero) rows = rows.filter((b) => b.hero_id === buildHero);
  if (term) rows = rows.filter((b) => `${b.title} ${b.author_name} ${heroName(b.hero_id)} ${b.game_build_id ?? ""}`.toLowerCase().includes(term));
  rows = [...rows].sort((a, b) => buildSort === "new" ? String(b.updated_at).localeCompare(String(a.updated_at)) : (b.likes ?? 0) - (a.likes ?? 0));
  return `<div class="filters">
      <select id="bhero"><option value="0">All heroes</option>${heroes.map((h) => `<option value="${h.hero_id}" ${h.hero_id === buildHero ? "selected" : ""}>${esc(h.hero_name)}</option>`).join("")}</select>
      <select id="bsort"><option value="likes" ${buildSort === "likes" ? "selected" : ""}>Most liked</option><option value="new" ${buildSort === "new" ? "selected" : ""}>Newest</option></select>
      <div class="seg"><button data-bview="all" class="${buildView === "all" ? "on" : ""}">All</button><button data-bview="saved" class="${buildView === "saved" ? "on" : ""}">Saved (${saved.length})</button></div>
    </div>
    ${rows.length ? rows.slice(0, 60).map(buildCard).join("") : `<div class="card muted">${buildView === "saved" ? "No saved builds yet — press ☆ on a build to keep it here." : "No builds match your search."}</div>`}
    <div class="card muted small">Make your own build on ${link(`${SITE}/sandbox`, "statslock.io")} and add its in-game build ID so others can copy it here.</div>`;
}
const metaMissing = () => `<div class="card">${metaError ? `<span class="err">${esc(metaError)}</span><br>` : "Downloading builds…<br>"}<button class="code" data-action="reload">Retry</button></div>`;

function renderSettings() {
  return `<div class="card"><h3>Overlay hotkey</h3>
    <div class="row"><span>Press to show / hide in game</span><button class="key ${listening ? "listening" : ""}" data-action="hotkey">${listening ? "Press keys…" : esc(settings.hotkey)}</button></div>
    <div class="row" style="justify-content:flex-start;margin-top:4px">${listening ? "Press Esc to cancel." : "Click, then press a key or combo (e.g. Ctrl+Shift+S)."}</div>
    ${settingsMsg ? `<div class="err" style="margin-top:4px">${esc(settingsMsg)}</div>` : ""}
    <button class="code" data-action="reset-hotkey" style="margin-top:6px">Reset to F8</button></div>
  <div class="card"><h3>Overlay opacity</h3><input type="range" id="opacity" min="50" max="100" value="${Math.round(settings.opacity * 100)}" /></div>
  <div class="card"><h3>Windows</h3><div class="muted">The <b>in-game overlay</b> opens with your hotkey. The <b>app window</b> opens when you double-click the tray icon.</div>
    <div class="row" style="margin-top:6px;justify-content:flex-start;gap:6px"><button class="code" data-action="open-main">Open app window</button><button class="code" data-action="open-overlay">Show overlay</button></div></div>`;
}

const TABS = OVERLAY ? ["live", "builds", "settings"] : ["live", "me", "meta", "builds", "settings"];
const TAB_LABEL = { live: "Live match", me: "My profile", meta: "Heroes", builds: "Builds", settings: "Settings" };
document.querySelector("nav").innerHTML = TABS.map((t) => `<button data-tab="${t}">${TAB_LABEL[t]}</button>`).join("");

function render() {
  q.style.display = tab === "meta" || tab === "builds" ? "" : "none";
  q.placeholder = tab === "builds" ? "Search title, creator, hero or ID…" : "Search hero…";
  const top = list.scrollTop;
  list.innerHTML = tab === "live" ? renderLive() : tab === "me" ? renderMe() : tab === "settings" ? renderSettings() : tab === "builds" ? renderBuilds() : renderMeta();
  list.scrollTop = top;
}
function setTab(t) { if (!TABS.includes(t)) t = TABS[0]; tab = t; document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t)); render(); }
function applyOpacity() { document.documentElement.style.setProperty("--op", OVERLAY ? settings.opacity : 1); }
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
list.addEventListener("change", (e) => {
  if (e.target.id === "bhero") { buildHero = Number(e.target.value); render(); }
  if (e.target.id === "bsort") { buildSort = e.target.value; render(); }
});
document.getElementById("close").addEventListener("click", () => invoke(OVERLAY ? "hide_overlay" : "hide_main").catch(() => {}));

async function pollLive() {
  if (me && gameRunning && !document.hidden) {
    try {
      liveError = null;
      const prev = live;
      live = await invoke("get_live", { accountId: me });
      // Match just ended: remember it so the recap card can link to the full breakdown.
      if (prev?.in_match && (!live.in_match || live.match_id !== prev.match_id)) { lastMatch = { id: prev.match_id, hero: prev.players?.find((p) => p.me)?.hero_id, ended: Date.now() }; laneFoe = 0; localStorage.setItem(LAST_KEY, JSON.stringify(lastMatch)); }
      const self = live.players?.find((p) => p.me);
      if (self?.name) { profile = { name: self.name, rank_tier: self.rank_tier, sub_rank: self.sub_rank, wins: self.wins, losses: self.losses }; saveProfile(); }
      if (self && OVERLAY && !buildHero) buildHero = self.hero_id; // overlay builds tab starts on your hero
    } catch (e) { liveError = String(e); }
    if (tab === "live") render();
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLive, gameRunning ? 30_000 : 60_000);
}

document.querySelector("nav").addEventListener("click", (e) => {
  const t = e.target?.closest("button")?.dataset?.tab; if (t) setTab(t);
});
list.addEventListener("click", async (e) => {
  const el = e.target?.closest("button, a");
  if (!el) return;
  const d = el.dataset;
  if (d.action === "hotkey") { listening = true; settingsMsg = ""; render(); return; }
  if (d.action === "reset-hotkey") return saveHotkey("F8");
  if (d.action === "open-main") return invoke("show_main").catch(() => {});
  if (d.action === "open-overlay") return invoke("show_overlay_cmd").catch(() => {});
  if (d.action === "reload") { metaError = null; render(); await invoke("reload_meta").catch(() => {}); return loadMeta(); }
  if (d.tabGo) return setTab(d.tabGo);
  if (d.lane) { laneFoe = laneFoe === Number(d.lane) ? 0 : Number(d.lane); return render(); }
  if (d.action === "dismiss-recap") { lastMatch = null; localStorage.removeItem(LAST_KEY); return render(); }
  if (d.heroBuilds) { buildHero = Number(d.heroBuilds); buildView = "all"; q.value = ""; return setTab("builds"); }
  if (d.bview) { buildView = d.bview; return render(); }
  if (d.save) {
    const b = meta?.builds?.find((x) => x.id === d.save) ?? saved.find((x) => x.id === d.save);
    saved = isSaved(d.save) ? saved.filter((s) => s.id !== d.save) : b ? [{ ...b, saved_at: Date.now() }, ...saved] : saved;
    persistSaved(); return render();
  }
  if (d.url) { e.preventDefault(); await invoke("open_url", { url: d.url }).catch(() => {}); return; }
  if (d.id) {
    const prev = el.textContent;
    try { await navigator.clipboard.writeText(d.id); el.textContent = "Copied!"; } catch { el.textContent = "Copy failed"; }
    setTimeout(() => (el.textContent = prev), 1200);
  }
});
q.addEventListener("input", render);
document.addEventListener("visibilitychange", () => { if (!document.hidden && gameRunning) pollLive(); });

async function loadMeta() {
  const r = await invoke("get_meta").catch((e) => ({ data: null, error: String(e) }));
  meta = r?.data ?? null; metaError = r?.error ?? null;
  // Keep saved copies fresh (likes, items) when the build is still published.
  if (meta?.builds) { saved = saved.map((s) => ({ ...(meta.builds.find((b) => b.id === s.id) ?? s), saved_at: s.saved_at })); persistSaved(); }
  render();
}

(async function init() {
  settings = await invoke("get_settings").catch(() => settings);
  applyOpacity();
  [me, gameRunning] = await Promise.all([invoke("steam_account_id").catch(() => null), invoke("game_running").catch(() => false)]);
  updateStatus();
  setTab(gameRunning || OVERLAY ? "live" : "meta");
  await loadMeta();
  listen("meta-updated", loadMeta);
  listen("game-state", (ev) => { gameRunning = !!ev.payload; live = null; updateStatus(); if (gameRunning) setTab("live"); else render(); pollLive(); });
  listen("open-tab", (ev) => { if (!OVERLAY) setTab(ev.payload); });
  listen("overlay-shown", () => { if (gameRunning) pollLive(); });
  pollLive();
})();
