// @ts-check
"use strict";

/** @param {any} mob */
function extractElements(mob) {
  /** @type {Record<string, string>} */
  const out = {};
  if (mob?.elements && typeof mob.elements === "object") {
    for (const [k, v] of Object.entries(mob.elements)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  // Support WZ elemAttr codes: 1 = Immune, 2 = Strong (resist), 3 = Weak
  const wzAttr = String(mob?.elemAttr || mob?.elem_attr || "");
  const map = [
    ["H", "Holy"],
    ["F", "Fire"],
    ["I", "Ice"],
    ["L", "Lightning"],
    ["S", "Poison"],
  ];
  for (const [code, name] of map) {
    if (wzAttr.includes(`${code}3`)) out[name] = "Weak";
    else if (wzAttr.includes(`${code}1`)) out[name] = "Immune";
    else if (wzAttr.includes(`${code}2`)) out[name] = "Strong";
  }
  return out;
}

/** @param {any} mapsData */
export function normalizeMaps(mapsData) {
  /** @type {Record<number, { name: string, street: string, isTown?: boolean, mobCapacity?: number, mobPositions?: Array<{ id: number, x: number, y: number }>, spawns: Array<{ id: number, count: number }> }>} */
  const maps = {};
  if (Array.isArray(mapsData?.regions)) {
    for (const reg of mapsData.regions) {
      for (const m of reg.maps || []) {
        maps[m.id] = {
          name: m.name,
          street: m.street_name || reg.region || "",
          isTown: Boolean(m.is_town),
          mobCapacity: Number(m.mob_capacity) || 0,
          mobPositions: Array.isArray(m.mob_positions) ? m.mob_positions : [],
          spawns: [],
        };
      }
    }
    return maps;
  }

  for (const [id, m] of Object.entries(mapsData || {})) {
    if (m && typeof m === "object") {
      maps[Number(id)] = {
        name: m.name || `Map #${id}`,
        street: m.street || m.street_name || "",
        isTown: Boolean(m.isTown || m.is_town),
        mobCapacity: Number(m.mobCapacity || m.mob_capacity) || 0,
        mobPositions: Array.isArray(m.mobPositions || m.mob_positions) ? (m.mobPositions || m.mob_positions) : [],
        spawns: Array.isArray(m.spawns) ? m.spawns : [],
      };
    }
  }
  return maps;
}

/** @param {any} mobsData @param {ReturnType<typeof normalizeMaps>} maps */
export function normalizeMonsters(mobsData, maps) {
  /** @type {Record<number, { name: string, level?: number, exp?: number, hp?: number, undead: boolean, elements: Record<string, string>, boss: boolean }>} */
  const mobs = {};
  const list = Array.isArray(mobsData?.monsters) ? mobsData.monsters : null;
  if (list) {
    for (const m of list) {
      const elements = extractElements(m);
      mobs[m.id] = {
        name: m.name,
        level: m.level,
        exp: m.exp,
        hp: m.hp ?? m.max_hp,
        undead: Boolean(m.undead),
        elements,
        boss: Boolean(m.boss),
      };
      for (const sp of m.maps || []) {
        if (!maps[sp.id]) {
          maps[sp.id] = { name: sp.name || `Map #${sp.id}`, street: "", spawns: [] };
        }
        maps[sp.id].spawns.push({ id: m.id, count: sp.count || 1 });
      }
    }
    return mobs;
  }

  for (const [id, m] of Object.entries(mobsData || {})) {
    if (m && typeof m === "object") {
      mobs[Number(id)] = {
        name: m.name || `Mob #${id}`,
        level: m.level,
        exp: m.exp,
        hp: m.max_hp ?? m.hp,
        undead: Boolean(m.undead),
        elements: extractElements(m),
        boss: Boolean(m.boss),
      };
    }
  }
  return mobs;
}

/** @param {any} itemsData */
export function normalizeItems(itemsData) {
  /** @type {Record<number, { name: string, cat: string, price: number | null }>} */
  const items = {};
  if (Array.isArray(itemsData?.items)) {
    for (const it of itemsData.items) {
      items[it.id] = { name: it.name, cat: it.category || "", price: it.stats?.price ?? null };
    }
    return items;
  }

  for (const [id, it] of Object.entries(itemsData || {})) {
    if (it && typeof it === "object") {
      items[Number(id)] = { name: it.name || `Item #${id}`, cat: it.category || "", price: it.price ?? null };
    }
  }
  return items;
}

const SPATIAL_PAD_X = 200;
const SPATIAL_PAD_Y = 150;
const MIN_AREA_MPX = 0.1;
const RESIST_SHARE_THRESHOLD = 0.2;

function isResist(val) {
  return val === "Strong" || val === "Immune";
}

function computeMapSpatial(m, totalSpawns) {
  const pos = Array.isArray(m.mobPositions) ? m.mobPositions : [];
  const cap = Number(m.mobCapacity) || 0;
  if (pos.length < 2) {
    return {
      widthPx: null,
      heightPx: null,
      surfaceAreaMPx: null,
      effectiveMobs: cap > 0 ? Math.min(cap, totalSpawns) : totalSpawns,
      spatialDensity: null,
    };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const pt of pos) {
    const x = Number(pt.x);
    const y = Number(pt.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      widthPx: null,
      heightPx: null,
      surfaceAreaMPx: null,
      effectiveMobs: cap > 0 ? Math.min(cap, totalSpawns) : totalSpawns,
      spatialDensity: null,
    };
  }
  const widthPx = Math.round(maxX - minX + SPATIAL_PAD_X);
  const heightPx = Math.round(maxY - minY + SPATIAL_PAD_Y);
  const surfaceAreaMPx = Number(Math.max(MIN_AREA_MPX, (widthPx * heightPx) / 1_000_000).toFixed(2));
  const effectiveMobs = cap > 0 ? Math.min(cap, pos.length) : pos.length;
  const spatialDensity = Number((effectiveMobs / surfaceAreaMPx).toFixed(1));
  return { widthPx, heightPx, surfaceAreaMPx, effectiveMobs, spatialDensity };
}

/**
 * Builds pre-aggregated map spawn summaries from explicit OSMS catalog fields.
 * @param {ReturnType<typeof normalizeMaps>} maps
 * @param {ReturnType<typeof normalizeMonsters>} mobs
 */
export function buildGuideIndex(maps, mobs) {
  const list = [];
  for (const [mapIdStr, m] of Object.entries(maps)) {
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
    let weightedHpPerExp = 0;
    let holyResistSpawns = 0;
    let fpResistSpawns = 0;
    let ilResistSpawns = 0;
    let hasUndead = false;
    let hasHolyWeak = false;
    let hasFireWeak = false;
    let hasPoisonWeak = false;
    let hasIceWeak = false;
    let hasLightningWeak = false;

    for (const [mobIdStr, count] of Object.entries(countsByMob)) {
      const mob = mobs[Number(mobIdStr)];
      if (!mob || !mob.level || !mob.exp || mob.boss) continue;
      const hp = Math.max(1, Number(mob.hp) || 1);
      const elems = mob.elements || {};
      const undead = Boolean(mob.undead);

      if (undead) hasUndead = true;
      if (elems.Holy === "Weak") hasHolyWeak = true;
      if (elems.Fire === "Weak") hasFireWeak = true;
      if (elems.Poison === "Weak") hasPoisonWeak = true;
      if (elems.Ice === "Weak") hasIceWeak = true;
      if (elems.Lightning === "Weak") hasLightningWeak = true;

      if (isResist(elems.Holy)) holyResistSpawns += count;
      if ((isResist(elems.Fire) && elems.Poison !== "Weak") || (isResist(elems.Poison) && elems.Fire !== "Weak")) {
        fpResistSpawns += count;
      }
      if ((isResist(elems.Ice) && elems.Lightning !== "Weak") || (isResist(elems.Lightning) && elems.Ice !== "Weak")) {
        ilResistSpawns += count;
      }

      const hpPerExp = Number((hp / mob.exp).toFixed(2));
      totalSpawns += count;
      weightedLevel += mob.level * count;
      weightedExp += mob.exp * count;
      weightedRatio += (mob.exp / hp) * count;
      weightedHpPerExp += hpPerExp * count;
      mobDetails.push({
        id: Number(mobIdStr),
        name: mob.name,
        level: mob.level,
        exp: mob.exp,
        hp,
        hpPerExp,
        count,
        undead,
        elements: elems,
      });
    }

    if (totalSpawns === 0 || mobDetails.length === 0) continue;
    mobDetails.sort((a, b) => b.count - a.count || b.count * b.exp - a.count * a.exp);
    const dominantMob = mobDetails[0];
    const domElems = dominantMob.elements || {};
    const spatial = computeMapSpatial(m, totalSpawns);

    const dominantHolyWeak = dominantMob.undead || domElems.Holy === "Weak";
    const hasHolyResist = isResist(domElems.Holy) || holyResistSpawns / totalSpawns >= RESIST_SHARE_THRESHOLD;
    const dominantFpWeak = domElems.Fire === "Weak" || domElems.Poison === "Weak";
    const hasFpResist =
      (isResist(domElems.Fire) && domElems.Poison !== "Weak") ||
      (isResist(domElems.Poison) && domElems.Fire !== "Weak") ||
      fpResistSpawns / totalSpawns >= RESIST_SHARE_THRESHOLD;
    const dominantIlWeak = domElems.Ice === "Weak" || domElems.Lightning === "Weak";
    const hasIlResist =
      (isResist(domElems.Ice) && domElems.Lightning !== "Weak") ||
      (isResist(domElems.Lightning) && domElems.Ice !== "Weak") ||
      ilResistSpawns / totalSpawns >= RESIST_SHARE_THRESHOLD;

    list.push({
      mapId,
      name: m.name,
      street: m.street || "Maple World",
      totalSpawns,
      ...spatial,
      avgLevel: Math.round(weightedLevel / totalSpawns),
      avgExp: Math.round(weightedExp / totalSpawns),
      avgRatio: weightedRatio / totalSpawns,
      avgHpPerExp: Number((weightedHpPerExp / totalSpawns).toFixed(2)),
      dominantMob,
      hasUndead,
      hasHolyWeak,
      hasFireWeak,
      hasPoisonWeak,
      hasIceWeak,
      hasLightningWeak,
      dominantHolyWeak,
      hasHolyResist,
      dominantFpWeak,
      hasFpResist,
      dominantIlWeak,
      hasIlResist,
      mobs: mobDetails,
    });
  }
  return list;
}

/** @param {string} baseUrl */
export async function fetchCatalog(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "") + "/";
  const fetchMobResponse = async () => {
    const r = await fetch(base + "monsters.json");
    return r.ok ? r : fetch(base + "mobs.json");
  };
  const [mapsR, mobsR, itemsR] = await Promise.all([
    fetch(base + "maps.json"),
    fetchMobResponse(),
    fetch(base + "items.json"),
  ]);
  if (!mapsR.ok || !mobsR.ok || !itemsR.ok) {
    throw new Error("Catalog HTTP error");
  }
  const [mapsRaw, mobsRaw, itemsRaw] = await Promise.all([
    mapsR.json(),
    mobsR.json(),
    itemsR.json(),
  ]);
  const maps = normalizeMaps(mapsRaw);
  const mobs = normalizeMonsters(mobsRaw, maps);
  const items = normalizeItems(itemsRaw);
  return { maps, mobs, items, guideMaps: buildGuideIndex(maps, mobs) };
}
