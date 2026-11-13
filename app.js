// @ts-check
"use strict";

/**
 * @typedef {{ name: string, street: string }} MapEntry
 * @typedef {{ name: string, level?: number, exp?: number }} MobEntry
 * @typedef {{ name: string, cat: string, price: number | null }} ItemEntry
 * @typedef {{ maps: Record<number, MapEntry>, mobs: Record<number, MobEntry>, items: Record<number, ItemEntry> }} CatalogDB
 * @typedef {{
 *   startTs: number | null,
 *   sessionExp: number,
 *   kills: number,
 *   mesos: number,
 *   hp: number | null,
 *   mp: number | null,
 *   mapId: number | null,
 *   ch: number | null
 * }} HudState
 * @typedef {(
 *   | { type: "map_change", map_id: number, channel: number }
 *   | { type: "exp_gain", gain: number, total_exp: number }
 *   | { type: "hp_mp", hp: number | null, mp: number | null, damage_taken?: number }
 *   | { type: "mob_kill", mob_id: number }
 *   | { type: "item_loot", item_id: number, qty: number }
 *   | { type: "meso_loot", amount: number }
 *   | { type: "mob_damage", mob_id: number | null, damage: number }
 * )} TelemetryEvent
 * @typedef {(
 *   | { type: "init", data: { hp: number | null, mp: number | null, map_id: number | null, channel: number | null } }
 *   | { type: "events", events: TelemetryEvent[] }
 * )} ServerMessage
 */

const DEFAULT_DB = "https://osmsdataexplorer.com/data/current/";

/** @param {string} id @returns {HTMLElement} */
function requireEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element #${id}`);
  return el;
}

const workerInput = /** @type {HTMLInputElement} */ (requireEl("workerUrl"));
const roomInput = /** @type {HTMLInputElement} */ (requireEl("roomId"));
const dbSourceSelect = /** @type {HTMLSelectElement} */ (requireEl("dbSource"));
const dbInput = /** @type {HTMLInputElement} */ (requireEl("dbBase"));
const statusDot = requireEl("statusDot");
const mapLine = requireEl("mapLine");
const feedEl = requireEl("feed");

const params = new URLSearchParams(window.location.search);
workerInput.value = params.get("worker") || localStorage.getItem("ms_worker") || "";
roomInput.value = params.get("room") || localStorage.getItem("ms_room") || "";

const savedDb = localStorage.getItem("ms_db") || DEFAULT_DB;
const hasPreset = Array.from(dbSourceSelect.options).some((opt) => opt.value === savedDb && opt.value !== "custom");
if (hasPreset) {
  dbSourceSelect.value = savedDb;
  dbInput.value = savedDb;
} else {
  dbSourceSelect.value = "custom";
  dbInput.value = savedDb;
  dbInput.classList.remove("hidden");
}

/** @returns {string} */
function getCatalogBase() {
  const raw = dbSourceSelect.value === "custom" ? dbInput.value.trim() : dbSourceSelect.value;
  return (raw || DEFAULT_DB).replace(/\/+$/, "") + "/";
}

/** @type {CatalogDB} */
const db = { maps: {}, mobs: {}, items: {} };
/** @type {HudState} */
const state = { startTs: null, sessionExp: 0, kills: 0, mesos: 0, hp: null, mp: null, mapId: null, ch: null };

/** @type {WebSocket | null} */
let ws = null;
/** @type {number | null} */
let reconnectTimer = null;
let reconnectDelayMs = 1500;

