import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { buildGuideIndex, normalizeItems, normalizeMaps, normalizeMonsters } from "../web/js/catalog.js";
import { CLASSIC_EXP_TABLE, JOB_NAMES, MAX_CLASSIC_LEVEL, base64ToBytes, eligibleJobsForLevel, escapeHtml, formatCompact, formatDuration, minLevelForJob, normalizeJobForLevel } from "../web/js/constants.js";
import { fetchWireGuardConf, probeEndpoint, sanitizeEndpointUrl } from "../web/js/endpoint.js";
import { recordedRateForMap, renderGuideHtml, renderSplitsHtml, scoreMap } from "../web/js/guide.js";

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
  assert.match(guideHtml, /<details class="guide-card">/);
  assert.match(guideHtml, /<table class="mob-table">/);
  assert.match(guideHtml, />\d+<span>\/100<\/span>/);
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

test("constants formatCompact, formatDuration, and base64ToBytes handle edge cases", () => {
  assert.equal(formatCompact(0), "0");
  assert.equal(formatCompact(9_999), "9,999");
  assert.equal(formatCompact(12_340), "12.3k");
  assert.equal(formatCompact(2_500_000), "2.50M");

  assert.equal(formatDuration(-5000), "00:00:00");
  assert.equal(formatDuration(45_000), "00:00:45");
  assert.equal(formatDuration(125_000), "00:02:05");
  assert.equal(formatDuration(3661_000), "01:01:01");

  assert.deepEqual(Array.from(base64ToBytes("SGVsbG8=")), [72, 101, 108, 108, 111]);
  assert.deepEqual(Array.from(base64ToBytes("!!!not-base64!!!")), []);
});

