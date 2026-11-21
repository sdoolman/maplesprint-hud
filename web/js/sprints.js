// @ts-check
"use strict";

import { CLASSIC_EXP_TABLE, MAX_CLASSIC_LEVEL, escapeHtml, formatCompact, formatDuration } from "./constants.js";
import { loadJson, saveJson } from "./session-model.js";

export const SPRINT_CONFIG = Object.freeze({
  maxActiveChallenges: 3,
  longSessionMins: 60,
  msPerMin: 60_000,
  msPerHour: 3_600_000,
  weekMs: 7 * 86_400_000,
  maxHistory: 50,
  defaultXphFallback: 45_000,
  defaultKpmFallback: 12,
  defaultMphFallback: 35_000,
  defaultDpmFallback: 4,
});

/**
 * @typedef {object} SprintTemplate
 * @property {string} id
 * @property {string} name
 * @property {import("./types.js").SprintGoalType} type
 * @property {number} value
 * @property {import("./types.js").SprintPace} pace
 * @property {"exp_pct" | "kills" | "mesos" | "drops"} [secondaryType]
 * @property {number} [secondaryValue]
 * @property {import("./types.js").SprintCompoundRule} [compound]
 */

/** @type {readonly SprintTemplate[]} */
export const SPRINT_TEMPLATES = Object.freeze([
  { id: "tpl_exp_5", name: "+5% EXP Push", type: "exp_pct", value: 5, pace: "balanced" },
  { id: "tpl_time_30", name: "30m Focused Grind", type: "time", value: 30, pace: "balanced" },
  { id: "tpl_kills_150", name: "150 Monster Hunt", type: "kills", value: 150, pace: "balanced" },
  { id: "tpl_mesos_50k", name: "50k Meso Farm", type: "mesos", value: 50_000, pace: "relaxed" },
  { id: "tpl_drops_40", name: "40 Item Drops", type: "drops", value: 40, pace: "relaxed" },
  {
    id: "tpl_mix_quick",
    name: "Smart Mix (20m or +3% EXP)",
    type: "mix",
    value: 20,
    secondaryType: "exp_pct",
    secondaryValue: 3,
    compound: "any",
    pace: "balanced",
  },
]);

/**
 * Converts a requested "+X% EXP" target into exact absolute EXP across level boundaries.
 * @param {number} startLevel
 * @param {number} currentExpInLevel
 * @param {number} pctDelta
 * @returns {number}
 */
export function expForPercentDelta(startLevel, currentExpInLevel, pctDelta) {
  let lv = Math.max(1, Math.min(MAX_CLASSIC_LEVEL - 1, Math.floor(Number(startLevel) || 1)));
  let remPct = Math.max(0.1, Number(pctDelta) || 0);
  let curExp = Math.max(0, Number(currentExpInLevel) || 0);
  let totalNeeded = 0;

  while (remPct > 0.0001 && lv < MAX_CLASSIC_LEVEL) {
    const req = CLASSIC_EXP_TABLE[lv] || 0;
    if (req <= 0) break;
    const pctLeftInLv = Math.max(0, ((req - Math.min(req, curExp)) / req) * 100);
    if (remPct <= pctLeftInLv || lv >= MAX_CLASSIC_LEVEL - 1) {
      totalNeeded += Math.ceil((remPct / 100) * req);
      remPct = 0;
    } else {
      totalNeeded += Math.max(0, req - Math.min(req, curExp));
      remPct -= pctLeftInLv;
      lv += 1;
      curExp = 0;
    }
  }
  return Math.max(1, Math.round(totalNeeded));
}

/**
 * Creates a live target sprint object from builder inputs.
 * @param {{
 *   type?: import("./types.js").SprintGoalType,
 *   value?: number,
 *   level?: number,
 *   totalExp?: number,
 *   pace?: import("./types.js").SprintPace,
 *   compound?: import("./types.js").SprintCompoundRule,
 *   secondaryType?: "exp_pct" | "kills" | "mesos" | "drops",
 *   secondaryValue?: number,
 *   mobId?: number | string | null,
 *   mobName?: string | null,
 *   mapId?: number | string | null,
 *   mapName?: string | null,
 *   name?: string,
 * }} opts
 * @returns {import("./types.js").TargetSprint}
 */
