import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from "electron";
import started from 'electron-squirrel-startup';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const DEFAULT_SERVER_COLOR = "#39c9ff";
const APP_DISPLAY_NAME = "BlockHost Manager";
const DEFAULT_SERVER_MAX_RAM_MB = 4096;
const MIN_SERVER_MAX_RAM_MB = 512;
const MAX_SERVER_MAX_RAM_MB = 32768;
const MINECRAFT_EULA_URL = "https://aka.ms/MinecraftEULA";
const JAVA_INSTALL_URL = "https://adoptium.net/temurin/releases/?package=jdk";
const DEFAULT_DDNS_HOSTNAME = "digi-project.freeddns.org";
const DEFAULT_DDNS_INTERVAL_MINUTES = 10;
const MIN_DDNS_INTERVAL_MINUTES = 5;
const APP_USER_AGENT = "BlockHostManager/1.0.0 (nadithjayawardana1@gmail.com)";
const PAPER_PROTOCOL_PLUGINS = [
  {
    slug: "viaversion",
    name: "ViaVersion",
  },
  {
    slug: "viabackwards",
    name: "ViaBackwards",
  },
  {
    slug: "viarewind",
    name: "ViaRewind",
  },
];
const FABRIC_PROTOCOL_MODS = [
  {
    slug: "fabric-api",
    name: "Fabric API",
  },
];
const execFileAsync = promisify(execFile);
const runningServers = new Map();
let mainWindow;
let tray;
let isQuitting = false;
let isStoppingServersForQuit = false;
let ddnsTimer = null;

class MissingJavaError extends Error {
  constructor() {
    super(
      "Java for developers is not installed or is not available on PATH. Install a JDK, then reopen BlockHost Manager."
    );
    this.name = "MissingJavaError";
    this.code = "MISSING_JAVA";
    this.installUrl = JAVA_INSTALL_URL;
  }
}

async function assertJavaInstalled() {
  try {
    await execFileAsync("java", ["-version"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new MissingJavaError();
    }

    throw error;
  }
}

function getDdnsConfigPath() {
  return path.join(app.getPath("userData"), "ddns-config.json");
}

function getDdnsStatusPath() {
  return path.join(app.getPath("userData"), "ddns-status.json");
}

function getAppSettingsPath() {
  return path.join(app.getPath("userData"), "app-settings.json");
}

function getAssetPath(...segments) {
  const appPath = app.isPackaged ? process.resourcesPath : app.getAppPath();

  return path.join(appPath, ...segments);
}

function getAppIconPath() {
  return getAssetPath("assets", "app-icon.png");
}

function normalizeDdnsConfig(config = {}) {
  const intervalMinutes = Number(config.intervalMinutes);

  return {
    enabled: Boolean(config.enabled),
    hostname: String(config.hostname || DEFAULT_DDNS_HOSTNAME).trim(),
    password: String(config.password || ""),
    intervalMinutes:
      Number.isFinite(intervalMinutes) && intervalMinutes >= MIN_DDNS_INTERVAL_MINUTES
        ? Math.round(intervalMinutes)
        : DEFAULT_DDNS_INTERVAL_MINUTES,
  };
}

function normalizeAppSettings(settings = {}) {
  const totalMemoryMb = Math.max(
    MIN_SERVER_MAX_RAM_MB,
    Math.floor(os.totalmem() / 1024 / 1024)
  );
  const maxAllowedRamMb = Math.min(MAX_SERVER_MAX_RAM_MB, totalMemoryMb);
  const serverMaxRamMb = Number(settings.serverMaxRamMb);
  const normalizedServerMaxRamMb =
    Number.isFinite(serverMaxRamMb) && serverMaxRamMb >= MIN_SERVER_MAX_RAM_MB
      ? Math.round(serverMaxRamMb / 512) * 512
      : DEFAULT_SERVER_MAX_RAM_MB;

  return {
    serverMaxRamMb: Math.max(
      MIN_SERVER_MAX_RAM_MB,
      Math.min(maxAllowedRamMb, normalizedServerMaxRamMb)
    ),
    minServerMaxRamMb: MIN_SERVER_MAX_RAM_MB,
    maxServerMaxRamMb: maxAllowedRamMb,
  };
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    return fallback;
  }
}

function readDdnsConfig() {
  return normalizeDdnsConfig(readJsonFile(getDdnsConfigPath(), {}));
}

function readAppSettings() {
  return normalizeAppSettings(readJsonFile(getAppSettingsPath(), {}));
}

function writeDdnsConfig(config) {
  const nextConfig = normalizeDdnsConfig(config);

  fs.writeFileSync(getDdnsConfigPath(), JSON.stringify(nextConfig, null, 2));

  return nextConfig;
}

function writeAppSettings(settings) {
  const nextSettings = normalizeAppSettings(settings);

  fs.writeFileSync(getAppSettingsPath(), JSON.stringify(nextSettings, null, 2));

  return nextSettings;
}

function readDdnsStatus() {
  return readJsonFile(getDdnsStatusPath(), null);
}

function writeDdnsStatus(status) {
  const nextStatus = {
    ...status,
    checkedAt: new Date().toISOString(),
  };

  fs.writeFileSync(getDdnsStatusPath(), JSON.stringify(nextStatus, null, 2));

  return nextStatus;
}

function getPublicDdnsSettings() {
  const config = readDdnsConfig();

  return {
    enabled: config.enabled,
    hostname: config.hostname,
    intervalMinutes: config.intervalMinutes,
    hasPassword: Boolean(config.password),
    lastStatus: readDdnsStatus(),
  };
}

function getPublicAppSettings() {
  return readAppSettings();
}

async function getPublicIpv4Address() {
  const response = await fetch("https://api.ipify.org/");

  if (!response.ok) {
    throw new Error(`Could not check public IP (${response.status})`);
  }

  const ip = (await response.text()).trim();

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    throw new Error("Public IP response was not an IPv4 address");
  }

  return ip;
}

async function getDomainIpv4Address(hostname) {
  try {
    const addresses = await dns.resolve4(hostname);

    return addresses[0] || "";
  } catch (error) {
    return "";
  }
}

async function updateDdnsNow(reason = "manual") {
  const config = readDdnsConfig();

  if (!config.hostname) {
    throw new Error("DDNS hostname is missing");
  }

  if (!config.password) {
    throw new Error("DDNS update password is missing");
  }

  const publicIp = await getPublicIpv4Address();
  const domainIp = await getDomainIpv4Address(config.hostname);

  if (domainIp === publicIp) {
    return writeDdnsStatus({
      ok: true,
      action: "skipped",
      reason,
      hostname: config.hostname,
      publicIp,
      domainIp,
      response: "Domain already matches public IP",
    });
  }

  const url = new URL("https://api-ipv4.dynu.com/nic/update");
  url.searchParams.set("hostname", config.hostname);
  url.searchParams.set("myip", publicIp);
  url.searchParams.set("myipv6", "no");
  url.searchParams.set("password", config.password);

  const response = await fetch(url);
  const text = (await response.text()).trim();
  const ok = response.ok && /^(good|nochg)\b/i.test(text);

  const status = writeDdnsStatus({
    ok,
    action: "updated",
    reason,
    hostname: config.hostname,
    publicIp,
    domainIp,
    response: text || `HTTP ${response.status}`,
  });

  if (!ok) {
    throw new Error(`Dynu update failed: ${status.response}`);
  }

  return status;
}

