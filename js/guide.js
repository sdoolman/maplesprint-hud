// @ts-check
"use strict";

import { escapeHtml, formatCompact, formatDuration } from "./constants.js";

/** @param {Array<any>} splits @param {number} mapId @returns {number} */
export function recordedRateForMap(splits, mapId) {
  let totalExp = 0;
  let totalMs = 0;
  for (const s of splits) {
    if (s.map_id === mapId && s.exp_gained > 0 && s.active_ms >= 5000) {
      totalExp += s.exp_gained;
      totalMs += s.active_ms;
    }
  }
  if (totalMs < 5000) return 0;
  return Math.round((totalExp * 3_600_000) / totalMs);
}

/**
 * Computes transparent training efficiency heuristics for a catalog map.
 * @param {any} mapEntry
 * @param {number} charLv
 * @param {string} jobFilter
 */
export function scoreMap(mapEntry, charLv, jobFilter) {
  const lvDiff = mapEntry.avgLevel - charLv;
  const lvGap = Math.max(0, Math.abs(lvDiff - 1) - 1) * 8;
  const spawns = Math.min(35, Math.sqrt(mapEntry.totalSpawns) * 6.5);
  const exp = Math.log10(Math.max(10, mapEntry.avgExp)) * 22;
  const ratio = Math.min(25, mapEntry.avgRatio * 45);

  let classBonus = 0;
  /** @type {string[]} */
  const affinityTags = [];

  if (jobFilter === "cleric") {
    if (mapEntry.hasUndead || mapEntry.hasHolyWeak) {
      classBonus += 45;
      affinityTags.push("✨ Heal / Holy Weak");
    } else {
      classBonus -= 18;
    }
  } else if (jobFilter === "magician") {
    if (mapEntry.hasFireWeak || mapEntry.hasIceWeak) {
      classBonus += 25;
      affinityTags.push("🔥❄️ Elemental Weak");
    }
    if (mapEntry.totalSpawns >= 10) {
      classBonus += 10;
      affinityTags.push("High Mob Density");
    }
  } else if (jobFilter === "warrior") {
    if (mapEntry.totalSpawns >= 14) {
      classBonus += 24;
      affinityTags.push("⚔️ High Mob Density (Slash Blast)");
    }
  } else if (jobFilter === "bowman" || jobFilter === "thief") {
    if (mapEntry.avgRatio >= 0.35) {
      classBonus += 20;
      affinityTags.push("🎯 High EXP-to-HP Ratio");
    }
  } else {
    if (mapEntry.hasUndead) affinityTags.push("Undead / Cleric Friendly");
    if (mapEntry.totalSpawns >= 15) affinityTags.push("High Spawn Density");
  }

  const score = Math.max(1, Math.round(exp + spawns + ratio + classBonus - lvGap));
  return {
    lvDiff,
    score,
    affinityTags,
    parts: {
      exp: Math.round(exp),
      spawns: Math.round(spawns),
      ratio: Math.round(ratio),
      classBonus,
      lvGap: Math.round(lvGap),
    },
  };
}

/**
 * Renders filtered & sorted Best Maps guide cards HTML safely.
 * @param {any} opts
 */
