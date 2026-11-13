import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
