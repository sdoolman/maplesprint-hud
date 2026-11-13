const DEFAULT_DB = "https://osmsdataexplorer.com/data/current/";

const $ = (id) => document.getElementById(id);
const workerInput = $("workerUrl");
const roomInput = $("roomId");
const dbInput = $("dbBase");
const statusDot = $("statusDot");
const mapLine = $("mapLine");
const feedEl = $("feed");

workerInput.value = localStorage.getItem("ms_worker") || "";
roomInput.value = localStorage.getItem("ms_room") || "default";
dbInput.value = localStorage.getItem("ms_db") || DEFAULT_DB;

const db = { maps: {}, mobs: {}, items: {} };
const state = { startTs: null, sessionExp: 0, kills: 0, mesos: 0, hp: null, mp: null, mapId: null, ch: null };
let ws = null;

async function loadCatalog() {
  const base = (dbInput.value.trim() || DEFAULT_DB).replace(/\/+$/, "") + "/";
  $("dbStatus").textContent = "Loading...";
  try {
    const [mapsR, mobsR, itemsR] = await Promise.all([
      fetch(base + "maps.json"),
      fetch(base + "monsters.json"),
      fetch(base + "items.json"),
    ]);
    const mapsD = await mapsR.json();
    for (const reg of mapsD.regions || []) {
      for (const m of reg.maps || []) db.maps[m.id] = { name: m.name, street: m.street_name || "" };
    }
    const mobsD = await mobsR.json();
    for (const m of mobsD.monsters || []) db.mobs[m.id] = { name: m.name, level: m.level, exp: m.exp };
    const itemsD = await itemsR.json();
    for (const it of itemsD.items || []) db.items[it.id] = { name: it.name, cat: it.category || "", price: it.stats?.price ?? null };
    $("dbStatus").textContent = `${Object.keys(db.mobs).length} mobs`;
  } catch {
    $("dbStatus").textContent = "DB error";
  }
}

function addFeed(text) {
  const li = document.createElement("li");
  const t = new Date().toLocaleTimeString();
  li.innerHTML = `<span>${text}</span><span class="ts">${t}</span>`;
  feedEl.prepend(li);
  while (feedEl.children.length > 40) feedEl.lastChild.remove();
}

function render() {
  const elapsed = state.startTs ? Math.max((Date.now() - state.startTs) / 1000, 1) : 1;
  $("sessionExp").textContent = state.sessionExp.toLocaleString();
  $("kills").textContent = String(state.kills);
  $("xph").textContent = state.startTs ? Math.floor((state.sessionExp * 3600) / elapsed).toLocaleString() : "0";
  $("kpm").textContent = state.startTs ? ((state.kills * 60) / elapsed).toFixed(1) : "0.0";
  $("hp").textContent = state.hp ?? "--";
  $("mp").textContent = state.mp ?? "--";
  $("mesos").textContent = state.mesos.toLocaleString();
  const m = state.mapId ? db.maps[state.mapId] : null;
  if (state.mapId) {
    mapLine.textContent = `${m ? `${m.name} (${m.street})` : `Map #${state.mapId}`} • Ch. ${state.ch ?? "?"}`;
  }
}

function handleEvent(ev) {
  if (!state.startTs) state.startTs = Date.now();
  if (ev.type === "exp_gain") {
    state.sessionExp += ev.gain;
    state.kills += 1;
    addFeed(`+${ev.gain} EXP (Total: ${ev.total_exp.toLocaleString()})`);
  } else if (ev.type === "hp_mp") {
    state.hp = ev.hp;
    state.mp = ev.mp;
    if (ev.damage_taken) addFeed(`Took ${ev.damage_taken} dmg (HP ${ev.hp})`);
  } else if (ev.type === "map_change") {
    state.mapId = ev.map_id;
    state.ch = ev.channel;
    const m = db.maps[ev.map_id];
    addFeed(`Entered ${m ? m.name : `Map #${ev.map_id}`} (Ch. ${ev.channel})`);
  } else if (ev.type === "mob_kill") {
    const mob = db.mobs[ev.mob_id];
    addFeed(`Killed ${mob ? `${mob.name} (Lv.${mob.level})` : `Mob #${ev.mob_id}`}`);
  } else if (ev.type === "item_loot") {
    const it = db.items[ev.item_id];
    addFeed(`Loot: ${it ? it.name : `Item #${ev.item_id}`} x${ev.qty}`);
  } else if (ev.type === "meso_loot") {
    state.mesos += ev.amount;
    addFeed(`+${ev.amount} mesos`);
  } else if (ev.type === "mob_damage" && ev.damage > 0) {
    const mob = ev.mob_id ? db.mobs[ev.mob_id] : null;
    addFeed(`Hit ${mob ? mob.name : "mob"} for ${ev.damage}`);
  }
}

function connect() {
  const base = workerInput.value.trim().replace(/\/+$/, "");
  const room = roomInput.value.trim() || "default";
  if (!base) return;
  localStorage.setItem("ms_worker", base);
  localStorage.setItem("ms_room", room);
  localStorage.setItem("ms_db", dbInput.value.trim() || DEFAULT_DB);

  if (ws) ws.close();
  const wsUrl = base.replace(/^http/, "ws") + `/room/${encodeURIComponent(room)}?role=hud`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    statusDot.textContent = "LIVE";
    statusDot.className = "pill live";
    if (!state.mapId) mapLine.textContent = "Connected — waiting for game traffic...";
  };
  ws.onclose = () => {
    statusDot.textContent = "OFFLINE";
    statusDot.className = "pill offline";
    if (!state.mapId) mapLine.textContent = "Not connected";
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "init" && msg.data) {
      state.hp = msg.data.hp;
      state.mp = msg.data.mp;
      state.mapId = msg.data.map_id;
      state.ch = msg.data.channel;
      render();
    } else if (msg.type === "events") {
      for (const ev of msg.events || []) handleEvent(ev);
      render();
    }
  };
}

$("connectBtn").addEventListener("click", () => {
  loadCatalog();
  connect();
});

loadCatalog();
if (workerInput.value.trim()) connect();
