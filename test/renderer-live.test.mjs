import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { updateOnlinePlayers } from "../src/lib/console-log.mjs";
import { diagnosticLinks } from "../src/lib/diagnostic-links.mjs";

// Exercise the actual renderer functions with a small DOM/IPC stand-in.
const source = fs.readFileSync(new URL("../src/renderer.js", import.meta.url), "utf8");
function rendererFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1);
  const rest = source.slice(start);
  const end = rest.indexOf("\nfunction ", 1);
  return rest.slice(0, end);
}

test("unchanged console refresh preserves DOM and manual scroll position", () => {
  let writes = 0;
  const output = { scrollHeight: 1000, scrollTop: 100, clientHeight: 300, set innerHTML(value) { writes++; } };
  const context = vm.createContext({
    document: { getElementById: (id) => id === "consoleOutput" ? output : null },
    state: { consoleAutoScroll: false }, consoleOutputMarkup: new WeakMap(),
    renderConsoleRows: () => "<div>unchanged log</div>", consoleErrorCount: () => 0,
  });
  vm.runInContext(`${rendererFunction("syncConsoleOutput")}\nsyncConsoleOutput(); syncConsoleOutput();`, context);
  assert.equal(writes, 1);
  assert.equal(output.scrollTop, 100);
});

test("log bursts render once per animation frame and do not render while hidden", () => {
  const callbacks = [];
  let paints = 0;
  const context = vm.createContext({
    consoleFrame: null, document: { hidden: false },
    requestAnimationFrame: (fn) => { callbacks.push(fn); return callbacks.length; },
    syncConsoleOutput: () => { paints++; },
  });
  vm.runInContext(rendererFunction("scheduleConsoleOutput"), context);
  for (let i = 0; i < 200; i++) context.scheduleConsoleOutput();
  assert.equal(callbacks.length, 1);
  callbacks[0]();
  assert.equal(paints, 1);
  context.document.hidden = true;
  context.scheduleConsoleOutput();
  assert.equal(callbacks.length, 1);
});

test("diagnostics include context around separated errors and redact Windows usernames", () => {
  const logs = Array.from({ length: 50 }, (_, id) => ({ id, raw: `Log line ${id}` }));
  logs[10].raw = String.raw`First error in C:\Users\TestUser\server`;
  logs[40].raw = "Second error";
  const context = vm.createContext({
    state: { runtime: { status: "offline" } },
    selectedServer: () => ({ name: "Test server", type: "fabric", version: "1.21.11" }),
    consoleEntries: () => logs,
    errors: [logs[10], logs[40]],
  });
  const report = vm.runInContext(`${rendererFunction("diagnosticText")}\ndiagnosticText(errors)`, context);
  assert.match(report, /Minecraft: 1\.21\.11/);
  assert.match(report, /Log line 9\nFirst error in C:\\Users\\<user>\\server\nLog line 11/);
  assert.match(report, /Log line 39\nSecond error\nLog line 41/);
  assert.doesNotMatch(report, /Log line 25|TestUser/);
});

function liveContext(runtime, usagePromise) {
  const context = vm.createContext({
    state: { selectedId: 1, runtime: structuredClone(runtime) }, liveRefreshSequence: 0,
    window: { minecraftAPI: { getRuntime: async () => structuredClone(runtime), getUsage: () => usagePromise } },
    updateLiveElements: () => {}, updateOnlinePlayers, render: () => {},
    consoleEntries: () => [], diagnosticText: () => "Startup crash report",
    showServerView: (view) => { context.state.serverView = view; },
  });
  vm.runInContext(`${rendererFunction("applyRuntime")}\n${rendererFunction("refreshLive")}\n${rendererFunction("startServer")}`, context);
  return context;
}

test("Start opens the console before the launch responds", async () => {
  const context = liveContext({ serverId: 1, status: "offline", logs: [] }, Promise.resolve(null));
  context.state.serverView = "overview";
  let finish;
  context.window.minecraftAPI.startServer = () => new Promise((resolve) => { finish = resolve; });
  const starting = context.startServer();
  assert.equal(context.state.serverView, "console");

  finish({ serverId: 1, status: "starting", logs: [] });
  await starting;
  context.state.serverView = "overview";
  context.window.minecraftAPI.getRuntime = async () => ({ serverId: 1, status: "running", logs: [] });
  await context.refreshLive();
  assert.equal(context.state.serverView, "overview");
});

test("opening an already running server stays on overview", async () => {
  const context = liveContext({ serverId: 1, status: "running", logs: [] }, Promise.resolve(null));
  context.state.runtime = null;
  context.state.serverView = "overview";
  await context.refreshLive();
  assert.equal(context.state.serverView, "overview");
});

test("a startup crash opens Errors even if polling missed Starting", async () => {
  const context = liveContext({ serverId: 1, status: "offline", startedAt: "attempt", startupFailed: true, logs: [] }, Promise.resolve(null));
  context.state.runtime = { status: "offline" };
  context.state.serverView = "overview";
  context.state.consoleSearch = "old search";
  await context.refreshLive();
  assert.equal(context.state.serverView, "console");
  assert.equal(context.state.consoleFilter, "errors");
  assert.equal(context.state.consoleSearch, "");
  assert.equal(context.state.startupDiagnostics, true);

  context.state.serverView = "overview";
  context.state.startupDiagnostics = "";
  await context.refreshLive();
  assert.equal(context.state.serverView, "overview");
  assert.equal(context.state.startupDiagnostics, "");
});

test("the startup crash dialog offers clipboard diagnostics and plain browser links", () => {
  const context = vm.createContext({ state: { startupDiagnostics: "Private test report", runtime: { status: "crashed" } }, diagnosticLinks, escapeHtml: String });
  const markup = vm.runInContext(`${rendererFunction("statusLabel")}\n${rendererFunction("renderStartupCrashModal")}\nrenderStartupCrashModal()`, context);
  assert.match(markup, /<dialog.*startupCrashDialog/);
  assert.match(markup, /id="copyStartupDiagnostics"/);
  for (const { url } of diagnosticLinks) assert.ok(markup.includes(`href="${url}" target="_blank"`));
  assert.doesNotMatch(markup, /Private test report/);
});

test("slow resource polling cannot replace the newly selected server", async () => {
  let finish;
  const context = liveContext({ serverId: 1, logs: [] }, new Promise((resolve) => { finish = resolve; }));
  const pending = context.refreshLive();
  context.state.selectedId = 2;
  context.state.runtime = { serverId: 2, logs: [] };
  finish({ processes: [] });
  await pending;
  assert.equal(context.state.runtime.serverId, 2);
});

test("logs and player joins received during a poll survive its older snapshot", async () => {
  let finish;
  const context = liveContext({ serverId: 1, startedAt: "session", logs: [{ id: 1 }], onlinePlayers: [] }, new Promise((resolve) => { finish = resolve; }));
  const pending = context.refreshLive();
  context.state.runtime.logs.push({ id: 2, event: "player-join", playerName: "Alex" });
  finish({ processes: [] });
  await pending;
  assert.deepEqual(Array.from(context.state.runtime.logs, (row) => row.id), [1, 2]);
  assert.deepEqual(Array.from(context.state.runtime.onlinePlayers), ["Alex"]);
});
