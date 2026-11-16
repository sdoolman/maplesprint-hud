// @ts-check
"use strict";

const DEFAULT_DB = "https://osmsdataexplorer.com/data/current/";
const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8080";
const DEFAULT_CODEC_WORKER = "https://maplesprint-hub.stav973.workers.dev";
const AUTO_PAUSE_IDLE_MS = 15_000;
const ROLLING_WINDOW_MS = 5 * 60 * 1000;

// Classic World (pre-Big Bang) Level 1-200 EXP curve
const CLASSIC_EXP_TABLE = (() => {
  const t = new Array(201).fill(0);
  const early = [
    0, 15, 34, 57, 92, 135, 372, 560, 840, 1242, 1716,
    2360, 3216, 4200, 5460, 7050, 8840, 11040, 13716, 16680, 20216,
    24402, 28980, 34320, 40512, 47216, 54900, 63666, 73080, 83720, 95700,
    108480, 122760, 138666, 155540, 174216, 194832, 216600, 240500, 266682, 294216,
    324240, 356916, 391160, 428280, 468450, 510420, 555680, 604416, 655200, 709716,
  ];
  for (let i = 1; i < early.length; i++) t[i] = early[i];
  for (let lv = 51; lv <= 200; lv++) {
    const prev = t[lv - 1];
    const rate = lv < 70 ? 1.08 : lv < 120 ? 1.065 : 1.055;
    t[lv] = Math.round(prev * rate);
  }
  return t;
})();

/** @type {Record<number, string>} */
const JOB_NAMES = {
  0: "Beginner",
  100: "Warrior", 110: "Fighter", 111: "Crusader", 112: "Hero",
  120: "Page", 121: "White Knight", 122: "Paladin",
  130: "Spearman", 131: "Dragon Knight", 132: "Dark Knight",
  200: "Magician", 210: "F/P Wizard", 211: "F/P Mage", 212: "F/P Arch Mage",
  220: "I/L Wizard", 221: "I/L Mage", 222: "I/L Arch Mage",
  230: "Cleric", 231: "Priest", 232: "Bishop",
  300: "Bowman", 310: "Hunter", 311: "Ranger", 312: "Bowmaster",
  320: "Crossbowman", 321: "Sniper", 322: "Marksman",
  400: "Thief", 410: "Assassin", 411: "Hermit", 412: "Night Lord",
  420: "Bandit", 421: "Chief Bandit", 422: "Shadower",
  500: "Pirate", 510: "Brawler", 520: "Gunslinger",
};

/** @param {string} id @returns {HTMLElement} */
function requireEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element #${id}`);
  return el;
}

const workerInput = /** @type {HTMLInputElement} */ (requireEl("workerUrl"));
const codecInput = /** @type {HTMLInputElement} */ (requireEl("codecUrl"));
const applyCodecBtn = /** @type {HTMLButtonElement} */ (requireEl("applyCodecBtn"));
const dbSourceSelect = /** @type {HTMLSelectElement} */ (requireEl("dbSource"));
const dbInput = /** @type {HTMLInputElement} */ (requireEl("dbBase"));
const downloadWgConfBtn = /** @type {HTMLButtonElement} */ (requireEl("downloadWgConfBtn"));
const wasmStatusBadge = requireEl("wasmStatusBadge");
const wgTunnelStatus = requireEl("wgTunnelStatus");
const endpointStatusBadge = requireEl("endpointStatusBadge");
const outboundIpTag = requireEl("outboundIpTag");
const wasmNodeDetail = requireEl("wasmNodeDetail");
const pipBtn = /** @type {HTMLButtonElement} */ (requireEl("pipBtn"));
const wakeBtn = /** @type {HTMLButtonElement} */ (requireEl("wakeBtn"));
const statusDot = requireEl("statusDot");
const grindStateBadge = requireEl("grindStateBadge");
const mapLine = requireEl("mapLine");
const feedEl = requireEl("feed");
const eventCountEl = requireEl("eventCount");

const tabHud = requireEl("tabHud");
const tabGuide = requireEl("tabGuide");
const tabHistory = requireEl("tabHistory");
const tabSetup = requireEl("tabSetup");
const viewHud = requireEl("viewHud");
const viewGuide = requireEl("viewGuide");
const viewHistory = requireEl("viewHistory");
const viewSetup = requireEl("viewSetup");

const manualLevelInput = /** @type {HTMLInputElement} */ (requireEl("manualLevelInput"));
const charJobEl = requireEl("charJob");
const levelPctEl = requireEl("levelPct");
const ttlEl = requireEl("ttl");
const levelProgressBar = requireEl("levelProgressBar");

const xphEl = requireEl("xph");
const xph5mEl = requireEl("xph5m");
const elapsedEl = requireEl("elapsed");
const sessionExpEl = requireEl("sessionExp");
const lastExpEl = requireEl("lastExp");
const killsEl = requireEl("kills");
const lastMobEl = requireEl("lastMob");
const kpmEl = requireEl("kpm");
const dpmEl = requireEl("dpm");
const hpEl = requireEl("hp");
const hpSubEl = requireEl("hpSub");
const mpEl = requireEl("mp");
const mpSubEl = requireEl("mpSub");
const mesosEl = requireEl("mesos");
const npcValueTagEl = requireEl("npcValueTag");
const mesoSubEl = requireEl("mesoSub");
const dropsEl = requireEl("drops");
const dropSubEl = requireEl("dropSub");

const guideLevelInput = /** @type {HTMLInputElement} */ (requireEl("guideLevel"));
const guideJobSelect = /** @type {HTMLSelectElement} */ (requireEl("guideJob"));
const guideSortSelect = /** @type {HTMLSelectElement} */ (requireEl("guideSort"));
const guideSearchInput = /** @type {HTMLInputElement} */ (requireEl("guideSearch"));
const guideListEl = requireEl("guideList");

const splitsTableBody = requireEl("splitsTableBody");
const exportSplitsBtn = requireEl("exportSplitsBtn");
const clearSplitsBtn = requireEl("clearSplitsBtn");

const params = new URLSearchParams(window.location.search);
workerInput.value = params.get("worker") || localStorage.getItem("ms_worker") || DEFAULT_LOCAL_ENDPOINT;
const activeRoomId = params.get("room") || "local";
codecInput.value = params.get("codec") || localStorage.getItem("ms_codec_url") || "";

