// @ts-check
"use strict";

import {
  AUTO_PAUSE_IDLE_MS,
  CLASSIC_EXP_TABLE,
  DEFAULT_DB,
  JOB_NAMES,
  MAX_CLASSIC_LEVEL,
  ROLLING_WINDOW_MS,
  base64ToBytes,
  formatCompact,
  formatDuration,
  requireEl,
} from "./constants.js";
import { fetchCatalog } from "./catalog.js";
import { ENDPOINT_CONFIG, EndpointClient, fetchWireGuardConf, probeEndpoint, sanitizeEndpointUrl } from "./endpoint.js";
import { renderGuideHtml, renderSplitsHtml } from "./guide.js";
import { PipOverlay } from "./pip.js";

const HUD_CONFIG = Object.freeze({
  maxFeedItems: 40,
  maxSplits: 50,
  killCorrelationMs: 500,
  renderIntervalMs: 1000,
  minRollingSpanMs: 15_000,
  defaultGuideLevel: 25,
  msPerHour: 3_600_000,
});

const STORAGE_KEYS = Object.freeze({
  endpoint: "ms_endpoint",
  legacyWorker: "ms_worker",
  db: "ms_db",
  splits: "ms_map_splits",
  level: "ms_char_level",
  job: "ms_char_job",
  wake: "ms_wake",
  codec: "ms_codec_url",
});

const endpointInput = /** @type {HTMLInputElement} */ (requireEl("endpointUrl"));
const connectBtn = /** @type {HTMLButtonElement} */ (requireEl("connectBtn"));
const dbSourceSelect = /** @type {HTMLSelectElement} */ (requireEl("dbSource"));
const downloadWgConfBtn = /** @type {HTMLButtonElement} */ (requireEl("downloadWgConfBtn"));
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
endpointInput.value =
  params.get("endpoint") ||
  params.get("worker") ||
  localStorage.getItem(STORAGE_KEYS.endpoint) ||
  localStorage.getItem(STORAGE_KEYS.legacyWorker) ||
  ENDPOINT_CONFIG.defaultUrl;

const pipOverlay = new PipOverlay(new URL("../css/pip.css?v=20261117h", import.meta.url).href);

function loadSavedSplits() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.splits);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSplits() {
  try {
    localStorage.setItem(STORAGE_KEYS.splits, JSON.stringify(state.mapSplits.slice(0, HUD_CONFIG.maxSplits)));
  } catch {}
}

const db = {
  /** @type {Record<number, any>} */ maps: {},
  /** @type {Record<number, any>} */ mobs: {},
  /** @type {Record<number, any>} */ items: {},
  loaded: false,
  /** @type {Array<any>} */ guideMaps: [],
};

function createSessionState(savedLevel, savedJob, savedSplits) {
  return {
    startTs: /** @type {number | null} */ (null),
    activeMs: 0,
    lastActiveTs: /** @type {number | null} */ (null),
    sessionExp: 0,
    lastExp: 0,
    totalExp: 0,
    level: Math.min(MAX_CLASSIC_LEVEL, Math.max(1, Number(savedLevel) || 1)),
    job: Number(savedJob) || 0,
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
    observedWgPort: ENDPOINT_CONFIG.defaultWgPort,
    /** @type {Array<{ ts: number, gain: number }>} */ expWindow: [],
    mapSplits: savedSplits,
    currentSplit: /** @type {any | null} */ (null),
  };
}

const state = createSessionState(
  localStorage.getItem(STORAGE_KEYS.level),
  localStorage.getItem(STORAGE_KEYS.job),
  loadSavedSplits()
);

function setCharacterProgression(level, job) {
  if (level >= 1 && level <= MAX_CLASSIC_LEVEL) {
    state.level = level;
    manualLevelInput.value = String(level);
    guideLevelInput.value = String(level);
    localStorage.setItem(STORAGE_KEYS.level, String(level));
  }
  if (job != null) {
    state.job = Number(job);
    localStorage.setItem(STORAGE_KEYS.job, String(state.job));
  }
}

manualLevelInput.value = String(state.level);
guideLevelInput.value = String(state.level > 1 ? state.level : HUD_CONFIG.defaultGuideLevel);

