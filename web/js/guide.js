// @ts-check
"use strict";

import { escapeHtml, formatCompact, formatDuration } from "./constants.js";

const MEOWDB_MAP_BASE = "https://meowdb.com/msclassic/maps/";
const HENESYS_MAP_BASE = "https://henesys.gg/maps/";

/** Configurable scoring weights & filter thresholds for Best Maps recommendations. */
export const GUIDE_CONFIG = Object.freeze({
  minLevelDelta: -4,
  maxLevelDelta: 4,
  maxGuideResults: 24,
  maxSplitsRows: 50,
  minRecordedMs: 5000,
  minSplitXphMs: 3000,
  msPerHour: 3_600_000,
  idealLevelOffset: 0,
  idealLevelGrace: 1,
  maxLevelFitPts: 35,
  levelFitStepPenalty: 7,
  efficiencyBestHpPerExp: 6,
  maxEfficiencyPts: 35,
  targetDensityMobsPerMPx: 18,
  fallbackDensitySpawns: 35,
  maxDensityPts: 30,
  clericWeakPts: 15,
  clericResistPts: -15,
  clericNeutralPts: -3,
  mageWeakPts: 12,
  mageResistPts: -12,
  warriorBonusPts: 12,
  warriorMinDensity: 8,
  warriorMinSpawns: 15,
  rangedBonusPts: 10,
  rangedMaxHpPerExp: 10,
  highlightDensityMobsPerMPx: 10,
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
 * Evaluates a map against configurable, bounded 0-100 suitability criteria defined in GUIDE_CONFIG.
 * Uses inverse HP/EXP efficiency (lower is better), spatial surface-area density, and dominant/resistant elemental synergy.
 */
export function scoreMap(mapEntry, charLv, jobFilter, cfg = GUIDE_CONFIG) {
  const lvDiff = mapEntry.avgLevel - charLv;
  const distFromIdeal = Math.max(0, Math.abs(lvDiff - cfg.idealLevelOffset) - cfg.idealLevelGrace);
  const levelFit = Math.max(0, cfg.maxLevelFitPts - distFromIdeal * cfg.levelFitStepPenalty);

  const avgHpPerExp =
    typeof mapEntry.avgHpPerExp === "number" && mapEntry.avgHpPerExp > 0
      ? mapEntry.avgHpPerExp
      : mapEntry.avgRatio > 0
      ? Number((1 / mapEntry.avgRatio).toFixed(2))
      : 30;
  const efficiency = Math.min(
    cfg.maxEfficiencyPts,
    Math.round(cfg.maxEfficiencyPts * (cfg.efficiencyBestHpPerExp / Math.max(0.1, avgHpPerExp)))
  );

  const hasSpatial = typeof mapEntry.spatialDensity === "number" && mapEntry.spatialDensity > 0;
  const effectiveMobs = mapEntry.effectiveMobs || mapEntry.totalSpawns || 0;
  const density = hasSpatial
    ? Math.min(cfg.maxDensityPts, Math.round((mapEntry.spatialDensity / cfg.targetDensityMobsPerMPx) * cfg.maxDensityPts))
    : Math.min(cfg.maxDensityPts, Math.round((effectiveMobs / cfg.fallbackDensitySpawns) * cfg.maxDensityPts));

  let classBonus = 0;
  /** @type {Array<{ label: string, tone: "pos" | "warn" | "neutral" }>} */
  const tags = [];

  if (jobFilter === "cleric") {
    if (mapEntry.hasHolyResist) {
      classBonus = cfg.clericResistPts;
      tags.push({ label: "Holy Resistant", tone: "warn" });
    } else if (mapEntry.dominantHolyWeak ?? (mapEntry.hasUndead || mapEntry.hasHolyWeak)) {
      classBonus = cfg.clericWeakPts;
      tags.push({ label: "Holy / Undead Weak", tone: "pos" });
    } else {
      classBonus = cfg.clericNeutralPts;
    }
  } else if (jobFilter === "magician_fp") {
    if (mapEntry.hasFpResist) {
      classBonus = cfg.mageResistPts;
      tags.push({ label: "Fire/Poison Resist", tone: "warn" });
    } else if (mapEntry.dominantFpWeak ?? (mapEntry.hasFireWeak || mapEntry.hasPoisonWeak)) {
      classBonus = cfg.mageWeakPts;
      tags.push({ label: "Fire / Poison Weak", tone: "pos" });
    }
  } else if (jobFilter === "magician_il") {
    if (mapEntry.hasIlResist) {
      classBonus = cfg.mageResistPts;
      tags.push({ label: "Ice/Lightning Resist", tone: "warn" });
    } else if (mapEntry.dominantIlWeak ?? (mapEntry.hasIceWeak || mapEntry.hasLightningWeak)) {
      classBonus = cfg.mageWeakPts;
      tags.push({ label: "Ice / Lightning Weak", tone: "pos" });
    }
  } else if (jobFilter === "magician") {
    const anyResist = Boolean(mapEntry.hasFpResist && mapEntry.hasIlResist);
    const anyWeak = Boolean(
      mapEntry.dominantFpWeak || mapEntry.dominantIlWeak || mapEntry.hasFireWeak || mapEntry.hasIceWeak || mapEntry.hasLightningWeak
    );
    if (anyResist) {
      classBonus = cfg.mageResistPts;
      tags.push({ label: "Elemental Resist", tone: "warn" });
    } else if (anyWeak) {
      classBonus = cfg.mageWeakPts;
      tags.push({ label: "Elemental Weak", tone: "pos" });
    }
  } else if (jobFilter === "warrior") {
    const highDensity = hasSpatial
      ? mapEntry.spatialDensity >= cfg.warriorMinDensity
      : effectiveMobs >= cfg.warriorMinSpawns;
    if (highDensity) {
      classBonus = cfg.warriorBonusPts;
      tags.push({ label: "High Spawn AoE", tone: "pos" });
    }
  } else if (jobFilter === "bowman" || jobFilter === "thief") {
    if (avgHpPerExp <= cfg.rangedMaxHpPerExp) {
      classBonus = cfg.rangedBonusPts;
      tags.push({ label: "Low HP/EXP", tone: "pos" });
    }
  } else {
    if (mapEntry.dominantHolyWeak ?? mapEntry.hasUndead) tags.push({ label: "Undead / Holy Weak", tone: "neutral" });
    const dense = hasSpatial
      ? mapEntry.spatialDensity >= cfg.highlightDensityMobsPerMPx
      : effectiveMobs >= cfg.highlightDensitySpawns;
    if (dense) tags.push({ label: "Compact Density", tone: "neutral" });
  }

  const reasons = [];
  if (avgHpPerExp <= 10) reasons.push(`Strong HP/EXP (${avgHpPerExp})`);
  else reasons.push(`${avgHpPerExp} HP/EXP`);
  if (hasSpatial) reasons.push(`${mapEntry.spatialDensity} mobs/Mpx²`);
  else reasons.push(`${effectiveMobs} spawns`);
  if (mapEntry.dominantMob?.name) reasons.push(`Main: ${mapEntry.dominantMob.name}`);

  const score = Math.max(1, Math.min(100, levelFit + efficiency + density + classBonus));
  return {
    lvDiff,
    score,
    avgHpPerExp,
    expPer100Hp: Number((100 / Math.max(0.1, avgHpPerExp)).toFixed(1)),
    reasonSummary: reasons.join(" · "),
    affinityTags: tags.map((t) => t.label),
    tags,
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
    if (sortBy === "hp_exp") return a.avgHpPerExp - b.avgHpPerExp || b.score - a.score;
    if (sortBy === "spawns") return (b.spatialDensity ?? b.totalSpawns) - (a.spatialDensity ?? a.totalSpawns);
    return b.score - a.score || a.avgHpPerExp - b.avgHpPerExp;
  });
}

function formatElemBadges(mob) {
  const parts = [];
  if (mob.undead) parts.push(`<span class="el-tag pos">Undead</span>`);
  for (const [el, eff] of Object.entries(mob.elements || {})) {
    if (eff === "Weak") parts.push(`<span class="el-tag pos">${escapeHtml(el)} Weak</span>`);
    else if (eff === "Strong" || eff === "Immune") parts.push(`<span class="el-tag warn">${escapeHtml(el)} ${escapeHtml(eff)}</span>`);
  }
  return parts.length > 0 ? parts.join(" ") : `<span class="muted">—</span>`;
}

function buildMobTableHtml(mobs) {
  const rows = mobs
    .map((mob) => {
      const hpExp = mob.hpPerExp ?? (mob.exp > 0 ? Number((mob.hp / mob.exp).toFixed(2)) : "—");
      return `<tr>
        <td><strong>${escapeHtml(mob.name)}</strong></td>
        <td class="num">Lv.${mob.level}</td>
        <td class="num accent">+${mob.exp.toLocaleString()}</td>
        <td class="num">${mob.hp.toLocaleString()}</td>
        <td class="num">${hpExp}</td>
        <td class="num">×${mob.count}</td>
        <td>${formatElemBadges(mob)}</td>
      </tr>`;
    })
    .join("");
  return `<div class="mob-table-wrap">
    <table class="mob-table">
      <thead>
        <tr>
          <th>Monster</th>
          <th class="num">Level</th>
          <th class="num">EXP</th>
          <th class="num">HP</th>
          <th class="num">HP/EXP</th>
          <th class="num">Spawns</th>
          <th>Elements</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function buildScoreBreakdownHtml(entry) {
  const p = entry.parts;
  const diffStr = entry.lvDiff > 0 ? `+${entry.lvDiff}` : `${entry.lvDiff}`;
  const spatialLine =
    entry.surfaceAreaMPx != null
      ? `${entry.effectiveMobs} mobs / ${entry.surfaceAreaMPx} Mpx² (${entry.widthPx}×${entry.heightPx}px)`
      : `${entry.effectiveMobs || entry.totalSpawns} spawns`;
  return `<div class="detail-metrics">
    <div class="detail-metric"><span>Level Fit (${diffStr} Lv)</span><strong class="num">${p.levelFit}/${GUIDE_CONFIG.maxLevelFitPts}</strong></div>
    <div class="detail-metric"><span>HP/EXP Efficiency (${entry.avgHpPerExp})</span><strong class="num">${p.efficiency}/${GUIDE_CONFIG.maxEfficiencyPts}</strong></div>
    <div class="detail-metric"><span>Spatial Density (${spatialLine})</span><strong class="num">${p.density}/${GUIDE_CONFIG.maxDensityPts}</strong></div>
    <div class="detail-metric"><span>Class Synergy</span><strong class="num">${p.classBonus >= 0 ? "+" : ""}${p.classBonus}</strong></div>
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
  const safeName = escapeHtml(entry.name);
  const topTags = (entry.tags || []).slice(0, 2);
  const pillsHtml = topTags
    .map((t) => `<span class="guide-pill ${t.tone}">${escapeHtml(t.label)}</span>`)
    .join("");
  const recBadge =
    entry.recordedXph > 0
      ? `<span class="guide-pill pos">Recorded ${formatCompact(entry.recordedXph)}/h</span>`
      : "";
  const scoreTone = entry.score >= 75 ? "high" : entry.score >= 55 ? "mid" : "low";
  const mobCountLabel = `${entry.mobs.length} mob ${entry.mobs.length === 1 ? "type" : "types"}`;

  return `
  <details class="guide-card">
    <summary class="guide-summary">
      <div class="guide-rank num">#${rankIndex + 1}</div>
      <div class="guide-main">
        <div class="guide-title-row">
          <span class="guide-map-name">${safeName}</span>
          <span class="guide-meta">${escapeHtml(entry.street)} · Avg Lv.${entry.avgLevel} (${diffLabel}) · ${mobCountLabel}</span>
        </div>
        <div class="guide-reason">${escapeHtml(entry.reasonSummary)}</div>
      </div>
      <div class="guide-tags">${recBadge}${pillsHtml}</div>
      <div class="guide-score-col">
        <div class="guide-score-val ${scoreTone} num">${entry.score}<span>/100</span></div>
        <div class="guide-score-bar"><div class="guide-score-fill ${scoreTone}" style="width:${entry.score}%"></div></div>
      </div>
      <span class="guide-chevron" aria-hidden="true">Details ▾</span>
    </summary>
    <div class="guide-details">
      ${buildScoreBreakdownHtml(entry)}
      ${buildMobTableHtml(entry.mobs)}
      <div class="guide-details-footer">
        <span class="muted small">Map #${entry.mapId}</span>
        <div class="guide-links">
          <button class="plan-sprint-btn" type="button" data-plan-map-id="${entry.mapId}">🎯 Plan Sprint Here</button>
          ${buildMapLinksHtml(entry.mapId, safeName)}
        </div>
      </div>
    </div>
  </details>`;
}

/** @param {any} opts */
export function renderGuideHtml({ loaded, guideMaps, mapSplits, charLv, jobFilter, sortBy, query }) {
  if (!loaded || guideMaps.length === 0) {
    return `<div class="guide-empty">Loading OSMS map &amp; monster catalog…</div>`;
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
    return `<div class="guide-empty">No matching maps found within ±${GUIDE_CONFIG.maxLevelDelta} levels of Lv. ${charLv}. Try searching by map or monster name.</div>`;
  }
  return top.map((m, idx) => buildGuideCardHtml(m, idx)).join("");
}

function formatSplitMobsHtml(killsByMob, mobsDb) {
  if (!killsByMob || typeof killsByMob !== "object") return `<span class="muted">—</span>`;
  const entries = Object.entries(killsByMob)
    .map(([id, info]) => ({ id: Number(id), count: Number(info?.count ?? info) || 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);
  if (entries.length === 0) return `<span class="muted">—</span>`;
  return entries
    .slice(0, 3)
    .map((e) => {
      const mob = mobsDb?.[e.id];
      const name = mob ? mob.name : e.id === 0 ? "Other" : `Mob #${e.id}`;
      return `<span class="split-mob-chip">${escapeHtml(name)} ×${e.count}</span>`;
    })
    .join(" ");
}

/**
 * Renders Map Splits history table rows safely with optional live active projection, filtering, and sorting.
 * @param {Array<any>} mapSplits
 * @param {Record<number, any>} mapsDb
 * @param {any} [opts]
 */
export function renderSplitsHtml(mapSplits, mapsDb, opts = {}) {
  const {
    mobsDb = {},
    minTimeSec = 0,
    onlyKills = false,
    onlyExp = false,
    query = "",
    sortBy = "recent",
    activeStartedTs = null,
    liveActiveMs = null,
  } = opts || {};

  const q = String(query || "").trim().toLowerCase();
  const minMs = Math.max(0, Number(minTimeSec) || 0) * 1000;

  const enriched = [];
  for (const s of mapSplits) {
    if (s.exp_gained <= 0 && s.kills <= 0 && s.map_id == null) continue;
    const isLive = activeStartedTs !== null && s.started_ts === activeStartedTs;
    const activeMs = isLive && typeof liveActiveMs === "number" ? Math.max(s.active_ms || 0, liveActiveMs) : s.active_ms || 0;
    const xph = activeMs >= GUIDE_CONFIG.minSplitXphMs ? Math.round(((s.exp_gained || 0) * GUIDE_CONFIG.msPerHour) / activeMs) : 0;
    const m = mapsDb[s.map_id];
    const mapName = m ? m.name : `Map #${s.map_id}`;
    const label = m ? (m.street ? `${m.name} (${m.street})` : m.name) : `Map #${s.map_id}`;

    if (activeMs < minMs && !isLive) continue;
    if (onlyKills && (s.kills || 0) <= 0) continue;
    if (onlyExp && (s.exp_gained || 0) <= 0) continue;
    if (q) {
      const hay = `${label} ch.${s.channel ?? ""} ${s.map_id}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    enriched.push({ s, isLive, activeMs, xph, mapName, label });
  }

  if (enriched.length === 0) {
    const msg =
      mapSplits.length > 0
        ? "No map splits match your current filters."
        : "No map splits recorded yet. Connect to your local endpoint to track map performance!";
    return `<tr><td colspan="8" class="empty-cell">${msg}</td></tr>`;
  }

  enriched.sort((a, b) => {
    if (sortBy === "time") return b.activeMs - a.activeMs;
    if (sortBy === "exp") return (b.s.exp_gained || 0) - (a.s.exp_gained || 0);
    if (sortBy === "xph") return b.xph - a.xph;
    if (sortBy === "kills") return (b.s.kills || 0) - (a.s.kills || 0);
    if (sortBy === "mesos") return (b.s.mesos_gained || 0) - (a.s.mesos_gained || 0);
    if (sortBy === "drops") return (b.s.drops || 0) - (a.s.drops || 0);
    return (b.s.started_ts || 0) - (a.s.started_ts || 0);
  });

  return enriched
    .slice(0, GUIDE_CONFIG.maxSplitsRows)
    .map(({ s, isLive, activeMs, xph, mapName, label }) => {
      const safeLabel = escapeHtml(label);
      const chHtml = s.channel != null ? ` <span class="muted">(Ch. ${s.channel})</span>` : "";
      const livePill = isLive ? `<span class="live-row-pill">LIVE</span> ` : "";
      const mobsHtml = formatSplitMobsHtml(s.killsByMob, mobsDb);

      return `<tr class="${isLive ? "active-split-row" : ""}" title="${safeLabel} — Map #${s.map_id}">
        <td>${livePill}<strong>${safeLabel}</strong>${chHtml} ${buildMapLinksHtml(s.map_id, escapeHtml(mapName), true)}</td>
        <td class="num">${formatDuration(activeMs)}</td>
        <td class="gold num">${(s.exp_gained || 0).toLocaleString()}</td>
        <td class="accent num">${xph.toLocaleString()}/h</td>
        <td class="num">${(s.kills || 0).toLocaleString()}</td>
        <td>${mobsHtml}</td>
        <td class="num">${(s.mesos_gained || 0).toLocaleString()}</td>
        <td class="num">${(s.drops || 0).toLocaleString()}</td>
      </tr>`;
    })
    .join("");
}