export function createTargetSprint(opts) {
  /** @type {import("./types.js").SprintGoalType} */
  const type = opts.type || "exp_pct";
  const value = Math.max(1, Number(opts.value) || 1);
  const level = Math.max(1, Math.min(MAX_CLASSIC_LEVEL, Number(opts.level) || 1));
  const totalExp = Math.max(0, Number(opts.totalExp) || 0);
  /** @type {import("./types.js").SprintPace} */
  const pace = opts.pace || "balanced";
  /** @type {import("./types.js").SprintCompoundRule} */
  const compound = opts.compound === "any" ? "any" : "all";
  const mobId = opts.mobId != null && opts.mobId !== "" ? Number(opts.mobId) : null;
  const mobName = opts.mobName || null;
  const mapId = opts.mapId != null && opts.mapId !== "" ? Number(opts.mapId) : null;
  const mapName = opts.mapName || null;

  /**
   * @param {"exp_pct" | "time" | "kills" | "mesos" | "drops"} gType
   * @param {number} gVal
   * @returns {import("./types.js").SprintGoal}
   */
  const makeGoal = (gType, gVal) => {
    if (gType === "exp_pct") {
      return {
        type: "exp_pct",
        targetPct: gVal,
        targetExp: expForPercentDelta(level, totalExp, gVal),
        label: `+${gVal}% EXP`,
      };
    }
    if (gType === "time") {
      return { type: "time", targetMs: gVal * SPRINT_CONFIG.msPerMin, label: `${gVal} min active` };
    }
    if (gType === "kills") {
      return {
        type: "kills",
        targetKills: gVal,
        mobId,
        mobName,
        label: mobName ? `${gVal}× ${mobName}` : `${gVal} kills`,
      };
    }
    if (gType === "mesos") {
      return { type: "mesos", targetMesos: gVal, label: `${formatCompact(gVal)} mesos` };
    }
    return { type: "drops", targetDrops: gVal, label: `${gVal} drops` };
  };

  /** @type {import("./types.js").SprintGoal[]} */
  const goals = [makeGoal(type === "mix" ? "time" : type, value)];
  if (type === "mix") {
    const secType = opts.secondaryType || "exp_pct";
    const secVal = Math.max(1, Number(opts.secondaryValue) || 3);
    goals.push(makeGoal(secType, secVal));
  }

  const title =
    opts.name ||
    (goals.length > 1
      ? `${goals[0].label} ${compound === "any" ? "or" : "+"} ${goals[1].label}`
      : goals[0].label);

  return {
    id: `sp_${Date.now()}`,
    title,
    type,
    pace,
    compound,
    mapId,
    mapName,
    goals,
    startedAt: Date.now(),
    completed: false,
    completedAt: null,
  };
}

/**
 * Estimates completion duration and difficulty for a planned target sprint.
 * @param {import("./types.js").TargetSprint} sprint
 * @param {import("./types.js").MeasuredRates} [rates]
 * @returns {import("./types.js").SprintEstimate}
 */
