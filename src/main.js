import { app, BrowserWindow, ipcMain, shell } from "electron";
import started from "electron-squirrel-startup";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APP_NAME = "BlockHost Manager";
const APP_USER_AGENT = "BlockHostManager/1.0.0";
const DEFAULT_COLOR = "#39c9ff";
const MINECRAFT_EULA_URL = "https://aka.ms/MinecraftEULA";
const JAVA_INSTALL_URL = "https://adoptium.net/temurin/releases/?package=jdk";
const SERVER_TYPES = new Set(["vanilla", "paper", "fabric", "forge", "neoforge"]);
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "piston-data.mojang.com",
  "piston-meta.mojang.com",
  "fill.papermc.io",
  "fill-data.papermc.io",
  "api.papermc.io",
  "meta.fabricmc.net",
  "maven.minecraftforge.net",
  "maven.neoforged.net",
]);
const runningServers = new Map();

let mainWindow;
let quitInProgress = false;

class MissingJavaError extends Error {
  constructor() {
    super("Java is not installed or is not available on PATH. Install a JDK and reopen BlockHost Manager.");
    this.name = "MissingJavaError";
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeServerType(value) {
  return SERVER_TYPES.has(value) ? value : "vanilla";
}

function serverTypeLabel(type) {
  return {
    vanilla: "Vanilla",
    paper: "Paper",
    fabric: "Fabric",
    forge: "Forge",
    neoforge: "NeoForge",
  }[type] || "Vanilla";
}

function normalizeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : DEFAULT_COLOR;
}

function safeSegment(value, fallback = "item") {
  const result = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return result || fallback;
}

function normalizeServerName(value) {
  const name = String(value || "").trim().slice(0, 80);
  if (!name) throw new Error("Server name is required");
  return name;
}

function normalizeServerId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid server id");
  return id;
}

function getServersRoot() {
  return path.join(app.getPath("userData"), "servers");
}

