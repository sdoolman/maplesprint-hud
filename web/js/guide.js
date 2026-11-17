// @ts-check
"use strict";

import { escapeHtml, formatCompact, formatDuration } from "./constants.js";

const MEOWDB_MAP_BASE = "https://meowdb.com/msclassic/maps/";
const HENESYS_MAP_BASE = "https://henesys.gg/maps/";

export const GUIDE_CONFIG = Object.freeze({
  minLevelDelta: -12,
  maxLevelDelta: 15,
  maxGuideResults: 24,
  maxSplitsRows: 30,
  minRecordedMs: 5000,
  minSplitXphMs: 3000,
  msPerHour: 3_600_000,
  idealLevelOffset: 1,
  idealLevelGrace: 1,
  maxLevelFitPts: 35,
  levelFitStepPenalty: 6,
  maxEfficiencyPts: 35,
  efficiencyScale: 2.5,
  maxDensityPts: 30,
  targetDensitySpawns: 45,
  clericBonusPts: 15,
  mageBonusPts: 12,
  warriorBonusPts: 12,
  warriorMinSpawns: 15,
  rangedBonusPts: 10,
  rangedMinExpPer100Hp: 10,
  highlightDensitySpawns: 20,
});

/** @param {Array<any>} splits @param {number} mapId @returns {number} */
export function recordedRateForMap(splits, mapId) {
  let totalExp = 0;
  let totalMs = 0;
  for (const s of splits) {
    if (s.map_id === mapId && s.exp_gained > 0 && s.active_ms >= GUIDE_CONFIG.minRecordedMs) {
      totalExp += s.exp_gained;
      totalMs += s.active_ms;
    }
  }
  if (totalMs < GUIDE_CONFIG.minRecordedMs) return 0;
  return Math.round((totalExp * GUIDE_CONFIG.msPerHour) / totalMs);
}

/**
 * Evaluates a map against transparent, bounded 0-100 suitability criteria defined in GUIDE_CONFIG.
 */
export function scoreMap(mapEntry, charLv, jobFilter) {
  const lvDiff = mapEntry.avgLevel - charLv;
  const distFromIdeal = Math.max(0, Math.abs(lvDiff - GUIDE_CONFIG.idealLevelOffset) - GUIDE_CONFIG.idealLevelGrace);
  const levelFit = Math.max(0, GUIDE_CONFIG.maxLevelFitPts - distFromIdeal * GUIDE_CONFIG.levelFitStepPenalty);

  const expPer100Hp = Number((mapEntry.avgRatio * 100).toFixed(1));
  const efficiency = Math.min(GUIDE_CONFIG.maxEfficiencyPts, Math.round(expPer100Hp * GUIDE_CONFIG.efficiencyScale));
  const density = Math.min(GUIDE_CONFIG.maxDensityPts, Math.round((mapEntry.totalSpawns / GUIDE_CONFIG.targetDensitySpawns) * GUIDE_CONFIG.maxDensityPts));

  let classBonus = 0;
  /** @type {string[]} */
  const affinityTags = [];

  if (jobFilter === "cleric") {
    if (mapEntry.hasUndead || mapEntry.hasHolyWeak) {
      classBonus = GUIDE_CONFIG.clericBonusPts;
      affinityTags.push("✨ Heal / Holy Weak (+50%)");
    } else {
      classBonus = -GUIDE_CONFIG.clericBonusPts;
    }
  } else if (jobFilter === "magician") {
    if (mapEntry.hasFireWeak || mapEntry.hasIceWeak || mapEntry.hasLightningWeak) {
      classBonus = GUIDE_CONFIG.mageBonusPts;
      affinityTags.push("🔥 Elemental Weak (+50%)");
    }
  } else if (jobFilter === "warrior") {
    if (mapEntry.totalSpawns >= GUIDE_CONFIG.warriorMinSpawns) {
      classBonus = GUIDE_CONFIG.warriorBonusPts;
      affinityTags.push("⚔️ High Spawn AoE");
    }
  } else if (jobFilter === "bowman" || jobFilter === "thief") {
    if (expPer100Hp >= GUIDE_CONFIG.rangedMinExpPer100Hp) {
      classBonus = GUIDE_CONFIG.rangedBonusPts;
      affinityTags.push("🎯 High EXP / HP");
    }
  } else {
    if (mapEntry.hasUndead) affinityTags.push("Undead / Cleric Friendly");
    if (mapEntry.totalSpawns >= GUIDE_CONFIG.highlightDensitySpawns) affinityTags.push("High Spawn Density");
  }

  const score = Math.max(1, Math.min(100, levelFit + efficiency + density + classBonus));
  return {
    lvDiff,
    score,
    expPer100Hp,
    affinityTags,
    parts: { levelFit, efficiency, density, classBonus, distFromIdeal },
  };
}

