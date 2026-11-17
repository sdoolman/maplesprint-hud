import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { buildGuideIndex, normalizeItems, normalizeMaps, normalizeMonsters } from "../web/js/catalog.js";
import { CLASSIC_EXP_TABLE, JOB_NAMES, MAX_CLASSIC_LEVEL, escapeHtml, formatCompact, formatDuration } from "../web/js/constants.js";
import { sanitizeEndpointUrl } from "../web/js/endpoint.js";
import { renderGuideHtml, renderSplitsHtml, scoreMap } from "../web/js/guide.js";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const webDir = path.join(rootDir, "web");
const html = readFileSync(path.join(webDir, "index.html"), "utf8");
const css = readFileSync(path.join(webDir, "css/style.css"), "utf8");
const mainJs = readFileSync(path.join(webDir, "js/main.js"), "utf8");
const jsFiles = readdirSync(path.join(webDir, "js"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => path.join(webDir, "js", f));

test("all ES modules in js/ have valid JavaScript syntax", () => {
  for (const filePath of jsFiles) {
    execFileSync(process.execPath, ["--check", filePath]);
  }
});

test("index.html uses cache-busted css/style.css and js/main.js module", () => {
  const cssMatch = html.match(/href="css\/style\.css\?v=([^"]+)"/);
  const jsMatch = html.match(/type="module"\s+src="js\/main\.js\?v=([^"]+)"/);
  assert.ok(cssMatch, "css/style.css must include ?v= cache-buster");
  assert.ok(jsMatch, "js/main.js must be loaded as type=module with ?v= cache-buster");
  assert.equal(cssMatch[1], jsMatch[1], "css/style.css and js/main.js cache-buster versions should match");
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

test("Classic World EXP table and job names match MapleStory Classic World (no Pirate, accurate Lv 51+ curve)", () => {
  assert.equal(CLASSIC_EXP_TABLE.length, MAX_CLASSIC_LEVEL);
  assert.equal(CLASSIC_EXP_TABLE[1], 15);
  assert.equal(CLASSIC_EXP_TABLE[51], 748_608);
  assert.equal(CLASSIC_EXP_TABLE[90], 11_938_059);
  assert.equal(CLASSIC_EXP_TABLE[99], 9_482_161_548);
  for (const [id, name] of Object.entries(JOB_NAMES)) {
    assert.ok(Number(id) < 500, `Unexpected non-Classic job ID ${id} (${name})`);
    assert.notEqual(name, "Pirate");
  }
});

test("endpoint URL sanitizer accepts only valid HTTP(S) origins", () => {
  const okRes = sanitizeEndpointUrl("http://127.0.0.1:8080/");
  assert.equal(okRes.ok, true);
  if (okRes.ok) {
    assert.equal(okRes.httpBase, "http://127.0.0.1:8080");
    assert.equal(okRes.wsUrl, "ws://127.0.0.1:8080/ws");
  }
  const tlsRes = sanitizeEndpointUrl("https://relay.example.com:8443/sub/");
  assert.equal(tlsRes.ok, true);
  if (tlsRes.ok) {
    assert.equal(tlsRes.wsUrl, "wss://relay.example.com:8443/sub/ws");
  }
  for (const bad of ["", "javascript:alert(1)", "file:///etc/passwd", "ws://127.0.0.1:8080", "not a url"]) {
    assert.equal(sanitizeEndpointUrl(bad).ok, false, `Expected ${bad} to fail sanitization`);
  }
});

test("OSMS elements schema, transparent 0-100 suitability rating, escaping, and MeowDB/Henesys links behave accurately", () => {
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
        {
          id: 21,
          name: "Rotten Mushroom",
          level: 24,
          exp: 45,
          hp: 436,
          undead: 1,
          elements: { Holy: "Weak", Fire: "Weak" },
          maps: [{ id: 10004140, count: 32 }],
        },
      ],
    },
    maps
  );
  const items = normalizeItems({ items: [{ id: 4000015, name: "Mushroom Cap", stats: { price: 15 } }] });
  assert.equal(items[4000015].price, 15);

  const guide = buildGuideIndex(maps, mobs);
  assert.equal(guide.length, 1);
  assert.equal(guide[0].hasUndead, true);
  assert.equal(guide[0].hasFireWeak, true);
  assert.equal(guide[0].hasHolyWeak, true);

  const clericScore = scoreMap(guide[0], 23, "cleric");
  const mageScore = scoreMap(guide[0], 23, "magician");
  const baseScore = scoreMap(guide[0], 23, "all");
  assert.ok(clericScore.score > baseScore.score && clericScore.score <= 100);
  assert.ok(mageScore.score > baseScore.score && mageScore.score <= 100);
  assert.equal(clericScore.parts.distFromIdeal, 0);

  const outOfRange = scoreMap(guide[0], 10, "all");
  assert.ok(outOfRange.parts.distFromIdeal > 0 && outOfRange.parts.levelFit < baseScore.parts.levelFit);

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
  assert.match(guideHtml, /Fit \d+\/100/);
  assert.ok(!html.includes('id="workerUrl"'), "Legacy workerUrl ID must not appear in index.html");

  const splitsHtml = renderSplitsHtml(
    [{ map_id: 10004140, channel: 2, active_ms: 60_000, exp_gained: 5000, kills: 120, mesos_gained: 1500, drops: 3 }],
    maps
  );
  assert.ok(splitsHtml.includes("&lt;Ant Tunnel&gt;"));
  assert.ok(splitsHtml.includes("300,000/h"));
});

test("layout CSS guards and full-width responsive layout", () => {
  assert.match(css, /\.wrap\s*\{[^}]*max-width:\s*1360px/);
  assert.match(css, /\.hud-layout\s*\{/);
  assert.match(css, /\.hidden\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /color-scheme:\s*dark;/);
});

test("public repo contains zero codec files, static ICO resource exists, safe URL validation, and zero plaintext opcodes", () => {
  assert.ok(!existsSync(path.join(rootDir, "relay/codec.go")), "relay/codec.go must not exist in public repo");
  assert.ok(!existsSync(path.join(rootDir, "codec.wasm")), "codec.wasm must not exist in public repo");
  assert.ok(existsSync(path.join(rootDir, "relay/assets/maplesprint.ico")), "Windows .ico asset must exist on disk");

  const mainGo = readFileSync(path.join(rootDir, "relay/main.go"), "utf8");
  const packetGo = readFileSync(path.join(rootDir, "relay/packet.go"), "utf8");
  const trayWinGo = readFileSync(path.join(rootDir, "relay/tray_windows.go"), "utf8");
  const allCode = [...jsFiles.map((f) => readFileSync(f, "utf8")), mainGo, packetGo, trayWinGo].join("\n");

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
  assert.match(trayWinGo, /validateHTTPURL/);
  assert.match(trayWinGo, /validateLogPath/);
  assert.ok(!trayWinGo.includes("createMapleIcon"), "In-memory icon pixel drawing must not exist");
  assert.ok(!mainGo.includes("<!DOCTYPE html>"), "relay/main.go must not embed its own HTML UI");
});