const savedDb = localStorage.getItem("ms_db") || DEFAULT_DB;
const hasPreset = Array.from(dbSourceSelect.options).some((opt) => opt.value === savedDb && opt.value !== "custom");
if (hasPreset) {
  dbSourceSelect.value = savedDb;
  dbInput.value = savedDb;
  dbInput.hidden = true;
  dbInput.classList.add("hidden");
} else {
  dbSourceSelect.value = "custom";
  dbInput.value = savedDb;
  dbInput.hidden = false;
  dbInput.classList.remove("hidden");
}

/** @returns {string} */
function getCatalogBase() {
  const raw = dbSourceSelect.value === "custom" ? dbInput.value.trim() : dbSourceSelect.value;
  return (raw || DEFAULT_DB).replace(/\/+$/, "") + "/";
}

function loadSavedSplits() {
  try {
    const raw = localStorage.getItem("ms_map_splits");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSplits() {
  try {
    localStorage.setItem("ms_map_splits", JSON.stringify(state.mapSplits.slice(0, 50)));
  } catch {}
}

const db = {
  /** @type {Record<number, { name: string, street: string, isTown?: boolean, spawns?: Array<{ id: number, count: number }> }>} */
  maps: {},
  /** @type {Record<number, { name: string, level?: number, exp?: number, hp?: number, undead?: boolean, elemAttr?: string, boss?: boolean, maps?: Array<{ id: number, name?: string, count?: number }> }>} */
  mobs: {},
  /** @type {Record<number, { name: string, cat: string, price: number | null }>} */
  items: {},
  loaded: false,
  /** @type {Array<any>} */
  guideMaps: [],
};

const state = {
  startTs: /** @type {number | null} */ (null),
  activeMs: 0,
  lastActiveTs: /** @type {number | null} */ (null),
  sessionExp: 0,
  lastExp: 0,
  totalExp: 0,
  level: Number(localStorage.getItem("ms_char_level")) || 1,
  job: Number(localStorage.getItem("ms_char_job")) || 0,
  kills: 0,
  lastMobId: /** @type {number | null} */ (null),
  mesos: 0,
  npcLootValue: 0,
  drops: 0,
  lastItemId: /** @type {number | null} */ (null),
  hp: /** @type {number | null} */ (null),
  mp: /** @type {number | null} */ (null),
  maxHp: /** @type {number | null} */ (null),
  maxMp: /** @type {number | null} */ (null),
  damageTaken: 0,
  damageDealt: 0,
  mapId: /** @type {number | null} */ (null),
  ch: /** @type {number | null} */ (null),
  events: 0,
  rawChunksReceived: 0,
  /** @type {Array<{ ts: number, gain: number }>} */
  expWindow: [],
  /** @type {Array<any>} */
  mapSplits: loadSavedSplits(),
  currentSplit: /** @type {any | null} */ (null),
  pipWin: /** @type {Window | null} */ (null),
};

manualLevelInput.value = String(state.level);
guideLevelInput.value = String(state.level > 1 ? state.level : 25);

// ============================================================================
// Pluggable Codec Loader (GitHub Pages Release Artifact ./codec.mjs or Custom BYOC)
// ============================================================================

const codecEngine = {
  ready: false,
  /** @type {any} */
  decoder: null,
};

async function initCodecWasm() {
  const customCodec = codecInput.value.trim() || params.get("codec") || localStorage.getItem("ms_codec_url") || "";
  if (params.get("codec")) {
    localStorage.setItem("ms_codec_url", params.get("codec") || "");
    codecInput.value = params.get("codec") || "";
  }

  /** @type {Array<{ url: string, label: string }>} */
  const candidates = [];
  if (customCodec.trim()) {
    const clean = customCodec.trim();
    const resolved = clean.endsWith(".mjs") || clean.endsWith(".js") ? clean : `${clean.replace(/\/+$/, "")}/codec.mjs`;
    candidates.push({ url: resolved, label: "Custom Codec (BYOC)" });
  }
  candidates.push(
    { url: new URL("./codec.mjs", window.location.href).href, label: "Pages Release Codec (Active)" },
    { url: `${DEFAULT_CODEC_WORKER.replace(/\/+$/, "")}/codec.mjs`, label: "Fallback Codec (Active)" }
  );

  for (const cand of candidates) {
    try {
      const mod = await import(cand.url);
      if (typeof mod.MapleDecoder !== "function") continue;
      codecEngine.decoder = new mod.MapleDecoder();
      codecEngine.ready = true;
      wasmStatusBadge.textContent = "CODEC: Ready";
      wasmNodeDetail.textContent = cand.label;
      wasmNodeDetail.classList.add("online");
      return;
    } catch {
      // Try next candidate
    }
  }

  wasmStatusBadge.textContent = "CODEC: Standby";
  wasmNodeDetail.textContent = "No codec.mjs loaded (?codec=)";
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Ingests a raw TCP segment from maplesprint-endpoint into the Worker-loaded MapleDecoder.
 * @param {string} flow
 * @param {number} seq
 * @param {string} b64Data
 */
function ingestRawChunkWasm(flow, seq, b64Data) {
  if (!codecEngine.ready || !codecEngine.decoder || !b64Data) return;
  const payload = base64ToBytes(b64Data);
  if (payload.length === 0) return;

  state.rawChunksReceived++;
  wgTunnelStatus.textContent = `Active (${state.rawChunksReceived.toLocaleString()} segs)`;
  wgTunnelStatus.classList.add("online");

  const events = codecEngine.decoder.feedChunk(flow, seq, payload);
  if (Array.isArray(events) && events.length > 0) {
    for (const ev of events) {
      handleEvent(ev);
    }
    render();
  }
}

// ============================================================================
// WireGuard + Endpoint Dashboard Status Poller & Config Generator
// ============================================================================

async function probeEndpointStatus() {
  const base = workerInput.value.trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    const res = await fetch(`${base}/status`, { cache: "no-store" });
    if (!res.ok) throw new Error("Status unavailable");
    const st = await res.json();
    endpointStatusBadge.textContent = `ONLINE (${st.mode || "relay"})`;
    endpointStatusBadge.classList.add("online");
    if (st.outbound_ip) {
      outboundIpTag.textContent = `Outbound NIC: ${st.outbound_ip} (No-Loop)`;
    }
    if (typeof st.packets_relayed === "number" && st.packets_relayed > 0) {
      wgTunnelStatus.textContent = `Active (${st.packets_relayed.toLocaleString()} pkts)`;
      wgTunnelStatus.classList.add("online");
    }
  } catch {
    if (ws && ws.readyState === WebSocket.OPEN) {
      endpointStatusBadge.textContent = "Connected (Remote / Worker)";
      endpointStatusBadge.classList.add("online");
    } else {
      endpointStatusBadge.textContent = "Offline — Start endpoint.exe";
      endpointStatusBadge.classList.remove("online");
    }
  }
}

downloadWgConfBtn.addEventListener("click", async () => {
  const base = workerInput.value.trim().replace(/\/+$/, "");
  if (base) {
    try {
      const res = await fetch(`${base}/MapleSprint.conf`);
      if (res.ok) {
        const text = await res.text();
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "MapleSprint.conf";
        a.click();
        return;
      }
    } catch {}
  }
  // Fallback template pointing to 127.0.0.1:51820 for local split-tunnel setup
  const confTemplate = [
    "[Interface]",
    "# Replace PrivateKey with your generated WireGuard client private key",
    "PrivateKey = <CLIENT_PRIVATE_KEY>",
    "Address = 10.66.66.2/32",
    "",
    "[Peer]",
    "# MapleSprint Local Endpoint (127.0.0.1:51820)",
    "PublicKey = <ENDPOINT_PUBLIC_KEY>",
    "Endpoint = 127.0.0.1:51820",
    "AllowedIPs = 158.115.192.0/19",
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
  const blob = new Blob([confTemplate], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "MapleSprint.conf";
  a.click();
});

// ============================================================================
// Catalog, Telemetry State & UI Rendering
// ============================================================================

/** @type {WebSocket | null} */
let ws = null;
/** @type {number | null} */
let reconnectTimer = null;
let reconnectDelayMs = 1500;

const fmtCompact = (n) => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
  return Math.round(v).toLocaleString();
};

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hrs = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${hrs}:${mins}:${secs}`;
}

async function loadCatalog() {
  const base = getCatalogBase();
  requireEl("dbStatus").textContent = "Loading...";
  try {
    const fetchMobFile = async () => {
      const r1 = await fetch(base + "monsters.json");
      if (r1.ok) return r1;
      return fetch(base + "mobs.json");
    };
    const [mapsR, mobsR, itemsR] = await Promise.all([
      fetch(base + "maps.json"),
      fetchMobFile(),
      fetch(base + "items.json"),
    ]);
    if (!mapsR.ok || !mobsR.ok || !itemsR.ok) {
      throw new Error("Catalog HTTP error");
    }
    db.maps = {};
    db.mobs = {};
    db.items = {};
    const mapsD = await mapsR.json();
    if (Array.isArray(mapsD.regions)) {
      for (const reg of mapsD.regions) {
        for (const m of reg.maps || []) {
          db.maps[m.id] = {
            name: m.name,
            street: m.street_name || reg.region || "",
            isTown: Boolean(m.is_town),
            spawns: [],
          };
        }
      }
    } else {
      for (const [id, m] of Object.entries(mapsD)) {
        if (m && typeof m === "object") {
          db.maps[Number(id)] = {
            name: m.name || `Map #${id}`,
            street: m.street || m.street_name || "",
            spawns: Array.isArray(m.spawns) ? m.spawns : [],
          };
        }
      }
    }

    const mobsD = await mobsR.json();
    if (Array.isArray(mobsD.monsters)) {
      for (const m of mobsD.monsters) {
        db.mobs[m.id] = {
          name: m.name,
          level: m.level,
          exp: m.exp,
          hp: m.hp ?? m.max_hp,
          undead: Boolean(m.undead),
          elemAttr: m.elemAttr || m.elem_attr || "",
          boss: Boolean(m.boss),
          maps: Array.isArray(m.maps) ? m.maps : [],
        };
        for (const sp of m.maps || []) {
          if (!db.maps[sp.id]) {
            db.maps[sp.id] = { name: sp.name || `Map #${sp.id}`, street: "", spawns: [] };
          }
          db.maps[sp.id].spawns?.push({ id: m.id, count: sp.count || 1 });
        }
      }
    } else {
      for (const [id, m] of Object.entries(mobsD)) {
        if (m && typeof m === "object") {
          db.mobs[Number(id)] = {
            name: m.name || `Mob #${id}`,
            level: m.level,
            exp: m.exp,
            hp: m.max_hp ?? m.hp,
            undead: Boolean(m.undead),
            elemAttr: m.elem_attr || m.elemAttr || "",
            boss: Boolean(m.boss),
          };
        }
      }
    }

    const itemsD = await itemsR.json();
    if (Array.isArray(itemsD.items)) {
      for (const it of itemsD.items) {
        db.items[it.id] = { name: it.name, cat: it.category || "", price: it.stats?.price ?? null };
      }
    } else {
      for (const [id, it] of Object.entries(itemsD)) {
        if (it && typeof it === "object") {
          db.items[Number(id)] = { name: it.name || `Item #${id}`, cat: it.category || "", price: it.price ?? null };
        }
      }
    }

    db.loaded = true;
    buildGuideIndex();
    requireEl("dbStatus").textContent = `${Object.keys(db.maps).length} maps · ${Object.keys(db.mobs).length} mobs · ${Object.keys(db.items).length} items`;
    render();
    renderGuide();
    renderSplitsTable();
  } catch {
    requireEl("dbStatus").textContent = "DB error";
  }
}