function matchesGuideFilter(m, charLv, query) {
  const lvDiff = m.avgLevel - charLv;
  if (!query) return lvDiff >= GUIDE_CONFIG.minLevelDelta && lvDiff <= GUIDE_CONFIG.maxLevelDelta;
  const hay = `${m.name} ${m.street} ${m.mobs.map((x) => x.name).join(" ")}`.toLowerCase();
  return hay.includes(query);
}

function sortGuideEntries(entries, sortBy) {
  entries.sort((a, b) => {
    if (sortBy === "recorded") return b.recordedXph - a.recordedXph || b.score - a.score;
    if (sortBy === "exp") return b.avgExp - a.avgExp;
    if (sortBy === "spawns") return b.totalSpawns - a.totalSpawns;
    return b.score - a.score || b.expPer100Hp - a.expPer100Hp;
  });
}

function buildMobChipsHtml(mobs) {
  return mobs
    .map(
      (mob) =>
        `<span class="mob-chip"><span class="mob-lv">Lv.${mob.level}</span> <strong>${escapeHtml(mob.name)}</strong> <span class="mob-exp">+${mob.exp.toLocaleString()} EXP</span> <span class="mob-hp">(${mob.hp.toLocaleString()} HP · ×${mob.count})</span></span>`
    )
    .join("");
}

function buildFitPopoverHtml(entry) {
  const p = entry.parts;
  const diffStr = entry.lvDiff > 0 ? `+${entry.lvDiff}` : `${entry.lvDiff}`;
  return `<div class="score-popover">
    <div class="score-row"><span>EXP / 100 HP (${entry.expPer100Hp})</span><span>+${p.efficiency}/${GUIDE_CONFIG.maxEfficiencyPts}</span></div>
    <div class="score-row"><span>Spawns (${entry.totalSpawns} mobs)</span><span>+${p.density}/${GUIDE_CONFIG.maxDensityPts}</span></div>
    <div class="score-row"><span>Level Fit (${diffStr} Lv)</span><span>+${p.levelFit}/${GUIDE_CONFIG.maxLevelFitPts}</span></div>
    <div class="score-row"><span>Class Synergy</span><span>${p.classBonus >= 0 ? "+" : ""}${p.classBonus}</span></div>
    <div class="score-row total"><span>Fit Rating</span><span>${entry.score}/100</span></div>
  </div>`;
}

function buildMapLinksHtml(mapId, safeMapName, shortHenesysLabel = false) {
  const meowUrl = `${MEOWDB_MAP_BASE}${String(mapId).padStart(9, "0")}`;
  const henesysUrl = `${HENESYS_MAP_BASE}${mapId}`;
  const henesysLabel = shortHenesysLabel ? "Henesys ↗" : "Henesys.gg ↗";
  return `<a class="hs-link" href="${meowUrl}" target="_blank" rel="noopener noreferrer" title="View ${safeMapName} on MeowDB">MeowDB ↗</a> <a class="hs-link" href="${henesysUrl}" target="_blank" rel="noopener noreferrer" title="View ${safeMapName} on Henesys.gg">${henesysLabel}</a>`;
}