function syncDdnsUpdater() {
  if (ddnsTimer) {
    clearInterval(ddnsTimer);
    ddnsTimer = null;
  }

  const config = readDdnsConfig();

  if (!config.enabled || !config.hostname || !config.password) {
    return;
  }

  updateDdnsNow("startup").catch((error) => {
    writeDdnsStatus({
      ok: false,
      action: "error",
      reason: "startup",
      hostname: config.hostname,
      response: error.message || "DDNS startup update failed",
    });
  });

  ddnsTimer = setInterval(() => {
    updateDdnsNow("scheduled").catch((error) => {
      writeDdnsStatus({
        ok: false,
        action: "error",
        reason: "scheduled",
        hostname: config.hostname,
        response: error.message || "DDNS scheduled update failed",
      });
    });
  }, config.intervalMinutes * 60 * 1000);
}

function runDdnsUpdateIfEnabled(reason) {
  const config = readDdnsConfig();

  if (!config.enabled || !config.hostname || !config.password) {
    return;
  }

  updateDdnsNow(reason).catch((error) => {
    writeDdnsStatus({
      ok: false,
      action: "error",
      reason,
      hostname: config.hostname,
      response: error.message || "DDNS update failed",
    });
  });
}

function normalizeServerColor(value) {
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return value;
  }

  return DEFAULT_SERVER_COLOR;
}

