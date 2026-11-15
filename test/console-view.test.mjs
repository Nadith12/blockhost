import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleViewCache } from "../src/lib/console-view.mjs";
import { parseConsoleLine } from "../src/lib/console-log.mjs";

const entry = (raw, id) => parseConsoleLine(raw, { id, receivedAt: "2026-11-05T01:00:00Z" });

test("unchanged IPC snapshots reuse normalization and rendered rows", () => {
  let normalized = 0;
  let rendered = 0;
  const cache = createConsoleViewCache((value) => { normalized++; return value; }, (value) => { rendered++; return value.message; });
  const logs = [entry("Hello", 1), entry("World", 2)];
  const first = cache.entries(logs, [1, "session"]);
  for (let i = 0; i < 50; i++) {
    const next = cache.entries(structuredClone(logs), [1, "session"]);
    assert.equal(next, first);
    assert.deepEqual(next.map(cache.row), ["Hello", "World"]);
  }
  assert.equal(normalized, 2);
  assert.equal(rendered, 2);
});

test("appending, editing, rotating and switching sessions invalidate snapshots", () => {
  let normalized = 0;
  const cache = createConsoleViewCache((value) => { normalized++; return value; }, (value) => value.raw);
  const logs = [entry("First", 1)];
  cache.entries(logs, "a");
  logs.push(entry("Second", 2));
  assert.equal(cache.entries(logs, "a").length, 2);
  logs[0] = entry("Changed", 1);
  assert.equal(cache.entries(logs, "a")[0].message, "Changed");
  logs.shift();
  assert.equal(cache.entries(logs, "a")[0].id, 2);
  const count = normalized;
  cache.entries(logs, "b");
  assert.equal(normalized, count + 1);
});

test("error groups stay correct after log rotation and rows do not reuse stale content", () => {
  const cache = createConsoleViewCache((value) => value, (value) => `${value.raw}:${value.errorGroupId}`);
  const logs = [entry("[APP] Start failed: Java", 1), entry("  at net.Main.run(Main.java:10)", 2), entry("Ready", 3)];
  const original = cache.entries(logs, 1);
  assert.equal(original[0].errorGroupId, original[1].errorGroupId);
  assert.ok(original[0].errorGroupId);
  const oldRow = cache.row(original[1]);
  const rotated = cache.entries(logs.slice(1), 1);
  assert.equal(rotated[0].errorGroupId, "");
  assert.notEqual(cache.row(rotated[0]), oldRow);
  assert.equal(logs[0].errorGroupId, "", "source entries must not be mutated");
});

test("rendered row storage is bounded", () => {
  let rendered = 0;
  const cache = createConsoleViewCache((value) => value, (value) => { rendered++; return value.raw; }, 2);
  const first = entry("One", 1);
  cache.row(first);
  cache.row(entry("Two", 2));
  cache.row(entry("Three", 3));
  cache.row(first);
  assert.equal(rendered, 4, "oldest row is evicted once capacity is reached");
});
