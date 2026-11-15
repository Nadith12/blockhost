import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStartupMonitor, readStartupCrashReport } from "../src/lib/startup-monitor.mjs";

test("routine errors do not fail startup, progress extends the idle window and the total cap still applies", () => {
  const monitor = createStartupMonitor(0, { startupIdleMinutes: 2, startupDeadlineMinutes: 5 });
  monitor.observe("[Server thread/ERROR]: Could not load plugin Example", 60_000);
  assert.equal(monitor.check(60_000), "starting");
  assert.equal(monitor.check(120_000), "idle");
  monitor.observe("[Server thread/INFO]: Preparing spawn area: 42%", 125_000);
  assert.equal(monitor.check(180_000), "starting");
  monitor.observe("[Server thread/INFO]: Preparing spawn area: 42%", 235_000);
  assert.equal(monitor.check(245_000), "idle");
  monitor.observe("[Server thread/INFO]: Preparing spawn area: 87%", 295_000);
  assert.equal(monitor.check(300_000), "deadline");
  assert.equal(monitor.observe("[Server thread/INFO]: Done (304.123s)! For help, type \"help\"", 304_000), true);
});

for (const [name, line, kind] of [
  ["Fabric", "[main/ERROR]: net.fabricmc.loader.impl.FormattedException: Incompatible mods found!", "incompatible-mod"],
  ["Forge", "[main/ERROR] [loading/]: Missing or unsupported mandatory dependencies:", "dependency"],
  ["NeoForge", "[main/ERROR]: Mod loading failed: ModLoadingException: incompatible version", "incompatible-mod"],
  ["Paper", "[Server thread/WARN]: **** FAILED TO BIND TO PORT!", "port"],
  ["Vanilla", "Error: Could not create the Java Virtual Machine.", "java"],
]) {
  test(`${name} fatal startup signatures carry actionable evidence`, () => {
    const monitor = createStartupMonitor(0);
    monitor.observe(line, 100);
    assert.equal(monitor.check(100), "startup-failed");
    const diagnosis = monitor.diagnose("startup-failed");
    assert.equal(diagnosis.kind, kind);
    assert.deepEqual(diagnosis.evidence, [line]);
    assert.ok(diagnosis.fix);
  });
}

test("Fabric's missing mod takes priority over a nested Minecraft version report and a client-class warning", () => {
  const monitor = createStartupMonitor(0);
  monitor.observe("[main/WARN]: Attempted to load class net/minecraft/client/Minecraft for invalid dist DEDICATED_SERVER", 100);
  monitor.observe("[main/ERROR]: Incompatible mods found!", 101);
  monitor.observe("- Mod 'Statement Vanilla Compatibility Module' (statement_vanilla_compatibility) 1.0.1+1.14.4-1.15.2 requires any version between 1.14.0-0 (inclusive) and 1.16.0-0 (exclusive) of 'Minecraft' (minecraft), but only the wrong version is present: 1.20.1!", 102);
  monitor.observe("\u001b[31m- Mod 'Forge Config Screens' (forgeconfigscreens) 8.0.2 requires any version of modmenu, which is missing!\u001b[0m", 103);
  const diagnosis = monitor.diagnose("startup-failed");
  assert.equal(diagnosis.kind, "dependency");
  assert.equal(diagnosis.mod, "forgeconfigscreens");
  assert.match(diagnosis.cause, /Forge Config Screens needs modmenu/);
  assert.deepEqual(diagnosis.requirements.map(({ kind, modId, installedVersion }) => [kind, modId, installedVersion]), [
    ["incompatible", "minecraft", "1.20.1"],
    ["missing", "modmenu", ""],
  ]);
  assert.ok(diagnosis.evidence.some(line => line.startsWith("- Mod 'Forge Config Screens'")));
});

