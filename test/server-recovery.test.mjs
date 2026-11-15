import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseConsoleLine } from "../src/lib/console-log.mjs";
import { createStartupMonitor } from "../src/lib/startup-monitor.mjs";
import { defaultAppOptions } from "../src/lib/app-settings-options.mjs";

const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const setup = main.slice(main.indexOf("function savePackSetup("), main.indexOf("function runtimeSnapshot("));
const lifecycle = main.slice(main.indexOf("async function retryPackStartup("), main.indexOf("function performWorldBackup("));
const stop = main.slice(main.indexOf("async function stopServer("), main.indexOf("async function runDueBackups("));

function fixture(server = { name: "Fixture" }) {
  const timers = new Map();
  const startupChecks = new Map();
  let elapsed = 0;
  const children = [];
  const notifications = [];
  const runningServers = new Map();
  const metadataUpdates = [];
  const context = vm.createContext({
    AbortController,
    Date: class extends Date { static now() { return Date.now() + elapsed; } },
    runningServers, RECOVERY_DELAYS_MS: [5000, 10000, 20000], RECOVERY_RESET_MS: 300000,
    quitInProgress: false, quitAfterTransfers: false, quitPromptOpen: false,
    normalizeServerId: Number, getServer: () => server, eulaAccepted: () => true,
    loadServerProperties: () => ({ values: {} }), serverEndpoint: () => ({}),
    probeServerPort: async () => ({ available: true }), assertJavaInstalled: async () => ({ details: { version: "21" }, source: "system" }), javaAssignment: () => ({}),
    launchCommand: () => ["java", []], updateServerMetadata: (_folder, updates) => {
      metadataUpdates.push(updates);
      Object.assign(server, updates);
    },
    memorySettings: () => ({ minMemoryMb: 512, maxMemoryMb: 4096 }),
    appendLog: (runtime, text) => runtime.logs.push(text),
    runtimeSnapshot: (id) => ({ ...runningServers.get(id) }),
    runningEntry: () => [...runningServers].find(([, runtime]) => runtime.process),
    getServerOperation: () => null,
    runStopBackup: async () => {},
    notifyServerEvent: preference => notifications.push(preference),
    appPreferences: () => ({ snapshot: () => ({ options: defaultAppOptions }) }),
    createStartupMonitor, readStartupCrashReport: async () => [],
    setInterval: callback => { const timer = Symbol(); startupChecks.set(timer, callback); return timer; },
    clearInterval: timer => startupChecks.delete(timer),
    withServerOperation: async (_id, _label, task) => task(),
    setTimeout: (callback, ms) => { const timer = Symbol(); timers.set(timer, { callback, ms }); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
    spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.pid = children.length + 1;
      Object.assign(child, { command, args, options });
      child.stdin = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin.write = () => {};
      children.push(child);
      return child;
    },
  });
  vm.runInContext(setup + lifecycle + stop, context);
  return {
    context, children, timers, notifications, metadataUpdates,
    runtime: () => runningServers.get(1),
    advanceStartup: ms => {
      elapsed += ms;
      startupChecks.forEach(check => check());
    },
    ready: () => children.at(-1).stdout.emit("data", Buffer.from("Done (2.0s)! For help, type help\n")),
    exit: (code) => children.at(-1).emit("close", code, null),
    runTimer: async () => {
      const [id, { callback, ms }] = timers.entries().next().value;
      timers.delete(id);
      await callback();
      return ms;
    },
  };
}

test("crash recovery keeps the crash log and stops after three failed restart attempts", async () => {
  const server = fixture();
  await server.context.startServer(1);
  server.ready();
  server.exit(1);
  for (const delay of [5000, 10000, 20000]) {
    assert.equal(server.runtime().status, "recovering");
    assert.equal(await server.runTimer(), delay);
    server.exit(1);
  }
  assert.equal(server.children.length, 4);
  assert.equal(server.timers.size, 0);
  assert.equal(server.runtime().status, "crashed");
  assert.match(server.runtime().logs.join("\n"), /Server crashed.*\n[\s\S]*recovery stopped after three/);
});