async function loadCatalog() {
  const base = getCatalogBase();
  requireEl("dbStatus").textContent = "Loading...";
  try {
    const [mapsR, mobsR, itemsR] = await Promise.all([
      fetch(base + "maps.json"),
      fetch(base + "monsters.json"),
      fetch(base + "items.json"),
    ]);
    if (!mapsR.ok || !mobsR.ok || !itemsR.ok) {
      throw new Error("Catalog HTTP error");
    }
    const mapsD = await mapsR.json();
    for (const reg of mapsD.regions || []) {
      for (const m of reg.maps || []) {
        db.maps[m.id] = { name: m.name, street: m.street_name || "" };
      }
    }
    const mobsD = await mobsR.json();
    for (const m of mobsD.monsters || []) {
      db.mobs[m.id] = { name: m.name, level: m.level, exp: m.exp };
    }
    const itemsD = await itemsR.json();
    for (const it of itemsD.items || []) {
      db.items[it.id] = { name: it.name, cat: it.category || "", price: it.stats?.price ?? null };
    }
    requireEl("dbStatus").textContent = `${Object.keys(db.mobs).length} mobs`;
  } catch {
    requireEl("dbStatus").textContent = "DB error";
  }
}

/** @param {string} text */
function addFeed(text) {
  const li = document.createElement("li");
  const msgSpan = document.createElement("span");
  msgSpan.textContent = text;
  const tsSpan = document.createElement("span");
  tsSpan.className = "ts";
  tsSpan.textContent = new Date().toLocaleTimeString();
  li.append(msgSpan, tsSpan);
  feedEl.prepend(li);
  while (feedEl.children.length > 40 && feedEl.lastChild) {
    feedEl.lastChild.remove();
  }
}

function render() {
  const elapsed = state.startTs ? Math.max((Date.now() - state.startTs) / 1000, 1) : 1;
  requireEl("sessionExp").textContent = state.sessionExp.toLocaleString();
  requireEl("kills").textContent = String(state.kills);
  requireEl("xph").textContent = state.startTs ? Math.floor((state.sessionExp * 3600) / elapsed).toLocaleString() : "0";
  requireEl("kpm").textContent = state.startTs ? ((state.kills * 60) / elapsed).toFixed(1) : "0.0";
  requireEl("hp").textContent = state.hp !== null ? String(state.hp) : "--";
  requireEl("mp").textContent = state.mp !== null ? String(state.mp) : "--";
  requireEl("mesos").textContent = state.mesos.toLocaleString();
  if (state.mapId !== null) {
    const m = db.maps[state.mapId];
    mapLine.textContent = `${m ? `${m.name} (${m.street})` : `Map #${state.mapId}`} • Ch. ${state.ch ?? "?"}`;
  }
}