function compareVersionLike(a, b) {
  return String(b).localeCompare(String(a), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function sanitizeFileName(value, fallback = "server") {
  const safeName = String(value || fallback)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return safeName || fallback;
}

function getServerTypeLabel(type) {
  if (type === "paper") return "Paper";
  if (type === "neoforge") return "NeoForge";
  if (type === "fabric") return "Fabric";
  if (type === "forge") return "Forge";

  return "Vanilla";
}

function normalizeServerType(type) {
  if (["vanilla", "paper", "neoforge", "fabric", "forge"].includes(type)) {
    return type;
  }

  return "vanilla";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "User-Agent": APP_USER_AGENT,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }

  return await response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": APP_USER_AGENT,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }

  return await response.text();
}

async function downloadFile(url, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const response = await fetch(url, {
    headers: {
      "User-Agent": APP_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download file (${response.status})`);
  }

  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(filePath)
  );
}

function getCacheFilePath(...segments) {
  return path.join(app.getPath("userData"), "jar-cache", ...segments);
}

function isUsableCachedFile(filePath, expectedSize = 0) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  if (!expectedSize) {
    return true;
  }

  return fs.statSync(filePath).size === Number(expectedSize);
}

function createServerFolder(name, serverId) {
  const serversFolder = path.join(app.getPath("userData"), "servers");
  const serverFolderName = `${sanitizeFileName(name)}-${serverId}`;
  const serverFolder = path.join(serversFolder, serverFolderName);
  const metadataPath = path.join(serverFolder, "server-info.json");

  fs.mkdirSync(serverFolder, { recursive: true });

  return {
    serverFolder,
    metadataPath,
  };
}

function writeServerMetadata(metadataPath, server) {
  fs.writeFileSync(metadataPath, JSON.stringify(server, null, 2));
}

function getNextSidebarOrder() {
  const orders = getSavedServers()
    .map((server) => Number(server.sidebarOrder))
    .filter(Number.isFinite);

  if (!orders.length) {
    return 0;
  }

  return Math.max(...orders) + 1;
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);

  return (
    relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  );
}

function findSavedServerFolder(serversFolder, serverId) {
  if (!fs.existsSync(serversFolder)) {
    return null;
  }

  const folders = fs.readdirSync(serversFolder, { withFileTypes: true });

  for (const folder of folders) {
    if (!folder.isDirectory()) continue;

    const serverFolder = path.join(serversFolder, folder.name);
    const metadataPath = path.join(serverFolder, "server-info.json");

    if (!fs.existsSync(metadataPath)) continue;

    let metadata;

    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    } catch (error) {
      continue;
    }

    const idFromFolder = Number(folder.name.split("-").at(-1));
    const savedServerId = Number(metadata.id || idFromFolder);

    if (savedServerId === serverId) {
      return {
        serverFolder,
        metadataPath,
        metadata,
      };
    }
  }

  return null;
}

function getSavedServers() {
  const serversFolder = path.join(app.getPath("userData"), "servers");

  if (!fs.existsSync(serversFolder)) {
    return [];
  }

  const folders = fs.readdirSync(serversFolder, { withFileTypes: true });

  const servers = [];

  for (const folder of folders) {
    if (!folder.isDirectory()) continue;

    const serverFolder = path.join(serversFolder, folder.name);
    const metadataPath = path.join(serverFolder, "server-info.json");

    if (!fs.existsSync(metadataPath)) continue;

    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));

      const idFromFolder = Number(folder.name.split("-").at(-1));

      servers.push({
        id: metadata.id || idFromFolder || Date.now(),
        name: metadata.name || folder.name,
        type: metadata.type || "vanilla",
        typeLabel: metadata.typeLabel || getServerTypeLabel(metadata.type || "vanilla"),
        version: metadata.version || "unknown",
        loaderVersion: metadata.loaderVersion || "",
        color: normalizeServerColor(metadata.color),
        folderPath: metadata.folderPath || serverFolder,
        jarPath: metadata.jarPath,
        jarUrl: metadata.jarUrl || "",
        jarSha1: metadata.jarSha1 || "",
        jarSize: metadata.jarSize || 0,
        compatibilityPlugins: Array.isArray(metadata.compatibilityPlugins)
          ? metadata.compatibilityPlugins
          : [],
        compatibilityNotes: Array.isArray(metadata.compatibilityNotes)
          ? metadata.compatibilityNotes
          : [],
        launchType: metadata.launchType || "jar",
        launchArgsPath: metadata.launchArgsPath || "",
        sidebarOrder: Number.isFinite(Number(metadata.sidebarOrder))
          ? Number(metadata.sidebarOrder)
          : null,
        createdAt: metadata.createdAt || "",
      });
    } catch (error) {
      console.log("Failed to load server metadata:", metadataPath);
    }
  }

  return servers.sort((a, b) => {
    const orderA = Number.isFinite(Number(a.sidebarOrder))
      ? Number(a.sidebarOrder)
      : Number.MAX_SAFE_INTEGER;
    const orderB = Number.isFinite(Number(b.sidebarOrder))
      ? Number(b.sidebarOrder)
      : Number.MAX_SAFE_INTEGER;

    if (orderA !== orderB) {
      return orderA - orderB;
    }

    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

function normalizeComparablePath(value) {
  if (!value) return "";

  return String(value).replace(/\//g, "\\").toLowerCase();
}

function findMatchingServerForProcess(commandLine, savedServers) {
  const normalizedCommandLine = normalizeComparablePath(commandLine);
  const serverIdMatch = String(commandLine).match(/-Dmyapp\.serverId=(\d+)/i);

  if (serverIdMatch) {
    const matchedServer = savedServers.find((server) => {
      return Number(server.id) === Number(serverIdMatch[1]);
    });

    if (matchedServer) return matchedServer;
  }

  const folderMatch = savedServers.find((server) => {
    return (
      server.folderPath &&
      normalizedCommandLine.includes(normalizeComparablePath(server.folderPath))
    );
  });

  if (folderMatch) return folderMatch;

  return null;
}

function extractJarPathFromCommandLine(commandLine) {
  const quotedMatch = commandLine.match(/-jar\s+"([^"]+\.jar)"/i);

  if (quotedMatch) return quotedMatch[1];

  const plainMatch = commandLine.match(/-jar\s+([^\s]+\.jar)/i);

  return plainMatch ? plainMatch[1] : "";
}

function getSavedServerById(serverId) {
  return getSavedServers().find((server) => Number(server.id) === Number(serverId));
}

function getEulaPath(server) {
  return path.join(server.folderPath, "eula.txt");
}

function hasAcceptedEula(server) {
  const eulaPath = getEulaPath(server);

  if (!fs.existsSync(eulaPath)) {
    return false;
  }

  const contents = fs.readFileSync(eulaPath, "utf-8");

  return /^eula=true$/im.test(contents);
}

function writeAcceptedEula(server) {
  fs.mkdirSync(server.folderPath, { recursive: true });
  fs.writeFileSync(
    getEulaPath(server),
    [
      "# By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA.",
      `# ${MINECRAFT_EULA_URL}`,
      `# ${new Date().toISOString()}`,
      "eula=true",
      "",
    ].join("\n")
  );
}

function readServerMaxPlayers(server) {
  const propertiesPath = path.join(server.folderPath, "server.properties");

  if (!fs.existsSync(propertiesPath)) {
    return 20;
  }

  const contents = fs.readFileSync(propertiesPath, "utf-8");
  const match = contents.match(/^max-players=(\d+)$/im);

  return match ? Number(match[1]) : 20;
}

function updatePlayerStatsFromLine(runtime, line) {
  const maxTextMatch = String(line).match(
    /There are (\d+) of a max of (\d+) players online:?\s*(.*)$/i
  );
  const slashMatch = String(line).match(
    /There are (\d+)\/(\d+) players online:?\s*(.*)$/i
  );
  const match = maxTextMatch || slashMatch;

  if (!match) return false;

  runtime.playerCount = Number(match[1]) || 0;
  runtime.maxPlayers = Number(match[2]) || runtime.maxPlayers || 20;
  runtime.players = match[3]
    ? match[3]
        .split(",")
        .map((player) => player.trim())
        .filter(Boolean)
    : [];

  return true;
}

function requestServerPlayerList(runtime) {
  if (runtime.status !== "running" || !runtime.process?.stdin?.writable) return;

  try {
    runtime.pendingPlayerListResponse = true;
    runtime.process.stdin.write("list\n");
  } catch (error) {
    runtime.pendingPlayerListResponse = false;
  }
}

function startPlayerListPolling(runtime) {
  if (runtime.playerListInterval) return;

  requestServerPlayerList(runtime);

  runtime.playerListInterval = setInterval(() => {
    requestServerPlayerList(runtime);
  }, 10000);
}

function stopPlayerListPolling(runtime) {
  if (!runtime.playerListInterval) return;

  clearInterval(runtime.playerListInterval);
  runtime.playerListInterval = null;
  runtime.pendingPlayerListResponse = false;
}

function appendServerLog(runtime, line) {
  const normalizedLine = String(line).trimEnd();

  if (!normalizedLine) return;

  runtime.logs.push(normalizedLine);

  if (runtime.logs.length > 250) {
    runtime.logs.splice(0, runtime.logs.length - 250);
  }
}

function getServerRuntimeSnapshot(serverId) {
  const runtime = runningServers.get(Number(serverId));
  const server = getSavedServerById(serverId);

  return {
    serverId: Number(serverId),
    status: runtime?.status || "offline",
    pid: runtime?.process?.pid || null,
    startedAt: runtime?.startedAt || null,
    stoppedAt: runtime?.stoppedAt || null,
    exitCode: runtime?.exitCode ?? null,
    eulaAccepted: server ? hasAcceptedEula(server) : false,
    eulaUrl: MINECRAFT_EULA_URL,
    playerCount: runtime?.playerCount || 0,
    maxPlayers: runtime?.maxPlayers || (server ? readServerMaxPlayers(server) : 20),
    players: runtime?.players || [],
    logs: runtime?.logs || [],
  };
}

function getActiveServerRuntimeEntry() {
  return Array.from(runningServers.entries()).find((entry) => {
    const runtime = entry[1];

    return runtime?.process && runtime.status !== "offline";
  });
}

function getActiveServerSummary() {
  const activeEntry = getActiveServerRuntimeEntry();

  if (!activeEntry) return null;

  const [serverId, runtime] = activeEntry;
  const server = getSavedServerById(serverId);

  return {
    serverId: Number(serverId),
    serverName: server?.name || "another server",
    status: runtime.status,
  };
}

function getRunningServer(serverId) {
  const runtime = runningServers.get(Number(serverId));

  if (!runtime || runtime.status === "offline") {
    return null;
  }

  return runtime;
}

function assertSavedServer(serverId) {
  const server = getSavedServerById(serverId);

  if (!server) {
    throw new Error("Saved server not found");
  }

  if (server.launchType === "javaArgsFile") {
    const launchArgsPath = path.isAbsolute(server.launchArgsPath || "")
      ? server.launchArgsPath
      : path.join(server.folderPath, server.launchArgsPath || "");

    if (!launchArgsPath || !fs.existsSync(launchArgsPath)) {
      throw new Error("Server launch files are missing");
    }
  } else if (!server.jarPath || !fs.existsSync(server.jarPath)) {
    throw new Error("Cached server.jar is missing");
  }

  fs.mkdirSync(server.folderPath, { recursive: true });

  return server;
}

function getServerLaunch(server, serverId) {
  const { serverMaxRamMb } = readAppSettings();
  const memoryArg = `-Xmx${serverMaxRamMb}M`;

  if (server.launchType === "javaArgsFile") {
    return {
      command: "java",
      args: [
        `-Dmyapp.serverId=${serverId}`,
        memoryArg,
        `@${server.launchArgsPath}`,
        "nogui",
      ],
    };
  }

  return {
    command: "java",
    args: [`-Dmyapp.serverId=${serverId}`, memoryArg, "-jar", server.jarPath, "nogui"],
  };
}

async function startSavedServer(serverId, options = {}) {
  const numericServerId = Number(serverId);
  const existingRuntime = getRunningServer(numericServerId);

  if (existingRuntime) {
    return getServerRuntimeSnapshot(numericServerId);
  }

  const activeServer = getActiveServerSummary();

  if (activeServer && activeServer.serverId !== numericServerId) {
    if (!options.forceSwitch) {
      return {
        ...getServerRuntimeSnapshot(numericServerId),
        requiresServerSwitch: true,
        activeServer,
      };
    }
  }

  const server = assertSavedServer(numericServerId);

  if (!hasAcceptedEula(server)) {
    if (!options.acceptEula) {
      return {
        ...getServerRuntimeSnapshot(numericServerId),
        requiresEula: true,
      };
    }

    writeAcceptedEula(server);
  }

  if (activeServer && activeServer.serverId !== numericServerId && options.forceSwitch) {
    await stopSavedServer(activeServer.serverId);
  }

  await assertJavaInstalled();

  const runtime = {
    status: "starting",
    process: null,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    exitCode: null,
    playerCount: 0,
    maxPlayers: readServerMaxPlayers(server),
    players: [],
    playerListInterval: null,
    pendingPlayerListResponse: false,
    logs: [],
  };

  runningServers.set(numericServerId, runtime);

  const launch = getServerLaunch(server, numericServerId);
  const serverProcess = spawn(launch.command, launch.args, {
    cwd: server.folderPath,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  runtime.process = serverProcess;
  appendServerLog(runtime, `[APP] Starting ${server.name}...`);
  runDdnsUpdateIfEnabled("server-start");

  serverProcess.stdout.on("data", (chunk) => {
    chunk.toString().split(/\r?\n/).forEach((line) => {
      const isPlayerListLine = updatePlayerStatsFromLine(runtime, line);

      if (!(isPlayerListLine && runtime.pendingPlayerListResponse)) {
        appendServerLog(runtime, line);
      }

      if (isPlayerListLine) {
        runtime.pendingPlayerListResponse = false;
      }

      if (/Done \(.+\)! For help/i.test(line)) {
        runtime.status = "running";
        startPlayerListPolling(runtime);
      }
    });
  });

  serverProcess.stderr.on("data", (chunk) => {
    chunk.toString().split(/\r?\n/).forEach((line) => {
      appendServerLog(runtime, line);
    });
  });

  serverProcess.on("error", (error) => {
    stopPlayerListPolling(runtime);
    runtime.status = "offline";
    runtime.stoppedAt = new Date().toISOString();
    appendServerLog(runtime, `[APP] Failed to start server: ${error.message}`);
  });

  serverProcess.on("exit", (code) => {
    stopPlayerListPolling(runtime);
    runtime.status = "offline";
    runtime.stoppedAt = new Date().toISOString();
    runtime.exitCode = code;
    runtime.playerCount = 0;
    runtime.players = [];
    appendServerLog(runtime, `[APP] Server stopped with exit code ${code ?? "unknown"}.`);
  });

  return getServerRuntimeSnapshot(numericServerId);
}

async function stopSavedServer(serverId) {
  const numericServerId = Number(serverId);
  const runtime = getRunningServer(numericServerId);

  if (!runtime) {
    return getServerRuntimeSnapshot(numericServerId);
  }

  runtime.status = "stopping";
  appendServerLog(runtime, "[APP] Stopping server...");

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (runtime.process && !runtime.process.killed) {
        appendServerLog(runtime, "[APP] Server did not stop in time. Killing process...");
        runtime.process.kill();
      }
    }, 15000);

    runtime.process.once("exit", () => {
      clearTimeout(timeout);
      resolve(getServerRuntimeSnapshot(numericServerId));
    });

    try {
      runtime.process.stdin.write("stop\n");
    } catch (error) {
      clearTimeout(timeout);
      runtime.process.kill();
      resolve(getServerRuntimeSnapshot(numericServerId));
    }
  });
}

