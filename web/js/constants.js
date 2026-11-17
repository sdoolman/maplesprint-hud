// @ts-check
"use strict";

export const DEFAULT_DB = "https://osmsdataexplorer.com/data/current/";
export const AUTO_PAUSE_IDLE_MS = 15_000;
export const ROLLING_WINDOW_MS = 5 * 60 * 1000;
export const MAX_CLASSIC_LEVEL = 100;

/**
 * Verified MapleStory Classic World EXP-to-next-level table (Levels 1 -> 100).
 * Entry index N holds the EXP required to advance from level N to N+1.
 */
export const CLASSIC_EXP_TABLE = Object.freeze([
  0,
  15, 34, 57, 92, 135, 372, 560, 840, 1242, 1716,
  2360, 3216, 4200, 5460, 7050, 8840, 11040, 13716, 16680, 20216,
  24402, 28980, 34320, 40512, 47216, 54900, 63666, 73080, 83720, 95700,
  108480, 122760, 138666, 155540, 174216, 194832, 216600, 240500, 266682, 294216,
  324240, 356916, 391160, 428280, 468450, 510420, 555680, 604416, 655200, 709716,
  748608, 789631, 832902, 878545, 926689, 977471, 1031036, 1087536, 1147132, 1209994,
  1276301, 1346242, 1420016, 1497832, 1579913, 1666492, 1757815, 1854143, 1955750, 2062925,
  2175973, 2295216, 2420993, 2553663, 2693603, 2841212, 2996910, 3161140, 3334370, 3517093,
  3709829, 3913127, 4127566, 4353756, 4592341, 4844001, 5109452, 5389449, 5684790, 11938059,
  25069923, 52646838, 110558359, 232172553, 487562361, 1023880958, 2150150011, 4515315023, 9482161548,
]);

/** Classic Explorer classes present in MapleStory Classic World. */
export const JOB_NAMES = Object.freeze({
  0: "Beginner",
  100: "Swordman", 110: "Fighter", 111: "Crusader", 112: "Hero",
  120: "Page", 121: "White Knight", 122: "Paladin",
  130: "Spearman", 131: "Dragon Knight", 132: "Dark Knight",
  200: "Magician", 210: "F/P Wizard", 211: "F/P Mage", 212: "F/P Arch Mage",
  220: "I/L Wizard", 221: "I/L Mage", 222: "I/L Arch Mage",
  230: "Cleric", 231: "Priest", 232: "Bishop",
  300: "Archer", 310: "Hunter", 311: "Ranger", 312: "Bowmaster",
  320: "Crossbowman", 321: "Sniper", 322: "Marksman",
  400: "Rogue", 410: "Assassin", 411: "Hermit", 412: "Night Lord",
  420: "Bandit", 421: "Chief Bandit", 422: "Shadower",
});

/**
 * Minimum Classic World character level required for a given Explorer job ID.
 * @param {number} jobId
 * @returns {number}
 */
export function minLevelForJob(jobId) {
  const id = Number(jobId) || 0;
  if (id <= 0) return 1;
  const adv = id % 10;
  if (adv >= 2) return 120;
  if (adv === 1) return 70;
  if (id % 100 !== 0) return 30;
  return id === 200 ? 8 : 10;
}

/**
 * Job `[id, name]` entries eligible for selection at the specified character level.
 * @param {number} level
 * @returns {Array<[string, string]>}
 */
export function eligibleJobsForLevel(level) {
  const lv = Math.max(1, Number(level) || 1);
  return Object.entries(JOB_NAMES).filter(([id]) => minLevelForJob(Number(id)) <= lv);
}

/**
 * Steps a known job ID down its class branch if level is below its requirement.
 * @param {number} jobId
 * @param {number} level
 * @returns {number}
 */
export function normalizeJobForLevel(jobId, level) {
  const id = Number(jobId) || 0;
  const lv = Math.max(1, Number(level) || 1);
  if (!(id in JOB_NAMES) || minLevelForJob(id) <= lv) return id;
  for (const cand of [
    Math.floor(id / 10) * 10 + 1,
    Math.floor(id / 10) * 10,
    Math.floor(id / 100) * 100,
    0,
  ]) {
    if (cand in JOB_NAMES && minLevelForJob(cand) <= lv) return cand;
  }
  return 0;
}

/** @param {string} id @returns {HTMLElement} */
export function requireEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element #${id}`);
  return el;
}

/** @param {number} n @returns {string} */
export function formatCompact(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
  return Math.round(v).toLocaleString();
}

/** @param {number} ms @returns {string} */
export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hrs = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${hrs}:${mins}:${secs}`;
}

/** @param {unknown} raw @returns {string} */
export function escapeHtml(raw) {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** @param {string} b64 @returns {Uint8Array} */
export function base64ToBytes(b64) {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}