test("Forge preserves version ranges, distinguishes a missing mod, and deduplicates its output", () => {
  const monitor = createStartupMonitor(0);
  const missing = "Mod ID: 'creativecore', Requested by: 'playerrevive', Expected range: '[2.11.20,)', Actual version: '[MISSING]'";
  monitor.observe(missing, 100);
  monitor.observe(`[main/ERROR] [loading/]: ${missing}`, 101);
  monitor.observe("Mod ID: 'balm', Requested by: 'waystones', Expected range: '[7.3.37,)', Actual version: '7.3.10'", 102);
  assert.deepEqual(monitor.diagnose("crashed").requirements, [
    { kind: "missing", modId: "creativecore", requiredBy: "playerrevive", version: "[2.11.20,)", installedVersion: "" },
    { kind: "incompatible", modId: "balm", requiredBy: "waystones", version: "[7.3.37,)", installedVersion: "7.3.10" },
  ]);
});

test("Fabric distinguishes a server-disabled dependency and a loader mismatch", () => {
  const monitor = createStartupMonitor(0);
  monitor.observe("- Mod 'Options Screen' (optionsscreen) 1.0 requires any version of modmenu, which is disabled for this environment (client/server only)!", 100);
  const diagnosis = monitor.diagnose("crashed");
  assert.equal(diagnosis.kind, "client-mod");
  assert.equal(diagnosis.requirements[0].kind, "environment");
  assert.match(diagnosis.cause, /Options Screen needs modmenu/);
  const loader = createStartupMonitor(0);
  loader.observe("- Mod 'Fabric API' (fabric-api) 0.92.0+1.20.1 requires version 0.15.6 or later of mod 'Fabric Loader' (fabricloader), but only the wrong version is present: 0.14.21!", 100);
  assert.equal(loader.diagnose("crashed").kind, "runtime");
  assert.match(loader.diagnose("crashed").cause, /Fabric Loader \(version 0\.15\.6 or later\).*Found 0\.14\.21/);
});

test("Java class-version errors override a generic mixin error without treating memory errors as version requirements", () => {
  const monitor = createStartupMonitor(0);
  monitor.observe("org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered", 100);
  monitor.observe("Caused by: java.lang.UnsupportedClassVersionError: example/Test has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0", 101);
  const diagnosis = monitor.diagnose("crashed");
  assert.equal(diagnosis.kind, "java");
  assert.equal(diagnosis.javaMajor, 21);
  const memory = createStartupMonitor(0);
  memory.observe("Error: Could not reserve enough space for 4194304KB object heap", 100);
  assert.equal(memory.diagnose("startup-failed").kind, "java");
  assert.equal(memory.diagnose("startup-failed").javaMajor, undefined);
});

test("dependency-shaped log content never turns a file path or URL into a mod ID", () => {
  const monitor = createStartupMonitor(0);
  monitor.observe("- Mod 'Test' (test) 1.0 requires any version of https://example.com/mod.jar, which is missing!", 100);
  assert.equal(monitor.diagnose("crashed").requirements, undefined);
});

test("reads only fresh server crash reports and uses their cause and mod attribution", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "blockhost-startup-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const reports = path.join(folder, "crash-reports");
  await fs.mkdir(reports);
  const stale = path.join(reports, "crash-2025-01-01_10.00.00-server.txt");
  await fs.writeFile(stale, "Description: Stale startup failure");
  await fs.utimes(stale, 10, 10);
  const startedAt = Date.now() - 100;
  assert.deepEqual(await readStartupCrashReport(folder, startedAt), []);
  await fs.writeFile(path.join(reports, "crash-2026-01-01_10.00.00-server.txt"),
    "Description: Exception in server tick loop\njava.lang.RuntimeException: Could not execute entrypoint stage 'main', provided by 'citresewn'\nCaused by: java.lang.NoClassDefFoundError: net/minecraft/client/Minecraft");
  const lines = await readStartupCrashReport(folder, startedAt);
  const diagnosis = createStartupMonitor(startedAt).diagnose("crashed", "exit code 1", lines);
  assert.equal(diagnosis.mod, "citresewn");
  assert.equal(diagnosis.kind, "client-mod");
});