async function restartSavedServer(serverId, options = {}) {
  const numericServerId = Number(serverId);

  await stopSavedServer(numericServerId);

  return await startSavedServer(numericServerId, {
    ...options,
    forceSwitch: true,
  });
}

async function stopAllRunningServers() {
  const activeEntry = getActiveServerRuntimeEntry();

  if (!activeEntry) return;

  await stopSavedServer(activeEntry[0]);
}

function sendServerCommand(serverId, command) {
  const numericServerId = Number(serverId);
  const runtime = getRunningServer(numericServerId);
  const normalizedCommand = String(command || "").trim();

  if (!runtime || runtime.status !== "running") {
    throw new Error("Server is not running");
  }

  if (!normalizedCommand) {
    return getServerRuntimeSnapshot(numericServerId);
  }

  runtime.process.stdin.write(`${normalizedCommand}\n`);
  appendServerLog(runtime, `> ${normalizedCommand}`);

  return getServerRuntimeSnapshot(numericServerId);
}

async function runPowerShellJson(script) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }
  );

  const output = stdout.trim();

  if (!output) {
    return null;
  }

  return JSON.parse(output);
}

function getHardwareMonitorHelperPath() {
  if (process.platform !== "win32") {
    return null;
  }

  const helperName = "hardware-monitor-helper.exe";
  const candidatePaths = app.isPackaged
    ? [path.join(process.resourcesPath, "hardware-monitor", helperName)]
    : [
        path.join(__dirname, "resources", "hardware-monitor", helperName),
        path.join(app.getAppPath(), "resources", "hardware-monitor", helperName),
      ];

  return candidatePaths.find((candidatePath) => fs.existsSync(candidatePath)) || null;
}

function normalizeCpuTemperatureResult(result) {
  if (!result || typeof result !== "object") {
    return {
      ok: false,
      error: "Hardware monitor helper returned invalid JSON"
    };
  }

  if (!result.ok || typeof result.cpuTemp !== "number") {
    return {
      ok: false,
      error: result.error || "No CPU temperature sensors found",
      sensors: Array.isArray(result.sensors) ? result.sensors : [],
    };
  }

  return {
    ok: true,
    cpuTemp: result.cpuTemp,
    sensors: Array.isArray(result.sensors) ? result.sensors : [],
  };
}

async function getCpuTemperatureFromHardwareMonitor() {
  if (process.platform !== "win32") {
    return {
      ok: false,
      error: "CPU temperature is only available on Windows",
    };
  }

  const helperPath = getHardwareMonitorHelperPath();

  if (!helperPath) {
    return {
      ok: false,
      error: "Hardware monitor helper not found",
    };
  }

  try {
    const { stdout } = await execFileAsync(helperPath, [], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const output = stdout.trim();

    if (!output) {
      return {
        ok: false,
        error: "Hardware monitor helper returned no output",
      };
    }

    return normalizeCpuTemperatureResult(JSON.parse(output));
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Hardware monitor helper failed",
    };
  }
}

async function getJavaJarProcesses() {
  const result = await runPowerShellJson(`
    $ErrorActionPreference = "Stop"
    $processes = @(Get-CimInstance Win32_Process |
      Where-Object {
        ($_.Name -eq "java.exe" -or $_.Name -eq "javaw.exe") -and
        $_.CommandLine -and
        ($_.CommandLine -match "\\.jar" -or $_.CommandLine -match "-Dmyapp\\.serverId=")
      })

    $perfRows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)
    $processorCount = [Environment]::ProcessorCount

    $items = foreach ($process in $processes) {
      $perf = $perfRows | Where-Object { $_.IDProcess -eq $process.ProcessId } | Select-Object -First 1
      $rawCpu = 0

      if ($perf -and $perf.PercentProcessorTime -ne $null) {
        $rawCpu = [double]$perf.PercentProcessorTime
      }

      $cpuPercent = 0

      if ($processorCount -gt 0) {
        $cpuPercent = [Math]::Min(100, [Math]::Round($rawCpu / $processorCount, 1))
      }

      [PSCustomObject]@{
        pid = [int]$process.ProcessId
        processName = [string]$process.Name
        commandLine = [string]$process.CommandLine
        workingSetBytes = [int64]$process.WorkingSetSize
        cpuPercent = [double]$cpuPercent
      }
    }

    [PSCustomObject]@{
      logicalProcessorCount = [int]$processorCount
      processes = @($items)
    } | ConvertTo-Json -Depth 5 -Compress
  `);

  return {
    logicalProcessorCount: result?.logicalProcessorCount || 0,
    processes: Array.isArray(result?.processes)
      ? result.processes
      : result?.processes
        ? [result.processes]
        : [],
  };
}

async function getVanillaVersionOptions() {
  const manifestUrl =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
  const data = await fetchJson(manifestUrl);

  return data.versions
    .filter((version) => version.type === "release")
    .map((version) => {
      return {
        id: version.id,
        label: version.id,
        type: "vanilla",
        version: version.id,
        versionUrl: version.url,
      };
    });
}

async function getPaperVersionOptions() {
  const project = await fetchJson("https://fill.papermc.io/v3/projects/paper");
  const versions = Object.values(project.versions || {})
    .flat()
    .filter(Boolean)
    .sort(compareVersionLike);

  return versions.map((version) => {
    return {
      id: version,
      label: version,
      type: "paper",
      version,
    };
  });
}

function getMinecraftVersionFromNeoForgeVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\./);

  if (!match) return "";

  const major = Number(match[1]);
  const minor = Number(match[2]);

  if (major === 20) {
    return `1.20.${minor}`;
  }

  if (major === 21) {
    return `1.21.${minor}`;
  }

  return "";
}

async function getNeoForgeVersionOptions() {
  const metadata = await fetchText(
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"
  );
  const versions = Array.from(metadata.matchAll(/<version>([^<]+)<\/version>/g))
    .map((match) => match[1])
    .filter((version) => !version.includes("beta"))
    .sort(compareVersionLike)
    .slice(0, 200);

  return versions.map((loaderVersion) => {
    const minecraftVersion = getMinecraftVersionFromNeoForgeVersion(loaderVersion);

    return {
      id: loaderVersion,
      label: minecraftVersion
        ? `${minecraftVersion} - NeoForge ${loaderVersion}`
        : `NeoForge ${loaderVersion}`,
      type: "neoforge",
      version: minecraftVersion || loaderVersion,
      loaderVersion,
    };
  });
}

async function getFabricLoaderVersion() {
  const loaders = await fetchJson("https://meta.fabricmc.net/v2/versions/loader");
  const loader = loaders.find((item) => item.stable) || loaders[0];

  if (!loader?.version) {
    throw new Error("Could not find a Fabric loader version");
  }

  return loader.version;
}

async function getFabricInstallerVersion() {
  const installers = await fetchJson("https://meta.fabricmc.net/v2/versions/installer");
  const installer = installers.find((item) => item.stable) || installers[0];

  if (!installer?.version) {
    throw new Error("Could not find a Fabric installer version");
  }

  return installer.version;
}

async function getFabricVersionOptions() {
  const [games, loaderVersion, installerVersion] = await Promise.all([
    fetchJson("https://meta.fabricmc.net/v2/versions/game"),
    getFabricLoaderVersion(),
    getFabricInstallerVersion(),
  ]);

  return games
    .filter((game) => game.stable)
    .map((game) => {
      return {
        id: game.version,
        label: `${game.version} - Fabric ${loaderVersion}`,
        type: "fabric",
        version: game.version,
        loaderVersion,
        installerVersion,
      };
    });
}

function getMinecraftVersionFromForgeVersion(version) {
  return String(version).split("-")[0] || "";
}

async function getForgeVersionOptions() {
  const metadata = await fetchText(
    "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml"
  );
  const versions = Array.from(metadata.matchAll(/<version>([^<]+)<\/version>/g))
    .map((match) => match[1])
    .filter((version) => version.includes("-"))
    .sort(compareVersionLike)
    .slice(0, 220);

  return versions.map((loaderVersion) => {
    const minecraftVersion = getMinecraftVersionFromForgeVersion(loaderVersion);
    const forgeVersion = loaderVersion.split("-").slice(1).join("-");

    return {
      id: loaderVersion,
      label: `${minecraftVersion} - Forge ${forgeVersion}`,
      type: "forge",
      version: minecraftVersion,
      loaderVersion,
    };
  });
}

async function getServerVersionOptions(type) {
  const serverType = normalizeServerType(type);

  if (serverType === "paper") {
    return await getPaperVersionOptions();
  }

  if (serverType === "neoforge") {
    return await getNeoForgeVersionOptions();
  }

  if (serverType === "fabric") {
    return await getFabricVersionOptions();
  }

  if (serverType === "forge") {
    return await getForgeVersionOptions();
  }

  return await getVanillaVersionOptions();
}

async function getVanillaServerDownload(versionUrl) {
  const data = await fetchJson(versionUrl);

  if (!data.downloads || !data.downloads.server) {
    throw new Error("This version does not have a server.jar download");
  }

  return {
    url: data.downloads.server.url,
    sha1: data.downloads.server.sha1,
    size: data.downloads.server.size,
  };
}

async function getPaperServerDownload(version) {
  const builds = await fetchJson(
    `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`
  );
  const stableBuild =
    builds.find((build) => build.channel === "STABLE") || builds[0];
  const download = stableBuild?.downloads?.["server:default"];

  if (!download?.url) {
    throw new Error("No Paper server download is available for this version");
  }

  return {
    url: download.url,
    sha256: download.checksums?.sha256 || "",
    size: download.size || 0,
    build: stableBuild.id || stableBuild.number || "",
    fileName: download.name || `paper-${version}.jar`,
  };
}