test("an exit before readiness produces an Errors entry", async () => {
  const server = fixture();
  await server.context.startServer(1);
  server.exit(1);
  assert.equal(server.runtime().status, "crashed");
  assert.equal(server.runtime().startupFailed, true);
  const entry = parseConsoleLine(server.runtime().logs.at(-1));
  assert.equal(entry.level, "error");
  assert.match(entry.message, /startup failed.*exit code 1/);
});

test("a legacy saved modpack gains a persistent repair state when startup fails", async () => {
  const setup = { id: 1, name: "Legacy pack", modpack: { name: "Legacy pack", version: "1" } };
  const server = fixture(setup);
  await server.context.startServer(1);
  server.exit(1);
  assert.equal(setup.modpackSetup.status, "repair");
  assert.equal(server.runtime().modpackSetup.diagnosis, server.runtime().startupDiagnosis);
});

test("bundled dependency repair commits only after startup verification and rolls back on failure or cancel", async () => {
  const diagnosis = { kind: "dependency", problem: "A required mod is missing.", evidence: [] };
  const setup = { id: 1, name: "Pack", folderPath: "saved-pack", modpackSetup: { status: "repair", diagnosis } };
  const server = fixture(setup);
  const transaction = {};
  const candidate = { id: "exact-bundled-file", name: "Bundled Library" };
  let enabled = false;
  let checks = 0;
  let committed = 0;
  let rolledBack = 0;
  let currentCandidate;
  server.context.findBundledPackDependency = async () => currentCandidate;
  server.context.assertJavaInstalled = async () => {
    assert.equal(enabled, true);
    return { details: { version: "21" }, source: "system" };
  };
  server.context.setAddonEnabled = (actualServer, id, enable) => {
    assert.equal(actualServer, setup);
    assert.equal(id, candidate.id);
    assert.equal(enable, true);
    enabled = true;
    return { transaction };
  };
  server.context.rollbackAddonTransaction = value => {
    assert.equal(value, transaction);
    rolledBack++;
    enabled = false;
  };
  server.context.commitAddonTransaction = value => {
    assert.equal(value, transaction);
    committed++;
  };
  const retry = () => server.context.startServer(1, { repairBundledDependency: true });
  assert.equal((await retry()).bundledDependencyUnavailable, true);
  assert.equal(enabled, false);

  currentCandidate = candidate;
  server.context.verifyPackServer = async actualServer => {
    checks++;
    assert.equal(actualServer.folderPath, "saved-pack");
    assert.equal(enabled, true);
    throw Object.assign(new Error("Another mod blocked startup."), { diagnosis: { problem: "Another mod blocked startup.", evidence: [] } });
  };
  const failed = await retry();
  assert.equal(failed.repairController, null);
  assert.match(failed.startupDiagnosis.problem, /disabled again/);
  assert.equal(enabled, false);
  assert.equal(rolledBack, 1);
  assert.equal(committed, 0);
  assert.equal(server.children.length, 0);

  let readyToCancel;
  const checking = new Promise(resolve => { readyToCancel = resolve; });
  server.context.verifyPackServer = async (_server, _java, signal) => {
    checks++;
    assert.equal(enabled, true);
    readyToCancel();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const pending = retry();
  await checking;
  server.context.stopServerRequest(1);
  const cancelled = await pending;
  assert.equal(cancelled.status, "offline");
  assert.equal(cancelled.repairController, null);
  assert.equal(enabled, false);
  assert.equal(rolledBack, 2);
  assert.equal(committed, 0);
  assert.equal(server.children.length, 0);

  server.context.verifyPackServer = async () => { checks++; assert.equal(enabled, true); };
  const passed = await retry();
  assert.equal(passed.status, "starting");
  assert.equal(checks, 3);
  assert.equal(rolledBack, 2);
  assert.equal(committed, 1);
  assert.equal(enabled, true);
  assert.equal(server.children.length, 1);
  assert.equal(setup.modpackSetup.status, "verified");
});

test("repair retry tests the saved installation and starts it only after verification", async () => {
  const setup = { id: 1, name: "Pack", folderPath: "saved-pack", modpackSetup: { status: "repair" } };
  const fixtureServer = fixture(setup);
  const diagnosis = { kind: "dependency", problem: "A required mod is missing." };
  fixtureServer.context.verifyPackServer = async server => {
    assert.equal(server.folderPath, "saved-pack");
    throw Object.assign(new Error(diagnosis.problem), { diagnosis });
  };
  await fixtureServer.context.startServer(1);
  assert.equal(fixtureServer.children.length, 0);
  assert.equal(setup.modpackSetup.diagnosis, diagnosis);

  fixtureServer.context.verifyPackServer = async server => assert.equal(server.folderPath, "saved-pack");
  await fixtureServer.context.startServer(1);
  assert.equal(fixtureServer.children.length, 1);
  assert.equal(fixtureServer.runtime().status, "starting");
  fixtureServer.ready();
  assert.equal(fixtureServer.runtime().status, "running");
  assert.equal(setup.modpackSetup.status, "verified");
});

test("cancelling a repair check preserves the saved repair status and skips normal startup", async () => {
  const original = { status: "repair", diagnosis: { kind: "dependency" } };
  const setup = { id: 1, name: "Pack", modpackSetup: original };
  const fixtureServer = fixture(setup);
  let started;
  const checking = new Promise(resolve => { started = resolve; });
  fixtureServer.context.verifyPackServer = async (_server, _java, signal) => {
    started();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const result = fixtureServer.context.startServer(1);
  await checking;
  fixtureServer.context.stopServerRequest(1);
  assert.equal((await result).status, "offline");
  assert.equal(setup.modpackSetup, original);
  assert.equal(fixtureServer.children.length, 0);
  assert.equal(fixtureServer.metadataUpdates.length, 0);
});

test("a fatal loader report marks the live process as failed and preserves the diagnosis when it exits", async () => {
  const server = fixture();
  await server.context.startServer(1);
  server.children[0].stderr.emit("data", Buffer.from(
    "[main/ERROR]: Mod loading failed\nCaused by: java.lang.RuntimeException: Attempted to load class net/minecraft/client/Minecraft for invalid dist DEDICATED_SERVER from mod citresewn\n"
  ));
  assert.equal(server.runtime().status, "startup-failed");
  assert.equal(server.runtime().startupDiagnosis.mod, "citresewn");
  assert.ok(server.runtime().process);
  server.exit(1);
  assert.equal(server.runtime().status, "crashed");
  assert.equal(server.runtime().startupDiagnosis.kind, "client-mod");
  assert.deepEqual(server.notifications, ["notifyCrash"]);
});

test("a running process stalls without being stopped and can still reach readiness", async () => {
  const server = fixture();
  await server.context.startServer(1);
  server.advanceStartup(5 * 60_000);
  assert.equal(server.runtime().status, "startup-stalled");
  assert.equal(server.runtime().startupDiagnosis.kind, "stall");
  assert.ok(server.runtime().process);
  server.ready();
  assert.equal(server.runtime().status, "running");
  assert.equal(server.runtime().startupDiagnosis, null);
  assert.deepEqual(server.notifications, ["notifyReady"]);
});

test("stopping during startup does not mark the attempt as failed", async () => {
  const server = fixture();
  await server.context.startServer(1);
  const stopping = server.context.stopServer(1);
  server.exit(1);
  await stopping;
  assert.equal(server.runtime().startupFailed, false);
});

test("normal stop and canceling a pending recovery never start another process", async () => {
  const server = fixture();
  await server.context.startServer(1);
  server.ready();
  const stopping = server.context.stopServer(1);
  server.exit(1);
  await stopping;
  assert.equal(server.timers.size, 0);

  await server.context.startServer(1);
  server.ready();
  server.exit(1);
  assert.equal(server.runtime().status, "recovering");
  await server.context.stopServer(1);
  assert.equal(server.runtime().status, "offline");
  assert.equal(server.timers.size, 0);
  assert.equal(server.children.length, 2);
});

test("recovery leaves the server offline if its port is now in use", async () => {
  const server = fixture();
  await server.context.startServer(1);
  server.ready();
  server.exit(1);
  server.context.probeServerPort = async () => ({ available: false });
  server.context.serverEndpoint = () => ({ port: 25565 });
  await server.runTimer();
  assert.equal(server.children.length, 1);
  assert.equal(server.runtime().status, "offline");
  assert.match(server.runtime().logs.at(-1), /Port 25565 is in use/);
});

test("Forge and Paper can run concurrently with their own Java and launch arguments", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "blockhost-parallel-java-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const forgeDir = path.join(temp, "Cisco Forge Server");
  const paperDir = path.join(temp, "Paper Server");
  const argsFile = path.join("libraries", "net", "minecraftforge", "forge", "1.19.2-43.5.1", "win_args.txt");
  fs.mkdirSync(path.dirname(path.join(forgeDir, argsFile)), { recursive: true });
  fs.mkdirSync(paperDir);
  fs.writeFileSync(path.join(forgeDir, argsFile), "forge args");
  const paperJar = path.join(paperDir, "server.jar");
  fs.writeFileSync(paperJar, "paper jar");

  const { context, children } = fixture();
  Object.assign(context, { fs, path });
  vm.runInContext(main.slice(main.indexOf("function launchCommand("), main.indexOf("async function startServer(")), context);
  context.getServer = (id) => id === 1
    ? { id, name: "Cisco", version: "1.19.2", folderPath: forgeDir, launchType: "javaArgsFile", launchArgsPath: argsFile }
    : { id, name: "Paper", version: "1.21.11", folderPath: paperDir, jarPath: paperJar };
  context.loadServerProperties = folder => ({ values: { port: folder === forgeDir ? 25565 : 25566 } });
  context.serverEndpoint = endpoint => endpoint;
  context.assertJavaInstalled = async server => {
    const version = server.id === 1 ? "17" : "21";
    return { command: path.join(temp, "Java " + version, "bin", "java.exe"), details: { version }, source: "managed" };
  };
  const launches = await Promise.all([context.startServer(1), context.startServer(2)]);
  assert.equal(launches.every(item => item.status === "starting"), true);
  const forge = children.find(child => child.options.cwd === forgeDir);
  const paper = children.find(child => child.options.cwd === paperDir);
  assert.equal(forge.command, path.join(temp, "Java 17", "bin", "java.exe"));
  assert.equal(paper.command, path.join(temp, "Java 21", "bin", "java.exe"));
  assert.equal(JSON.stringify(forge.args), JSON.stringify(["-Dblockhost.serverId=1", "-Xms512M", "-Xmx4096M", "@" + path.join(forgeDir, argsFile), "nogui"]));
  assert.equal(JSON.stringify(paper.args.slice(-3)), JSON.stringify(["-jar", paperJar, "nogui"]));
});

test("clean process exit triggers one backup and stop waits for it", async () => {
  const server = fixture();
  const { context } = server;
  const backupBody = main.slice(main.indexOf("async function runStopBackup("), main.indexOf("async function stopServer("));
  vm.runInContext(backupBody, context);
  let enabled = true;
  let backups = 0;
  let finish;
  context.getBackupSettings = () => ({ enabled, destination: "backup-folder" });
  context.worldBackupsInProgress = new Map();
  context.performWorldBackup = () => {
    backups += 1;
    return new Promise(resolve => { finish = resolve; });
  };

  await context.startServer(1);
  const stopping = context.stopServer(1);
  server.exit(0);
  await Promise.resolve();
  assert.equal(backups, 1);
  assert.equal(await Promise.race([stopping.then(() => "stopped"), Promise.resolve("pending")]), "pending");
  finish();
  await stopping;
  await context.stopServer(1);
  assert.equal(backups, 1);

  await context.startServer(1);
  server.exit(0);
  await Promise.resolve();
  assert.equal(backups, 2, "a clean console stop also backs up");
  finish();
  await server.runtime().shutdownBackup;

  enabled = false;
  await context.startServer(1);
  server.exit(0);
  await server.runtime().shutdownBackup;
  assert.equal(backups, 2);
});