const codecEngine = {
  ready: false,
  /** @type {any} */
  decoder: null,
};

async function initCodec() {
  const customCodec = params.get("codec") || localStorage.getItem(STORAGE_KEYS.codec) || "";
  if (params.get("codec")) localStorage.setItem(STORAGE_KEYS.codec, customCodec);

  /** @type {string[]} */
  const candidates = [];
  if (customCodec.trim()) {
    const clean = customCodec.trim();
    candidates.push(clean.endsWith(".mjs") || clean.endsWith(".js") ? clean : `${clean.replace(/\/+$/, "")}/codec.mjs`);
  }
  candidates.push(new URL("../codec.mjs", import.meta.url).href);

  for (const url of candidates) {
    try {
      const mod = await import(url);
      if (typeof mod.MapleDecoder !== "function") continue;
      codecEngine.decoder = new mod.MapleDecoder();
      codecEngine.ready = true;
      wasmNodeDetail.textContent = "Ready";
      wasmNodeDetail.classList.add("online");
      return;
    } catch {
      // Try next candidate
    }
  }

  wasmNodeDetail.textContent = "Standby";
}

function ingestRawChunk(flow, seq, b64Data) {
  if (!codecEngine.ready || !codecEngine.decoder || !b64Data) return;
  const payload = base64ToBytes(b64Data);
  if (payload.length === 0) return;

  state.rawChunksReceived++;
  wgTunnelStatus.textContent = `Active (${state.rawChunksReceived.toLocaleString()} segs)`;
  wgTunnelStatus.classList.add("online");

  const events = codecEngine.decoder.feedChunk(flow, seq, payload);
  if (Array.isArray(events) && events.length > 0) {
    for (const ev of events) handleEvent(ev);
    render();
  }
}

function applyEndpointProbeUI(result) {
  if (result.invalid) {
    endpointStatusBadge.textContent = result.error;
    endpointStatusBadge.classList.remove("online");
    connectBtn.disabled = true;
    connectBtn.textContent = "Invalid URL";
    return;
  }
  if (result.ok && result.status) {
    const st = result.status;
    endpointStatusBadge.textContent = `ONLINE (${st.mode || "relay"})`;
    endpointStatusBadge.classList.add("online");
    connectBtn.disabled = false;
    connectBtn.textContent = endpointClient.isOpen() ? "Reconnect Endpoint" : "Connect Endpoint";
    connectBtn.title = "Connect to local endpoint WebSocket";
    if (typeof st.wg_port === "number" && st.wg_port > 0) {
      state.observedWgPort = st.wg_port;
      if (!state.rawChunksReceived && !(st.packets_relayed > 0)) {
        if (st.wg_handshake) {
          wgTunnelStatus.textContent = "Tunnel Ready (Launch game)";
          wgTunnelStatus.classList.add("online");
        } else {
          wgTunnelStatus.textContent = `Waiting (:${st.wg_port})`;
          wgTunnelStatus.classList.remove("online");
        }
      }
    }
    if (st.outbound_ip) outboundIpTag.textContent = `Outbound NIC: ${st.outbound_ip} (No-Loop)`;
    if (typeof st.packets_relayed === "number" && st.packets_relayed > 0) {
      wgTunnelStatus.textContent = `Active (${st.packets_relayed.toLocaleString()} pkts)`;
      wgTunnelStatus.classList.add("online");
    }
    return;
  }

  if (endpointClient.isOpen()) {
    endpointStatusBadge.textContent = "Connected (Active)";
    endpointStatusBadge.classList.add("online");
    connectBtn.disabled = false;
    connectBtn.textContent = "Reconnect Endpoint";
  } else {
    endpointStatusBadge.textContent = "Offline — Start relay";
    endpointStatusBadge.classList.remove("online");
    connectBtn.disabled = true;
    connectBtn.textContent = "Endpoint Offline";
    connectBtn.title = "Start the endpoint relay binary first";
  }
}

async function refreshEndpointStatus() {
  applyEndpointProbeUI(await probeEndpoint(endpointInput.value));
}