test("probeEndpoint and fetchWireGuardConf handle valid, error, and offline relay states", async () => {
  const origFetch = globalThis.fetch;
  try {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true, wg_port: 51825 }), { status: 200 });
    };

    const invalid = await probeEndpoint("ftp://127.0.0.1:8080");
    assert.equal(invalid.ok, false);
    assert.equal(invalid.invalid, true);
    assert.equal(fetchCalls, 0);

    const okProbe = await probeEndpoint("http://127.0.0.1:8080/");
    assert.equal(okProbe.ok, true);
    assert.equal(okProbe.status?.wg_port, 51825);

    globalThis.fetch = async () => new Response("nope", { status: 503 });
    const httpErr = await probeEndpoint("http://127.0.0.1:8080");
    assert.equal(httpErr.ok, false);
    assert.equal(httpErr.invalid, false);
    assert.equal(httpErr.error, "HTTP 503");

    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const netErr = await probeEndpoint("http://127.0.0.1:8080");
    assert.equal(netErr.ok, false);
    assert.equal(netErr.error, "ECONNREFUSED");

    const fallbackConf = await fetchWireGuardConf("http://127.0.0.1:8080", 51899);
    assert.match(fallbackConf, /Endpoint = 127\.0\.0\.1:51899/);
    assert.match(fallbackConf, /^PrivateKey = [A-Za-z0-9+/]{43}=$/m);
    assert.match(fallbackConf, /^PublicKey = [A-Za-z0-9+/]{43}=$/m);
    const defaultPortConf = await fetchWireGuardConf("invalid", -1);
    assert.match(defaultPortConf, /Endpoint = 127\.0\.0\.1:51820/);

    globalThis.fetch = async () => new Response("[Interface]\nAddress = 10.66.66.2/32\n", { status: 200 });
    const liveConf = await fetchWireGuardConf("http://127.0.0.1:8080");
    assert.match(liveConf, /Address = 10\.66\.66\.2\/32/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("guide scoring, filtering, sorting, recordedRateForMap, and empty states work accurately", () => {
  const highSpawnEntry = {
    id: 100040000,
    name: "Wild Boar Land",
    region: "Victoria",
    street: "Perion",
    isTown: false,
    avgLevel: 25,
    avgExp: 42,
    avgRatio: 0.12,
    totalSpawns: 30,
    hasUndead: false,
    hasFireWeak: false,
    hasIceWeak: true,
    hasLightningWeak: false,
    hasHolyWeak: false,
    mobs: [{ name: "Wild Boar", level: 25, exp: 42, hp: 350, count: 30 }],
  };
  const lowSpawnEntry = {
    ...highSpawnEntry,
    id: 100040001,
    name: "Quiet Field",
    avgExp: 60,
    totalSpawns: 8,
    hasIceWeak: false,
    mobs: [{ name: "Jr. Boogie", level: 26, exp: 60, hp: 600, count: 8 }],
  };

  assert.ok(scoreMap(highSpawnEntry, 24, "warrior").affinityTags.some((t) => t.includes("High Spawn AoE")));
  assert.ok(scoreMap(highSpawnEntry, 24, "magician_il").affinityTags.some((t) => t.includes("Ice / Lightning Weak")));
  assert.ok(scoreMap(highSpawnEntry, 24, "bowman").affinityTags.some((t) => t.includes("Low HP/EXP")));
  assert.ok(scoreMap(highSpawnEntry, 24, "thief").affinityTags.some((t) => t.includes("Low HP/EXP")));
  assert.ok(scoreMap(highSpawnEntry, 24, "cleric").score < scoreMap(highSpawnEntry, 24, "all").score);

  const splits = [
    { map_id: 100040000, active_ms: 2000, exp_gained: 9999 }, // below minRecordedMs (5000)
    { map_id: 100040000, active_ms: 30_000, exp_gained: 1500 },
    { map_id: 100040000, active_ms: 30_000, exp_gained: 4500 },
  ];
  assert.equal(recordedRateForMap(splits, 100040000), 360_000);
  assert.equal(recordedRateForMap(splits, 999999), 0);

  assert.match(renderGuideHtml({ loaded: false, guideMaps: [], mapSplits: [], charLv: 24, jobFilter: "all", sortBy: "score", query: "" }), /Loading OSMS map &amp; monster catalog/);
  assert.match(renderGuideHtml({ loaded: true, guideMaps: [highSpawnEntry], mapSplits: [], charLv: 24, jobFilter: "all", sortBy: "score", query: "no-such-map" }), /No matching maps found/);

  const sortedByMobExp = renderGuideHtml({
    loaded: true,
    guideMaps: [highSpawnEntry, lowSpawnEntry],
    mapSplits: splits,
    charLv: 24,
    jobFilter: "all",
    sortBy: "exp",
    query: "",
  });
  assert.ok(sortedByMobExp.indexOf("Quiet Field") < sortedByMobExp.indexOf("Wild Boar Land"));

  assert.match(renderSplitsHtml([], new Map()), /No map splits recorded yet/);
  const shortSplitHtml = renderSplitsHtml(
    [{ map_id: 999999, channel: 1, active_ms: 1500, exp_gained: 100, kills: 2, mesos_gained: 0, drops: 0 }],
    new Map()
  );
  assert.match(shortSplitHtml, /Map #999999/);
  assert.match(shortSplitHtml, /0\/h/);
});

test("mob_kill and map-wide mob_damage do not pollute kills, lastMobId, feed, or active timer", () => {
  const mobKillMatch = mainJs.match(/mob_kill\([^)]*\)\s*\{([\s\S]*?)\n  \},/);
  assert.ok(mobKillMatch, "Expected mob_kill handler in web/js/main.js");
  const body = mobKillMatch[1];
  assert.ok(!body.includes("recordActiveTime"), "mob_kill must not call recordActiveTime for other players' kills");
  assert.ok(!body.includes("state.lastMobId"), "mob_kill must not update state.lastMobId before exp_gain");
  assert.ok(!body.includes("state.kills"), "mob_kill must not increment state.kills directly");
  assert.ok(!mainJs.includes("mob_damage("), "map-wide mob_damage must not be handled in Live Events feed");
  assert.ok(!mainJs.includes("attack_hit("), "unattributed attack_hit must not be handled in Live Events feed");
  assert.match(html, /<select id="charJob"/, "charJob must be an editable select element");
  assert.match(mainJs, /Live stream active/, "mapLine must update when raw chunks are flowing prior to SetField");
  assert.match(mainJs, /ev\.mob_id/, "exp_gain must consume decoder-attributed mob_id directly");
  assert.match(mainJs, /eligibleJobsForLevel/, "job dropdown must filter options by character level");
});

test("job selector enforces Classic World advancement level gates (1st Lv8/10, 2nd Lv30, 3rd Lv70, 4th Lv120)", () => {
  assert.equal(minLevelForJob(0), 1);
  assert.equal(minLevelForJob(200), 8);
  assert.equal(minLevelForJob(100), 10);
  assert.equal(minLevelForJob(110), 30);
  assert.equal(minLevelForJob(111), 70);
  assert.equal(minLevelForJob(112), 120);

  const idsAt = (lv) => eligibleJobsForLevel(lv).map(([id]) => Number(id));
  assert.deepEqual(idsAt(7), [0]);
  assert.deepEqual(idsAt(8), [0, 200]);
  assert.deepEqual(idsAt(29), [0, 100, 200, 300, 400]);
  assert.ok(idsAt(30).includes(110) && !idsAt(30).includes(111));
  assert.ok(idsAt(69).includes(230) && !idsAt(69).includes(231));
  assert.ok(idsAt(70).includes(231) && !idsAt(70).includes(232));
  assert.ok(!idsAt(100).some((id) => id % 10 === 2));
  assert.ok(idsAt(120).includes(112) && idsAt(120).includes(422));

  assert.equal(normalizeJobForLevel(112, 100), 111);
  assert.equal(normalizeJobForLevel(111, 50), 110);
  assert.equal(normalizeJobForLevel(111, 29), 100);
  assert.equal(normalizeJobForLevel(230, 8), 200);
  assert.equal(normalizeJobForLevel(100, 9), 0);
});

test("R8 formula uses ±4 level window, inverse HP/EXP (max 35 at <=6), spatial density, and elemental resistance penalties", () => {
  const maps = normalizeMaps({
    regions: [
      {
        region: "Victoria",
        maps: [
          {
            id: 10003090,
            name: "Compact Swamp",
            street_name: "Warning Street",
            is_town: false,
            mob_capacity: 24,
            mob_positions: [
              { id: 18, x: 100, y: 100 },
              { id: 18, x: 900, y: 400 },
            ],
          },
          {
            id: 10005076,
            name: "Huge Sprawling Tunnel",
            street_name: "Dungeon",
            is_town: false,
            mob_capacity: 24,
            mob_positions: [
              { id: 18, x: 0, y: 0 },
              { id: 18, x: 3000, y: 3500 },
            ],
          },
        ],
      },
    ],
  });
  const mobs = normalizeMonsters(
    {
      monsters: [
        {
          id: 18,
          name: "Jr. Necki",
          level: 21,
          exp: 40,
          hp: 240, // 6.0 HP/EXP -> max 35 pts
          undead: 0,
          elements: { Holy: "Strong", Fire: "Weak", Ice: "Strong" },
          maps: [
            { id: 10003090, count: 24 },
            { id: 10005076, count: 24 },
          ],
        },
      ],
    },
    maps
  );
  const idx = buildGuideIndex(maps, mobs);
  const compact = idx.find((m) => m.mapId === 10003090);
  const huge = idx.find((m) => m.mapId === 10005076);
  assert.ok(compact && huge);
  assert.equal(compact.avgHpPerExp, 6);
  assert.ok(compact.spatialDensity > huge.spatialDensity);

  const sCompact = scoreMap(compact, 21, "all");
  const sHuge = scoreMap(huge, 21, "all");
  assert.equal(sCompact.parts.efficiency, 35);
  assert.ok(sCompact.parts.density > sHuge.parts.density);

  // Cleric: -15 on Holy:Strong; F/P: +12 on Fire:Weak; I/L: -12 on Ice:Strong
  assert.equal(scoreMap(compact, 21, "cleric").parts.classBonus, -15);
  assert.equal(scoreMap(compact, 21, "magician_fp").parts.classBonus, 12);
  assert.equal(scoreMap(compact, 21, "magician_il").parts.classBonus, -12);

  // Strict ±4 level window excludes Lv.21 map when char is Lv.15 (diff +6) or Lv.27 (diff -6)
  const tooLow = renderGuideHtml({ loaded: true, guideMaps: idx, mapSplits: [], charLv: 15, jobFilter: "all", sortBy: "score", query: "" });
  assert.match(tooLow, /No matching maps found/);
});

test("Phase 0 HUD: soft reset, per-mob kills, EXP detail, dmg/m, and filtered real-time Map Log work accurately", () => {
  assert.match(mainJs, /function softResetSprint\(\)/);
  const softResetBlock = mainJs.match(/function softResetSprint\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.ok(!softResetBlock.includes("decoder.reset"), "Soft reset must not reset the live packet decoder");
  assert.ok(mainJs.includes("state.damageDealt += Math.max(0, dmg)"), "exp_gain must update damageDealt for dmg/m");
  assert.ok(mainJs.includes("state.killsByMob"), "HUD must track exact killsByMob");
  assert.ok(mainJs.includes("levelExpDetailEl.textContent"), "HUD must render EXP-to-next-level detail");

  const splits = [
    { map_id: 10003090, channel: 33, started_ts: 1000, active_ms: 4000, exp_gained: 0, kills: 0, mesos_gained: 0, drops: 0 },
    { map_id: 10003090, channel: 33, started_ts: 2000, active_ms: 60_000, exp_gained: 1160, kills: 20, killsByMob: { 29: { count: 20, exp: 1160 } }, mesos_gained: 500, drops: 4 },
  ];
  const filteredHtml = renderSplitsHtml(
    splits,
    { 10003090: { name: "The Swamp of Despair I", street: "Warning Street" } },
    {
      mobsDb: { 29: { name: "Ligator" } },
      minTimeSec: 10,
      onlyKills: true,
      activeStartedTs: 2000,
      liveActiveMs: 90_000,
    }
  );
  assert.match(filteredHtml, /LIVE/);
  assert.match(filteredHtml, /Ligator ×20/);
  assert.match(filteredHtml, /00:01:30/);
  assert.ok(!filteredHtml.includes("00:00:04"), "0-kill visit below minTimeSec must be filtered out");
});
