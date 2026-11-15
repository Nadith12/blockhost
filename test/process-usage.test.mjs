import assert from "node:assert/strict";
import test from "node:test";
import { aggregateProcessTreeUsage } from "../src/lib/process-usage.mjs";

test("process usage includes every descendant JVM and excludes unrelated processes", () => {
  const [usage] = aggregateProcessTreeUsage([
    { pid: 100, parentPid: 1, cpuRaw: 0, ramBytes: 5 * 1024 * 1024 },
    { pid: 101, parentPid: 100, cpuRaw: 16, ramBytes: 1400 * 1024 * 1024 },
    { pid: 102, parentPid: 101, cpuRaw: 8, ramBytes: 20 * 1024 * 1024 },
    { pid: 200, parentPid: 1, cpuRaw: 80, ramBytes: 999 * 1024 * 1024 },
  ], [100], 8);
  assert.equal(usage.processCount, 3);
  assert.equal(usage.cpuPercent, 3);
  assert.equal(usage.ramBytes, 1425 * 1024 * 1024);
});

test("process usage safely handles a root that disappeared between samples", () => {
  const [usage] = aggregateProcessTreeUsage([], [999], 16);
  assert.deepEqual(usage, { pid: 999, processCount: 1, cpuPercent: 0, ramBytes: 0 });
});