export function estimateSession(sprint, rates = {}) {
  const xph = rates.xph && rates.xph > 0 ? rates.xph : SPRINT_CONFIG.defaultXphFallback;
  const kpm = rates.kpm && rates.kpm > 0 ? rates.kpm : SPRINT_CONFIG.defaultKpmFallback;
  const mph = rates.mph && rates.mph > 0 ? rates.mph : SPRINT_CONFIG.defaultMphFallback;
  const dpm = rates.dpm && rates.dpm > 0 ? rates.dpm : SPRINT_CONFIG.defaultDpmFallback;
  const hasMeasured = Boolean(
    (rates.xph && rates.xph > 0) ||
      (rates.kpm && rates.kpm > 0) ||
      (rates.mph && rates.mph > 0) ||
      (rates.dpm && rates.dpm > 0)
  );

  const minsPerGoal = sprint.goals.map((g) => {
    if (g.type === "exp_pct") return ((g.targetExp || 0) / xph) * 60;
    if (g.type === "time") return (g.targetMs || 0) / SPRINT_CONFIG.msPerMin;
    if (g.type === "kills") return (g.targetKills || 0) / kpm;
    if (g.type === "mesos") return ((g.targetMesos || 0) / mph) * 60;
    return (g.targetDrops || 0) / dpm;
  });

  const estMins =
    sprint.goals.length > 1 && sprint.compound === "any"
      ? Math.min(...minsPerGoal)
      : Math.max(...minsPerGoal);
  const roundedMins = Math.max(1, Math.round(estMins));
  /** @type {"Relaxed" | "Balanced" | "Ambitious"} */
  const difficulty = roundedMins <= 20 ? "Relaxed" : roundedMins <= 45 ? "Balanced" : "Ambitious";
  const suggestSplit = roundedMins > SPRINT_CONFIG.longSessionMins;
  return {
    estMins: roundedMins,
    difficulty,
    suggestSplit,
    splitHint: suggestSplit
      ? `Long session (~${roundedMins}m) — consider splitting into two ~${Math.round(roundedMins / 2)}m sprints.`
      : null,
    rateSource: hasMeasured ? "Measured pace" : "Default estimate (grind to calibrate)",
  };
}

/**
 * Evaluates live progress of the active target sprint against current HUD state.
 * @param {import("./types.js").TargetSprint | null} sprint
 * @param {Partial<import("./types.js").SessionState>} state
 * @param {number} effectiveActiveMs
 * @param {import("./types.js").MeasuredRates} [rates]
 * @returns {import("./types.js").SprintProgress | null}
 */