function getCachePath(...segments) {
  return path.join(
    app.getPath("userData"),
    "server-cache",
    ...segments.map((segment) => safeSegment(segment))
  );
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getAssetPath(...segments) {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(root, ...segments);
}

function writeMetadata(serverFolder, server) {
  fs.writeFileSync(
    path.join(serverFolder, "server-info.json"),
    JSON.stringify(server, null, 2),
    "utf8"
  );
}

function getSavedServers() {
  const root = getServersRoot();
  if (!fs.existsSync(root)) return [];

  const servers = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(root, entry.name);
    const metadata = readJson(path.join(folderPath, "server-info.json"));
    if (!metadata) continue;

    const id = Number(metadata.id || entry.name.split("-").at(-1));
    if (!Number.isSafeInteger(id)) continue;

    const type = normalizeServerType(metadata.type);
    servers.push({
      id,
      name: String(metadata.name || entry.name),
      type,
      typeLabel: serverTypeLabel(type),
      version: String(metadata.version || "unknown"),
      loaderVersion: String(metadata.loaderVersion || ""),
      color: normalizeColor(metadata.color),
      folderPath,
      jarPath: String(metadata.jarPath || ""),
      launchType: metadata.launchType === "javaArgsFile" ? "javaArgsFile" : "jar",
      launchArgsPath: String(metadata.launchArgsPath || ""),
      createdAt: String(metadata.createdAt || ""),
    });
  }

  return servers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getServer(id) {
  const serverId = normalizeServerId(id);
  return getSavedServers().find((server) => server.id === serverId) || null;
}

function createServerFolder(name, id) {
  const root = getServersRoot();
  const folder = path.join(root, `${safeSegment(name, "server")}-${id}`);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function compareVersions(a, b) {
  return String(b).localeCompare(String(a), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function validateDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The download service returned an invalid URL");
  }
  if (url.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(`Downloads from ${url.hostname || "this host"} are not allowed`);
  }
  return url.toString();
}

async function fetchResponse(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "User-Agent": APP_USER_AGENT,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response;
}

async function fetchJson(url) {
  const response = await fetchResponse(url, { headers: { Accept: "application/json" } });
  return response.json();
}

async function fetchText(url) {
  return (await fetchResponse(url)).text();
}

async function hashFile(filePath, algorithm) {
  const hash = crypto.createHash(algorithm);
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function downloadFile(url, destination, integrity = {}) {
  const safeUrl = validateDownloadUrl(url);
  const partial = `${destination}.part`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(partial, { force: true });

  try {
    const response = await fetchResponse(safeUrl);
    validateDownloadUrl(response.url);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));

    const size = fs.statSync(partial).size;
    if (integrity.size && size !== Number(integrity.size)) {
      throw new Error("Downloaded file size did not match the provider metadata");
    }
    if (integrity.sha1 && (await hashFile(partial, "sha1")) !== integrity.sha1) {
      throw new Error("Downloaded file failed SHA-1 verification");
    }
    if (integrity.sha256 && (await hashFile(partial, "sha256")) !== integrity.sha256) {
      throw new Error("Downloaded file failed SHA-256 verification");
    }

    fs.renameSync(partial, destination);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

async function cachedDownload(type, version, info, fallbackName) {
  const fileName = safeSegment(info.fileName || fallbackName, "server.jar");
  const destination = getCachePath(type, version, fileName);
  const matchesSize =
    fs.existsSync(destination) &&
    (!info.size || fs.statSync(destination).size === Number(info.size));

  let valid = matchesSize;
  if (valid && info.sha1) valid = (await hashFile(destination, "sha1")) === info.sha1;
  if (valid && info.sha256) valid = (await hashFile(destination, "sha256")) === info.sha256;

  if (!valid) await downloadFile(info.url, destination, info);
  return { path: destination, usedCache: valid };
}

async function assertJavaInstalled() {
  try {
    await execFileAsync("java", ["-version"], { windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (error.code === "ENOENT") throw new MissingJavaError();
    throw error;
  }
}

async function getVersionOptions(typeValue) {
  const type = normalizeServerType(typeValue);
  if (type === "vanilla") {
    const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
    return manifest.versions
      .filter((version) => version.type === "release")
      .map((version) => ({
        id: version.id,
        label: version.id,
        version: version.id,
        versionUrl: version.url,
      }));
  }

  if (type === "paper") {
    const project = await fetchJson("https://fill.papermc.io/v3/projects/paper");
    return Object.values(project.versions || {})
      .flat()
      .filter(Boolean)
      .sort(compareVersions)
      .map((version) => ({ id: version, label: version, version }));
  }

  if (type === "fabric") {
    const [games, loaders, installers] = await Promise.all([
      fetchJson("https://meta.fabricmc.net/v2/versions/game"),
      fetchJson("https://meta.fabricmc.net/v2/versions/loader"),
      fetchJson("https://meta.fabricmc.net/v2/versions/installer"),
    ]);
    const loaderVersion = (loaders.find((item) => item.stable) || loaders[0])?.version;
    const installerVersion = (installers.find((item) => item.stable) || installers[0])?.version;
    if (!loaderVersion || !installerVersion) throw new Error("Fabric versions are unavailable");
    return games
      .filter((game) => game.stable)
      .map((game) => ({
        id: game.version,
        label: `${game.version} · Fabric ${loaderVersion}`,
        version: game.version,
        loaderVersion,
        installerVersion,
      }));
  }

  if (type === "forge") {
    const xml = await fetchText("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml");
    return Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g))
      .map((match) => match[1])
      .filter((version) => version.includes("-"))
      .sort(compareVersions)
      .slice(0, 220)
      .map((loaderVersion) => ({
        id: loaderVersion,
        label: loaderVersion,
        version: loaderVersion.split("-")[0],
        loaderVersion,
      }));
  }

  const xml = await fetchText("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml");
  return Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g))
    .map((match) => match[1])
    .filter((version) => !version.includes("beta"))
    .sort(compareVersions)
    .slice(0, 200)
    .map((loaderVersion) => ({
      id: loaderVersion,
      label: `NeoForge ${loaderVersion}`,
      version: neoforgeMinecraftVersion(loaderVersion) || loaderVersion,
      loaderVersion,
    }));
}

function neoforgeMinecraftVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\./);
  if (!match) return "";
  if (Number(match[1]) === 20) return `1.20.${Number(match[2])}`;
  if (Number(match[1]) === 21) return `1.21.${Number(match[2])}`;
  return "";
}

async function vanillaDownload(versionUrl) {
  const url = validateDownloadUrl(versionUrl);
  if (new URL(url).hostname !== "piston-meta.mojang.com") {
    throw new Error("Invalid Vanilla version metadata URL");
  }
  const data = await fetchJson(url);
  const server = data.downloads?.server;
  if (!server?.url) throw new Error("This Minecraft version has no server download");
  return { url: server.url, sha1: server.sha1 || "", size: server.size || 0 };
}

