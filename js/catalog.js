// @ts-check
"use strict";

/** @param {any} mapsData */
export function normalizeMaps(mapsData) {
  /** @type {Record<number, { name: string, street: string, isTown?: boolean, spawns: Array<{ id: number, count: number }> }>} */
  const maps = {};
  if (Array.isArray(mapsData?.regions)) {
    for (const reg of mapsData.regions) {
      for (const m of reg.maps || []) {
        maps[m.id] = {
          name: m.name,
          street: m.street_name || reg.region || "",
          isTown: Boolean(m.is_town),
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
        spawns: Array.isArray(m.spawns) ? m.spawns : [],
      };
    }
  }
  return maps;
}

/** @param {any} mobsData @param {ReturnType<typeof normalizeMaps>} maps */
export function normalizeMonsters(mobsData, maps) {
  /** @type {Record<number, { name: string, level?: number, exp?: number, hp?: number, undead?: boolean, elemAttr?: string, boss?: boolean }>} */
  const mobs = {};
  if (Array.isArray(mobsData?.monsters)) {
    for (const m of mobsData.monsters) {
      mobs[m.id] = {
        name: m.name,
        level: m.level,
        exp: m.exp,
        hp: m.hp ?? m.max_hp,
        undead: Boolean(m.undead),
        elemAttr: m.elemAttr || m.elem_attr || "",
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
        elemAttr: m.elem_attr || m.elemAttr || "",
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

const UNDEAD_KEYWORDS = ["zombie", "wraith", "skeleton", "mummy", "chronos", "shade"];

/**
 * Builds pre-aggregated map spawn summaries used by the Best Maps planner.
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
    let hasUndead = false;
    let hasHolyWeak = false;
    let hasFireWeak = false;
    let hasIceWeak = false;

    for (const [mobIdStr, count] of Object.entries(countsByMob)) {
      const mob = mobs[Number(mobIdStr)];
      if (!mob || !mob.level || !mob.exp || mob.boss) continue;
      const hp = Math.max(1, Number(mob.hp) || 1);
      const elem = String(mob.elemAttr || "");
      const nameLower = mob.name.toLowerCase();
      const undead =
        Boolean(mob.undead) ||
        elem.includes("H3") ||
        elem.includes("H2") ||
        UNDEAD_KEYWORDS.some((kw) => nameLower.includes(kw));

      if (undead) {
        hasUndead = true;
        hasHolyWeak = true;
      }
      if (elem.includes("F3") || elem.includes("F2")) hasFireWeak = true;
      if (elem.includes("I3") || elem.includes("I2")) hasIceWeak = true;

      totalSpawns += count;
      weightedLevel += mob.level * count;
      weightedExp += mob.exp * count;
      weightedRatio += (mob.exp / hp) * count;
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
  const guideMaps = buildGuideIndex(maps, mobs);
  return { maps, mobs, items, guideMaps };
}
