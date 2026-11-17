// @ts-check
"use strict";

export const DEFAULT_DB = "https://osmsdataexplorer.com/data/current/";
export const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8080";
export const AUTO_PAUSE_IDLE_MS = 15_000;
export const ROLLING_WINDOW_MS = 5 * 60 * 1000;

/** Classic World (pre-Big Bang) Level 1-200 EXP curve. */
export const CLASSIC_EXP_TABLE = (() => {
  const t = new Array(201).fill(0);
  const early = [
    0, 15, 34, 57, 92, 135, 372, 560, 840, 1242, 1716,
    2360, 3216, 4200, 5460, 7050, 8840, 11040, 13716, 16680, 20216,
    24402, 28980, 34320, 40512, 47216, 54900, 63666, 73080, 83720, 95700,
    108480, 122760, 138666, 155540, 174216, 194832, 216600, 240500, 266682, 294216,
    324240, 356916, 391160, 428280, 468450, 510420, 555680, 604416, 655200, 709716,
  ];
  for (let i = 1; i < early.length; i++) t[i] = early[i];
  for (let lv = 51; lv <= 200; lv++) {
    const rate = lv < 70 ? 1.08 : lv < 120 ? 1.065 : 1.055;
    t[lv] = Math.round(t[lv - 1] * rate);
  }
  return Object.freeze(t);
})();

/** @type {Readonly<Record<number, string>>} */
export const JOB_NAMES = Object.freeze({
  0: "Beginner",
  100: "Warrior", 110: "Fighter", 111: "Crusader", 112: "Hero",
  120: "Page", 121: "White Knight", 122: "Paladin",
  130: "Spearman", 131: "Dragon Knight", 132: "Dark Knight",
  200: "Magician", 210: "F/P Wizard", 211: "F/P Mage", 212: "F/P Arch Mage",
  220: "I/L Wizard", 221: "I/L Mage", 222: "I/L Arch Mage",
  230: "Cleric", 231: "Priest", 232: "Bishop",
  300: "Bowman", 310: "Hunter", 311: "Ranger", 312: "Bowmaster",
  320: "Crossbowman", 321: "Sniper", 322: "Marksman",
  400: "Thief", 410: "Assassin", 411: "Hermit", 412: "Night Lord",
  420: "Bandit", 421: "Chief Bandit", 422: "Shadower",
  500: "Pirate", 510: "Brawler", 520: "Gunslinger",
});

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
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