function buildGuideCardHtml(entry, rankIndex) {
  const diffLabel = entry.lvDiff > 0 ? `+${entry.lvDiff}` : `${entry.lvDiff}`;
  const recBadge =
    entry.recordedXph > 0
      ? `<span class="badge recorded">⚡ Recorded: ${formatCompact(entry.recordedXph)} EXP/h</span>`
      : "";
  const affBadges = entry.affinityTags.map((t) => `<span class="badge affinity">${escapeHtml(t)}</span>`).join("");
  const safeName = escapeHtml(entry.name);

  return `
  <article class="guide-card">
    <div class="guide-card-top">
      <div>
        <div class="guide-map-title">
          <span>#${rankIndex + 1} · ${safeName}</span>
          ${buildMapLinksHtml(entry.mapId, safeName)}
        </div>
        <div class="guide-map-region">${escapeHtml(entry.street)} · Avg Lv. ${entry.avgLevel} (${diffLabel}) · ${entry.expPer100Hp} EXP/100 HP · ${entry.totalSpawns} spawns</div>
      </div>
      <div class="guide-badges">
        ${recBadge}
        ${affBadges}
        <div class="score-wrap" tabindex="0">
          <span class="badge score">Fit ${entry.score}/100 ⓘ</span>
          ${buildFitPopoverHtml(entry)}
        </div>
      </div>
    </div>
    <div class="guide-mobs">${buildMobChipsHtml(entry.mobs)}</div>
  </article>`;
}

/** @param {any} opts */
export function renderGuideHtml({ loaded, guideMaps, mapSplits, charLv, jobFilter, sortBy, query }) {
  if (!loaded || guideMaps.length === 0) {
    return `<div class="guide-card"><div class="guide-map-region">Loading OSMS map &amp; monster catalog…</div></div>`;
  }

  const normalizedQuery = (query || "").trim().toLowerCase();
  const ranked = [];
  for (const m of guideMaps) {
    if (!matchesGuideFilter(m, charLv, normalizedQuery)) continue;
    ranked.push({
      ...m,
      ...scoreMap(m, charLv, jobFilter),
      recordedXph: recordedRateForMap(mapSplits, m.mapId),
    });
  }
  sortGuideEntries(ranked, sortBy);

  const top = ranked.slice(0, GUIDE_CONFIG.maxGuideResults);
  if (top.length === 0) {
    return `<div class="guide-card"><div class="guide-map-region">No matching maps found for Lv. ${charLv}. Try clearing the search filter.</div></div>`;
  }
  return top.map((m, idx) => buildGuideCardHtml(m, idx)).join("");
}

/**
 * Renders Map Splits history table rows safely.
 * @param {Array<any>} mapSplits
 * @param {Record<number, any>} mapsDb
 */
export function renderSplitsHtml(mapSplits, mapsDb) {
  const rows = mapSplits.filter((s) => s.exp_gained > 0 || s.kills > 0 || s.map_id != null);
  if (rows.length === 0) {
    return `<tr><td colspan="7" class="empty-cell">No map splits recorded yet. Connect to your local endpoint to track map performance!</td></tr>`;
  }

  return rows
    .slice(0, GUIDE_CONFIG.maxSplitsRows)
    .map((s) => {
      const m = mapsDb[s.map_id];
      const mapName = m ? m.name : `Map #${s.map_id}`;
      const label = m ? (m.street ? `${m.name} (${m.street})` : m.name) : `Map #${s.map_id}`;
      const xph =
        s.active_ms >= GUIDE_CONFIG.minSplitXphMs
          ? Math.round((s.exp_gained * GUIDE_CONFIG.msPerHour) / s.active_ms)
          : 0;
      const safeLabel = escapeHtml(label);
      const chHtml = s.channel != null ? ` <span class="muted">(Ch. ${s.channel})</span>` : "";

      return `<tr title="${safeLabel} — Map #${s.map_id}">
        <td><strong>${safeLabel}</strong>${chHtml} ${buildMapLinksHtml(s.map_id, escapeHtml(mapName), true)}</td>
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