function buildGuideIndex() {
  const list = [];
  for (const [mapIdStr, m] of Object.entries(db.maps)) {
    const mapId = Number(mapIdStr);
    if (!m || m.isTown || !Array.isArray(m.spawns) || m.spawns.length === 0) continue;

    /** @type {Record<number, number>} */
    const countsByMob = {};
    for (const sp of m.spawns) {
      countsByMob[sp.id] = (countsByMob[sp.id] || 0) + Math.max(1, Number(sp.count) || 1);
    }

    const mobDetails = [];
    let totalSpawns = 0;
    let weightedLevel = 0;
    let weightedExp = 0;
    let weightedRatio = 0;
    let hasUndead = false;
    let hasHolyWeak = false;
    let hasFireWeak = false;
    let hasIceWeak = false;

    for (const [mobIdStr, count] of Object.entries(countsByMob)) {
      const mob = db.mobs[Number(mobIdStr)];
      if (!mob || !mob.level || !mob.exp || mob.boss) continue;
      const hp = Math.max(1, Number(mob.hp) || 1);
      const ratio = mob.exp / hp;
      const elem = String(mob.elemAttr || "");
      const nameLower = mob.name.toLowerCase();
      const undead =
        Boolean(mob.undead) ||
        elem.includes("H3") ||
        elem.includes("H2") ||
        nameLower.includes("zombie") ||
        nameLower.includes("wraith") ||
        nameLower.includes("skeleton") ||
        nameLower.includes("mummy") ||
        nameLower.includes("chronos") ||
        nameLower.includes("shade");

      if (undead) {
        hasUndead = true;
        hasHolyWeak = true;
      }
      if (elem.includes("F3") || elem.includes("F2")) hasFireWeak = true;
      if (elem.includes("I3") || elem.includes("I2")) hasIceWeak = true;

      totalSpawns += count;
      weightedLevel += mob.level * count;
      weightedExp += mob.exp * count;
      weightedRatio += ratio * count;
      mobDetails.push({
        id: Number(mobIdStr),
        name: mob.name,
        level: mob.level,
        exp: mob.exp,
        hp,
        count,
        undead,
      });
    }

    if (totalSpawns === 0 || mobDetails.length === 0) continue;
    mobDetails.sort((a, b) => b.count * b.exp - a.count * a.exp);

    list.push({
      mapId,
      name: m.name,
      street: m.street || "Maple World",
      totalSpawns,
      avgLevel: Math.round(weightedLevel / totalSpawns),
      avgExp: Math.round(weightedExp / totalSpawns),
      avgRatio: weightedRatio / totalSpawns,
      hasUndead,
      hasHolyWeak,
      hasFireWeak,
      hasIceWeak,
      mobs: mobDetails.slice(0, 4),
    });
  }
  db.guideMaps = list;
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

function recordActiveTime(ts) {
  const now = ts || Date.now();
  if (!state.startTs) state.startTs = now;
  if (state.lastActiveTs !== null) {
    const delta = now - state.lastActiveTs;
    if (delta > 0 && delta <= AUTO_PAUSE_IDLE_MS) {
      state.activeMs += delta;
      if (state.currentSplit) state.currentSplit.active_ms += delta;
    }
  }
  state.lastActiveTs = now;
}

function ensureCurrentSplit(mapId, channel, ts) {
  if (mapId == null) return null;
  if (state.currentSplit && state.currentSplit.map_id === mapId) {
    if (channel != null) state.currentSplit.channel = channel;
    return state.currentSplit;
  }
  const split = {
    map_id: mapId,
    channel: channel ?? state.ch ?? null,
    started_ts: ts || Date.now(),
    active_ms: 0,
    exp_gained: 0,
    kills: 0,
    mesos_gained: 0,
    drops: 0,
  };
  state.currentSplit = split;
  state.mapSplits.unshift(split);
  if (state.mapSplits.length > 50) state.mapSplits.length = 50;
  saveSplits();
  return split;
}

function recordedRateForMap(mapId) {
  let totalExp = 0;
  let totalMs = 0;
  for (const s of state.mapSplits) {
    if (s.map_id === mapId && s.exp_gained > 0 && s.active_ms >= 5000) {
      totalExp += s.exp_gained;
      totalMs += s.active_ms;
    }
  }
  if (totalMs < 5000) return 0;
  return Math.round((totalExp * 3_600_000) / totalMs);
}

function computeRolling5mXph(now) {
  const cutoff = now - ROLLING_WINDOW_MS;
  while (state.expWindow.length > 0 && state.expWindow[0].ts < cutoff) {
    state.expWindow.shift();
  }
  if (state.expWindow.length === 0) return 0;
  let sum = 0;
  for (const item of state.expWindow) sum += item.gain;
  const spanMs = Math.max(15_000, Math.min(ROLLING_WINDOW_MS, now - state.expWindow[0].ts));
  return Math.round((sum * 3_600_000) / spanMs);
}

function render() {
  const now = Date.now();
  const isGrinding = state.lastActiveTs !== null && now - state.lastActiveTs <= AUTO_PAUSE_IDLE_MS;

  grindStateBadge.textContent = isGrinding ? "ACTIVE" : "PAUSED";
  grindStateBadge.className = `pill ${isGrinding ? "active-state" : "paused"}`;

  const pendingDelta = isGrinding && state.lastActiveTs ? Math.max(0, now - state.lastActiveTs) : 0;
  const effectiveActiveMs = state.activeMs + pendingDelta;
  const activeSec = Math.max(effectiveActiveMs / 1000, 1);

  sessionExpEl.textContent = state.sessionExp.toLocaleString();
  lastExpEl.textContent =
    state.lastExp < 0
      ? `${state.lastExp.toLocaleString()} (Death loss)`
      : `+${state.lastExp.toLocaleString()} last gain`;

  killsEl.textContent = String(state.kills);
  if (state.lastMobId !== null) {
    const mob = db.mobs[state.lastMobId];
    lastMobEl.textContent = mob ? `${mob.name} (Lv.${mob.level ?? "?"})` : `Mob #${state.lastMobId}`;
  } else {
    lastMobEl.textContent = "No kills yet";
  }

  const xphVal = state.startTs ? Math.max(0, Math.floor((state.sessionExp * 3600) / activeSec)) : 0;
  const rolling5m = computeRolling5mXph(now);

  xphEl.textContent = xphVal.toLocaleString();
  xph5mEl.textContent = `5m: ${fmtCompact(rolling5m)}/h`;
  elapsedEl.textContent = `${formatDuration(effectiveActiveMs)} active`;

  kpmEl.textContent = state.startTs ? ((state.kills * 60) / activeSec).toFixed(1) : "0.0";
  dpmEl.textContent =
    state.startTs && state.damageDealt > 0
      ? `${Math.round((state.damageDealt * 60) / activeSec).toLocaleString()} dmg/m`
      : "0 dmg/m";

  hpEl.textContent =
    state.hp !== null
      ? state.maxHp
        ? `${state.hp.toLocaleString()}/${state.maxHp.toLocaleString()}`
        : String(state.hp)
      : "--";
  hpSubEl.textContent = `${state.damageTaken.toLocaleString()} dmg taken`;

  mpEl.textContent =
    state.mp !== null
      ? state.maxMp
        ? `${state.mp.toLocaleString()}/${state.maxMp.toLocaleString()}`
        : String(state.mp)
      : "--";

  const netMesos = state.mesos + state.npcLootValue;
  mesosEl.textContent = netMesos.toLocaleString();
  npcValueTagEl.textContent = `NPC: +${fmtCompact(state.npcLootValue)}`;
  mesoSubEl.textContent =
    state.startTs ? `${Math.round((netMesos * 3600) / activeSec).toLocaleString()} / hr` : "0 / hr";

  dropsEl.textContent = state.drops.toLocaleString();
  if (state.lastItemId !== null) {
    const it = db.items[state.lastItemId];
    dropSubEl.textContent = it ? it.name : `Item #${state.lastItemId}`;
  } else {
    dropSubEl.textContent = "No drops yet";
  }

  charJobEl.textContent = JOB_NAMES[state.job] || `Job #${state.job}`;
  const reqExp = CLASSIC_EXP_TABLE[Math.min(200, Math.max(1, state.level))] || 0;
  let pct = 0;
  if (reqExp > 0 && state.totalExp > 0) {
    pct = Math.min(99.99, Math.max(0, (state.totalExp / reqExp) * 100));
  } else if (reqExp > 0 && state.sessionExp > 0) {
    pct = Math.min(99.99, Math.max(0, ((state.sessionExp % reqExp) / reqExp) * 100));
  }
  levelPctEl.textContent = `${pct.toFixed(2)}%`;
  levelProgressBar.style.width = `${pct.toFixed(2)}%`;

  const rateForEta = rolling5m > 0 ? rolling5m : xphVal;
  if (reqExp > 0 && rateForEta > 0) {
    const curInLevel = state.totalExp > 0 ? Math.min(reqExp, state.totalExp) : state.sessionExp % reqExp;
    const remExp = Math.max(0, reqExp - curInLevel);
    const minsLeft = (remExp / rateForEta) * 60;
    if (minsLeft < 1) {
      ttlEl.textContent = "ETA < 1m";
    } else if (minsLeft < 60) {
      ttlEl.textContent = `ETA ${Math.ceil(minsLeft)}m`;
    } else {
      ttlEl.textContent = `ETA ${Math.floor(minsLeft / 60)}h ${Math.round(minsLeft % 60)}m`;
    }
  } else {
    ttlEl.textContent = "ETA —";
  }

  if (state.mapId !== null) {
    const m = db.maps[state.mapId];
    mapLine.textContent = `${m ? `${m.name} (${m.street})` : `Map #${state.mapId}`} • Ch. ${state.ch ?? "?"}`;
  }
  eventCountEl.textContent = `${state.events.toLocaleString()} events`;
  updatePipOverlay(xphVal, rolling5m, pct, isGrinding);
}

/** @type {number | null} */
let pendingKillMobId = null;
/** @type {number | null} */
let pendingKillTimer = null;

function clearPendingKill() {
  pendingKillMobId = null;
  if (pendingKillTimer !== null) {
    clearTimeout(pendingKillTimer);
    pendingKillTimer = null;
  }
}

/** @param {any} ev */
function handleEvent(ev) {
  const evTs = ev.ts || Date.now();
  state.events++;

  switch (ev.type) {
    case "exp_gain": {
      recordActiveTime(evTs);
      if (pendingKillMobId !== null) {
        const mob = db.mobs[pendingKillMobId];
        state.lastMobId = pendingKillMobId;
        addFeed(`Killed ${mob ? `${mob.name} (Lv.${mob.level ?? "?"})` : `Mob #${pendingKillMobId}`}`);
        clearPendingKill();
      }
      state.sessionExp += ev.gain;
      state.lastExp = ev.gain;
      if (typeof ev.total_exp === "number") state.totalExp = ev.total_exp;
      if (ev.gain > 0) {
        state.kills += 1;
        state.expWindow.push({ ts: evTs, gain: ev.gain });
      }
      const split = ensureCurrentSplit(ev.map_id ?? state.mapId, state.ch, evTs);
      if (split) {
        split.exp_gained += ev.gain;
        if (ev.gain > 0) split.kills += 1;
      }
      saveSplits();
      if (ev.loss || ev.gain < 0) {
        addFeed(`EXP Loss: ${ev.gain.toLocaleString()} EXP (Total: ${(ev.total_exp ?? 0).toLocaleString()})`);
      } else {
        addFeed(`+${ev.gain.toLocaleString()} EXP (Total: ${(ev.total_exp ?? 0).toLocaleString()})`);
      }
      break;
    }

    case "char_stats":
      if (ev.level && ev.level >= 1) {
        state.level = ev.level;
        manualLevelInput.value = String(state.level);
        guideLevelInput.value = String(state.level);
        localStorage.setItem("ms_char_level", String(state.level));
      }
      if (ev.job !== null && ev.job !== undefined) {
        state.job = ev.job;
        localStorage.setItem("ms_char_job", String(state.job));
      }
      if (ev.max_hp) state.maxHp = ev.max_hp;
      if (ev.max_mp) state.maxMp = ev.max_mp;
      break;

    case "hp_mp":
      if (ev.hp !== null && ev.hp !== undefined) state.hp = ev.hp;
      if (ev.mp !== null && ev.mp !== undefined) state.mp = ev.mp;
      if (ev.max_hp) state.maxHp = ev.max_hp;
      if (ev.max_mp) state.maxMp = ev.max_mp;
      if (ev.damage_taken) {
        state.damageTaken += ev.damage_taken;
        addFeed(`Took ${ev.damage_taken} dmg (HP ${ev.hp})`);
      }
      if (ev.mp_delta) {
        mpSubEl.textContent = `${ev.mp_delta > 0 ? "+" : ""}${ev.mp_delta} MP`;
      }
      break;

    case "map_change": {
      state.mapId = ev.map_id;
      state.ch = ev.channel;
      ensureCurrentSplit(ev.map_id, ev.channel, evTs);
      const m = db.maps[ev.map_id];
      addFeed(`Entered ${m ? m.name : `Map #${ev.map_id}`} (Ch. ${ev.channel})`);
      renderSplitsTable();
      break;
    }

    case "mob_kill": {
      recordActiveTime(evTs);
      state.lastMobId = ev.mob_id;
      clearPendingKill();
      pendingKillMobId = ev.mob_id;
      pendingKillTimer = window.setTimeout(clearPendingKill, 500);
      break;
    }

    case "item_loot": {
      recordActiveTime(evTs);
      const qty = ev.qty || 1;
      state.drops += qty;
      state.lastItemId = ev.item_id;
      const it = db.items[ev.item_id];
      const npcPrice = it && typeof it.price === "number" ? it.price * qty : 0;
      state.npcLootValue += npcPrice;
      const split = ensureCurrentSplit(state.mapId, state.ch, evTs);
      if (split) {
        split.drops += qty;
        split.mesos_gained += npcPrice;
      }
      saveSplits();
      addFeed(`Loot: ${it ? it.name : `Item #${ev.item_id}`} x${qty}${npcPrice > 0 ? ` (+${npcPrice.toLocaleString()} NPC)` : ""}`);
      break;
    }

    case "meso_loot": {
      recordActiveTime(evTs);
      state.mesos += ev.amount;
      const split = ensureCurrentSplit(state.mapId, state.ch, evTs);
      if (split) split.mesos_gained += ev.amount;
      saveSplits();
      addFeed(`+${ev.amount.toLocaleString()} mesos`);
      break;
    }

    case "mob_damage":
    case "attack_hit":
      recordActiveTime(evTs);
      if (ev.damage > 0) {
        state.damageDealt += ev.damage;
        const mob = ev.mob_id !== null ? db.mobs[ev.mob_id] : null;
        if (ev.type === "mob_damage") {
          addFeed(`Hit ${mob ? mob.name : "mob"} for ${ev.damage}`);
        }
      }
      break;
  }
}

function renderGuide() {
  if (!db.loaded || db.guideMaps.length === 0) {
    guideListEl.innerHTML = `<div class="guide-card"><div class="guide-map-region">Loading OSMS map &amp; monster catalog…</div></div>`;
    return;
  }

  const charLv = Math.max(1, Math.min(200, Number(guideLevelInput.value) || state.level || 25));
  const jobFilter = guideJobSelect.value;
  const sortBy = guideSortSelect.value;
  const q = (guideSearchInput.value || "").trim().toLowerCase();

  const scored = [];
  for (const m of db.guideMaps) {
    const lvDiff = m.avgLevel - charLv;
    if (!q && (lvDiff < -12 || lvDiff > 15)) continue;

    if (q) {
      const hay = `${m.name} ${m.street} ${m.mobs.map((x) => x.name).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }

    const distPenalty = Math.max(0, Math.abs(lvDiff - 1) - 3) * 12;
    const densityFactor = Math.min(35, Math.sqrt(m.totalSpawns) * 6.5);
    const expFactor = Math.log10(Math.max(10, m.avgExp)) * 22;
    const ratioFactor = Math.min(25, m.avgRatio * 45);

    let classBonus = 0;
    const affinityTags = [];

    if (jobFilter === "cleric") {
      if (m.hasUndead || m.hasHolyWeak) {
        classBonus += 45;
        affinityTags.push("✨ Heal / Holy Weak");
      } else {
        classBonus -= 18;
      }
    } else if (jobFilter === "magician") {
      if (m.hasFireWeak || m.hasIceWeak) {
        classBonus += 25;
        affinityTags.push("🔥❄️ Elemental Weak");
      }
      if (m.totalSpawns >= 10) {
        classBonus += 10;
        affinityTags.push("High Mob Density");
      }
    } else if (jobFilter === "warrior") {
      if (m.totalSpawns >= 14) {
        classBonus += 24;
        affinityTags.push("⚔️ High Mob Density (Slash Blast)");
      }
    } else if (jobFilter === "bowman" || jobFilter === "thief") {
      if (m.avgRatio >= 0.35) {
        classBonus += 20;
        affinityTags.push("🎯 High EXP-to-HP Ratio");
      }
    } else {
      if (m.hasUndead) affinityTags.push("Undead / Cleric Friendly");
      if (m.totalSpawns >= 15) affinityTags.push("High Spawn Density");
    }

    const recordedXph = recordedRateForMap(m.mapId);
    const score = Math.max(1, Math.round(expFactor + densityFactor + ratioFactor + classBonus - distPenalty));

    scored.push({
      ...m,
      lvDiff,
      score,
      recordedXph,
      affinityTags,
    });
  }

  scored.sort((a, b) => {
    if (sortBy === "recorded") return b.recordedXph - a.recordedXph || b.score - a.score;
    if (sortBy === "exp") return b.avgExp - a.avgExp;
    if (sortBy === "spawns") return b.totalSpawns - a.totalSpawns;
    return b.score - a.score;
  });

  const top = scored.slice(0, 24);
  if (top.length === 0) {
    guideListEl.innerHTML = `<div class="guide-card"><div class="guide-map-region">No matching maps found for Lv. ${charLv}. Try clearing the search filter.</div></div>`;
    return;
  }

  guideListEl.innerHTML = top
    .map((m, idx) => {
      const diffLabel = m.lvDiff > 0 ? `+${m.lvDiff}` : `${m.lvDiff}`;
      const recBadge =
        m.recordedXph > 0
          ? `<span class="badge recorded">⚡ Recorded: ${fmtCompact(m.recordedXph)} EXP/h</span>`
          : "";
      const affBadges = m.affinityTags.map((t) => `<span class="badge affinity">${t}</span>`).join("");
      const mobsHtml = m.mobs
        .map(
          (mob) =>
            `<span class="mob-chip"><span class="mob-lv">Lv.${mob.level}</span> <strong>${mob.name}</strong> <span class="mob-exp">+${mob.exp.toLocaleString()} EXP</span> <span class="mob-hp">(${mob.hp.toLocaleString()} HP · ×${mob.count})</span></span>`
        )
        .join("");

      return `
      <article class="guide-card">
        <div class="guide-card-top">
          <div>
            <div class="guide-map-title">#${idx + 1} · ${m.name}</div>
            <div class="guide-map-region">${m.street} · Avg Mob Lv. ${m.avgLevel} (${diffLabel} vs you) · ${m.totalSpawns} spawns</div>
          </div>
          <div class="guide-badges">
            ${recBadge}
            ${affBadges}
            <span class="badge score">Score ${m.score}</span>
          </div>
        </div>
        <div class="guide-mobs">${mobsHtml}</div>
      </article>`;
    })
    .join("");
}

function renderSplitsTable() {
  const rows = state.mapSplits.filter((s) => s.exp_gained > 0 || s.kills > 0 || s.map_id != null);
  if (rows.length === 0) {
    splitsTableBody.innerHTML = `<tr><td colspan="7" class="empty-cell">No map splits recorded yet. Connect to a room to track map performance!</td></tr>`;
    return;
  }

  splitsTableBody.innerHTML = rows
    .slice(0, 30)
    .map((s) => {
      const m = db.maps[s.map_id];
      const label = m ? (m.street ? `${m.name} (${m.street})` : m.name) : `Map #${s.map_id}`;
      const xph = s.active_ms >= 3000 ? Math.round((s.exp_gained * 3_600_000) / s.active_ms) : 0;
      return `<tr>
        <td><strong>${label}</strong>${s.channel != null ? ` <span class="muted">(Ch. ${s.channel})</span>` : ""}</td>
        <td>${formatDuration(s.active_ms || 0)}</td>
        <td class="gold">${(s.exp_gained || 0).toLocaleString()}</td>
        <td class="accent">${xph.toLocaleString()}/h</td>
        <td>${(s.kills || 0).toLocaleString()}</td>
        <td>${(s.mesos_gained || 0).toLocaleString()}</td>
        <td>${(s.drops || 0).toLocaleString()}</td>
      </tr>`;
    })
    .join("");
}

async function togglePipOverlay() {
  if (state.pipWin && !state.pipWin.closed) {
    state.pipWin.close();
    state.pipWin = null;
    return;
  }

  let win = null;
  if ("documentPictureInPicture" in window) {
    try {
      // @ts-ignore
      win = await window.documentPictureInPicture.requestWindow({ width: 340, height: 145 });
    } catch {}
  }
  if (!win) {
    win = window.open("", "MapleSprintMini", "width=340,height=160,menubar=no,toolbar=no,location=no,status=no");
  }
  if (!win) return;

  state.pipWin = win;
  win.document.open();
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>MapleSprint Mini</title>
  <style>
    body { margin:0; padding:10px 12px; background:#0b0f19; color:#e2e8f0; font-family:system-ui,-apple-system,sans-serif; display:flex; flex-direction:column; gap:6px; }
    .top { display:flex; justify-content:space-between; align-items:center; font-size:11px; color:#8492a6; font-weight:700; }
    .pill { padding:1px 6px; border-radius:99px; font-size:10px; font-weight:800; }
    .pill.active { background:rgba(52,211,153,0.2); color:#34d399; }
    .pill.paused { background:rgba(250,204,21,0.2); color:#facc15; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .metric { background:#131a2a; border:1px solid #232d45; border-radius:8px; padding:6px 8px; }
    .lbl { font-size:10px; color:#8492a6; font-weight:700; }
    .val { font-size:15px; font-weight:800; color:#38bdf8; font-variant-numeric:tabular-nums; }
    .val.gold { color:#facc15; }
  </style>
</head>
<body>
  <div class="top">
    <span id="pipMap">MapleSprint Mini</span>
    <span id="pipState" class="pill paused">PAUSED</span>
  </div>
  <div class="row">
    <div class="metric"><div class="lbl">EXP / HR</div><div id="pipXph" class="val">0</div></div>
    <div class="metric"><div class="lbl">LV PROGRESS · <span id="pipEta">ETA —</span></div><div id="pipPct" class="val gold">0.00%</div></div>
  </div>
</body>
</html>`);
  win.document.close();
  render();
}

function updatePipOverlay(xphVal, rolling5m, pct, isGrinding) {
  if (!state.pipWin || state.pipWin.closed) return;
  const d = state.pipWin.document;
  const elXph = d.getElementById("pipXph");
  const elPct = d.getElementById("pipPct");
  const elEta = d.getElementById("pipEta");
  const elState = d.getElementById("pipState");
  const elMap = d.getElementById("pipMap");
  if (elXph) elXph.textContent = `${fmtCompact(xphVal)}/h (5m: ${fmtCompact(rolling5m)})`;
  if (elPct) elPct.textContent = `Lv.${state.level} · ${pct.toFixed(2)}%`;
  if (elEta) elEta.textContent = ttlEl.textContent;
  if (elState) {
    elState.textContent = isGrinding ? "ACTIVE" : "PAUSED";
    elState.className = `pill ${isGrinding ? "active" : "paused"}`;
  }
  if (elMap && state.mapId !== null) {
    const m = db.maps[state.mapId];
    elMap.textContent = m ? m.name : `Map #${state.mapId}`;
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
  const room = activeRoomId;
  if (!base) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  localStorage.setItem("ms_worker", base);
  localStorage.setItem("ms_db", getCatalogBase());

  probeEndpointStatus();

  if (ws) ws.close();
  const isLocalEndpoint = base.includes("127.0.0.1") || base.includes("localhost") || base.includes(":8080");
  const wsPath = isLocalEndpoint && room === "local" ? "/ws" : `/room/${encodeURIComponent(room)}?role=hud`;
  const wsUrl = base.replace(/^http/, "ws") + wsPath;

  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    reconnectDelayMs = 1500;
    statusDot.textContent = "LIVE";
    statusDot.className = "pill live";
    endpointStatusBadge.textContent = "ONLINE (Connected)";
    endpointStatusBadge.classList.add("online");
    if (state.mapId === null) mapLine.textContent = "Connected — waiting for WireGuard game traffic...";
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
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "raw_chunk") {
      ingestRawChunkWasm(msg.flow || "default", msg.seq || 0, msg.data || "");
      return;
    }
    if (msg.type === "endpoint_ready") {
      endpointStatusBadge.textContent = "ONLINE (Wasm Raw Relay)";
      endpointStatusBadge.classList.add("online");
      return;
    }
    if (msg.type === "init" && msg.data) {
      if (msg.data.hp !== null && msg.data.hp !== undefined) state.hp = msg.data.hp;
      if (msg.data.mp !== null && msg.data.mp !== undefined) state.mp = msg.data.mp;
      if (msg.data.max_hp) state.maxHp = msg.data.max_hp;
      if (msg.data.max_mp) state.maxMp = msg.data.max_mp;
      if (msg.data.map_id !== null && msg.data.map_id !== undefined) state.mapId = msg.data.map_id;
      if (msg.data.channel !== null && msg.data.channel !== undefined) state.ch = msg.data.channel;
      if (msg.data.total_exp) state.totalExp = msg.data.total_exp;
      if (msg.data.level && msg.data.level >= 1) {
        state.level = msg.data.level;
        manualLevelInput.value = String(state.level);
        guideLevelInput.value = String(state.level);
        localStorage.setItem("ms_char_level", String(state.level));
      }
      if (msg.data.job !== null && msg.data.job !== undefined) {
        state.job = msg.data.job;
        localStorage.setItem("ms_char_job", String(state.job));
      }
      if (typeof msg.data.session_exp === "number" && msg.data.session_exp > state.sessionExp) {
        state.sessionExp = msg.data.session_exp;
        if (!state.startTs) state.startTs = msg.data.session_start_ts || Date.now();
      }
      if (typeof msg.data.active_ms === "number" && msg.data.active_ms > state.activeMs) {
        state.activeMs = msg.data.active_ms;
      }
      if (typeof msg.data.kills === "number" && msg.data.kills > state.kills) {
        state.kills = msg.data.kills;
      }
      if (typeof msg.data.mesos === "number" && msg.data.mesos > state.mesos) {
        state.mesos = msg.data.mesos;
      }
      if (typeof msg.data.drops === "number" && msg.data.drops > state.drops) {
        state.drops = msg.data.drops;
      }
      if (Array.isArray(msg.data.map_splits)) {
        for (const s of msg.data.map_splits) {
          if (!state.mapSplits.some((loc) => loc.map_id === s.map_id && loc.started_ts === s.started_ts)) {
            state.mapSplits.push(s);
          }
        }
        saveSplits();
        renderSplitsTable();
      }
      if (state.mapId !== null) ensureCurrentSplit(state.mapId, state.ch, Date.now());
      render();
    } else if (msg.type === "events") {
      for (const ev of msg.events || []) handleEvent(ev);
      render();
    } else if (msg.type) {
      handleEvent(msg);
      render();
    }
  };
}

function switchTab(tabName) {
  for (const [btn, view, key] of [
    [tabHud, viewHud, "hud"],
    [tabGuide, viewGuide, "guide"],
    [tabHistory, viewHistory, "history"],
    [tabSetup, viewSetup, "setup"],
  ]) {
    const active = key === tabName;
    btn.classList.toggle("active", active);
    view.classList.toggle("hidden", !active);
  }
  if (tabName === "guide") renderGuide();
  if (tabName === "history") renderSplitsTable();
}

tabHud.addEventListener("click", () => switchTab("hud"));
tabGuide.addEventListener("click", () => switchTab("guide"));
tabHistory.addEventListener("click", () => switchTab("history"));
tabSetup.addEventListener("click", () => switchTab("setup"));

applyCodecBtn.addEventListener("click", () => {
  localStorage.setItem("ms_codec_url", codecInput.value.trim());
  initCodecWasm();
});

pipBtn.addEventListener("click", togglePipOverlay);

manualLevelInput.addEventListener("change", () => {
  const lv = Math.max(1, Math.min(200, Number(manualLevelInput.value) || 1));
  state.level = lv;
  manualLevelInput.value = String(lv);
  guideLevelInput.value = String(lv);
  localStorage.setItem("ms_char_level", String(lv));
  render();
});

guideLevelInput.addEventListener("input", renderGuide);
guideJobSelect.addEventListener("change", renderGuide);
guideSortSelect.addEventListener("change", renderGuide);
guideSearchInput.addEventListener("input", renderGuide);

exportSplitsBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.mapSplits, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `maplesprint-splits-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

clearSplitsBtn.addEventListener("click", () => {
  state.mapSplits = [];
  state.currentSplit = null;
  saveSplits();
  renderSplitsTable();
  renderGuide();
});

dbSourceSelect.addEventListener("change", () => {
  if (dbSourceSelect.value === "custom") {
    dbInput.hidden = false;
    dbInput.classList.remove("hidden");
    dbInput.focus();
    return;
  }
  dbInput.hidden = true;
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

function resetLocalState() {
  clearPendingKill();
  state.startTs = null;
  state.activeMs = 0;
  state.lastActiveTs = null;
  state.sessionExp = 0;
  state.lastExp = 0;
  state.kills = 0;
  state.lastMobId = null;
  state.mesos = 0;
  state.npcLootValue = 0;
  state.drops = 0;
  state.lastItemId = null;
  state.hp = null;
  state.mp = null;
  state.damageTaken = 0;
  state.damageDealt = 0;
  state.mapId = null;
  state.ch = null;
  state.events = 0;
  state.rawChunksReceived = 0;
  state.expWindow = [];
  state.currentSplit = null;
  if (codecEngine.decoder && typeof codecEngine.decoder.reset === "function") {
    codecEngine.decoder.reset();
  }
  feedEl.replaceChildren();
  mapLine.textContent = ws && ws.readyState === WebSocket.OPEN ? "Connected — waiting for WireGuard game traffic..." : "Not connected";
  render();
}

requireEl("resetBtn").addEventListener("click", async () => {
  resetLocalState();
  const base = workerInput.value.trim().replace(/\/+$/, "");
  const room = activeRoomId;
  if (base && room && room !== "local") {
    try {
      await fetch(`${base}/room/${encodeURIComponent(room)}`, { method: "DELETE" });
    } catch {}
  }
});

/** @type {WakeLockSentinel | null} */
let wakeLock = null;
let wakeWanted = localStorage.getItem("ms_wake") === "1";

function updateWakeUi() {
  const active = wakeLock !== null;
  wakeBtn.classList.toggle("active", active);
  wakeBtn.setAttribute("aria-pressed", String(active));
  wakeBtn.textContent = active ? "☀ Awake" : "☀ Wake";
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    wakeBtn.disabled = true;
    wakeBtn.title = "Screen Wake Lock unsupported in this browser";
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      updateWakeUi();
    });
  } catch {
    wakeLock = null;
  }
  updateWakeUi();
}

async function releaseWakeLock() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch {}
    wakeLock = null;
  }
  updateWakeUi();
}

if (!("wakeLock" in navigator)) {
  wakeBtn.disabled = true;
  wakeBtn.title = "Screen Wake Lock unsupported in this browser";
} else if (wakeWanted) {
  requestWakeLock();
}

wakeBtn.addEventListener("click", async () => {
  if (wakeLock) {
    wakeWanted = false;
    localStorage.setItem("ms_wake", "0");
    await releaseWakeLock();
  } else {
    wakeWanted = true;
    localStorage.setItem("ms_wake", "1");
    await requestWakeLock();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wakeWanted && !wakeLock) {
    requestWakeLock();
  }
});

setInterval(() => {
  if (state.startTs) render();
}, 1000);

setInterval(probeEndpointStatus, 5000);

initCodecWasm();
loadCatalog();
probeEndpointStatus();
if (workerInput.value.trim()) connect();
