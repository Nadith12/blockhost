import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWriteFile } from "./safe-filesystem.mjs";
import { getPropertiesPath, parseProperties, serializeProperties } from "./server-properties.mjs";
import { serverPortIsListening } from "./server-port.mjs";
import { createStartupMonitor, readStartupCrashReport } from "./startup-monitor.mjs";
import { createTrialWorld } from "./world-manager.mjs";

const LOOPBACK = "127.0.0.1";
const DIMENSIONS_SAVED = /\bThreadedAnvilChunkStorage:\s+All dimensions are saved\s*$/;

function chooseLoopbackPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer(socket => socket.destroy());
    listener.once("error", reject);
    listener.listen({ port: 0, host: LOOPBACK, exclusive: true }, () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function observeLines(stream, observe) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop().slice(0, 1000);
    for (const line of lines) observe(line);
  });
  stream.once("end", () => { if (pending) observe(pending); });
}

function startupError(diagnosis, message) {
  const detail = diagnosis.evidence.slice(0, 4).join("\n");
  const error = new Error(message ?? `This pack did not pass its dedicated-server startup check. ${diagnosis.problem}${detail ? `\n${detail}` : ` ${diagnosis.cause}`}`);
  error.diagnosis = diagnosis;
  return error;
}

async function bootServer(folder, command, args, port, options) {
  const { signal, startupOptions, onReady, spawnImpl, readyForMs, shutdownTimeoutMs, savedShutdownGraceMs } = options;
  const startedAt = Date.now();
  const monitor = createStartupMonitor(startedAt, startupOptions);
  const child = spawnImpl(command, args, { cwd: folder, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let readyAt = 0;
  let stopRequested = false;
  let savedAt = 0;
  let exit, launchError;
  const closed = new Promise(resolve => child.once("close", (code, killedBy) => {
    exit = { code, killedBy };
    resolve(exit);
  }));
  child.once("error", error => { launchError = error; });
  child.stdin.on("error", error => { launchError ||= error; });
  const observe = line => {
    const now = Date.now();
    if (monitor.observe(line, now) && !readyAt) readyAt = now;
    if (stopRequested && !savedAt && DIMENSIONS_SAVED.test(line)) savedAt = now;
  };
  observeLines(child.stdout, observe);
  observeLines(child.stderr, observe);

  function waitForExit(milliseconds) {
    const timer = new AbortController();
    const waitSignal = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
    return Promise.race([closed, delay(milliseconds, null, { signal: waitSignal })]).finally(() => timer.abort());
  }

  async function failure(status, reason = "") {
    if (!exit && status === "startup-failed") await waitForExit(750);
    const report = await readStartupCrashReport(folder, startedAt);
    signal?.throwIfAborted();
    return startupError(monitor.diagnose(status, reason, report));
  }

  try {
    while (true) {
      signal?.throwIfAborted();
      const now = Date.now();
      const status = monitor.check(now);
      if (launchError) {
        throw startupError({
          kind: "launch",
          problem: "BlockHost could not launch the server.",
          cause: "The Java process could not open or communicate with BlockHost.",
          fix: "Check the Java runtime in Server settings, then retry.",
          evidence: [launchError.message],
        }, `Could not run the modpack startup check. ${launchError.message}`);
      }
      if (exit) throw await failure("crashed", `The server exited before verification finished (${exit.killedBy || exit.code}).`);
      if (status === "startup-failed") throw await failure(status);
      if (status === "deadline") throw await failure("startup-stalled", status);
      if (readyAt && now - readyAt >= readyForMs) break;
      await delay(200, undefined, { signal });
    }
    const listening = await serverPortIsListening({ host: LOOPBACK, port });
    signal?.throwIfAborted();
    if (!listening) {
      throw startupError({
        kind: "port",
        problem: "Minecraft reported readiness without a listening test port.",
        cause: "BlockHost could not reach the server at its private test address.",
        fix: "Retry startup. If it happens again, open Details for the server output.",
        evidence: monitor.diagnose("startup-failed").evidence,
      });
    }
    if (exit || monitor.check(Date.now()) === "startup-failed") throw await failure("crashed", "The server stopped during the readiness check.");
    onReady?.();
    stopRequested = true;
    child.stdin.write("stop\n");
    const shutdownDeadline = Date.now() + shutdownTimeoutMs;
    while (!exit && !launchError) {
      const deadline = savedAt ? Math.min(shutdownDeadline, savedAt + savedShutdownGraceMs) : shutdownDeadline;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await waitForExit(Math.min(remaining, 200));
    }
    signal?.throwIfAborted();
    // A verified test may have a non-daemon mod thread left after Minecraft saved and stopped.
    // Only the private test process is reaped here. Normal server shutdown is unchanged.
    if (!exit && savedAt && !launchError && monitor.check(Date.now()) !== "startup-failed") {
      return { forcedStopAfterSave: true };
    }
    if (!exit || exit.killedBy || exit.code !== 0 || launchError || monitor.check(Date.now()) === "startup-failed") {
      throw startupError({
        kind: "shutdown",
        problem: "The modpack reached startup but did not shut down cleanly after the test.",
        cause: "The server did not complete a clean stop and save.",
        fix: "Retry startup and check Details if the problem persists.",
        evidence: monitor.diagnose("startup-failed").evidence,
      });
    }
    return { forcedStopAfterSave: false };
  } finally {
    if (!exit) {
      child.kill("SIGKILL");
      await closed;
    }
  }
}

export async function verifyModpackStartup(folder, command, args, {
  signal, startupOptions, onReady, spawnImpl = spawn, readyForMs = 3000,
  shutdownTimeoutMs = 60_000, savedShutdownGraceMs = 5_000,
} = {}) {
  signal?.throwIfAborted();
  const properties = getPropertiesPath(folder);
  const original = await fs.readFile(properties);
  const parsed = parseProperties(original.toString("utf8"));
  let trial;
  let result;
  try {
    trial = await createTrialWorld(folder, parsed.values["level-name"], signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw startupError({
      kind: "setup",
      problem: "BlockHost could not make a copy of this world for the startup check.",
      cause: "The configured world folder could not be copied safely.",
      fix: "Check available disk space and the world folder in Server settings, then retry.",
      evidence: [error.message],
    });
  }
  try {
    const port = await chooseLoopbackPort().catch(error => {
      signal?.throwIfAborted();
      throw startupError({
        kind: "port",
        problem: "BlockHost could not open a private port for the startup check.",
        cause: "The system could not reserve a localhost port.",
        fix: "Retry startup and check Details if the problem persists.",
        evidence: [error.message],
      });
    });
    signal?.throwIfAborted();
    const overrides = serializeProperties(parseProperties(""), {
      "server-ip": LOOPBACK, "server-port": port, "enable-query": false, "enable-rcon": false,
      "enable-jmx-monitoring": false, "management-server-enabled": false, "level-name": trial.name,
    });
    // Java uses the final definition. Keep these overrides after every publisher setting.
    atomicWriteFile(properties, Buffer.concat([original, Buffer.from("\n\n" + overrides)]));
    try {
      result = await bootServer(folder, command, args, port, {
        signal, startupOptions, onReady, spawnImpl, readyForMs, shutdownTimeoutMs, savedShutdownGraceMs,
      });
    } finally {
      atomicWriteFile(properties, original);
    }
  } finally {
    await trial.remove();
  }
  signal?.throwIfAborted();
  return result;
}
