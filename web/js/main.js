// @ts-check
"use strict";

import {
  AUTO_PAUSE_IDLE_MS,
  DEFAULT_DB,
  JOB_NAMES,
  MAX_CLASSIC_LEVEL,
  base64ToBytes,
  eligibleJobsForLevel,
  formatCompact,
  formatDuration,
  requireEl,
} from "./constants.js";
import { fetchCatalog } from "./catalog.js";
import { ENDPOINT_CONFIG, EndpointClient, fetchWireGuardConf, probeEndpoint, sanitizeEndpointUrl } from "./endpoint.js";
import { FeedView, ToastView } from "./feed-view.js";
import { renderGuideHtml, renderSplitsHtml } from "./guide.js";
import { PipOverlay } from "./pip.js";
import { SessionModel } from "./session-model.js";
import {
  SPRINT_TEMPLATES,
  SprintStore,
  buildChallengeLibrary,
  createTargetSprint,
  estimateSession,
  renderChallengesTabHtml,
  renderHudChallengesHtml,
} from "./sprints.js";

const HUD_CONFIG = Object.freeze({
  maxFeedItems: 60,
  renderIntervalMs: 1000,
  defaultGuideLevel: 25,
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
  activeSprint: "ms_active_sprint_v1",
  challenges: "ms_challenges_v1",
  sprintHistory: "ms_sprint_history_v1",
});

/** @type {Record<string, string>} */
const SPRINT_TYPE_LABELS = {
  exp_pct: "TARGET VALUE (% EXP)",
  time: "TARGET MINUTES",
  kills: "TARGET KILLS",
  mesos: "TARGET MESOS",
  drops: "TARGET DROPS",
  mix: "PRIMARY TIME (MIN)",
};

// --- DOM Bindings ---
const endpointInput = /** @type {HTMLInputElement} */ (requireEl("endpointUrl"));
const connectBtn = /** @type {HTMLButtonElement} */ (requireEl("connectBtn"));
const dbSourceSelect = /** @type {HTMLSelectElement} */ (requireEl("dbSource"));
const downloadWgConfBtn = /** @type {HTMLButtonElement} */ (requireEl("downloadWgConfBtn"));
const wgTunnelStatus = requireEl("wgTunnelStatus");
const endpointStatusBadge = requireEl("endpointStatusBadge");
const outboundIpTag = requireEl("outboundIpTag");
const wasmNodeDetail = requireEl("wasmNodeDetail");
const softResetBtn = /** @type {HTMLButtonElement} */ (requireEl("softResetBtn"));
const pipBtn = /** @type {HTMLButtonElement} */ (requireEl("pipBtn"));
const wakeBtn = /** @type {HTMLButtonElement} */ (requireEl("wakeBtn"));
const statusDot = requireEl("statusDot");
const grindStateBadge = requireEl("grindStateBadge");
const mapLine = requireEl("mapLine");
const feedEl = requireEl("feed");
const eventCountEl = requireEl("eventCount");

const tabHud = requireEl("tabHud");
const tabSessions = requireEl("tabSessions");
const tabChallenges = requireEl("tabChallenges");
const tabGuide = requireEl("tabGuide");
const tabHistory = requireEl("tabHistory");
const tabSetup = requireEl("tabSetup");
const viewHud = requireEl("viewHud");
const viewSessions = requireEl("viewSessions");
const viewChallenges = requireEl("viewChallenges");
const viewGuide = requireEl("viewGuide");
const viewHistory = requireEl("viewHistory");
const viewSetup = requireEl("viewSetup");
const toastContainer = requireEl("toastContainer");

const hudSprintTitle = requireEl("hudSprintTitle");
const hudSprintDetail = requireEl("hudSprintDetail");
const hudSprintEta = requireEl("hudSprintEta");
const hudPlanSprintBtn = /** @type {HTMLButtonElement} */ (requireEl("hudPlanSprintBtn"));
const hudClearSprintBtn = /** @type {HTMLButtonElement} */ (requireEl("hudClearSprintBtn"));
const hudSprintTrack = requireEl("hudSprintTrack");
const hudSprintBar = requireEl("hudSprintBar");
const hudManageChallengesBtn = /** @type {HTMLButtonElement} */ (requireEl("hudManageChallengesBtn"));
const hudChallengesList = requireEl("hudChallengesList");
const feedFiltersEl = requireEl("feedFilters");