async function cacheServerJar(type, version, downloadInfo, defaultFileName) {
  const fileName = sanitizeFileName(downloadInfo.fileName || defaultFileName, "server.jar");
  const cachedJarPath = getCacheFilePath(type, version, fileName);
  const cacheInfoPath = getCacheFilePath(type, version, "cache-info.json");
  const usedCache = isUsableCachedFile(cachedJarPath, downloadInfo.size);

  if (!usedCache) {
    await downloadFile(downloadInfo.url, cachedJarPath);
    fs.writeFileSync(
      cacheInfoPath,
      JSON.stringify(
        {
          type,
          version,
          url: downloadInfo.url,
          sha1: downloadInfo.sha1 || "",
          sha256: downloadInfo.sha256 || "",
          size: downloadInfo.size || 0,
          cachedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  }

  return {
    cachedJarPath,
    usedCache,
  };
}

function pickPrimaryJarFile(version) {
  const files = Array.isArray(version.files) ? version.files : [];
  const jarFiles = files.filter((file) => {
    return String(file.filename || "").toLowerCase().endsWith(".jar");
  });

  return jarFiles.find((file) => file.primary) || jarFiles[0] || null;
}

function getModrinthVersionsUrl(slug, options = {}) {
  const url = new URL(
    `https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version`
  );

  if (options.loader) {
    url.searchParams.set("loaders", JSON.stringify([options.loader]));
  }

  if (options.gameVersion) {
    url.searchParams.set("game_versions", JSON.stringify([options.gameVersion]));
  }

  if (options.featured) {
    url.searchParams.set("featured", "true");
  }

  return url.toString();
}

async function getLatestModrinthDownload(slug, options = {}) {
  let versions = await fetchJson(
    getModrinthVersionsUrl(slug, {
      ...options,
      featured: true,
    })
  );

  if (!versions.length) {
    versions = await fetchJson(getModrinthVersionsUrl(slug, options));
  }

  if (!versions.length && options.gameVersion) {
    versions = await fetchJson(
      getModrinthVersionsUrl(slug, {
        ...options,
        gameVersion: "",
      })
    );
  }

  const version =
    versions.find((item) => item.version_type === "release") ||
    versions[0];
  const file = version ? pickPrimaryJarFile(version) : null;

  if (!version || !file?.url) {
    throw new Error(`Could not find a compatible download for ${slug}`);
  }

  return {
    versionId: version.id,
    versionNumber: version.version_number,
    url: file.url,
    fileName: file.filename,
    size: file.size || 0,
    sha1: file.hashes?.sha1 || "",
  };
}

async function installPaperProtocolPlugins(serverFolder) {
  const pluginsFolder = path.join(serverFolder, "plugins");
  const installed = [];
  const notes = [];

  fs.mkdirSync(pluginsFolder, { recursive: true });

  for (const plugin of PAPER_PROTOCOL_PLUGINS) {
    try {
      const downloadInfo = await getLatestModrinthDownload(plugin.slug, {
        loader: "paper",
      });
      const cachedPluginPath = getCacheFilePath(
        "plugins",
        plugin.slug,
        downloadInfo.versionId,
        sanitizeFileName(downloadInfo.fileName, `${plugin.slug}.jar`)
      );

      if (!isUsableCachedFile(cachedPluginPath, downloadInfo.size)) {
        await downloadFile(downloadInfo.url, cachedPluginPath);
      }

      const pluginPath = path.join(
        pluginsFolder,
        sanitizeFileName(downloadInfo.fileName, `${plugin.slug}.jar`)
      );

      fs.copyFileSync(cachedPluginPath, pluginPath);
      installed.push({
        name: plugin.name,
        version: downloadInfo.versionNumber,
        path: pluginPath,
      });
    } catch (error) {
      notes.push(`${plugin.name} could not be installed: ${error.message}`);
    }
  }

  return {
    addons: installed,
    notes,
  };
}

async function installFabricProtocolMods(serverFolder, minecraftVersion) {
  const modsFolder = path.join(serverFolder, "mods");
  const installed = [];
  const notes = [
    "Fabric only installs Fabric API by default. ViaFabric/ViaBackwards/ViaRewind are not auto-installed because mismatched builds can prevent the server from starting.",
  ];

  fs.mkdirSync(modsFolder, { recursive: true });

  for (const mod of FABRIC_PROTOCOL_MODS) {
    try {
      const downloadInfo = await getLatestModrinthDownload(mod.slug, {
        loader: "fabric",
        gameVersion: minecraftVersion,
      });
      const cachedModPath = getCacheFilePath(
        "mods",
        mod.slug,
        downloadInfo.versionId,
        sanitizeFileName(downloadInfo.fileName, `${mod.slug}.jar`)
      );

      if (!isUsableCachedFile(cachedModPath, downloadInfo.size)) {
        await downloadFile(downloadInfo.url, cachedModPath);
      }

      const modPath = path.join(
        modsFolder,
        sanitizeFileName(downloadInfo.fileName, `${mod.slug}.jar`)
      );

      fs.copyFileSync(cachedModPath, modPath);
      installed.push({
        name: mod.name,
        version: downloadInfo.versionNumber,
        path: modPath,
      });
    } catch (error) {
      notes.push(`${mod.name} could not be installed: ${error.message}`);
    }
  }

  return {
    addons: installed,
    notes,
  };
}

async function installProtocolCompatibilityAddons(type, serverFolder, minecraftVersion) {
  try {
    if (type === "paper") {
      return await installPaperProtocolPlugins(serverFolder);
    }

    if (type === "fabric") {
      return await installFabricProtocolMods(serverFolder, minecraftVersion);
    }

    return {
      addons: [],
      notes: [
        `${getServerTypeLabel(type)} does not have a safe universal server-side ViaVersion add-on installed by this app.`,
      ],
    };
  } catch (error) {
    return {
      addons: [],
      notes: [
        `Protocol compatibility add-ons could not be installed: ${error.message || "unknown error"}`,
      ],
    };
  }
}

async function createJarBackedServer(serverData, downloadInfo) {
  const type = normalizeServerType(serverData.type);
  const color = normalizeServerColor(serverData.color);
  const serverId = Date.now();
  const sidebarOrder = getNextSidebarOrder();
  const { serverFolder, metadataPath } = createServerFolder(
    serverData.name,
    serverId
  );
  const cacheResult = await cacheServerJar(
    type,
    serverData.version,
    downloadInfo,
    `${type}-${serverData.version}.jar`
  );
  const compatibility = await installProtocolCompatibilityAddons(
    type,
    serverFolder,
    serverData.version
  );

  const server = {
    id: serverId,
    name: serverData.name,
    type,
    typeLabel: getServerTypeLabel(type),
    version: serverData.version,
    loaderVersion: serverData.loaderVersion || "",
    color,
    folderPath: serverFolder,
    jarPath: cacheResult.cachedJarPath,
    jarUrl: downloadInfo.url || "",
    jarSha1: downloadInfo.sha1 || "",
    jarSize: downloadInfo.size || 0,
    compatibilityPlugins: compatibility.addons,
    compatibilityNotes: compatibility.notes,
    sidebarOrder,
    createdAt: new Date().toISOString(),
  };

  writeServerMetadata(metadataPath, server);

  return {
    success: true,
    usedCache: cacheResult.usedCache,
    server,
    serverFolder,
    jarPath: cacheResult.cachedJarPath,
    metadataPath,
  };
}

async function cacheNeoForgeInstaller(loaderVersion) {
  const fileName = `neoforge-${loaderVersion}-installer.jar`;
  const installerPath = getCacheFilePath("neoforge", loaderVersion, fileName);
  const url =
    `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/${fileName}`;
  const usedCache = isUsableCachedFile(installerPath);

  if (!usedCache) {
    await downloadFile(url, installerPath);
  }

  return {
    installerPath,
    url,
    usedCache,
  };
}

async function installNeoForgeServer(loaderVersion, serverFolder) {
  const installer = await cacheNeoForgeInstaller(loaderVersion);

  await assertJavaInstalled();

  await execFileAsync("java", ["-jar", installer.installerPath, "--installServer"], {
    cwd: serverFolder,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 20,
  });

  const argsFileName = process.platform === "win32" ? "win_args.txt" : "unix_args.txt";
  const launchArgsPath = path.join(
    "libraries",
    "net",
    "neoforged",
    "neoforge",
    loaderVersion,
    argsFileName
  );
  const absoluteLaunchArgsPath = path.join(serverFolder, launchArgsPath);

  if (!fs.existsSync(absoluteLaunchArgsPath)) {
    throw new Error("NeoForge installed, but its server launch file was not found");
  }

  return {
    ...installer,
    launchArgsPath,
  };
}

async function createNeoForgeServer(serverData) {
  const color = normalizeServerColor(serverData.color);
  const serverId = Date.now();
  const sidebarOrder = getNextSidebarOrder();
  const loaderVersion = String(serverData.loaderVersion || serverData.version);
  const minecraftVersion =
    serverData.minecraftVersion ||
    getMinecraftVersionFromNeoForgeVersion(loaderVersion) ||
    loaderVersion;
  const { serverFolder, metadataPath } = createServerFolder(
    serverData.name,
    serverId
  );
  const install = await installNeoForgeServer(loaderVersion, serverFolder);
  const compatibility = await installProtocolCompatibilityAddons(
    "neoforge",
    serverFolder,
    minecraftVersion
  );

  const server = {
    id: serverId,
    name: serverData.name,
    type: "neoforge",
    typeLabel: getServerTypeLabel("neoforge"),
    version: minecraftVersion,
    loaderVersion,
    color,
    folderPath: serverFolder,
    jarPath: install.installerPath,
    jarUrl: install.url,
    jarSha1: "",
    jarSize: fs.statSync(install.installerPath).size,
    launchType: "javaArgsFile",
    launchArgsPath: install.launchArgsPath,
    compatibilityPlugins: compatibility.addons,
    compatibilityNotes: compatibility.notes,
    sidebarOrder,
    createdAt: new Date().toISOString(),
  };

  writeServerMetadata(metadataPath, server);

  return {
    success: true,
    usedCache: install.usedCache,
    server,
    serverFolder,
    jarPath: install.installerPath,
    metadataPath,
  };
}

async function getFabricServerDownload(serverData) {
  const loaderVersion = serverData.loaderVersion || (await getFabricLoaderVersion());
  const installerVersion =
    serverData.installerVersion || (await getFabricInstallerVersion());
  const version = serverData.version;
  const url =
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}` +
    `/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installerVersion)}/server/jar`;

  return {
    url,
    size: 0,
    sha1: "",
    fileName: `fabric-server-${version}-${loaderVersion}.jar`,
    loaderVersion,
  };
}

async function cacheForgeInstaller(loaderVersion) {
  const fileName = `forge-${loaderVersion}-installer.jar`;
  const installerPath = getCacheFilePath("forge", loaderVersion, fileName);
  const url =
    `https://maven.minecraftforge.net/net/minecraftforge/forge/${loaderVersion}/${fileName}`;
  const usedCache = isUsableCachedFile(installerPath);

  if (!usedCache) {
    await downloadFile(url, installerPath);
  }

  return {
    installerPath,
    url,
    usedCache,
  };
}