export function evaluateSprintProgress(sprint, state, effectiveActiveMs, rates = {}) {
  if (!sprint || !Array.isArray(sprint.goals) || sprint.goals.length === 0) return null;

  /** @type {import("./types.js").SubGoalProgress[]} */
  const subGoals = sprint.goals.map((g) => {
    let cur = 0;
    let target = 1;
    let curLabel = "0";
    let targetLabel = g.label;
    /** @type {number | null} */
    let remMins = null;

    if (g.type === "exp_pct") {
      cur = Math.max(0, state.sessionExp || 0);
      target = Math.max(1, g.targetExp || 1);
      curLabel = `${formatCompact(cur)} EXP`;
      targetLabel = `${formatCompact(target)} EXP (+${g.targetPct ?? 0}%)`;
      if (rates.xph && rates.xph > 0) remMins = (Math.max(0, target - cur) / rates.xph) * 60;
    } else if (g.type === "time") {
      cur = Math.max(0, effectiveActiveMs || 0);
      target = Math.max(1, g.targetMs || 1);
      curLabel = formatDuration(cur);
      targetLabel = formatDuration(target);
      remMins = Math.max(0, target - cur) / SPRINT_CONFIG.msPerMin;
    } else if (g.type === "kills") {
      cur =
        g.mobId != null
          ? Number(state.killsByMob?.[g.mobId]?.count || 0)
          : Math.max(0, state.kills || 0);
      target = Math.max(1, g.targetKills || 1);
      curLabel = `${cur}`;
      targetLabel = g.label;
      if (rates.kpm && rates.kpm > 0) remMins = Math.max(0, target - cur) / rates.kpm;
    } else if (g.type === "mesos") {
      cur = Math.max(0, (state.mesos || 0) + (state.npcLootValue || 0));
      target = Math.max(1, g.targetMesos || 1);
      curLabel = formatCompact(cur);
      targetLabel = `${formatCompact(target)} mesos`;
      if (rates.mph && rates.mph > 0) remMins = (Math.max(0, target - cur) / rates.mph) * 60;
    } else {
      cur = Math.max(0, state.drops || 0);
      target = Math.max(1, g.targetDrops || 1);
      curLabel = `${cur}`;
      targetLabel = `${target} drops`;
      if (rates.dpm && rates.dpm > 0) remMins = Math.max(0, target - cur) / rates.dpm;
    }

    const pct = Math.min(100, Math.max(0, (cur / target) * 100));
    return { ...g, cur, target, pct, done: cur >= target, curLabel, targetLabel, remMins };
  });

  const completed =
    sprint.compound === "any" ? subGoals.some((g) => g.done) : subGoals.every((g) => g.done);
  const pct =
    sprint.compound === "any"
      ? Math.max(...subGoals.map((g) => g.pct))
      : subGoals.reduce((acc, g) => acc + g.pct, 0) / subGoals.length;

  /** @type {number[]} */
  const validMins = [];
  for (const g of subGoals) {
    if (typeof g.remMins === "number" && Number.isFinite(g.remMins)) validMins.push(g.remMins);
  }
  let etaLabel = "ETA —";
  if (completed) {
    etaLabel = "Target Complete!";
  } else if (validMins.length > 0) {
    const mins = sprint.compound === "any" ? Math.min(...validMins) : Math.max(...validMins);
    etaLabel =
      mins < 1
        ? "ETA < 1m"
        : mins < 60
        ? `ETA ${Math.ceil(mins)}m`
        : `ETA ${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
  }

  return {
    pct,
    completed,
    etaLabel,
    summaryLabel: subGoals
      .map((g) => `${g.curLabel} / ${g.targetLabel}`)
      .join(sprint.compound === "any" ? " · OR · " : " · "),
    subGoals,
  };
}

/**
 * Measurable Challenge Library — strictly packet-trackable metrics (zero manual checkboxes).
 * @param {number} [level]
 * @param {import("./types.js").ChallengeMobContext} [ctx]
 * @returns {import("./types.js").ChallengeTemplate[]}
 */
export function buildChallengeLibrary(level = 25, ctx = {}) {
  const lv = Math.max(1, Math.min(MAX_CLASSIC_LEVEL, Number(level) || 25));
  const reqExp = CLASSIC_EXP_TABLE[lv] || 50_000;
  const exp3 = Math.max(500, Math.round(reqExp * 0.03));
  const exp5 = Math.max(1000, Math.round(reqExp * 0.05));
  const mobName = ctx.mobName || null;
  const mobId = ctx.mobId ?? null;

  /** @type {import("./types.js").ChallengeTemplate[]} */
  const list = [
    { id: "ch_exp_3", category: "EXP", title: "Gain +3% EXP", metric: "exp", target: exp3, unit: "EXP" },
    { id: "ch_exp_5", category: "EXP", title: "Gain +5% EXP", metric: "exp", target: exp5, unit: "EXP" },
    { id: "ch_kills_100", category: "Combat", title: "Slay 100 monsters", metric: "kills", target: 100, unit: "kills" },
    { id: "ch_kills_250", category: "Combat", title: "Slay 250 monsters", metric: "kills", target: 250, unit: "kills" },
  ];
  if (mobId != null && mobName) {
    list.push({
      id: `ch_mob_${mobId}`,
      category: "Combat",
      title: `Hunt 75× ${mobName}`,
      metric: "mob_kills",
      mobId,
      target: 75,
      unit: "kills",
    });
  }
  list.push(
    { id: "ch_mesos_25k", category: "Economy", title: "Earn 25,000 mesos (incl. NPC)", metric: "mesos", target: 25_000, unit: "mesos" },
    { id: "ch_mesos_75k", category: "Economy", title: "Earn 75,000 mesos (incl. NPC)", metric: "mesos", target: 75_000, unit: "mesos" },
    { id: "ch_drops_30", category: "Loot", title: "Collect 30 item drops", metric: "drops", target: 30, unit: "drops" },
    { id: "ch_explore_2", category: "Exploration", title: "Train across 2 hunting maps", metric: "maps", target: 2, unit: "maps" },
    { id: "ch_time_20", category: "Consistency", title: "20 min active grinding", metric: "active_mins", target: 20, unit: "min" },
    { id: "ch_sprints_3", category: "Consistency", title: "Complete 3 sprints this week", metric: "weekly_sprints", target: 3, unit: "sprints" },
    { id: "ch_special_1", category: "Special", title: "Gain 150 kills + 20 drops", metric: "kills_and_drops", target: 150, secondaryTarget: 20, unit: "kills" }
  );
  return list;
}

/**
 * Wraps a challenge template into an active tracked challenge.
 * @param {import("./types.js").ChallengeTemplate} tpl
 * @returns {import("./types.js").ActiveChallenge}
 */
function activateChallenge(tpl) {
  return { ...tpl, progress: 0, secondaryProgress: 0, completed: false, completedAt: null, visitedMaps: [] };
}

/**
 * Generates an initial balanced set of 3 active challenges.
 * @param {number} [level]
 * @param {import("./types.js").ChallengeMobContext} [ctx]
 * @returns {import("./types.js").ActiveChallenge[]}
 */
export function createDefaultChallenges(level = 25, ctx = {}) {
  const lib = buildChallengeLibrary(level, ctx);
  const picks = ["ch_exp_5", "ch_kills_100", "ch_mesos_25k"];
  /** @type {import("./types.js").ActiveChallenge[]} */
  const out = [];
  for (const id of picks) {
    const found = lib.find((c) => c.id === id);
    if (found) out.push(activateChallenge(found));
  }
  return out;
}

/**
 * Replaces one challenge slot with an unused candidate from the library.
 * @param {import("./types.js").ActiveChallenge[]} active
 * @param {string} replaceId
 * @param {number} [level]
 * @param {import("./types.js").ChallengeMobContext} [ctx]
 * @returns {import("./types.js").ActiveChallenge[]}
 */
export function rerollChallenge(active, replaceId, level = 25, ctx = {}) {
  const lib = buildChallengeLibrary(level, ctx);
  const usedIds = new Set(active.map((c) => c.id));
  const pool = lib.filter((c) => !usedIds.has(c.id));
  if (pool.length === 0) return active;
  const next = pool[Math.floor(Math.random() * pool.length)];
  return active.map((c) => (c.id === replaceId ? activateChallenge(next) : c));
}

/**
 * Synchronizes active challenge progress from current sprint state & returns newly completed challenges.
 * @param {import("./types.js").ActiveChallenge[]} challenges
 * @param {Partial<import("./types.js").SessionState>} state
 * @param {number} effectiveActiveMs
 * @param {number} [weeklySprintsCompleted]
 * @returns {import("./types.js").ActiveChallenge[]}
 */
export function syncChallengesWithState(challenges, state, effectiveActiveMs, weeklySprintsCompleted = 0) {
  /** @type {import("./types.js").ActiveChallenge[]} */
  const newlyCompleted = [];
  const mapsWithKills = new Set(
    (state.mapSplits || []).filter((s) => (s.kills || 0) > 0 && s.map_id != null).map((s) => s.map_id)
  );
  if (state.mapId != null && (state.kills || 0) > 0) mapsWithKills.add(state.mapId);

  for (const ch of challenges) {
    if (ch.completed) continue;
    if (ch.metric === "exp") ch.progress = Math.max(0, state.sessionExp || 0);
    else if (ch.metric === "kills") ch.progress = Math.max(0, state.kills || 0);
    else if (ch.metric === "mob_kills") ch.progress = ch.mobId != null ? Number(state.killsByMob?.[ch.mobId]?.count || 0) : 0;
    else if (ch.metric === "mesos") ch.progress = Math.max(0, (state.mesos || 0) + (state.npcLootValue || 0));
    else if (ch.metric === "drops") ch.progress = Math.max(0, state.drops || 0);
    else if (ch.metric === "maps") ch.progress = mapsWithKills.size;
    else if (ch.metric === "active_mins") ch.progress = Math.floor((effectiveActiveMs || 0) / SPRINT_CONFIG.msPerMin);
    else if (ch.metric === "weekly_sprints") ch.progress = weeklySprintsCompleted;
    else if (ch.metric === "kills_and_drops") {
      ch.progress = Math.max(0, state.kills || 0);
      ch.secondaryProgress = Math.max(0, state.drops || 0);
    }

    const done =
      ch.metric === "kills_and_drops"
        ? ch.progress >= ch.target && ch.secondaryProgress >= (ch.secondaryTarget || 1)
        : ch.progress >= ch.target;

    if (done) {
      ch.completed = true;
      ch.completedAt = Date.now();
      newlyCompleted.push(ch);
    }
  }
  return newlyCompleted;
}

/**
 * @param {import("./types.js").ActiveChallenge} ch
 * @returns {number}
 */
export function challengeProgressPct(ch) {
  if (ch.completed) return 100;
  if (ch.metric === "kills_and_drops") {
    const p1 = Math.min(100, (ch.progress / Math.max(1, ch.target)) * 100);
    const p2 = Math.min(100, ((ch.secondaryProgress || 0) / Math.max(1, ch.secondaryTarget || 1)) * 100);
    return (p1 + p2) / 2;
  }
  return Math.min(100, Math.max(0, (ch.progress / Math.max(1, ch.target)) * 100));
}

/**
 * @param {import("./types.js").ActiveChallenge} ch
 * @returns {string}
 */
export function challengeProgressText(ch) {
  if (ch.metric === "kills_and_drops") {
    return `${ch.progress}/${ch.target} kills · ${ch.secondaryProgress || 0}/${ch.secondaryTarget || 0} drops`;
  }
  const cur = ch.progress >= 1000 ? formatCompact(ch.progress) : String(ch.progress);
  const tgt = ch.target >= 1000 ? formatCompact(ch.target) : String(ch.target);
  return `${cur} / ${tgt} ${ch.unit || ""}`.trim();
}

/**
 * Renders the compact Active Challenges widget inside Live HUD.
 * @param {import("./types.js").ActiveChallenge[]} challenges
 * @returns {string}
 */
export function renderHudChallengesHtml(challenges) {
  if (!challenges || challenges.length === 0) {
    return `<div class="muted small">No active challenges — open Challenges to pin up to 3.</div>`;
  }
  return challenges
    .map((ch) => {
      const pct = challengeProgressPct(ch);
      return `<div class="hud-ch-item ${ch.completed ? "done" : ""}">
        <div class="hud-ch-top">
          <span class="hud-ch-title">${ch.completed ? "✓ " : ""}${escapeHtml(ch.title)}</span>
          <span class="hud-ch-val num">${escapeHtml(challengeProgressText(ch))}</span>
        </div>
        <div class="mini-track"><div class="mini-fill ${ch.completed ? "done" : ""}" style="width:${pct.toFixed(1)}%"></div></div>
      </div>`;
    })
    .join("");
}

/**
 * Renders the Challenges tab Active Board and Filterable Library.
 * @param {import("./types.js").ActiveChallenge[]} active
 * @param {import("./types.js").ChallengeTemplate[]} library
 * @param {string} [categoryFilter]
 * @returns {{ activeHtml: string, libHtml: string }}
 */
export function renderChallengesTabHtml(active, library, categoryFilter = "All") {
  const activeIds = new Set(active.map((c) => c.id));
  const activeHtml = active
    .map((ch) => {
      const pct = challengeProgressPct(ch);
      return `<article class="ch-card ${ch.completed ? "done" : ""}">
        <div class="ch-card-top">
          <div>
            <span class="ch-cat">${escapeHtml(ch.category)}</span>
            <h3>${ch.completed ? "✓ " : ""}${escapeHtml(ch.title)}</h3>
          </div>
          <div class="ch-actions">
            <span class="num ch-pct">${Math.round(pct)}%</span>
            <button class="pill wake" type="button" data-reroll-challenge="${escapeHtml(ch.id)}" title="Swap this challenge for another">↻ Reroll</button>
          </div>
        </div>
        <div class="progress-track"><div class="progress-fill ${ch.completed ? "done" : ""}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="ch-meta"><span>${escapeHtml(challengeProgressText(ch))}</span><span>${ch.completed ? "Completed" : "In Progress"}</span></div>
      </article>`;
    })
    .join("");

  const filteredLib = library.filter((c) => categoryFilter === "All" || c.category === categoryFilter);
  const libHtml = filteredLib
    .map((ch) => {
      const pinned = activeIds.has(ch.id);
      return `<div class="lib-row">
        <div>
          <span class="ch-cat">${escapeHtml(ch.category)}</span>
          <strong>${escapeHtml(ch.title)}</strong>
        </div>
        <button class="pill wake" type="button" data-pin-challenge="${escapeHtml(ch.id)}" ${pinned ? "disabled" : ""}>${pinned ? "Active" : "+ Pin"}</button>
      </div>`;
    })
    .join("");

  return { activeHtml, libHtml };
}

/**
 * Owns Target Sprint persistence, Sprint History, Active Challenges board, and Planned Map context.
 * Pure Model/Store — zero DOM dependencies so it can be unit-tested in Node.
 */
export class SprintStore {
  /**
   * @param {{
   *   storage?: import("./types.js").StorageLike | null,
   *   keys?: { activeSprint: string, challenges: string, sprintHistory: string },
   *   initialLevel?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    /** @type {import("./types.js").StorageLike | null} */
    this.storage = opts.storage ?? null;
    this.keys = opts.keys ?? {
      activeSprint: "ms_active_sprint_v1",
      challenges: "ms_challenges_v1",
      sprintHistory: "ms_sprint_history_v1",
    };

    /** @type {import("./types.js").TargetSprint | null} */
    this.activeSprint = loadJson(this.storage, this.keys.activeSprint, null);

    const savedHist = loadJson(this.storage, this.keys.sprintHistory, /** @type {import("./types.js").SprintHistoryEntry[]} */ ([]));
    /** @type {import("./types.js").SprintHistoryEntry[]} */
    this.sprintHistory = Array.isArray(savedHist) ? savedHist : [];

    const savedCh = loadJson(this.storage, this.keys.challenges, /** @type {import("./types.js").ActiveChallenge[] | null} */ (null));
    /** @type {import("./types.js").ActiveChallenge[]} */
    this.activeChallenges =
      Array.isArray(savedCh) && savedCh.length > 0
        ? savedCh.slice(0, SPRINT_CONFIG.maxActiveChallenges)
        : createDefaultChallenges(opts.initialLevel ?? 25);

    /** @type {import("./types.js").PlannedMapContext | null} */
    this.plannedMapContext = null;
  }

  /** @param {number} [now] */
  getWeeklySprintCount(now = Date.now()) {
    const cutoff = now - SPRINT_CONFIG.weekMs;
    return this.sprintHistory.filter((s) => (s.completedAt || 0) >= cutoff).length;
  }

  /** @param {import("./types.js").PlannedMapContext | null} ctx */
  setPlannedMapContext(ctx) {
    this.plannedMapContext = ctx;
  }

  /** @param {import("./types.js").TargetSprint} sprint */
  startSprint(sprint) {
    this.activeSprint = sprint;
    saveJson(this.storage, this.keys.activeSprint, this.activeSprint);
  }

  clearSprint() {
    this.activeSprint = null;
    saveJson(this.storage, this.keys.activeSprint, null);
  }

  /**
   * Clears any completed active sprint and resets in-progress sprint-scoped challenge progress.
   */
  resetForNewSprint() {
    if (this.activeSprint?.completed) {
      this.clearSprint();
    }
    for (const ch of this.activeChallenges) {
      if (!ch.completed && ch.metric !== "weekly_sprints") {
        ch.progress = 0;
        ch.secondaryProgress = 0;
      }
    }
    saveJson(this.storage, this.keys.challenges, this.activeChallenges);
  }

  /**
   * @param {string} replaceId
   * @param {number} level
   * @param {import("./types.js").ChallengeMobContext} [ctx]
   */
  rerollSlot(replaceId, level, ctx = {}) {
    this.activeChallenges = rerollChallenge(this.activeChallenges, replaceId, level, ctx);
    saveJson(this.storage, this.keys.challenges, this.activeChallenges);
  }

  /**
   * @param {number} level
   * @param {import("./types.js").ChallengeMobContext} [ctx]
   */
  rerollAll(level, ctx = {}) {
    const lib = buildChallengeLibrary(level, ctx);
    const shuffled = [...lib].sort(() => Math.random() - 0.5);
    this.activeChallenges = shuffled.slice(0, SPRINT_CONFIG.maxActiveChallenges).map(activateChallenge);
    saveJson(this.storage, this.keys.challenges, this.activeChallenges);
  }

  /**
   * Pins a challenge from the library into the active board (replacing a completed slot first).
   * @param {string} id
   * @param {number} level
   * @param {import("./types.js").ChallengeMobContext} [ctx]
   * @returns {boolean}
   */
  pinChallenge(id, level, ctx = {}) {
    if (this.activeChallenges.some((c) => c.id === id)) return false;
    const lib = buildChallengeLibrary(level, ctx);
    const pick = lib.find((c) => c.id === id);
    if (!pick) return false;
    const fresh = activateChallenge(pick);
    if (this.activeChallenges.length < SPRINT_CONFIG.maxActiveChallenges) {
      this.activeChallenges.push(fresh);
    } else {
      const doneIdx = this.activeChallenges.findIndex((c) => c.completed);
      this.activeChallenges[doneIdx >= 0 ? doneIdx : this.activeChallenges.length - 1] = fresh;
    }
    saveJson(this.storage, this.keys.challenges, this.activeChallenges);
    return true;
  }

  /**
   * Evaluates active sprint and synchronizes challenges against live session state.
   * @param {Partial<import("./types.js").SessionState>} sessionState
   * @param {number} effectiveActiveMs
   * @param {import("./types.js").MeasuredRates} rates
   * @param {number} [now]
   * @returns {{
   *   sprintProgress: import("./types.js").SprintProgress | null,
   *   sprintJustCompleted: import("./types.js").TargetSprint | null,
   *   newlyCompletedChallenges: import("./types.js").ActiveChallenge[],
   * }}
   */
  evaluateAndSync(sessionState, effectiveActiveMs, rates, now = Date.now()) {
    /** @type {import("./types.js").TargetSprint | null} */
    let sprintJustCompleted = null;
    const sprintProgress = this.activeSprint
      ? evaluateSprintProgress(this.activeSprint, sessionState, effectiveActiveMs, rates)
      : null;

    if (this.activeSprint && sprintProgress?.completed && !this.activeSprint.completed) {
      this.activeSprint.completed = true;
      this.activeSprint.completedAt = now;
      saveJson(this.storage, this.keys.activeSprint, this.activeSprint);
      this.sprintHistory.unshift({
        id: this.activeSprint.id,
        title: this.activeSprint.title,
        completedAt: now,
      });
      if (this.sprintHistory.length > SPRINT_CONFIG.maxHistory) {
        this.sprintHistory.length = SPRINT_CONFIG.maxHistory;
      }
      saveJson(this.storage, this.keys.sprintHistory, this.sprintHistory);
      sprintJustCompleted = this.activeSprint;
    }

    const newlyCompletedChallenges = syncChallengesWithState(
      this.activeChallenges,
      sessionState,
      effectiveActiveMs,
      this.getWeeklySprintCount(now)
    );
    if (newlyCompletedChallenges.length > 0) {
      saveJson(this.storage, this.keys.challenges, this.activeChallenges);
    }

    return { sprintProgress, sprintJustCompleted, newlyCompletedChallenges };
  }
}