const quickSprintBtn = /** @type {HTMLButtonElement} */ (requireEl("quickSprintBtn"));
const sprintMapContextEl = requireEl("sprintMapContext");
const sprintTemplatesRow = requireEl("sprintTemplatesRow");
const sprintTypeSelect = /** @type {HTMLSelectElement} */ (requireEl("sprintTypeSelect"));
const sprintValueLabel = requireEl("sprintValueLabel");
const sprintValueInput = /** @type {HTMLInputElement} */ (requireEl("sprintValueInput"));
const sprintMobField = requireEl("sprintMobField");
const sprintMobSelect = /** @type {HTMLSelectElement} */ (requireEl("sprintMobSelect"));
const sprintPaceSelect = /** @type {HTMLSelectElement} */ (requireEl("sprintPaceSelect"));
const sprintMixRow = requireEl("sprintMixRow");
const sprintCompoundMode = /** @type {HTMLSelectElement} */ (requireEl("sprintCompoundMode"));
const sprintSecondaryType = /** @type {HTMLSelectElement} */ (requireEl("sprintSecondaryType"));
const sprintSecondaryValue = /** @type {HTMLInputElement} */ (requireEl("sprintSecondaryValue"));
const sprintCalcEstimateEl = requireEl("sprintCalcEstimate");
const startSprintBtn = /** @type {HTMLButtonElement} */ (requireEl("startSprintBtn"));

const weeklySprintsTag = requireEl("weeklySprintsTag");
const rerollAllChallengesBtn = /** @type {HTMLButtonElement} */ (requireEl("rerollAllChallengesBtn"));
const challengesActiveList = requireEl("challengesActiveList");
const challengeCategoryFilter = /** @type {HTMLSelectElement} */ (requireEl("challengeCategoryFilter"));
const challengesLibraryList = requireEl("challengesLibraryList");

const manualLevelInput = /** @type {HTMLInputElement} */ (requireEl("manualLevelInput"));
const charJobEl = /** @type {HTMLSelectElement} */ (requireEl("charJob"));
const levelExpDetailEl = requireEl("levelExpDetail");
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
const killsBreakdownEl = requireEl("killsBreakdown");
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
const dropsBreakdownEl = requireEl("dropsBreakdown");

const guideLevelInput = /** @type {HTMLInputElement} */ (requireEl("guideLevel"));
const guideJobSelect = /** @type {HTMLSelectElement} */ (requireEl("guideJob"));
const guideSortSelect = /** @type {HTMLSelectElement} */ (requireEl("guideSort"));
const guideSearchInput = /** @type {HTMLInputElement} */ (requireEl("guideSearch"));
const guideListEl = requireEl("guideList");

const splitMinTimeSelect = /** @type {HTMLSelectElement} */ (requireEl("splitMinTime"));
const splitSortSelect = /** @type {HTMLSelectElement} */ (requireEl("splitSort"));
const splitSearchInput = /** @type {HTMLInputElement} */ (requireEl("splitSearch"));
const splitOnlyKillsCheck = /** @type {HTMLInputElement} */ (requireEl("splitOnlyKills"));
const splitsTableBody = requireEl("splitsTableBody");
const exportSplitsBtn = requireEl("exportSplitsBtn");
const clearSplitsBtn = requireEl("clearSplitsBtn");

// --- Models & Views ---
const params = new URLSearchParams(window.location.search);
endpointInput.value =
  params.get("endpoint") ||
  params.get("worker") ||
  localStorage.getItem(STORAGE_KEYS.endpoint) ||
  localStorage.getItem(STORAGE_KEYS.legacyWorker) ||
  ENDPOINT_CONFIG.defaultUrl;

const sessionModel = new SessionModel({
  storage: localStorage,
  keys: { level: STORAGE_KEYS.level, job: STORAGE_KEYS.job, splits: STORAGE_KEYS.splits },
  defaultWgPort: ENDPOINT_CONFIG.defaultWgPort,
});
const state = sessionModel.state;

const sprintStore = new SprintStore({
  storage: localStorage,
  keys: {
    activeSprint: STORAGE_KEYS.activeSprint,
    challenges: STORAGE_KEYS.challenges,
    sprintHistory: STORAGE_KEYS.sprintHistory,
  },
  initialLevel: state.level,
});

const feedView = new FeedView(feedEl, feedFiltersEl, HUD_CONFIG.maxFeedItems);
const toastView = new ToastView(toastContainer);
const pipOverlay = new PipOverlay(new URL("../css/pip.css?v=20261121c", import.meta.url).href);