export function renderGuideHtml({ loaded, guideMaps, mapSplits, charLv, jobFilter, sortBy, query }) {
  if (!loaded || guideMaps.length === 0) {
    return `<div class="guide-card"><div class="guide-map-region">Loading OSMS map &amp; monster catalog…</div></div>`;
  }

  const q = (query || "").trim().toLowerCase();
  const scored = [];

  for (const m of guideMaps) {
    const lvDiff = m.avgLevel - charLv;
    if (!q && (lvDiff < -12 || lvDiff > 15)) continue;
    if (q) {
      const hay = `${m.name} ${m.street} ${m.mobs.map((x) => x.name).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const evaluated = scoreMap(m, charLv, jobFilter);
    scored.push({
      ...m,
      ...evaluated,
      recordedXph: recordedRateForMap(mapSplits, m.mapId),
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
    return `<div class="guide-card"><div class="guide-map-region">No matching maps found for Lv. ${charLv}. Try clearing the search filter.</div></div>`;
  }

  return top
    .map((m, idx) => {
      const diffLabel = m.lvDiff > 0 ? `+${m.lvDiff}` : `${m.lvDiff}`;
      const recBadge =
        m.recordedXph > 0
          ? `<span class="badge recorded">⚡ Recorded: ${formatCompact(m.recordedXph)} EXP/h</span>`
          : "";
      const affBadges = m.affinityTags.map((t) => `<span class="badge affinity">${escapeHtml(t)}</span>`).join("");
      const mobsHtml = m.mobs
        .map(
          (mob) =>
            `<span class="mob-chip"><span class="mob-lv">Lv.${mob.level}</span> <strong>${escapeHtml(mob.name)}</strong> <span class="mob-exp">+${mob.exp.toLocaleString()} EXP</span> <span class="mob-hp">(${mob.hp.toLocaleString()} HP · ×${mob.count})</span></span>`
        )
        .join("");

      const paddedId = String(m.mapId).padStart(9, "0");
      const meowUrl = `https://meowdb.com/msclassic/maps/${paddedId}`;
      const henesysUrl = `https://henesys.gg/maps/${m.mapId}`;
      const sp = m.parts;
      const gapLabel = sp.lvGap > 0 ? `-${sp.lvGap}` : "0 (Sweet spot)";
      const safeName = escapeHtml(m.name);

      return `
      <article class="guide-card">
        <div class="guide-card-top">
          <div>
            <div class="guide-map-title">
              <span>#${idx + 1} · ${safeName}</span>
              <a class="hs-link" href="${meowUrl}" target="_blank" rel="noopener noreferrer" title="View ${safeName} on MeowDB">MeowDB ↗</a>
              <a class="hs-link" href="${henesysUrl}" target="_blank" rel="noopener noreferrer" title="View ${safeName} on Henesys.gg">Henesys.gg ↗</a>
            </div>
            <div class="guide-map-region">${escapeHtml(m.street)} · Avg Mob Lv. ${m.avgLevel} (${diffLabel} vs you) · ${m.totalSpawns} spawns</div>
          </div>
          <div class="guide-badges">
            ${recBadge}
            ${affBadges}
            <div class="score-wrap" tabindex="0">
              <span class="badge score">Score ${m.score} ⓘ</span>
              <div class="score-popover">
                <div class="score-row"><span>Base EXP</span><span>+${sp.exp}</span></div>
                <div class="score-row"><span>Spawn Density</span><span>+${sp.spawns}</span></div>
                <div class="score-row"><span>EXP / HP Ratio</span><span>+${sp.ratio}</span></div>
                <div class="score-row"><span>Class Affinity</span><span>${sp.classBonus >= 0 ? "+" : ""}${sp.classBonus}</span></div>
                <div class="score-row"><span>Level Gap</span><span>${gapLabel}</span></div>
                <div class="score-row total"><span>Total Score</span><span>${m.score}</span></div>
              </div>
            </div>
          </div>
        </div>
        <div class="guide-mobs">${mobsHtml}</div>
      </article>`;
    })
    .join("");
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
    .slice(0, 30)
    .map((s) => {
      const m = mapsDb[s.map_id];
      const mapName = m ? m.name : `Map #${s.map_id}`;
      const label = m ? (m.street ? `${m.name} (${m.street})` : m.name) : `Map #${s.map_id}`;
      const paddedId = String(s.map_id).padStart(9, "0");
      const meowUrl = `https://meowdb.com/msclassic/maps/${paddedId}`;
      const henesysUrl = `https://henesys.gg/maps/${s.map_id}`;
      const xph = s.active_ms >= 3000 ? Math.round((s.exp_gained * 3_600_000) / s.active_ms) : 0;
      const safeLabel = escapeHtml(label);
      const safeMapName = escapeHtml(mapName);

      return `<tr title="${safeLabel} — Map #${s.map_id}">
        <td><strong>${safeLabel}</strong>${s.channel != null ? ` <span class="muted">(Ch. ${s.channel})</span>` : ""} <a class="hs-link" href="${meowUrl}" target="_blank" rel="noopener noreferrer" title="View ${safeMapName} on MeowDB">MeowDB ↗</a> <a class="hs-link" href="${henesysUrl}" target="_blank" rel="noopener noreferrer" title="View ${safeMapName} on Henesys.gg">Henesys ↗</a></td>
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