async function installForgeServer(loaderVersion, serverFolder) {
  const installer = await cacheForgeInstaller(loaderVersion);

  await assertJavaInstalled();

  await execFileAsync("java", ["-jar", installer.installerPath, "--installServer"], {
    cwd: serverFolder,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 20,
  });

  const argsFileName = process.platform === "win32" ? "win_args.txt" : "unix_args.txt";
  const launchArgsPath = path.join(
    "libraries",
    "net",
    "minecraftforge",
    "forge",
    loaderVersion,
    argsFileName
  );
  const absoluteLaunchArgsPath = path.join(serverFolder, launchArgsPath);

  if (!fs.existsSync(absoluteLaunchArgsPath)) {
    throw new Error("Forge installed, but its server launch file was not found");
  }

  return {
    ...installer,
    launchArgsPath,
  };
}

async function createForgeServer(serverData) {
  const color = normalizeServerColor(serverData.color);
  const serverId = Date.now();
  const sidebarOrder = getNextSidebarOrder();
  const loaderVersion = String(serverData.loaderVersion || serverData.version);
  const minecraftVersion =
    serverData.minecraftVersion ||
    getMinecraftVersionFromForgeVersion(loaderVersion) ||
    loaderVersion;
  const { serverFolder, metadataPath } = createServerFolder(
    serverData.name,
    serverId
  );
  const install = await installForgeServer(loaderVersion, serverFolder);
  const compatibility = await installProtocolCompatibilityAddons(
    "forge",
    serverFolder,
    minecraftVersion
  );

  const server = {
    id: serverId,
    name: serverData.name,
    type: "forge",
    typeLabel: getServerTypeLabel("forge"),
    version: minecraftVersion,
    loaderVersion,
    color,
    folderPath: serverFolder,
    jarPath: install.installerPath,
    jarUrl: install.url,
    jarSha1: "",
    jarSize: fs.statSync(install.installerPath).size,
    launchType: "javaArgsFile",
    launchArgsPath: install.launchArgsPath,
    compatibilityPlugins: compatibility.addons,
    compatibilityNotes: compatibility.notes,
    sidebarOrder,
    createdAt: new Date().toISOString(),
  };

  writeServerMetadata(metadataPath, server);

  return {
    success: true,
    usedCache: install.usedCache,
    server,
    serverFolder,
    jarPath: install.installerPath,
    metadataPath,
  };
}