async function paperDownload(version) {
  if (!/^[0-9a-z][0-9a-z._-]{0,50}$/i.test(version)) {
    throw new Error("Invalid Paper version");
  }
  const builds = await fetchJson(
    `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`
  );
  const build = builds.find((item) => item.channel === "STABLE") || builds[0];
  const file = build?.downloads?.["server:default"];
  if (!file?.url) throw new Error("No Paper download is available for this version");
  return {
    url: file.url,
    sha256: file.checksums?.sha256 || "",
    size: file.size || 0,
    fileName: file.name || `paper-${version}.jar`,
  };
}

async function createJarServer(data, type, info, loaderVersion = "") {
  const id = Date.now();
  const name = normalizeServerName(data.name);
  const folder = createServerFolder(name, id);
  try {
    const cached = await cachedDownload(type, data.version, info, `${type}-${data.version}.jar`);
    const server = {
      id,
      name,
      type,
      typeLabel: serverTypeLabel(type),
      version: String(data.version),
      loaderVersion,
      color: normalizeColor(data.color),
      folderPath: folder,
      jarPath: cached.path,
      launchType: "jar",
      createdAt: new Date().toISOString(),
    };
    writeMetadata(folder, server);
    return { success: true, usedCache: cached.usedCache, server };
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

async function installLoaderServer(data, type, loaderVersion, installerUrl) {
  await assertJavaInstalled();
  const id = Date.now();
  const name = normalizeServerName(data.name);
  const folder = createServerFolder(name, id);
  try {
    const installerName = `${type}-${loaderVersion}-installer.jar`;
    const cached = await cachedDownload(type, loaderVersion, {
      url: installerUrl,
      fileName: installerName,
    }, installerName);
    await execFileAsync("java", ["-jar", cached.path, "--installServer"], {
      cwd: folder,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });

    const argsName = process.platform === "win32" ? "win_args.txt" : "unix_args.txt";
    const argsRelative = type === "forge"
      ? path.join("libraries", "net", "minecraftforge", "forge", loaderVersion, argsName)
      : path.join("libraries", "net", "neoforged", "neoforge", loaderVersion, argsName);
    if (!fs.existsSync(path.join(folder, argsRelative))) {
      throw new Error(`${serverTypeLabel(type)} installed without a server launch file`);
    }

    const server = {
      id,
      name,
      type,
      typeLabel: serverTypeLabel(type),
      version: String(data.version),
      loaderVersion,
      color: normalizeColor(data.color),
      folderPath: folder,
      jarPath: cached.path,
      launchType: "javaArgsFile",
      launchArgsPath: argsRelative,
      createdAt: new Date().toISOString(),
    };
    writeMetadata(folder, server);
    return { success: true, usedCache: cached.usedCache, server };
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

async function createServer(data = {}) {
  const type = normalizeServerType(data.type);
  const version = String(data.version || "").trim();
  if (!version) throw new Error("Minecraft version is required");

  if (type === "vanilla") {
    return createJarServer(data, type, await vanillaDownload(data.versionUrl));
  }
  if (type === "paper") {
    return createJarServer(data, type, await paperDownload(version));
  }
  if (type === "fabric") {
    const loader = safeSegment(data.loaderVersion);
    const installer = safeSegment(data.installerVersion);
    const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
    return createJarServer(data, type, {
      url,
      fileName: `fabric-server-${version}-${loader}.jar`,
    }, loader);
  }

  const loader = safeSegment(data.loaderVersion || version);
  if (type === "forge") {
    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${loader}/forge-${loader}-installer.jar`;
    return installLoaderServer(data, type, loader, url);
  }
  const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loader}/neoforge-${loader}-installer.jar`;
  return installLoaderServer(data, type, loader, url);
}

function eulaPath(server) {
  return path.join(server.folderPath, "eula.txt");
}

function eulaAccepted(server) {
  try {
    return /^eula=true$/im.test(fs.readFileSync(eulaPath(server), "utf8"));
  } catch {
    return false;
  }
}

function acceptEula(server) {
  fs.writeFileSync(
    eulaPath(server),
    `# Accepted through ${APP_NAME} on ${new Date().toISOString()}\n# ${MINECRAFT_EULA_URL}\neula=true\n`,
    "utf8"
  );
}

function appendLog(runtime, value) {
  const line = String(value).trimEnd();
  if (!line) return;
  runtime.logs.push(line);
  if (runtime.logs.length > 300) runtime.logs.splice(0, runtime.logs.length - 300);
}

function runtimeSnapshot(id) {
  const serverId = normalizeServerId(id);
  const runtime = runningServers.get(serverId);
  const server = getServer(serverId);
  return {
    serverId,
    status: runtime?.status || "offline",
    pid: runtime?.process?.pid || null,
    startedAt: runtime?.startedAt || null,
    stoppedAt: runtime?.stoppedAt || null,
    exitCode: runtime?.exitCode ?? null,
    logs: runtime?.logs || [],
    eulaAccepted: server ? eulaAccepted(server) : false,
    eulaUrl: MINECRAFT_EULA_URL,
  };
}

function runningEntry() {
  return Array.from(runningServers.entries()).find(([, runtime]) =>
    runtime.process && runtime.status !== "offline"
  );
}

function maxMemoryMb() {
  const halfSystemMemory = Math.floor(os.totalmem() / 1024 / 1024 / 2 / 512) * 512;
  return Math.max(512, Math.min(4096, halfSystemMemory));
}

function launchCommand(server) {
  const common = [`-Dblockhost.serverId=${server.id}`, `-Xmx${maxMemoryMb()}M`];
  if (server.launchType === "javaArgsFile") {
    const absoluteArgs = path.isAbsolute(server.launchArgsPath)
      ? server.launchArgsPath
      : path.join(server.folderPath, server.launchArgsPath);
    if (!fs.existsSync(absoluteArgs)) throw new Error("Server launch files are missing");
    return ["java", [...common, `@${absoluteArgs}`, "nogui"]];
  }
  if (!server.jarPath || !fs.existsSync(server.jarPath)) {
    throw new Error("Server JAR is missing; delete and download the server again");
  }
  return ["java", [...common, "-jar", server.jarPath, "nogui"]];
}

async function startServer(id, options = {}) {
  const serverId = normalizeServerId(id);
  const current = runningServers.get(serverId);
  if (current?.process && current.status !== "offline") return runtimeSnapshot(serverId);

  const active = runningEntry();
  if (active && active[0] !== serverId) {
    if (!options.forceSwitch) {
      return {
        ...runtimeSnapshot(serverId),
        requiresServerSwitch: true,
        activeServer: { serverId: active[0], serverName: getServer(active[0])?.name || "another server" },
      };
    }
    await stopServer(active[0]);
  }

  const server = getServer(serverId);
  if (!server) throw new Error("Saved server not found");
  if (!eulaAccepted(server)) {
    if (!options.acceptEula) return { ...runtimeSnapshot(serverId), requiresEula: true };
    acceptEula(server);
  }

  await assertJavaInstalled();
  const [command, args] = launchCommand(server);
  const runtime = {
    status: "starting",
    process: null,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    exitCode: null,
    logs: [],
  };
  const child = spawn(command, args, {
    cwd: server.folderPath,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  runtime.process = child;
  runningServers.set(serverId, runtime);
  appendLog(runtime, `[APP] Starting ${server.name} with ${maxMemoryMb()} MB maximum RAM...`);

  const handleOutput = (chunk) => {
    chunk.toString().split(/\r?\n/).forEach((line) => {
      appendLog(runtime, line);
      if (/Done \(.+\)! For help/i.test(line)) runtime.status = "running";
    });
  };
  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);
  child.on("error", (error) => {
    runtime.status = "offline";
    runtime.stoppedAt = new Date().toISOString();
    appendLog(runtime, `[APP] Start failed: ${error.message}`);
  });
  child.on("exit", (code) => {
    runtime.status = "offline";
    runtime.stoppedAt = new Date().toISOString();
    runtime.exitCode = code;
    appendLog(runtime, `[APP] Server stopped (exit code ${code ?? "unknown"}).`);
  });
  return runtimeSnapshot(serverId);
}

async function stopServer(id) {
  const serverId = normalizeServerId(id);
  const runtime = runningServers.get(serverId);
  if (!runtime?.process || runtime.status === "offline") return runtimeSnapshot(serverId);

  runtime.status = "stopping";
  appendLog(runtime, "[APP] Stopping server...");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (runtime.process && !runtime.process.killed) {
        appendLog(runtime, "[APP] Graceful stop timed out; terminating process.");
        runtime.process.kill();
      }
    }, 15_000);
    runtime.process.once("exit", () => {
      clearTimeout(timer);
      resolve(runtimeSnapshot(serverId));
    });
    try {
      runtime.process.stdin.write("stop\n");
    } catch {
      runtime.process.kill();
    }
  });
}

function sendCommand(id, value) {
  const serverId = normalizeServerId(id);
  const command = String(value || "").trim();
  const runtime = runningServers.get(serverId);
  if (!runtime?.process || runtime.status !== "running") throw new Error("Server is not running");
  if (!command) return runtimeSnapshot(serverId);
  runtime.process.stdin.write(`${command}\n`);
  appendLog(runtime, `> ${command}`);
  return runtimeSnapshot(serverId);
}

async function getWindowsUsage(pids) {
  const list = pids.join(",");
  const script = `
    $ids = @(${list})
    $perf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)
    $items = foreach ($id in $ids) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
      $row = $perf | Where-Object { $_.IDProcess -eq $id } | Select-Object -First 1
      if ($process) {
        [PSCustomObject]@{
          pid = [int]$id
          cpuPercent = if ($row) { [Math]::Min(100, [Math]::Round([double]$row.PercentProcessorTime / [Environment]::ProcessorCount, 1)) } else { 0 }
          ramBytes = [int64]$process.WorkingSetSize
        }
      }
    }
    @($items) | ConvertTo-Json -Compress
  `;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(result) ? result : result ? [result] : [];
}

async function getUnixUsage(pids) {
  const { stdout } = await execFileAsync("ps", ["-p", pids.join(","), "-o", "pid=,pcpu=,rss="], {
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, cpu, rss] = line.trim().split(/\s+/).map(Number);
    return { pid, cpuPercent: cpu || 0, ramBytes: (rss || 0) * 1024 };
  });
}

async function getUsage() {
  const entries = Array.from(runningServers.entries()).filter(([, runtime]) =>
    runtime.process?.pid && runtime.status !== "offline"
  );
  if (!entries.length) return { sampledAt: new Date().toISOString(), processes: [] };
  const pids = entries.map(([, runtime]) => runtime.process.pid);
  let usage = [];
  try {
    usage = process.platform === "win32" ? await getWindowsUsage(pids) : await getUnixUsage(pids);
  } catch {
    usage = [];
  }
  return {
    sampledAt: new Date().toISOString(),
    processes: entries.map(([serverId, runtime]) => {
      const row = usage.find((item) => Number(item.pid) === runtime.process.pid) || {};
      return {
        serverId,
        pid: runtime.process.pid,
        cpuPercent: Number(row.cpuPercent) || 0,
        ramBytes: Number(row.ramBytes) || 0,
      };
    }),
  };
}

async function deleteServer(id) {
  const serverId = normalizeServerId(id);
  await stopServer(serverId);
  const server = getServer(serverId);
  if (!server) return { deleted: false };
  const root = getServersRoot();
  if (!isInside(root, server.folderPath)) throw new Error("Refusing to delete an unexpected folder");
  fs.rmSync(server.folderPath, { recursive: true, force: true });
  runningServers.delete(serverId);
  return { deleted: true };
}

async function stopAllServers() {
  const ids = Array.from(runningServers.keys());
  await Promise.all(ids.map((id) => stopServer(id)));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    icon: getAssetPath("assets", "app-icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === MINECRAFT_EULA_URL || url.startsWith("https://adoptium.net/")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow.webContents.getURL();
    if (url !== current) event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

if (started) app.quit();

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitInProgress || !runningEntry()) return;
  event.preventDefault();
  quitInProgress = true;
  stopAllServers().finally(() => app.quit());
});

ipcMain.handle("servers:getVersionOptions", (_event, options) =>
  getVersionOptions(options?.type)
);
ipcMain.handle("servers:create", (_event, data) => createServer(data));
ipcMain.handle("servers:getSaved", () => getSavedServers());
ipcMain.handle("servers:getRuntimeState", (_event, id) => runtimeSnapshot(id));
ipcMain.handle("servers:getUsage", () => getUsage());
ipcMain.handle("servers:start", (_event, data) => startServer(data?.id, {
  acceptEula: Boolean(data?.acceptEula),
  forceSwitch: Boolean(data?.forceSwitch),
}));
ipcMain.handle("servers:stop", (_event, id) => stopServer(id));
ipcMain.handle("servers:sendCommand", (_event, data) => sendCommand(data?.id, data?.command));
ipcMain.handle("servers:delete", (_event, id) => deleteServer(id));
