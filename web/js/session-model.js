// @ts-check
"use strict";

import {
  AUTO_PAUSE_IDLE_MS,
  CLASSIC_EXP_TABLE,
  MAX_CLASSIC_LEVEL,
  ROLLING_WINDOW_MS,
  normalizeJobForLevel,
} from "./constants.js";

export const SESSION_CONFIG = Object.freeze({
  maxSplits: 50,
  killCorrelationMs: 500,
  minRollingSpanMs: 15_000,
  msPerHour: 3_600_000,
  defaultWgPort: 51820,
});

/**
 * Safely parses JSON from a `StorageLike` backend.
 * @template T
 * @param {import("./types.js").StorageLike | null} storage
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
export function loadJson(storage, key, fallback) {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    return raw ? /** @type {T} */ (JSON.parse(raw)) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Safely writes or removes JSON in a `StorageLike` backend.
 * @param {import("./types.js").StorageLike | null} storage
 * @param {string} key
 * @param {unknown} value
 */
export function saveJson(storage, key, value) {
  if (!storage) return;
  try {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {}
}

/**
 * Creates a clean `SessionState` record.
 * @param {number | string | null} savedLevel
 * @param {number | string | null} savedJob
 * @param {import("./types.js").MapSplit[]} savedSplits
 * @param {number} [defaultWgPort]
 * @returns {import("./types.js").SessionState}
 */
export function createSessionState(savedLevel, savedJob, savedSplits, defaultWgPort = SESSION_CONFIG.defaultWgPort) {
  const level = Math.min(MAX_CLASSIC_LEVEL, Math.max(1, Number(savedLevel) || 1));
  return {
    startTs: null,
    activeMs: 0,
    lastActiveTs: null,
    sessionExp: 0,
    lastExp: 0,
    totalExp: 0,
    level,
    job: normalizeJobForLevel(Number(savedJob) || 0, level),
    kills: 0,
    killsByMob: {},
    lastMobId: null,
    mesos: 0,
    npcLootValue: 0,
    drops: 0,
    dropsByItem: {},
    lastItemId: null,
    hp: null,
    mp: null,
    maxHp: null,
    maxMp: null,
    damageTaken: 0,
    damageDealt: 0,
    mapId: null,
    ch: null,
    events: 0,
    rawChunksReceived: 0,
    observedWgPort: defaultWgPort,
    expWindow: [],
    mapSplits: Array.isArray(savedSplits) ? savedSplits : [],
    currentSplit: null,
  };
}

/**
 * Owns live grinding telemetry state, map split tracking, and rate calculations.
 * Pure Model — zero DOM dependencies so it can be thoroughly unit-tested in Node.
 */
export class SessionModel {
  /**
   * @param {{
   *   storage?: import("./types.js").StorageLike | null,
   *   keys?: { level: string, job: string, splits: string },
   *   defaultWgPort?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    /** @type {import("./types.js").StorageLike | null} */
    this.storage = opts.storage ?? null;
    this.keys = opts.keys ?? {
      level: "ms_char_level",
      job: "ms_char_job",
      splits: "ms_map_splits",
    };
    this.defaultWgPort = opts.defaultWgPort ?? SESSION_CONFIG.defaultWgPort;
    /** @type {number | null} */
    this.pendingKillMobId = null;
    /** @type {number | null} */
    this.pendingKillTs = null;

    const savedSplits = loadJson(this.storage, this.keys.splits, /** @type {import("./types.js").MapSplit[]} */ ([]));
    const savedLevel = this.storage ? this.storage.getItem(this.keys.level) : null;
    const savedJob = this.storage ? this.storage.getItem(this.keys.job) : null;
    /** @type {import("./types.js").SessionState} */
    this.state = createSessionState(savedLevel, savedJob, Array.isArray(savedSplits) ? savedSplits : [], this.defaultWgPort);
  }

  saveSplits() {
    saveJson(this.storage, this.keys.splits, this.state.mapSplits.slice(0, SESSION_CONFIG.maxSplits));
  }

  /**
   * Updates character level and/or job while enforcing Classic World advancement level gates.
   * @param {number | null | undefined} level
   * @param {number | null | undefined} job
   * @returns {{ levelChanged: boolean, jobChanged: boolean }}
   */
  setCharacterProgression(level, job) {
    const prevLevel = this.state.level;
    const prevJob = this.state.job;
    if (typeof level === "number" && level >= 1 && level <= MAX_CLASSIC_LEVEL) {
      this.state.level = Math.floor(level);
      if (this.storage) this.storage.setItem(this.keys.level, String(this.state.level));
    }
    const rawJob = typeof job === "number" ? job : this.state.job;
    const validJob = normalizeJobForLevel(rawJob, this.state.level);
    if (typeof job === "number" || validJob !== this.state.job) {
      this.state.job = validJob;
      if (this.storage) this.storage.setItem(this.keys.job, String(this.state.job));
    }
    return {
      levelChanged: this.state.level !== prevLevel,
      jobChanged: this.state.job !== prevJob,
    };
  }

  clearPendingKill() {
    this.pendingKillMobId = null;
    this.pendingKillTs = null;
  }

  /**
   * Stages a map-wide mob kill ID for short-window correlation with our own `exp_gain`.
   * @param {number} mobId
   * @param {number} [now]
   */
  stagePendingKill(mobId, now = Date.now()) {
    this.pendingKillMobId = mobId;
    this.pendingKillTs = now;
  }

  /**
   * Returns staged pending kill ID only if still within `killCorrelationMs`.
   * @param {number} now
   * @returns {number | null}
   */
  consumePendingKill(now) {
    if (
      this.pendingKillMobId !== null &&
      this.pendingKillTs !== null &&
      now - this.pendingKillTs <= SESSION_CONFIG.killCorrelationMs
    ) {
      const id = this.pendingKillMobId;
      this.clearPendingKill();
      return id;
    }
    this.clearPendingKill();
    return null;
  }

  /**
   * Advances active grinding time if within `AUTO_PAUSE_IDLE_MS`.
   * @param {number} [ts]
   */
  recordActiveTime(ts = Date.now()) {
    if (!this.state.startTs) this.state.startTs = ts;
    if (this.state.lastActiveTs !== null) {
      const delta = ts - this.state.lastActiveTs;
      if (delta > 0 && delta <= AUTO_PAUSE_IDLE_MS) {
        this.state.activeMs += delta;
        if (this.state.currentSplit) this.state.currentSplit.active_ms += delta;
      }
    }
    this.state.lastActiveTs = ts;
  }

  /**
   * Returns current map split or creates a new one when map changes.
   * @param {number | null | undefined} mapId
   * @param {number | null | undefined} channel
   * @param {number} [ts]
   * @returns {import("./types.js").MapSplit | null}
   */
  ensureCurrentSplit(mapId, channel, ts = Date.now()) {
    if (mapId == null) return null;
    if (this.state.currentSplit && this.state.currentSplit.map_id === mapId) {
      if (channel != null) this.state.currentSplit.channel = channel;
      return this.state.currentSplit;
    }
    /** @type {import("./types.js").MapSplit} */
    const split = {
      map_id: mapId,
      channel: channel ?? this.state.ch ?? null,
      started_ts: ts,
      active_ms: 0,
      exp_gained: 0,
      kills: 0,
      mesos_gained: 0,
      drops: 0,
    };
    this.state.currentSplit = split;
    this.state.mapSplits.unshift(split);
    if (this.state.mapSplits.length > SESSION_CONFIG.maxSplits) {
      this.state.mapSplits.length = SESSION_CONFIG.maxSplits;
    }
    this.saveSplits();
    return split;
  }

  clearSplits() {
    this.state.mapSplits = [];
    this.state.currentSplit = null;
    this.saveSplits();
  }

  /**
   * Computes rolling 5-minute EXP/hr.
   * @param {number} [now]
   * @returns {number}
   */
  computeRolling5mXph(now = Date.now()) {
    const cutoff = now - ROLLING_WINDOW_MS;
    while (this.state.expWindow.length > 0 && this.state.expWindow[0].ts < cutoff) {
      this.state.expWindow.shift();
    }
    if (this.state.expWindow.length === 0) return 0;
    let sum = 0;
    for (const item of this.state.expWindow) sum += item.gain;
    const spanMs = Math.max(
      SESSION_CONFIG.minRollingSpanMs,
      Math.min(ROLLING_WINDOW_MS, now - this.state.expWindow[0].ts)
    );
    return Math.round((sum * SESSION_CONFIG.msPerHour) / spanMs);
  }

  /**
   * Computes current level progress bar percentage, EXP detail, and ETA.
   * @param {number} rateForEta
   * @returns {import("./types.js").LevelProgress}
   */
  computeLevelProgress(rateForEta) {
    const reqExp = CLASSIC_EXP_TABLE[this.state.level] || 0;
    if (this.state.level >= MAX_CLASSIC_LEVEL || reqExp <= 0) {
      return { pct: 100, pctLabel: "MAX", etaLabel: "Lv. Cap", expDetail: "Max Level" };
    }
    let pct = 0;
    let expDetail = `— / ${reqExp.toLocaleString()} EXP`;
    if (this.state.totalExp > 0) {
      const cur = Math.min(reqExp, this.state.totalExp);
      const rem = Math.max(0, reqExp - cur);
      pct = Math.min(99.99, Math.max(0, (cur / reqExp) * 100));
      expDetail = `${cur.toLocaleString()} / ${reqExp.toLocaleString()} (${rem.toLocaleString()} to Lv.${this.state.level + 1})`;
    } else if (this.state.sessionExp > 0) {
      const cur = this.state.sessionExp % reqExp;
      const rem = Math.max(0, reqExp - cur);
      pct = Math.min(99.99, Math.max(0, (cur / reqExp) * 100));
      expDetail = `~${rem.toLocaleString()} to Lv.${this.state.level + 1}`;
    }
    if (rateForEta <= 0) {
      return { pct, pctLabel: `${pct.toFixed(2)}%`, etaLabel: "ETA —", expDetail };
    }
    const curInLevel =
      this.state.totalExp > 0 ? Math.min(reqExp, this.state.totalExp) : this.state.sessionExp % reqExp;
    const minsLeft = (Math.max(0, reqExp - curInLevel) / rateForEta) * 60;
    const etaLabel =
      minsLeft < 1
        ? "ETA < 1m"
        : minsLeft < 60
        ? `ETA ${Math.ceil(minsLeft)}m`
        : `ETA ${Math.floor(minsLeft / 60)}h ${Math.round(minsLeft % 60)}m`;
    return { pct, pctLabel: `${pct.toFixed(2)}%`, etaLabel, expDetail };
  }

  /**
   * Computes current measured grinding rates (empty object if <15s active).
   * @param {number} [now]
   * @returns {import("./types.js").MeasuredRates}
   */
  computeMeasuredRates(now = Date.now()) {
    const isGrinding = this.state.lastActiveTs !== null && now - this.state.lastActiveTs <= AUTO_PAUSE_IDLE_MS;
    const pendingDelta = isGrinding && this.state.lastActiveTs ? Math.max(0, now - this.state.lastActiveTs) : 0;
    const effectiveActiveMs = this.state.activeMs + pendingDelta;
    if (!this.state.startTs || effectiveActiveMs < SESSION_CONFIG.minRollingSpanMs) return {};
    const activeSec = Math.max(effectiveActiveMs / 1000, 1);
    const rolling5m = this.computeRolling5mXph(now);
    const xph = rolling5m > 0 ? rolling5m : Math.max(0, Math.floor((this.state.sessionExp * 3600) / activeSec));
    return {
      xph,
      kpm: (this.state.kills * 60) / activeSec,
      mph: ((this.state.mesos + this.state.npcLootValue) * 3600) / activeSec,
      dpm: (this.state.drops * 60) / activeSec,
    };
  }

  /**
   * Soft-resets live sprint counters while preserving connection, HP/MP, level, job, totalExp, and map.
   * @param {number} [now]
   */
  softReset(now = Date.now()) {
    this.clearPendingKill();
    this.state.startTs = null;
    this.state.activeMs = 0;
    this.state.lastActiveTs = null;
    this.state.sessionExp = 0;
    this.state.lastExp = 0;
    this.state.kills = 0;
    this.state.killsByMob = {};
    this.state.lastMobId = null;
    this.state.mesos = 0;
    this.state.npcLootValue = 0;
    this.state.drops = 0;
    this.state.dropsByItem = {};
    this.state.lastItemId = null;
    this.state.damageTaken = 0;
    this.state.damageDealt = 0;
    this.state.events = 0;
    this.state.expWindow = [];
    this.state.currentSplit = null;
    if (this.state.mapId !== null) {
      this.ensureCurrentSplit(this.state.mapId, this.state.ch, now);
    }
  }

  /**
   * Full session reset (used by Setup's hard Reset button).
   */
  hardReset() {
    this.clearPendingKill();
    Object.assign(
      this.state,
      createSessionState(this.state.level, this.state.job, this.state.mapSplits, this.defaultWgPort)
    );
  }

  /**
   * Applies an `init` snapshot payload from the relay/server.
   * @param {import("./types.js").InitPayload} d
   * @param {number} [now]
   * @returns {{ levelChanged: boolean, jobChanged: boolean, splitsMerged: boolean }}
   */
  applyInit(d, now = Date.now()) {
    if (d.hp != null) this.state.hp = d.hp;
    if (d.mp != null) this.state.mp = d.mp;
    if (d.max_hp) this.state.maxHp = d.max_hp;
    if (d.max_mp) this.state.maxMp = d.max_mp;
    if (d.map_id != null) this.state.mapId = d.map_id;
    if (d.channel != null) this.state.ch = d.channel;
    if (d.total_exp) this.state.totalExp = d.total_exp;
    const prog = this.setCharacterProgression(d.level, d.job);

    if (typeof d.session_exp === "number" && d.session_exp > this.state.sessionExp) {
      this.state.sessionExp = d.session_exp;
      if (!this.state.startTs) this.state.startTs = d.session_start_ts || now;
    }
    if (typeof d.active_ms === "number" && d.active_ms > this.state.activeMs) this.state.activeMs = d.active_ms;
    if (typeof d.kills === "number" && d.kills > this.state.kills) this.state.kills = d.kills;
    if (typeof d.mesos === "number" && d.mesos > this.state.mesos) this.state.mesos = d.mesos;
    if (typeof d.drops === "number" && d.drops > this.state.drops) this.state.drops = d.drops;

    let splitsMerged = false;
    if (Array.isArray(d.map_splits)) {
      for (const s of d.map_splits) {
        if (!this.state.mapSplits.some((loc) => loc.map_id === s.map_id && loc.started_ts === s.started_ts)) {
          this.state.mapSplits.push(s);
          splitsMerged = true;
        }
      }
      if (splitsMerged) this.saveSplits();
    }
    if (this.state.mapId !== null) this.ensureCurrentSplit(this.state.mapId, this.state.ch, now);
    return { ...prog, splitsMerged };
  }

  /**
   * Processes a decoded telemetry event and returns structured UI side-effect descriptors.
   * @param {import("./types.js").TelemetryEvent} ev
   * @param {Pick<import("./types.js").CatalogData, "maps" | "mobs" | "items">} catalog
   * @returns {{
   *   feed: import("./types.js").FeedItemDescriptor[],
   *   mpDeltaText: string | null,
   *   splitUpdated: boolean,
   *   levelChanged: boolean,
   *   jobChanged: boolean,
   * }}
   */
  applyEvent(ev, catalog) {
    /** @type {import("./types.js").FeedItemDescriptor[]} */
    const feed = [];
    /** @type {string | null} */
    let mpDeltaText = null;
    let splitUpdated = false;
    let levelChanged = false;
    let jobChanged = false;

    if (!ev || !ev.type) {
      return { feed, mpDeltaText, splitUpdated, levelChanged, jobChanged };
    }
    const evTs = ev.ts || Date.now();

    if (ev.type === "mob_kill") {
      if (typeof ev.mob_id === "number") {
        this.stagePendingKill(ev.mob_id, evTs);
      }
      return { feed, mpDeltaText, splitUpdated, levelChanged, jobChanged };
    }

    if (ev.type === "exp_gain") {
      this.state.events++;
      const gain = Number(ev.gain) || 0;
      this.recordActiveTime(evTs);
      const mobId = typeof ev.mob_id === "number" ? ev.mob_id : this.consumePendingKill(evTs);
      if (gain > 0 && mobId !== null) {
        const mob = catalog.mobs[mobId];
        this.state.lastMobId = mobId;
        if (mob && typeof mob.hp === "number" && mob.hp > 0) {
          const dmg =
            ev.self_kill === true || !mob.exp ? mob.hp : Math.round(mob.hp * Math.min(1, gain / mob.exp));
          this.state.damageDealt += Math.max(0, dmg);
        }
        feed.push({
          text: `Killed ${mob ? `${mob.name} (Lv.${mob.level ?? "?"})` : `Mob #${mobId}`}`,
          category: "kills",
        });
        this.clearPendingKill();
      }
      this.state.sessionExp += gain;
      this.state.lastExp = gain;
      if (typeof ev.total_exp === "number") this.state.totalExp = ev.total_exp;
      if (gain > 0) {
        this.state.kills += 1;
        const mobKey = mobId ?? 0;
        const prev = this.state.killsByMob[mobKey] || { count: 0, exp: 0 };
        this.state.killsByMob[mobKey] = { count: prev.count + 1, exp: prev.exp + gain };
        this.state.expWindow.push({ ts: evTs, gain });
      }
      const split = this.ensureCurrentSplit(ev.map_id ?? this.state.mapId, this.state.ch, evTs);
      if (split) {
        split.exp_gained += gain;
        if (gain > 0) {
          split.kills += 1;
          if (!split.killsByMob) split.killsByMob = {};
          const mobKey = mobId ?? 0;
          const sPrev = split.killsByMob[mobKey] || { count: 0, exp: 0 };
          split.killsByMob[mobKey] = { count: sPrev.count + 1, exp: sPrev.exp + gain };
        }
        splitUpdated = true;
      }
      this.saveSplits();
      feed.push({
        text:
          ev.loss || gain < 0
            ? `EXP Loss: ${gain.toLocaleString()} EXP (Total: ${(ev.total_exp ?? 0).toLocaleString()})`
            : `+${gain.toLocaleString()} EXP (Total: ${(ev.total_exp ?? 0).toLocaleString()})`,
        category: "exp",
        major: Boolean(ev.loss || gain < 0),
      });
    } else if (ev.type === "char_stats") {
      this.state.events++;
      const prog = this.setCharacterProgression(ev.level, ev.job);
      levelChanged = prog.levelChanged;
      jobChanged = prog.jobChanged;
      if (ev.max_hp) this.state.maxHp = ev.max_hp;
      if (ev.max_mp) this.state.maxMp = ev.max_mp;
      if (typeof ev.total_exp === "number" && ev.total_exp >= 0) this.state.totalExp = ev.total_exp;
    } else if (ev.type === "hp_mp") {
      this.state.events++;
      if (ev.hp != null) this.state.hp = ev.hp;
      if (ev.mp != null) this.state.mp = ev.mp;
      if (ev.max_hp) this.state.maxHp = ev.max_hp;
      if (ev.max_mp) this.state.maxMp = ev.max_mp;
      if (ev.damage_taken || (typeof ev.mp_delta === "number" && ev.mp_delta < 0)) {
        this.recordActiveTime(evTs);
      }
      if (ev.damage_taken) {
        this.state.damageTaken += ev.damage_taken;
        feed.push({ text: `Took ${ev.damage_taken} dmg (HP ${ev.hp ?? "?"})`, category: "kills" });
      }
      if (ev.mp_delta) mpDeltaText = `${ev.mp_delta > 0 ? "+" : ""}${ev.mp_delta} MP`;
    } else if (ev.type === "map_change") {
      this.state.events++;
      if (ev.map_id != null) this.state.mapId = ev.map_id;
      if (ev.channel != null) this.state.ch = ev.channel;
      this.ensureCurrentSplit(ev.map_id, ev.channel, evTs);
      splitUpdated = true;
      const m = ev.map_id != null ? catalog.maps[ev.map_id] : null;
      feed.push({
        text: `Entered ${m ? m.name : `Map #${ev.map_id ?? "?"}`} (Ch. ${ev.channel ?? "?"})`,
        category: "general",
      });
    } else if (ev.type === "item_loot") {
      this.state.events++;
      this.recordActiveTime(evTs);
      const itemId = Number(ev.item_id) || 0;
      const qty = ev.qty || 1;
      this.state.drops += qty;
      this.state.dropsByItem[itemId] = (this.state.dropsByItem[itemId] || 0) + qty;
      this.state.lastItemId = itemId;
      const it = catalog.items[itemId];
      const npcPrice = it && typeof it.price === "number" ? it.price * qty : 0;
      this.state.npcLootValue += npcPrice;
      const split = this.ensureCurrentSplit(this.state.mapId, this.state.ch, evTs);
      if (split) {
        split.drops += qty;
        split.mesos_gained += npcPrice;
        splitUpdated = true;
      }
      this.saveSplits();
      feed.push({
        text: `Loot: ${it ? it.name : `Item #${itemId}`} x${qty}${npcPrice > 0 ? ` (+${npcPrice.toLocaleString()} NPC)` : ""}`,
        category: "drops",
      });
    } else if (ev.type === "meso_loot") {
      this.state.events++;
      const amount = Number(ev.amount) || 0;
      this.recordActiveTime(evTs);
      this.state.mesos += amount;
      const split = this.ensureCurrentSplit(this.state.mapId, this.state.ch, evTs);
      if (split) {
        split.mesos_gained += amount;
        splitUpdated = true;
      }
      this.saveSplits();
      feed.push({ text: `+${amount.toLocaleString()} mesos`, category: "mesos" });
    }

    return { feed, mpDeltaText, splitUpdated, levelChanged, jobChanged };
  }
}
