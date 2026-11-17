import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { buildGuideIndex, normalizeItems, normalizeMaps, normalizeMonsters } from "./js/catalog.js";
import { escapeHtml, formatCompact, formatDuration } from "./js/constants.js";
import { renderGuideHtml, renderSplitsHtml, scoreMap } from "./js/guide.js";

const rootDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const html = readFileSync(path.join(rootDir, "index.html"), "utf8");
const css = readFileSync(path.join(rootDir, "style.css"), "utf8");
const mainJs = readFileSync(path.join(rootDir, "js/main.js"), "utf8");
const jsFiles = readdirSync(path.join(rootDir, "js"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => path.join(rootDir, "js", f));

test("all ES modules in js/ have valid JavaScript syntax", () => {
  for (const filePath of jsFiles) {
    execFileSync(process.execPath, ["--check", filePath]);
  }
});

test("index.html uses cache-busted style.css and js/main.js module", () => {
  const cssMatch = html.match(/href="style\.css\?v=([^"]+)"/);
  const jsMatch = html.match(/type="module"\s+src="js\/main\.js\?v=([^"]+)"/);
  assert.ok(cssMatch, "style.css must include ?v= cache-buster");
  assert.ok(jsMatch, "js/main.js must be loaded as type=module with ?v= cache-buster");
  assert.equal(cssMatch[1], jsMatch[1], "style.css and js/main.js cache-buster versions should match");
});

test("all requireEl() IDs exist uniquely in index.html", () => {
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, "Duplicate element IDs found in index.html");
  const requiredIds = [...mainJs.matchAll(/requireEl\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(requiredIds.length > 0, "Expected requireEl() calls in js/main.js");
  for (const id of requiredIds) {
    assert.ok(htmlIds.includes(id), `Missing #${id} in index.html`);
  }
});

test("layout CSS guards and full-width responsive layout", () => {
  assert.match(css, /\.wrap\s*\{[^}]*max-width:\s*1360px/);
  assert.match(css, /\.hud-layout\s*\{/);
  assert.match(css, /\.config\s*\{[^}]*display:\s*flex;\s*flex-direction:\s*column;/);
  assert.match(css, /\.actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/);
  assert.match(css, /\.hidden\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /color-scheme:\s*dark;/);
});

test("catalog normalization, guide scoring, HTML escaping, and MeowDB/Henesys links behave accurately", () => {
  assert.equal(escapeHtml(`<script>"'&`), "&lt;script&gt;&quot;&#39;&amp;");
  assert.equal(formatCompact(1_250_000), "1.25M");
  assert.equal(formatDuration(3661_000), "01:01:01");

  const maps = normalizeMaps({
    regions: [
      { region: "Victoria", maps: [{ id: 10004140, name: "<Ant Tunnel>", street_name: "Sleepywood", is_town: false }] },
    ],
  });
  const mobs = normalizeMonsters(
    {
      monsters: [
        { id: 2230101, name: "Zombie Mushroom", level: 24, exp: 42, hp: 500, undead: true, maps: [{ id: 10004140, count: 16 }] },
      ],
    },
    maps
  );
  const items = normalizeItems({ items: [{ id: 4000015, name: "Horny Mushroom Cap", stats: { price: 15 } }] });
  assert.equal(items[4000015].price, 15);

  const guide = buildGuideIndex(maps, mobs);
  assert.equal(guide.length, 1);
  assert.equal(guide[0].hasUndead, true);

  const clericScore = scoreMap(guide[0], 23, "cleric");
  const baseScore = scoreMap(guide[0], 23, "all");
  assert.ok(clericScore.score > baseScore.score, "Cleric bonus should boost undead map score");
  assert.equal(clericScore.parts.lvGap, 0, "Mob Lv. 24 vs Char Lv. 23 should be inside 0-penalty sweet spot");

  const outOfRange = scoreMap(guide[0], 10, "all");
  assert.ok(outOfRange.parts.lvGap > 0, "Mob Lv. 24 vs Char Lv. 10 should incur level-gap penalty");

  const guideHtml = renderGuideHtml({
    loaded: true,
    guideMaps: guide,
    mapSplits: [],
    charLv: 23,
    jobFilter: "cleric",
    sortBy: "score",
    query: "",
  });
  assert.ok(!guideHtml.includes("<Ant Tunnel>"), "Map names must be HTML-escaped");
  assert.ok(guideHtml.includes("&lt;Ant Tunnel&gt;"));
  assert.ok(guideHtml.includes("https://meowdb.com/msclassic/maps/010004140"));
  assert.ok(guideHtml.includes("https://henesys.gg/maps/10004140"));

  const splitsHtml = renderSplitsHtml(
    [{ map_id: 10004140, channel: 2, active_ms: 60_000, exp_gained: 5000, kills: 120, mesos_gained: 1500, drops: 3 }],
    maps
  );
  assert.ok(splitsHtml.includes("&lt;Ant Tunnel&gt;"));
  assert.ok(splitsHtml.includes("300,000/h"));
});

test("public repo contains zero codec files, static ICO resource exists, and zero plaintext MapleStory opcodes", () => {
  assert.ok(!existsSync(path.join(rootDir, "forwarder/codec.go")), "forwarder/codec.go must not exist in public repo");
  assert.ok(!existsSync(path.join(rootDir, "codec.wasm")), "codec.wasm must not exist in public repo");
  assert.ok(existsSync(path.join(rootDir, "forwarder/assets/maplesprint.ico")), "Windows .ico asset must exist on disk");

  const mainGo = readFileSync(path.join(rootDir, "forwarder/main.go"), "utf8");
  const trayWinGo = readFileSync(path.join(rootDir, "forwarder/tray_windows.go"), "utf8");
  const allCode = [...jsFiles.map((f) => readFileSync(f, "utf8")), mainGo, trayWinGo].join("\n");

  for (const forbidden of [
    "0x007e", "0x008b", "0x01a9", "0x02a8", "0x02a9", "0x02aa",
    "0x03c9", "0x03d4", "0x03d5", "0x03f3", "0x5A3C",
    "You have gained", "StatChanged", "SetField", "MobLeaveField",
  ]) {
    assert.ok(!allCode.includes(forbidden), `Secret protocol token "${forbidden}" must not appear in public repo`);
  }

  assert.match(mainGo, /golang\.org\/x\/net\/websocket/);
  assert.match(mainGo, /Access-Control-Allow-Private-Network/);
  assert.match(mainGo, /NewPhysicalNICDialer/);
  assert.ok(!mainGo.includes("<!DOCTYPE html>"), "forwarder/main.go must not embed its own HTML UI");
});