const endpointClient = new EndpointClient({
  onOpen() {
    statusDot.textContent = "LIVE";
    statusDot.className = "pill live";
    endpointStatusBadge.textContent = "ONLINE (Connected)";
    endpointStatusBadge.classList.add("online");
    if (state.mapId === null) mapLine.textContent = "Connected — waiting for WireGuard game traffic...";
  },
  onClose() {
    statusDot.textContent = "OFFLINE";
    statusDot.className = "pill offline";
    if (state.mapId === null) mapLine.textContent = "Not connected";
  },
  onError(reason) {
    statusDot.textContent = "ERROR";
    statusDot.className = "pill offline";
    endpointStatusBadge.textContent = reason;
    endpointStatusBadge.classList.remove("online");
  },
  onMessage(rawJson) {
    handleServerMessage(rawJson);
  },
});

function connectToEndpoint() {
  const check = sanitizeEndpointUrl(endpointInput.value);
  if (!check.ok) {
    endpointStatusBadge.textContent = check.error;
    endpointStatusBadge.classList.remove("online");
    return;
  }
  localStorage.setItem(STORAGE_KEYS.endpoint, check.httpBase);
  localStorage.setItem(STORAGE_KEYS.db, dbSourceSelect.value || DEFAULT_DB);
  refreshEndpointStatus();
  endpointClient.connect(check.httpBase);
}

downloadWgConfBtn.addEventListener("click", async () => {
  const text = await fetchWireGuardConf(endpointInput.value, state.observedWgPort);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "MapleSprint.conf";
  a.click();
});

async function loadCatalog() {
  const dbStatus = requireEl("dbStatus");
  dbStatus.textContent = "Loading...";
  try {
    const loaded = await fetchCatalog(dbSourceSelect.value || DEFAULT_DB);
    db.maps = loaded.maps;
    db.mobs = loaded.mobs;
    db.items = loaded.items;
    db.guideMaps = loaded.guideMaps;
    db.loaded = true;
    dbStatus.textContent = `${Object.keys(db.maps).length} maps · ${Object.keys(db.mobs).length} mobs · ${Object.keys(db.items).length} items`;
    render();
    renderGuide();
    renderSplitsTable();
  } catch {
    dbStatus.textContent = "DB error";
  }
}