/** @type {import("./types.js").CatalogData} */
const db = {
  maps: {},
  mobs: {},
  items: {},
  loaded: false,
  guideMaps: [],
};

// --- Character Level & Job Controls ---
/** @param {number} jobId */
function guideFilterForJob(jobId) {
  const id = Number(jobId) || 0;
  if (id >= 230 && id <= 232) return "cleric";
  if (id >= 210 && id <= 212) return "magician_fp";
  if (id >= 220 && id <= 222) return "magician_il";
  if (id >= 100 && id < 200) return "warrior";
  if (id >= 300 && id < 400) return "bowman";
  if (id >= 400 && id < 500) return "thief";
  return "all";
}

/** @param {number} [level] */
function populateJobSelect(level = state.level) {
  charJobEl.replaceChildren();
  for (const [id, name] of eligibleJobsForLevel(level)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    charJobEl.append(opt);
  }
}

/** @param {number} jobId */
function setJobSelectValue(jobId) {
  const val = String(Number(jobId) || 0);
  if (![...charJobEl.options].some((o) => o.value === val)) {
    if (Number(val) in JOB_NAMES) return;
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = `Job #${val}`;
    charJobEl.append(opt);
  }
  charJobEl.value = val;
}

/**
 * @param {number | null | undefined} level
 * @param {number | null | undefined} job
 */
function syncCharacterProgressionUI(level, job) {
  const { levelChanged } = sessionModel.setCharacterProgression(level, job);
  if (levelChanged) {
    manualLevelInput.value = String(state.level);
    guideLevelInput.value = String(state.level);
    populateJobSelect(state.level);
  }
  setJobSelectValue(state.job);
}

populateJobSelect(state.level);
setJobSelectValue(state.job);
manualLevelInput.value = String(state.level);
guideLevelInput.value = String(state.level > 1 ? state.level : HUD_CONFIG.defaultGuideLevel);

// --- Codec & Local Relay Endpoint ---
const codecEngine = {
  ready: false,
  /** @type {{ feedChunk: (flow: string, seq: number, data: Uint8Array) => import("./types.js").TelemetryEvent[], reset?: () => void } | null} */
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

/**
 * @param {string} flow
 * @param {number} seq
 * @param {string} b64Data
 */
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
  } else if (state.rawChunksReceived === 1 || state.mapId === null) {
    render();
  }
}

/** @param {Awaited<ReturnType<typeof probeEndpoint>>} result */
function applyEndpointProbeUI(result) {
  if (result.invalid) {
    endpointStatusBadge.textContent = result.error || "Invalid URL";
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
    renderSessionsPlanner();
    renderChallenges();
  } catch {
    dbStatus.textContent = "DB error";
  }
}

// --- HUD View Renderers ---
/**
 * @template T
 * @param {HTMLElement} container
 * @param {T[]} entries
 * @param {(entry: T) => string} formatEntry
 */
function renderBreakdownChips(container, entries, formatEntry) {
  container.replaceChildren();
  for (const entry of entries.slice(0, 4)) {
    const chip = document.createElement("span");
    chip.className = "breakdown-chip";
    chip.textContent = formatEntry(entry);
    container.append(chip);
  }
}

