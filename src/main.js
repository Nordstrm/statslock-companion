// Plain JS (no bundler) keeps the installer tiny.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const list = document.getElementById("list");
const q = document.getElementById("q");
let meta = null;

const names = (v) => (Array.isArray(v) ? v.slice(0, 6).map((x) => (typeof x === "string" ? x : x?.name ?? x?.hero_name ?? "")).filter(Boolean) : []);
const chips = (arr) => arr.map((n) => `<span class="chip">${n}</span>`).join("") || '<span class="row">No data yet</span>';
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function render() {
  if (!meta) { list.textContent = "No data yet — connect to the internet once."; return; }
  const term = q.value.trim().toLowerCase();
  const heroes = meta.heroes.filter((h) => !term || h.hero_name.toLowerCase().includes(term)).slice(0, term ? 10 : 44);
  list.innerHTML = heroes.map((h) => {
    const builds = meta.builds.filter((b) => b.hero_id === h.hero_id).slice(0, 3);
    return `<div class="hero">
      <div class="row"><h3 style="color:var(--fg)">${esc(h.hero_name)}</h3><span>${h.win_rate != null ? Number(h.win_rate).toFixed(1) + "% WR" : ""} ${h.tier ? "· Tier " + esc(h.tier) : ""}</span></div>
      ${h.power_spike_tag ? `<div class="row">Power spike: ${esc(h.power_spike_tag)}</div>` : ""}
      <h4>Core items</h4>${chips(names(h.popular_items).map(esc))}
      <h4>Weak against</h4>${chips(names(h.counters_weak_to).map(esc))}
      <h4>Community build IDs</h4>${builds.map((b) => `<div class="row"><span>${esc(b.title)} — ${esc(b.author_name)}</span><button class="code" data-id="${esc(b.game_build_id)}">${esc(b.game_build_id)}</button></div>`).join("") || '<span class="row">None yet</span>'}
    </div>`;
  }).join("");
}

list.addEventListener("click", async (e) => {
  const id = e.target?.dataset?.id;
  if (!id) return;
  await navigator.clipboard.writeText(id);
  e.target.textContent = "Copied!";
  setTimeout(() => (e.target.textContent = id), 1200);
});
q.addEventListener("input", render);
listen("game-state", (e) => { document.getElementById("status").textContent = e.payload ? "Deadlock running" : "Waiting for Deadlock…"; });

(async function load() {
  meta = await invoke("get_meta");
  render();
  if (!meta) setTimeout(load, 3000);
})();