/** @param {TelemetryEvent} ev */
function handleEvent(ev) {
  if (!state.startTs) state.startTs = Date.now();
  switch (ev.type) {
    case "exp_gain":
      state.sessionExp += ev.gain;
      state.kills += 1;
      addFeed(`+${ev.gain} EXP (Total: ${ev.total_exp.toLocaleString()})`);
      break;
    case "hp_mp":
      state.hp = ev.hp;
      state.mp = ev.mp;
      if (ev.damage_taken) addFeed(`Took ${ev.damage_taken} dmg (HP ${ev.hp})`);
      break;
    case "map_change": {
      state.mapId = ev.map_id;
      state.ch = ev.channel;
      const m = db.maps[ev.map_id];
      addFeed(`Entered ${m ? m.name : `Map #${ev.map_id}`} (Ch. ${ev.channel})`);
      break;
    }
    case "mob_kill": {
      const mob = db.mobs[ev.mob_id];
      addFeed(`Killed ${mob ? `${mob.name} (Lv.${mob.level ?? "?"})` : `Mob #${ev.mob_id}`}`);
      break;
    }
    case "item_loot": {
      const it = db.items[ev.item_id];
      addFeed(`Loot: ${it ? it.name : `Item #${ev.item_id}`} x${ev.qty}`);
      break;
    }
    case "meso_loot":
      state.mesos += ev.amount;
      addFeed(`+${ev.amount} mesos`);
      break;
    case "mob_damage":
      if (ev.damage > 0) {
        const mob = ev.mob_id !== null ? db.mobs[ev.mob_id] : null;
        addFeed(`Hit ${mob ? mob.name : "mob"} for ${ev.damage}`);
      }
      break;
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null || !workerInput.value.trim()) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
    connect();
  }, reconnectDelayMs);
}

function connect() {
  const base = workerInput.value.trim().replace(/\/+$/, "");
  const room = roomInput.value.trim();
  if (!base) return;
  if (!room) {
    mapLine.textContent = "Enter a Room ID to connect";
    return;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  localStorage.setItem("ms_worker", base);
  localStorage.setItem("ms_room", room);
  localStorage.setItem("ms_db", getCatalogBase());

  if (ws) ws.close();
  const wsUrl = base.replace(/^http/, "ws") + `/room/${encodeURIComponent(room)}?role=hud`;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    reconnectDelayMs = 1500;
    statusDot.textContent = "LIVE";
    statusDot.className = "pill live";
    if (state.mapId === null) mapLine.textContent = "Connected — waiting for game traffic...";
  };
  ws.onerror = () => {
    statusDot.textContent = "ERROR";
    statusDot.className = "pill offline";
  };
  ws.onclose = () => {
    statusDot.textContent = "OFFLINE";
    statusDot.className = "pill offline";
    if (state.mapId === null) mapLine.textContent = "Not connected";
    scheduleReconnect();
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = /** @type {ServerMessage} */ (JSON.parse(e.data));
    } catch {
      return;
    }
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

dbSourceSelect.addEventListener("change", () => {
  if (dbSourceSelect.value === "custom") {
    dbInput.classList.remove("hidden");
    dbInput.focus();
    return;
  }
  dbInput.classList.add("hidden");
  dbInput.value = dbSourceSelect.value;
  localStorage.setItem("ms_db", getCatalogBase());
  loadCatalog();
});

dbInput.addEventListener("change", () => {
  if (dbSourceSelect.value === "custom" && dbInput.value.trim()) {
    localStorage.setItem("ms_db", getCatalogBase());
    loadCatalog();
  }
});

requireEl("connectBtn").addEventListener("click", () => {
  if (Object.keys(db.mobs).length === 0) loadCatalog();
  connect();
});

requireEl("shareBtn").addEventListener("click", async () => {
  const base = workerInput.value.trim().replace(/\/+$/, "");
  const room = roomInput.value.trim();
  if (!base || !room) {
    mapLine.textContent = "Enter Worker URL and Room ID before sharing";
    return;
  }
  const shareUrl = `${window.location.origin}${window.location.pathname}?worker=${encodeURIComponent(base)}&room=${encodeURIComponent(room)}`;
  const btn = requireEl("shareBtn");
  try {
    await navigator.clipboard.writeText(shareUrl);
    btn.textContent = "Copied!";
    window.setTimeout(() => { btn.textContent = "Share Link"; }, 1500);
  } catch {
    window.prompt("Copy HUD share link:", shareUrl);
  }
});

function resetLocalState() {
  state.startTs = null;
  state.sessionExp = 0;
  state.kills = 0;
  state.mesos = 0;
  state.hp = null;
  state.mp = null;
  state.mapId = null;
  state.ch = null;
  feedEl.replaceChildren();
  mapLine.textContent = ws && ws.readyState === WebSocket.OPEN ? "Connected — waiting for game traffic..." : "Not connected";
  render();
}

requireEl("resetBtn").addEventListener("click", async () => {
  resetLocalState();
  const base = workerInput.value.trim().replace(/\/+$/, "");
  const room = roomInput.value.trim();
  if (base && room) {
    try {
      await fetch(`${base}/room/${encodeURIComponent(room)}`, { method: "DELETE" });
    } catch {
      // Ignore network errors or 401 when an active ingester owns the room
    }
  }
});

loadCatalog();
if (workerInput.value.trim() && roomInput.value.trim()) connect();