async function createServerByType(serverData) {
  const type = normalizeServerType(serverData.type);

  if (!serverData.name || !serverData.version) {
    throw new Error("Missing server creation information");
  }

  if (type === "paper") {
    const downloadInfo = await getPaperServerDownload(serverData.version);

    return await createJarBackedServer(
      {
        ...serverData,
        type,
      },
      downloadInfo
    );
  }

  if (type === "neoforge") {
    await assertJavaInstalled();

    return await createNeoForgeServer(serverData);
  }

  if (type === "fabric") {
    const downloadInfo = await getFabricServerDownload(serverData);

    return await createJarBackedServer(
      {
        ...serverData,
        type,
        loaderVersion: downloadInfo.loaderVersion,
      },
      downloadInfo
    );
  }

  if (type === "forge") {
    await assertJavaInstalled();

    return await createForgeServer(serverData);
  }

  const downloadInfo = await getVanillaServerDownload(serverData.versionUrl);

  return await createJarBackedServer(
    {
      ...serverData,
      type: "vanilla",
    },
    downloadInfo
  );
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

function createTrayIcon() {
  const iconPath = getAppIconPath();
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  return icon.resize({ width: 16, height: 16 });
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;

  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_DISPLAY_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show",
        click: showMainWindow,
      },
      {
        type: "separator",
      },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("double-click", showMainWindow);
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on("close", (event) => {
    if (isQuitting) return;

    event.preventDefault();
    mainWindow.hide();
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow();
  createTray();
  syncDdnsUpdater();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    showMainWindow();
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  if (isStoppingServersForQuit) return;

  if (ddnsTimer) {
    clearInterval(ddnsTimer);
    ddnsTimer = null;
  }

  const hasRunningServers = Array.from(runningServers.values()).some((runtime) => {
    return runtime.process && runtime.status !== "offline";
  });

  if (!hasRunningServers) return;

  event.preventDefault();
  isQuitting = true;
  isStoppingServersForQuit = true;

  await stopAllRunningServers();

  app.quit();
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

ipcMain.handle("vanilla:getVersions", async () => {
  const manifestUrl =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

  const response = await fetch(manifestUrl);

  if (!response.ok) {
    throw new Error("Failed to fetch Vanilla version manifest");
  }

  const data = await response.json();

  const versions = data.versions.map((version) => {
    return {
      id: version.id,
      type: version.type,
      url: version.url,
      releaseTime: version.releaseTime,
    };
  });

  return versions;
});

ipcMain.handle("vanilla:getServerDownload", async (event, versionUrl) => {
  const response = await fetch(versionUrl);

  if (!response.ok) {
    throw new Error("Failed to fetch Vanilla version data");
  }

  const data = await response.json();

  if (!data.downloads || !data.downloads.server) {
    throw new Error("This version does not have a server.jar download");
  }

  return {
    url: data.downloads.server.url,
    sha1: data.downloads.server.sha1,
    size: data.downloads.server.size,
  };
});

ipcMain.handle("vanilla:downloadServerJar", async (event, serverData) => {
  const { name, version, jarUrl, jarSha1, jarSize } = serverData;
  const color = normalizeServerColor(serverData.color);

  if (!name || !version || !jarUrl) {
    throw new Error("Missing server download information");
  }

  const safeName = name.replace(/[^a-z0-9-_ ]/gi, "").replace(/\s+/g, "-");
  const serverId = Date.now();

  const serversFolder = path.join(app.getPath("userData"), "servers");
  const serverFolderName = `${safeName}-${serverId}`;
  const serverFolder = path.join(serversFolder, serverFolderName);
  const metadataPath = path.join(serverFolder, "server-info.json");

  const cacheFolder = path.join(
    app.getPath("userData"),
    "jar-cache",
    "vanilla",
    version
  );

  const cachedJarPath = path.join(cacheFolder, "server.jar");
  const cacheInfoPath = path.join(cacheFolder, "cache-info.json");

  fs.mkdirSync(serverFolder, { recursive: true });
  fs.mkdirSync(cacheFolder, { recursive: true });

  let usedCache = false;

  if (fs.existsSync(cachedJarPath)) {
    const stats = fs.statSync(cachedJarPath);

    if (!jarSize || stats.size === jarSize) {
      usedCache = true;
    }
  }

  if (!usedCache) {
    const response = await fetch(jarUrl);

    if (!response.ok) {
      throw new Error("Failed to download server.jar");
    }

    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(cachedJarPath)
    );

    fs.writeFileSync(
      cacheInfoPath,
      JSON.stringify(
        {
          type: "vanilla",
          version,
          jarUrl,
          jarSha1,
          jarSize,
          cachedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  }

  const server = {
    id: serverId,
    name,
    type: "vanilla",
    version,
    color,
    folderPath: serverFolder,
    jarPath: cachedJarPath,
    jarUrl,
    jarSha1,
    jarSize,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(metadataPath, JSON.stringify(server, null, 2));

  return {
    success: true,
    usedCache,
    server,
    serverFolder,
    jarPath: cachedJarPath,
    metadataPath,
  };
});

ipcMain.handle("servers:getVersionOptions", async (event, options) => {
  return await getServerVersionOptions(options?.type);
});

ipcMain.handle("servers:create", async (event, serverData) => {
  return await createServerByType(serverData);
});

ipcMain.handle("servers:getSaved", async () => {
  return getSavedServers();
});

ipcMain.handle("system:getServerRuntimeStats", async () => {
  const savedServers = getSavedServers();
  const javaStats = await getJavaJarProcesses();

  const processGroups = new Map();

  for (const process of javaStats.processes) {
    const matchedServer = findMatchingServerForProcess(
      process.commandLine,
      savedServers
    );

    if (!matchedServer) continue;

    const key = String(matchedServer.id);
    const existing = processGroups.get(key) || {
      pids: [],
      processNames: [],
      commandLines: [],
      jarPaths: [],
      cpuPercent: 0,
      ramBytes: 0,
      serverId: matchedServer.id,
      serverName: matchedServer.name,
      serverColor: matchedServer.color,
      serverVersion: matchedServer.version,
    };

    existing.pids.push(process.pid);
    existing.processNames.push(process.processName);
    existing.commandLines.push(process.commandLine);
    existing.jarPaths.push(extractJarPathFromCommandLine(process.commandLine));
    existing.cpuPercent += Number(process.cpuPercent) || 0;
    existing.ramBytes += Number(process.workingSetBytes) || 0;

    processGroups.set(key, existing);
  }

  const processes = Array.from(processGroups.values()).map((process) => {
    return {
      ...process,
      pid: process.pids[0] || null,
      cpuPercent: Number(process.cpuPercent.toFixed(1)),
    };
  });

  return {
    sampledAt: new Date().toISOString(),
    logicalProcessorCount: javaStats.logicalProcessorCount,
    totalCpuPercent: processes.reduce((sum, process) => {
      return sum + process.cpuPercent;
    }, 0),
    totalRamBytes: processes.reduce((sum, process) => {
      return sum + process.ramBytes;
    }, 0),
    processes,
  };
});

ipcMain.handle("hardware:getCpuTemp", async () => {
  return await getCpuTemperatureFromHardwareMonitor();
});

ipcMain.handle("settings:getApp", async () => {
  return getPublicAppSettings();
});

ipcMain.handle("settings:saveApp", async (event, settings) => {
  return writeAppSettings(settings);
});

ipcMain.handle("ddns:getSettings", async () => {
  return getPublicDdnsSettings();
});

ipcMain.handle("ddns:saveSettings", async (event, settings) => {
  const existingConfig = readDdnsConfig();
  const nextPassword =
    typeof settings.password === "string" && settings.password.length > 0
      ? settings.password
      : existingConfig.password;

  writeDdnsConfig({
    ...existingConfig,
    enabled: Boolean(settings.enabled),
    hostname: settings.hostname,
    intervalMinutes: settings.intervalMinutes,
    password: nextPassword,
  });

  syncDdnsUpdater();

  return getPublicDdnsSettings();
});

ipcMain.handle("ddns:runNow", async () => {
  await updateDdnsNow("manual");
  syncDdnsUpdater();

  return getPublicDdnsSettings();
});

ipcMain.handle("servers:getRuntimeState", async (event, serverId) => {
  return getServerRuntimeSnapshot(serverId);
});

ipcMain.handle("servers:start", async (event, serverData) => {
  return await startSavedServer(serverData.id, {
    acceptEula: Boolean(serverData.acceptEula),
    forceSwitch: Boolean(serverData.forceSwitch),
  });
});

ipcMain.handle("servers:stop", async (event, serverId) => {
  return await stopSavedServer(serverId);
});

ipcMain.handle("servers:restart", async (event, serverData) => {
  return await restartSavedServer(serverData.id, {
    acceptEula: Boolean(serverData.acceptEula),
  });
});

ipcMain.handle("servers:sendCommand", async (event, serverData) => {
  return sendServerCommand(serverData.id, serverData.command);
});

ipcMain.handle("servers:deleteSaved", async (event, serverId) => {
  const numericServerId = Number(serverId);

  if (!Number.isFinite(numericServerId)) {
    throw new Error("Invalid server id");
  }

  const serversFolder = path.join(app.getPath("userData"), "servers");
  const savedServer = findSavedServerFolder(serversFolder, numericServerId);

  if (!savedServer) {
    return { success: true, deleted: false };
  }

  await stopSavedServer(numericServerId);

  if (!isPathInside(serversFolder, savedServer.serverFolder)) {
    throw new Error("Refusing to delete an unexpected server folder");
  }

  fs.rmSync(savedServer.serverFolder, { recursive: true, force: true });

  return { success: true, deleted: true };
});

ipcMain.handle("servers:updateSaved", async (event, serverData) => {
  const numericServerId = Number(serverData.id);

  if (!Number.isFinite(numericServerId)) {
    throw new Error("Invalid server id");
  }

  const serversFolder = path.join(app.getPath("userData"), "servers");
  const savedServer = findSavedServerFolder(serversFolder, numericServerId);

  if (!savedServer) {
    throw new Error("Saved server not found");
  }

  if (!isPathInside(serversFolder, savedServer.serverFolder)) {
    throw new Error("Refusing to update an unexpected server folder");
  }

  const nextMetadata = {
    ...savedServer.metadata,
  };

  if (typeof serverData.name === "string") {
    const name = serverData.name.trim();

    if (!name) {
      throw new Error("Server name cannot be empty");
    }

    nextMetadata.name = name;
  }

  if (typeof serverData.color === "string") {
    nextMetadata.color = normalizeServerColor(serverData.color);
  }

  fs.writeFileSync(
    savedServer.metadataPath,
    JSON.stringify(nextMetadata, null, 2)
  );

  return {
    success: true,
    server: nextMetadata,
  };
});

ipcMain.handle("servers:reorder", async (event, serverIds) => {
  if (!Array.isArray(serverIds)) {
    throw new Error("Invalid server order");
  }

  const serversFolder = path.join(app.getPath("userData"), "servers");

  serverIds.forEach((serverId, index) => {
    const numericServerId = Number(serverId);

    if (!Number.isFinite(numericServerId)) {
      throw new Error("Invalid server id in order");
    }

    const savedServer = findSavedServerFolder(serversFolder, numericServerId);

    if (!savedServer) {
      return;
    }

    if (!isPathInside(serversFolder, savedServer.serverFolder)) {
      throw new Error("Refusing to reorder an unexpected server folder");
    }

    const nextMetadata = {
      ...savedServer.metadata,
      sidebarOrder: index,
    };

    fs.writeFileSync(
      savedServer.metadataPath,
      JSON.stringify(nextMetadata, null, 2)
    );
  });

  return getSavedServers();
});
