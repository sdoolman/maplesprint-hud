import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const js = readFileSync(new URL("./app.js", import.meta.url), "utf8");

test("app.js has valid JavaScript syntax", () => {
  execFileSync(process.execPath, ["--check", new URL("./app.js", import.meta.url).pathname]);
});

test("index.html uses cache-busted style.css and app.js", () => {
  const cssMatch = html.match(/href="style\.css\?v=([^"]+)"/);
  const jsMatch = html.match(/src="app\.js\?v=([^"]+)"/);
  assert.ok(cssMatch, "style.css must include ?v= cache-buster");
  assert.ok(jsMatch, "app.js must include ?v= cache-buster");
  assert.equal(cssMatch[1], jsMatch[1], "style.css and app.js cache-buster versions should match");
});

test("all requireEl() IDs exist uniquely in index.html", () => {
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, "Duplicate element IDs found in index.html");
  const requiredIds = [...js.matchAll(/requireEl\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(requiredIds.length > 0, "Expected requireEl() calls in app.js");
  for (const id of requiredIds) {
    assert.ok(htmlIds.includes(id), `Missing #${id} in index.html`);
  }
});

test("layout CSS and hidden custom catalog input guards", () => {
  assert.match(css, /\.config\s*\{[^}]*display:\s*flex;\s*flex-direction:\s*column;/);
  assert.match(css, /\.actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/);
  assert.match(css, /\.hidden\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /color-scheme:\s*dark;/);
  assert.match(html, /<input\s+id="dbBase"[^>]*\bhidden\b/);
});

test("Endpoint Dashboard, Best Maps guide, Map Splits log, 15s Auto-Pause, Level ETA, and PiP Mini Overlay are wired", () => {
  for (const id of [
    "tabHud",
    "tabGuide",
    "tabHistory",
    "grindStateBadge",
    "wasmStatusBadge",
    "wgTunnelStatus",
    "endpointStatusBadge",
    "outboundIpTag",
    "wasmNodeDetail",
    "downloadWgConfBtn",
    "pipBtn",
    "toggleConfigBtn",
    "manualLevelInput",
    "charJob",
    "levelPct",
    "ttl",
    "levelProgressBar",
    "xph5m",
    "npcValueTag",
    "guideLevel",
    "guideJob",
    "guideSort",
    "guideSearch",
    "guideList",
    "splitsTableBody",
    "exportSplitsBtn",
    "clearSplitsBtn",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `Expected #${id} in index.html`);
  }
  assert.match(js, /CLASSIC_EXP_TABLE/);
  assert.match(js, /AUTO_PAUSE_IDLE_MS\s*=\s*15_000/);
  assert.match(js, /function initCodecWasm\(\)/);
  assert.match(js, /function ingestRawChunkWasm\(/);
  assert.match(js, /function probeEndpointStatus\(\)/);
  assert.match(js, /function buildGuideIndex\(\)/);
  assert.match(js, /function renderGuide\(\)/);
  assert.match(js, /function renderSplitsTable\(\)/);
  assert.match(js, /function togglePipOverlay\(\)/);
});

test("codec.wasm is valid WebAssembly and public repo contains zero plaintext MapleStory opcodes or codec.go", async () => {
  assert.ok(!existsSync(new URL("./forwarder/codec.go", import.meta.url)), "forwarder/codec.go must not exist in public repo");

  const wasmBytes = readFileSync(new URL("./codec.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const { get_in_ptr, get_res_ptr, check_header, decode_frame } = /** @type {any} */ (instance.exports);
  assert.equal(typeof get_in_ptr, "function");
  assert.equal(typeof get_res_ptr, "function");
  assert.equal(check_header(0x1111, 0x1111 ^ 32), 32);
  assert.equal(typeof decode_frame, "function");

  const mainGo = readFileSync(new URL("./forwarder/main.go", import.meta.url), "utf8");
  for (const forbidden of [
    "0x007e",
    "0x008b",
    "0x01a9",
    "0x02a8",
    "0x02a9",
    "0x02aa",
    "0x03c9",
    "0x03d4",
    "0x03d5",
    "0x03f3",
    "0x5A3C",
    "You have gained",
    "StatChanged",
    "SetField",
    "MobLeaveField",
  ]) {
    assert.ok(!js.includes(forbidden), `Secret signature "${forbidden}" must not appear in app.js`);
    assert.ok(!mainGo.includes(forbidden), `Secret signature "${forbidden}" must not appear in forwarder/main.go`);
  }

  // Verify forwarder/main.go is a clean, UI-free open-source relay using golang.org/x/net/websocket
  assert.match(mainGo, /golang\.org\/x\/net\/websocket/);
  assert.match(mainGo, /Access-Control-Allow-Private-Network/);
  assert.match(mainGo, /NewPhysicalNICDialer/);
  assert.ok(!mainGo.includes("<!DOCTYPE html>"), "forwarder/main.go must not embed its own HTML UI");
});