/** @param {number} activeSec */
function renderCombatAndVitals(activeSec) {
  killsEl.textContent = String(state.kills);
  if (state.lastMobId !== null) {
    const mob = db.mobs[state.lastMobId];
    lastMobEl.textContent = mob ? `${mob.name} (Lv.${mob.level ?? "?"})` : `Mob #${state.lastMobId}`;
  } else {
    lastMobEl.textContent = "No kills yet";
  }

  const mobEntries = Object.entries(state.killsByMob)
    .map(([id, info]) => ({ id: Number(id), count: info.count }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);
  renderBreakdownChips(killsBreakdownEl, mobEntries, (e) => {
    const mob = db.mobs[e.id];
    const label = mob ? mob.name : e.id === 0 ? "Other" : `Mob #${e.id}`;
    return `${label} ×${e.count}`;
  });

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

/** @param {number} activeSec */
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

  const dropEntries = Object.entries(state.dropsByItem)
    .map(([id, qty]) => ({ id: Number(id), qty: Number(qty) || 0 }))
    .filter((e) => e.qty > 0)
    .sort((a, b) => b.qty - a.qty);
  renderBreakdownChips(dropsBreakdownEl, dropEntries, (e) => {
    const it = db.items[e.id];
    return `${it ? it.name : `Item #${e.id}`} ×${e.qty}`;
  });
}

/** @returns {import("./types.js").ChallengeMobContext} */
function getChallengeMobContext() {
  if (sprintStore.plannedMapContext?.mobs?.length) {
    const top = sprintStore.plannedMapContext.mobs[0];
    return { mobId: top.id ?? null, mobName: top.name ?? null };
  }
  if (state.lastMobId != null && db.mobs[state.lastMobId]) {
    return { mobId: state.lastMobId, mobName: db.mobs[state.lastMobId].name };
  }
  return {};
}

function renderChallenges() {
  const lib = buildChallengeLibrary(state.level, getChallengeMobContext());
  const weeklyCount = sprintStore.getWeeklySprintCount();
  weeklySprintsTag.textContent = `${weeklyCount} sprint${weeklyCount === 1 ? "" : "s"} this week`;
  hudChallengesList.innerHTML = renderHudChallengesHtml(sprintStore.activeChallenges);
  if (!viewChallenges.classList.contains("hidden")) {
    const { activeHtml, libHtml } = renderChallengesTabHtml(
      sprintStore.activeChallenges,
      lib,
      challengeCategoryFilter.value || "All"
    );
    challengesActiveList.innerHTML = activeHtml;
    challengesLibraryList.innerHTML = libHtml;
  }
}

/**
 * @param {number} effectiveActiveMs
 * @param {import("./types.js").MeasuredRates} rates
 */
function renderActiveSprintAndChallenges(effectiveActiveMs, rates) {
  const { sprintProgress, sprintJustCompleted, newlyCompletedChallenges } = sprintStore.evaluateAndSync(
    state,
    effectiveActiveMs,
    rates
  );

  if (sprintStore.activeSprint && sprintProgress) {
    const mapSuffix = sprintStore.activeSprint.mapName ? ` @ ${sprintStore.activeSprint.mapName}` : "";
    hudSprintTitle.textContent = `${sprintStore.activeSprint.title}${mapSuffix}`;
    hudSprintDetail.textContent = sprintProgress.summaryLabel;
    hudSprintEta.textContent = sprintProgress.etaLabel;
    hudSprintTrack.classList.remove("hidden");
    hudClearSprintBtn.classList.remove("hidden");
    hudSprintBar.style.width = `${sprintProgress.pct.toFixed(1)}%`;
    hudSprintBar.classList.toggle("done", sprintProgress.completed);
    if (sprintJustCompleted) {
      toastView.show("🎯 Sprint Complete!", `${sprintJustCompleted.title}${mapSuffix}`);
      feedView.add(`Sprint Complete: ${sprintJustCompleted.title}${mapSuffix}`, "challenges", true);
    }
  } else {
    hudSprintTitle.textContent = "No target active";
    hudSprintDetail.textContent = "Plan a target session or start grinding freely.";
    hudSprintEta.textContent = "No target";
    hudSprintTrack.classList.add("hidden");
    hudClearSprintBtn.classList.add("hidden");
    hudSprintBar.style.width = "0%";
    hudSprintBar.classList.remove("done");
  }

  for (const ch of newlyCompletedChallenges) {
    toastView.show("🏆 Challenge Complete!", ch.title);
    feedView.add(`Challenge Complete: ${ch.title}`, "challenges", true);
  }
  renderChallenges();
}

function render() {
  const now = Date.now();
  const isGrinding = state.lastActiveTs !== null && now - state.lastActiveTs <= AUTO_PAUSE_IDLE_MS;
  if (isGrinding) {
    grindStateBadge.textContent = "ACTIVE";
    grindStateBadge.className = "pill active-state";
  } else if (state.startTs) {
    grindStateBadge.textContent = "PAUSED";
    grindStateBadge.className = "pill paused";
  } else {
    grindStateBadge.textContent = "STANDBY";
    grindStateBadge.className = "pill";
  }

  const pendingDelta = isGrinding && state.lastActiveTs ? Math.max(0, now - state.lastActiveTs) : 0;
  const effectiveActiveMs = state.activeMs + pendingDelta;
  const activeSec = Math.max(effectiveActiveMs / 1000, 1);

  sessionExpEl.textContent = state.sessionExp.toLocaleString();
  lastExpEl.textContent =
    state.lastExp < 0 ? `${state.lastExp.toLocaleString()} (Death loss)` : `+${state.lastExp.toLocaleString()} last gain`;

  const xphVal = state.startTs ? Math.max(0, Math.floor((state.sessionExp * 3600) / activeSec)) : 0;
  const rolling5m = sessionModel.computeRolling5mXph(now);
  xphEl.textContent = xphVal.toLocaleString();
  xph5mEl.textContent = `5m: ${formatCompact(rolling5m)}/h`;
  elapsedEl.textContent = `${formatDuration(effectiveActiveMs)} active`;

  renderCombatAndVitals(activeSec);
  renderInventory(activeSec);

  setJobSelectValue(state.job);
  const prog = sessionModel.computeLevelProgress(rolling5m > 0 ? rolling5m : xphVal);
  levelExpDetailEl.textContent = prog.expDetail;
  levelPctEl.textContent = prog.pctLabel;
  levelProgressBar.style.width = `${prog.pct.toFixed(2)}%`;
  ttlEl.textContent = prog.etaLabel;

  let currentMapName = "";
  if (state.mapId !== null) {
    const m = db.maps[state.mapId];
    currentMapName = m ? m.name : `Map #${state.mapId}`;
    mapLine.textContent = `${m ? `${m.name} (${m.street})` : `Map #${state.mapId}`} • Ch. ${state.ch ?? "?"}`;
  } else if (endpointClient.isOpen()) {
    mapLine.textContent =
      state.rawChunksReceived > 0
        ? `Live stream active (${state.rawChunksReceived.toLocaleString()} segs) — change map or Ch. to detect map`
        : "Connected — waiting for WireGuard game traffic...";
  } else {
    mapLine.textContent = "Not connected";
  }
  eventCountEl.textContent = `${state.events.toLocaleString()} events`;

  if (!viewHistory.classList.contains("hidden")) {
    const liveSplitMs =
      state.currentSplit && isGrinding ? (state.currentSplit.active_ms || 0) + pendingDelta : null;
    renderSplitsTable(liveSplitMs);
  }

  renderActiveSprintAndChallenges(effectiveActiveMs, {
    xph: rolling5m > 0 ? rolling5m : xphVal,
    kpm: state.startTs ? (state.kills * 60) / activeSec : 0,
    mph: state.startTs ? ((state.mesos + state.npcLootValue) * 3600) / activeSec : 0,
    dpm: state.startTs ? (state.drops * 60) / activeSec : 0,
  });

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

// --- Event Ingestion ---
/** @param {import("./types.js").TelemetryEvent} ev */
function handleEvent(ev) {
  const res = sessionModel.applyEvent(ev, db);
  if (res.levelChanged) {
    manualLevelInput.value = String(state.level);
    guideLevelInput.value = String(state.level);
    populateJobSelect(state.level);
  }
  if (res.levelChanged || res.jobChanged) setJobSelectValue(state.job);
  if (res.mpDeltaText) mpSubEl.textContent = res.mpDeltaText;
  for (const item of res.feed) feedView.add(item.text, item.category, Boolean(item.major));
  if (res.splitUpdated && !viewHistory.classList.contains("hidden")) renderSplitsTable();
}

/** @param {string} rawJson */
function handleServerMessage(rawJson) {
  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(rawJson);
  } catch {
    return;
  }
  if (msg.type === "raw_chunk") {
    ingestRawChunk(String(msg.flow || "default"), Number(msg.seq) || 0, String(msg.data || ""));
    return;
  }
  if (msg.type === "endpoint_ready") {
    endpointStatusBadge.textContent = "ONLINE (Connected)";
    endpointStatusBadge.classList.add("online");
    return;
  }
  if (msg.type === "init" && msg.data) {
    const res = sessionModel.applyInit(msg.data);
    if (res.levelChanged) {
      manualLevelInput.value = String(state.level);
      guideLevelInput.value = String(state.level);
      populateJobSelect(state.level);
    }
    setJobSelectValue(state.job);
    if (res.splitsMerged) renderSplitsTable();
    render();
  } else if (msg.type === "events") {
    for (const ev of msg.events || []) handleEvent(ev);
    render();
  } else if (msg.type) {
    handleEvent(msg);
    render();
  }
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

/** @param {number | null} [liveActiveMs] */
function renderSplitsTable(liveActiveMs = null) {
  splitsTableBody.innerHTML = renderSplitsHtml(state.mapSplits, db.maps, {
    mobsDb: db.mobs,
    minTimeSec: Number(splitMinTimeSelect.value) || 0,
    onlyKills: splitOnlyKillsCheck.checked,
    query: splitSearchInput.value,
    sortBy: splitSortSelect.value,
    activeStartedTs: state.currentSplit?.started_ts ?? null,
    liveActiveMs,
  });
}

// --- Sessions Planner Controller ---
function populateSprintMobOptions() {
  const prevVal = sprintMobSelect.value;
  sprintMobSelect.replaceChildren();
  const anyOpt = document.createElement("option");
  anyOpt.value = "";
  anyOpt.textContent = "Any monster";
  sprintMobSelect.append(anyOpt);

  /** @type {Array<{ id: number, name: string }>} */
  const mobs = [];
  /** @type {Set<number>} */
  const seen = new Set();
  /**
   * @param {number | null | undefined} id
   * @param {string | undefined} name
   */
  const addMob = (id, name) => {
    if (id == null || seen.has(Number(id))) return;
    seen.add(Number(id));
    mobs.push({ id: Number(id), name: name || `Mob #${id}` });
  };

  if (sprintStore.plannedMapContext?.mobs) {
    for (const m of sprintStore.plannedMapContext.mobs) addMob(m.id, m.name);
  }
  if (state.mapId != null) {
    const mapEntry = db.guideMaps.find((m) => (m.mapId ?? m.id) === state.mapId);
    if (mapEntry?.mobs) {
      for (const m of mapEntry.mobs) addMob(m.id, m.name);
    }
  }
  for (const idStr of Object.keys(state.killsByMob)) {
    const id = Number(idStr);
    if (id > 0) addMob(id, db.mobs[id]?.name);
  }

  for (const m of mobs) {
    const opt = document.createElement("option");
    opt.value = String(m.id);
    opt.textContent = m.name;
    sprintMobSelect.append(opt);
  }
  if ([...sprintMobSelect.options].some((o) => o.value === prevVal)) {
    sprintMobSelect.value = prevVal;
  }
}

function buildSprintDraftFromForm() {
  const type = /** @type {import("./types.js").SprintGoalType} */ (sprintTypeSelect.value || "exp_pct");
  const value = Math.max(1, Number(sprintValueInput.value) || 1);
  const mobId = type === "kills" && sprintMobSelect.value ? Number(sprintMobSelect.value) : null;
  const mobName = mobId != null ? sprintMobSelect.selectedOptions[0]?.textContent || db.mobs[mobId]?.name || null : null;
  const mapId = sprintStore.plannedMapContext?.mapId ?? state.mapId ?? null;
  const mapName =
    sprintStore.plannedMapContext?.name ?? (state.mapId != null ? db.maps[state.mapId]?.name || null : null);
  return createTargetSprint({
    type,
    value,
    level: state.level,
    totalExp: state.totalExp,
    pace: /** @type {import("./types.js").SprintPace} */ (sprintPaceSelect.value || "balanced"),
    compound: /** @type {import("./types.js").SprintCompoundRule} */ (sprintCompoundMode.value || "any"),
    secondaryType: /** @type {"exp_pct" | "kills" | "mesos" | "drops"} */ (sprintSecondaryType.value || "exp_pct"),
    secondaryValue: Math.max(1, Number(sprintSecondaryValue.value) || 3),
    mobId,
    mobName,
    mapId,
    mapName,
  });
}

function updateSprintCalculator() {
  const type = sprintTypeSelect.value || "exp_pct";
  sprintValueLabel.textContent = SPRINT_TYPE_LABELS[type] || "TARGET VALUE";
  sprintMobField.classList.toggle("hidden", type !== "kills");
  sprintMixRow.classList.toggle("hidden", type !== "mix");

  const draft = buildSprintDraftFromForm();
  const est = estimateSession(draft, sessionModel.computeMeasuredRates());
  sprintCalcEstimateEl.replaceChildren();

  const line1 = document.createElement("strong");
  line1.textContent = `Est. ~${est.estMins} min · ${est.difficulty} (${draft.title})`;
  const line2 = document.createElement("span");
  line2.className = "muted small";
  line2.textContent = est.splitHint ? `${est.rateSource} — ${est.splitHint}` : est.rateSource;
  sprintCalcEstimateEl.append(line1, line2);
}

function renderSessionsPlanner() {
  if (sprintTemplatesRow.children.length === 0) {
    for (const tpl of SPRINT_TEMPLATES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill wake";
      btn.textContent = tpl.name;
      btn.dataset.templateId = tpl.id;
      sprintTemplatesRow.append(btn);
    }
  }

  const ctx = sprintStore.plannedMapContext;
  if (ctx) {
    sprintMapContextEl.classList.remove("hidden");
    sprintMapContextEl.replaceChildren();
    const text = document.createElement("span");
    text.textContent = `Planned Map: ${ctx.name} (${ctx.mobs.map((m) => m.name).slice(0, 3).join(", ")})`;
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "pill wake";
    clearBtn.textContent = "✕ Clear Map";
    clearBtn.addEventListener("click", () => {
      sprintStore.setPlannedMapContext(null);
      renderSessionsPlanner();
    });
    sprintMapContextEl.append(text, clearBtn);
  } else {
    sprintMapContextEl.classList.add("hidden");
  }

  populateSprintMobOptions();
  updateSprintCalculator();
}

/** @param {import("./types.js").TargetSprint} sprint */
function launchTargetSprint(sprint) {
  softResetSprint();
  sprintStore.startSprint(sprint);
  toastView.show("🎯 Target Sprint Started", sprint.title);
  feedView.add(`Started Target Sprint: ${sprint.title}`, "challenges", true);
  render();
  switchTab("hud");
}

// --- Navigation & UI Event Wiring ---
/** @type {Array<[HTMLElement, HTMLElement, string]>} */
const TAB_ROUTES = [
  [tabHud, viewHud, "hud"],
  [tabSessions, viewSessions, "sessions"],
  [tabChallenges, viewChallenges, "challenges"],
  [tabGuide, viewGuide, "guide"],
  [tabHistory, viewHistory, "history"],
  [tabSetup, viewSetup, "setup"],
];

/** @param {string} tabName */
function switchTab(tabName) {
  for (const [btn, view, key] of TAB_ROUTES) {
    const active = key === tabName;
    btn.classList.toggle("active", active);
    view.classList.toggle("hidden", !active);
  }
  if (tabName === "sessions") renderSessionsPlanner();
  if (tabName === "challenges") renderChallenges();
  if (tabName === "guide") renderGuide();
  if (tabName === "history") renderSplitsTable();
}

tabHud.addEventListener("click", () => switchTab("hud"));
tabSessions.addEventListener("click", () => switchTab("sessions"));
tabChallenges.addEventListener("click", () => switchTab("challenges"));
tabGuide.addEventListener("click", () => switchTab("guide"));
tabHistory.addEventListener("click", () => switchTab("history"));
tabSetup.addEventListener("click", () => switchTab("setup"));
pipBtn.addEventListener("click", () => pipOverlay.toggle(render));

hudPlanSprintBtn.addEventListener("click", () => switchTab("sessions"));
hudManageChallengesBtn.addEventListener("click", () => switchTab("challenges"));
hudClearSprintBtn.addEventListener("click", () => {
  sprintStore.clearSprint();
  render();
});

sprintTemplatesRow.addEventListener("click", (ev) => {
  const target = ev.target instanceof Element ? ev.target : null;
  const btn = target?.closest("[data-template-id]");
  if (!btn) return;
  const tpl = SPRINT_TEMPLATES.find((t) => t.id === btn.getAttribute("data-template-id"));
  if (!tpl) return;
  sprintTypeSelect.value = tpl.type;
  sprintValueInput.value = String(tpl.value);
  sprintPaceSelect.value = tpl.pace || "balanced";
  if (tpl.type === "mix") {
    sprintCompoundMode.value = tpl.compound || "any";
    sprintSecondaryType.value = tpl.secondaryType || "exp_pct";
    sprintSecondaryValue.value = String(tpl.secondaryValue || 3);
  }
  updateSprintCalculator();
});

for (const ctrl of [
  sprintTypeSelect,
  sprintValueInput,
  sprintMobSelect,
  sprintPaceSelect,
  sprintCompoundMode,
  sprintSecondaryType,
  sprintSecondaryValue,
]) {
  ctrl.addEventListener("input", updateSprintCalculator);
  ctrl.addEventListener("change", updateSprintCalculator);
}

quickSprintBtn.addEventListener("click", () => {
  launchTargetSprint(
    createTargetSprint({
      type: "exp_pct",
      value: 5,
      level: state.level,
      totalExp: state.totalExp,
      mapId: sprintStore.plannedMapContext?.mapId ?? state.mapId ?? null,
      mapName:
        sprintStore.plannedMapContext?.name ?? (state.mapId != null ? db.maps[state.mapId]?.name || null : null),
    })
  );
});

startSprintBtn.addEventListener("click", () => {
  launchTargetSprint(buildSprintDraftFromForm());
});

guideListEl.addEventListener("click", (ev) => {
  const target = ev.target instanceof Element ? ev.target : null;
  const btn = target?.closest("[data-plan-map-id]");
  if (!btn) return;
  const mapId = Number(btn.getAttribute("data-plan-map-id"));
  const entry = db.guideMaps.find((m) => (m.mapId ?? m.id) === mapId);
  if (!entry) return;
  sprintStore.setPlannedMapContext({ mapId: entry.mapId ?? mapId, name: entry.name, mobs: entry.mobs || [] });
  switchTab("sessions");
});

challengesActiveList.addEventListener("click", (ev) => {
  const target = ev.target instanceof Element ? ev.target : null;
  const btn = target?.closest("[data-reroll-challenge]");
  if (!btn) return;
  const id = btn.getAttribute("data-reroll-challenge");
  if (!id) return;
  sprintStore.rerollSlot(id, state.level, getChallengeMobContext());
  renderChallenges();
});

challengesLibraryList.addEventListener("click", (ev) => {
  const target = ev.target instanceof Element ? ev.target : null;
  const btn = target?.closest("[data-pin-challenge]");
  if (!btn) return;
  const id = btn.getAttribute("data-pin-challenge");
  if (!id) return;
  sprintStore.pinChallenge(id, state.level, getChallengeMobContext());
  renderChallenges();
});

rerollAllChallengesBtn.addEventListener("click", () => {
  sprintStore.rerollAll(state.level, getChallengeMobContext());
  renderChallenges();
});

challengeCategoryFilter.addEventListener("change", renderChallenges);

manualLevelInput.addEventListener("change", () => {
  const lv = Math.max(1, Math.min(MAX_CLASSIC_LEVEL, Number(manualLevelInput.value) || 1));
  syncCharacterProgressionUI(lv, null);
  render();
});

charJobEl.addEventListener("mousedown", () => {
  const lv = Math.max(1, Math.min(MAX_CLASSIC_LEVEL, Number(manualLevelInput.value) || 1));
  if (lv !== state.level) {
    syncCharacterProgressionUI(lv, null);
    render();
  }
});

charJobEl.addEventListener("change", () => {
  const jobId = Number(charJobEl.value) || 0;
  syncCharacterProgressionUI(null, jobId);
  guideJobSelect.value = guideFilterForJob(jobId);
  render();
  renderGuide();
});

guideLevelInput.addEventListener("input", renderGuide);
guideJobSelect.addEventListener("change", renderGuide);
guideSortSelect.addEventListener("change", renderGuide);
guideSearchInput.addEventListener("input", renderGuide);

splitMinTimeSelect.addEventListener("change", () => renderSplitsTable());
splitSortSelect.addEventListener("change", () => renderSplitsTable());
splitSearchInput.addEventListener("input", () => renderSplitsTable());
splitOnlyKillsCheck.addEventListener("change", () => renderSplitsTable());

function softResetSprint() {
  sessionModel.softReset();
  sprintStore.resetForNewSprint();
  feedView.clear();
  feedView.add("Started new sprint (live connection & character state preserved)", "general");
  renderSplitsTable();
  render();
}

softResetBtn.addEventListener("click", softResetSprint);

exportSplitsBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.mapSplits, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `maplesprint-splits-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

clearSplitsBtn.addEventListener("click", () => {
  sessionModel.clearSplits();
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
  sessionModel.hardReset();
  if (codecEngine.decoder && typeof codecEngine.decoder.reset === "function") {
    codecEngine.decoder.reset();
  }
  feedView.clear();
  mapLine.textContent = endpointClient.isOpen() ? "Connected — waiting for WireGuard game traffic..." : "Not connected";
  render();
});

// --- Wake Lock ---
/** @type {WakeLockSentinel | null} */
let wakeLock = null;
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

// --- Boot ---
setInterval(() => {
  if (state.startTs || state.rawChunksReceived > 0) render();
}, HUD_CONFIG.renderIntervalMs);

setInterval(refreshEndpointStatus, ENDPOINT_CONFIG.probeIntervalMs);

renderSessionsPlanner();
renderChallenges();
initCodec();
loadCatalog();
refreshEndpointStatus();
if (endpointInput.value.trim()) connectToEndpoint();