function addFeed(text) {
  const li = document.createElement("li");
  const msgSpan = document.createElement("span");
  msgSpan.textContent = text;
  const tsSpan = document.createElement("span");
  tsSpan.className = "ts";
  tsSpan.textContent = new Date().toLocaleTimeString();
  li.append(msgSpan, tsSpan);
  feedEl.prepend(li);
  while (feedEl.children.length > HUD_CONFIG.maxFeedItems && feedEl.lastChild) {
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
  if (state.mapSplits.length > HUD_CONFIG.maxSplits) state.mapSplits.length = HUD_CONFIG.maxSplits;
  saveSplits();
  return split;
}

function computeRolling5mXph(now) {
  const cutoff = now - ROLLING_WINDOW_MS;
  while (state.expWindow.length > 0 && state.expWindow[0].ts < cutoff) {
    state.expWindow.shift();
  }
  if (state.expWindow.length === 0) return 0;
  let sum = 0;
  for (const item of state.expWindow) sum += item.gain;
  const spanMs = Math.max(HUD_CONFIG.minRollingSpanMs, Math.min(ROLLING_WINDOW_MS, now - state.expWindow[0].ts));
  return Math.round((sum * HUD_CONFIG.msPerHour) / spanMs);
}

function computeLevelProgress(rateForEta) {
  const reqExp = CLASSIC_EXP_TABLE[state.level] || 0;
  if (state.level >= MAX_CLASSIC_LEVEL || reqExp <= 0) {
    return { pct: 100, pctLabel: "MAX", etaLabel: "Lv. Cap" };
  }
  let pct = 0;
  if (state.totalExp > 0) {
    pct = Math.min(99.99, Math.max(0, (state.totalExp / reqExp) * 100));
  } else if (state.sessionExp > 0) {
    pct = Math.min(99.99, Math.max(0, ((state.sessionExp % reqExp) / reqExp) * 100));
  }
  if (rateForEta <= 0) {
    return { pct, pctLabel: `${pct.toFixed(2)}%`, etaLabel: "ETA —" };
  }
  const curInLevel = state.totalExp > 0 ? Math.min(reqExp, state.totalExp) : state.sessionExp % reqExp;
  const minsLeft = (Math.max(0, reqExp - curInLevel) / rateForEta) * 60;
  const etaLabel =
    minsLeft < 1
      ? "ETA < 1m"
      : minsLeft < 60
      ? `ETA ${Math.ceil(minsLeft)}m`
      : `ETA ${Math.floor(minsLeft / 60)}h ${Math.round(minsLeft % 60)}m`;
  return { pct, pctLabel: `${pct.toFixed(2)}%`, etaLabel };
}

function renderCombatAndVitals(activeSec) {
  killsEl.textContent = String(state.kills);
  if (state.lastMobId !== null) {
    const mob = db.mobs[state.lastMobId];
    lastMobEl.textContent = mob ? `${mob.name} (Lv.${mob.level ?? "?"})` : `Mob #${state.lastMobId}`;
  } else {
    lastMobEl.textContent = "No kills yet";
  }

  kpmEl.textContent = state.startTs ? ((state.kills * 60) / activeSec).toFixed(1) : "0.0";
  dpmEl.textContent =
    state.startTs && state.damageDealt > 0
      ? `${Math.round((state.damageDealt * 60) / activeSec).toLocaleString()} dmg/m`
      : "0 dmg/m";

  hpEl.textContent =
    state.hp !== null ? (state.maxHp ? `${state.hp.toLocaleString()}/${state.maxHp.toLocaleString()}` : String(state.hp)) : "--";
  hpSubEl.textContent = `${state.damageTaken.toLocaleString()} dmg taken`;

  mpEl.textContent =
    state.mp !== null ? (state.maxMp ? `${state.mp.toLocaleString()}/${state.maxMp.toLocaleString()}` : String(state.mp)) : "--";
}

function renderInventory(activeSec) {
  const netMesos = state.mesos + state.npcLootValue;
  mesosEl.textContent = netMesos.toLocaleString();
  npcValueTagEl.textContent = `NPC: +${formatCompact(state.npcLootValue)}`;
  mesoSubEl.textContent = state.startTs ? `${Math.round((netMesos * 3600) / activeSec).toLocaleString()} / hr` : "0 / hr";

  dropsEl.textContent = state.drops.toLocaleString();
  if (state.lastItemId !== null) {
    const it = db.items[state.lastItemId];
    dropSubEl.textContent = it ? it.name : `Item #${state.lastItemId}`;
  } else {
    dropSubEl.textContent = "No drops yet";
  }
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
    state.lastExp < 0 ? `${state.lastExp.toLocaleString()} (Death loss)` : `+${state.lastExp.toLocaleString()} last gain`;

  const xphVal = state.startTs ? Math.max(0, Math.floor((state.sessionExp * 3600) / activeSec)) : 0;
  const rolling5m = computeRolling5mXph(now);
  xphEl.textContent = xphVal.toLocaleString();
  xph5mEl.textContent = `5m: ${formatCompact(rolling5m)}/h`;
  elapsedEl.textContent = `${formatDuration(effectiveActiveMs)} active`;

  renderCombatAndVitals(activeSec);
  renderInventory(activeSec);

  charJobEl.textContent = JOB_NAMES[state.job] || `Job #${state.job}`;
  const prog = computeLevelProgress(rolling5m > 0 ? rolling5m : xphVal);
  levelPctEl.textContent = prog.pctLabel;
  levelProgressBar.style.width = `${prog.pct.toFixed(2)}%`;
  ttlEl.textContent = prog.etaLabel;

  let currentMapName = "";
  if (state.mapId !== null) {
    const m = db.maps[state.mapId];
    currentMapName = m ? m.name : `Map #${state.mapId}`;
    mapLine.textContent = `${m ? `${m.name} (${m.street})` : `Map #${state.mapId}`} • Ch. ${state.ch ?? "?"}`;
  }
  eventCountEl.textContent = `${state.events.toLocaleString()} events`;

  pipOverlay.update({
    xphVal,
    rolling5m,
    level: state.level,
    pct: prog.pct,
    etaText: prog.etaLabel,
    isGrinding,
    mapName: currentMapName,
  });
}

/** @type {number | null} */ let pendingKillMobId = null;
/** @type {number | null} */ let pendingKillTimer = null;

function clearPendingKill() {
  pendingKillMobId = null;
  if (pendingKillTimer !== null) {
    clearTimeout(pendingKillTimer);
    pendingKillTimer = null;
  }
}

/** @type {Record<string, (ev: any, evTs: number) => void>} */
const EVENT_HANDLERS = {
  exp_gain(ev, evTs) {
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
    addFeed(
      ev.loss || ev.gain < 0
        ? `EXP Loss: ${ev.gain.toLocaleString()} EXP (Total: ${(ev.total_exp ?? 0).toLocaleString()})`
        : `+${ev.gain.toLocaleString()} EXP (Total: ${(ev.total_exp ?? 0).toLocaleString()})`
    );
  },
  char_stats(ev) {
    setCharacterProgression(ev.level, ev.job);
    if (ev.max_hp) state.maxHp = ev.max_hp;
    if (ev.max_mp) state.maxMp = ev.max_mp;
  },
  hp_mp(ev) {
    if (ev.hp != null) state.hp = ev.hp;
    if (ev.mp != null) state.mp = ev.mp;
    if (ev.max_hp) state.maxHp = ev.max_hp;
    if (ev.max_mp) state.maxMp = ev.max_mp;
    if (ev.damage_taken) {
      state.damageTaken += ev.damage_taken;
      addFeed(`Took ${ev.damage_taken} dmg (HP ${ev.hp})`);
    }
    if (ev.mp_delta) mpSubEl.textContent = `${ev.mp_delta > 0 ? "+" : ""}${ev.mp_delta} MP`;
  },
  map_change(ev, evTs) {
    state.mapId = ev.map_id;
    state.ch = ev.channel;
    ensureCurrentSplit(ev.map_id, ev.channel, evTs);
    const m = db.maps[ev.map_id];
    addFeed(`Entered ${m ? m.name : `Map #${ev.map_id}`} (Ch. ${ev.channel})`);
    renderSplitsTable();
  },
  mob_kill(ev) {
    // Only stage the mob ID for correlation with our own subsequent exp_gain;
    // map-wide kill events fire for other players' kills on the same map too.
    clearPendingKill();
    pendingKillMobId = ev.mob_id;
    pendingKillTimer = window.setTimeout(clearPendingKill, HUD_CONFIG.killCorrelationMs);
  },
  item_loot(ev, evTs) {
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
  },
  meso_loot(ev, evTs) {
    recordActiveTime(evTs);
    state.mesos += ev.amount;
    const split = ensureCurrentSplit(state.mapId, state.ch, evTs);
    if (split) split.mesos_gained += ev.amount;
    saveSplits();
    addFeed(`+${ev.amount.toLocaleString()} mesos`);
  },
  mob_damage(ev, evTs) {
    recordActiveTime(evTs);
    if (ev.damage > 0) {
      state.damageDealt += ev.damage;
      const mob = ev.mob_id !== null ? db.mobs[ev.mob_id] : null;
      addFeed(`Hit ${mob ? mob.name : "mob"} for ${ev.damage}`);
    }
  },
  attack_hit(ev, evTs) {
    recordActiveTime(evTs);
    if (ev.damage > 0) state.damageDealt += ev.damage;
  },
};

function handleEvent(ev) {
  const fn = EVENT_HANDLERS[ev?.type];
  if (!fn) return;
  state.events++;
  fn(ev, ev.ts || Date.now());
}

function renderGuide() {
  const charLv = Math.max(
    1,
    Math.min(MAX_CLASSIC_LEVEL, Number(guideLevelInput.value) || state.level || HUD_CONFIG.defaultGuideLevel)
  );
  guideListEl.innerHTML = renderGuideHtml({
    loaded: db.loaded,
    guideMaps: db.guideMaps,
    mapSplits: state.mapSplits,
    charLv,
    jobFilter: guideJobSelect.value,
    sortBy: guideSortSelect.value,
    query: guideSearchInput.value,
  });
}

function renderSplitsTable() {
  splitsTableBody.innerHTML = renderSplitsHtml(state.mapSplits, db.maps);
}

function handleInitMessage(d) {
  if (d.hp != null) state.hp = d.hp;
  if (d.mp != null) state.mp = d.mp;
  if (d.max_hp) state.maxHp = d.max_hp;
  if (d.max_mp) state.maxMp = d.max_mp;
  if (d.map_id != null) state.mapId = d.map_id;
  if (d.channel != null) state.ch = d.channel;
  if (d.total_exp) state.totalExp = d.total_exp;
  setCharacterProgression(d.level, d.job);

  if (typeof d.session_exp === "number" && d.session_exp > state.sessionExp) {
    state.sessionExp = d.session_exp;
    if (!state.startTs) state.startTs = d.session_start_ts || Date.now();
  }
  if (typeof d.active_ms === "number" && d.active_ms > state.activeMs) state.activeMs = d.active_ms;
  if (typeof d.kills === "number" && d.kills > state.kills) state.kills = d.kills;
  if (typeof d.mesos === "number" && d.mesos > state.mesos) state.mesos = d.mesos;
  if (typeof d.drops === "number" && d.drops > state.drops) state.drops = d.drops;
  if (Array.isArray(d.map_splits)) {
    for (const s of d.map_splits) {
      if (!state.mapSplits.some((loc) => loc.map_id === s.map_id && loc.started_ts === s.started_ts)) {
        state.mapSplits.push(s);
      }
    }
    saveSplits();
    renderSplitsTable();
  }
  if (state.mapId !== null) ensureCurrentSplit(state.mapId, state.ch, Date.now());
  render();
}

function handleServerMessage(rawJson) {
  let msg;
  try {
    msg = JSON.parse(rawJson);
  } catch {
    return;
  }
  if (msg.type === "raw_chunk") {
    ingestRawChunk(msg.flow || "default", msg.seq || 0, msg.data || "");
    return;
  }
  if (msg.type === "endpoint_ready") {
    endpointStatusBadge.textContent = "ONLINE (Connected)";
    endpointStatusBadge.classList.add("online");
    return;
  }
  if (msg.type === "init" && msg.data) {
    handleInitMessage(msg.data);
  } else if (msg.type === "events") {
    for (const ev of msg.events || []) handleEvent(ev);
    render();
  } else if (msg.type) {
    handleEvent(msg);
    render();
  }
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
pipBtn.addEventListener("click", () => pipOverlay.toggle(render));

manualLevelInput.addEventListener("change", () => {
  const lv = Math.max(1, Math.min(MAX_CLASSIC_LEVEL, Number(manualLevelInput.value) || 1));
  setCharacterProgression(lv, null);
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
  localStorage.setItem(STORAGE_KEYS.db, dbSourceSelect.value || DEFAULT_DB);
  loadCatalog();
});

connectBtn.addEventListener("click", () => {
  if (Object.keys(db.mobs).length === 0) loadCatalog();
  connectToEndpoint();
});

requireEl("resetBtn").addEventListener("click", () => {
  clearPendingKill();
  Object.assign(state, createSessionState(state.level, state.job, state.mapSplits));
  if (codecEngine.decoder && typeof codecEngine.decoder.reset === "function") {
    codecEngine.decoder.reset();
  }
  feedEl.replaceChildren();
  mapLine.textContent = endpointClient.isOpen() ? "Connected — waiting for WireGuard game traffic..." : "Not connected";
  render();
});

/** @type {WakeLockSentinel | null} */ let wakeLock = null;
let wakeWanted = localStorage.getItem(STORAGE_KEYS.wake) === "1";

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
    localStorage.setItem(STORAGE_KEYS.wake, "0");
    await releaseWakeLock();
  } else {
    wakeWanted = true;
    localStorage.setItem(STORAGE_KEYS.wake, "1");
    await requestWakeLock();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wakeWanted && !wakeLock) requestWakeLock();
});

setInterval(() => {
  if (state.startTs) render();
}, HUD_CONFIG.renderIntervalMs);

setInterval(refreshEndpointStatus, ENDPOINT_CONFIG.probeIntervalMs);

initCodec();
loadCatalog();
refreshEndpointStatus();
if (endpointInput.value.trim()) connectToEndpoint();
