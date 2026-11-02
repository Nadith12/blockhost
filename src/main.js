import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import started from "electron-squirrel-startup";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { atomicWriteFile, commitFileBackup, isPathInside } from "./lib/safe-filesystem.mjs";
import {
  createServerFolder as createStoredServerFolder,
  getSavedServer,
  getSavedServers as loadSavedServers,
  normalizeColor,
  normalizeServerId,
  normalizeServerName,
  normalizeServerType,
  safeSegment,
  serverTypeLabel,
  updateServerMetadata,
  writeServerMetadata,
} from "./lib/server-store.mjs";
import {
  getActiveOperations,
  subscribeOperations,
  waitForOperations,
  withServerOperation,
} from "./lib/operation-manager.mjs";
import {
  loadServerProperties,
  rollbackServerProperties,
  saveServerProperties,
} from "./lib/server-properties.mjs";
import {
  checkAddonUpdates,
  cleanupAbandonedAddonTransactions,
  commitAddonTransaction,
  installManualAddon,
  installModrinthAddon,
  listServerAddons,
  removeAddon,
  recommendCompatibleAddons,
  rollbackAddonTransaction,
  rollbackAddonVersion,
  searchCompatibleAddons,
  setAddonReleaseChannel,
  setAddonEnabled,
  updateAllModrinthAddons,
  updateModrinthAddon,
} from "./lib/addon-manager.mjs";
import {
  cleanupAbandonedTransfers,
  exportBlockhostServer,
  importBlockhostServer,
} from "./lib/transfer-manager.mjs";
import {
  cleanupAbandonedExternalImports,
  importExternalServer,
} from "./lib/external-importer.mjs";
import { exportWorld, importWorld } from "./lib/world-manager.mjs";
import { assertSupportedJavaRuntime, parseJavaRuntimeDetails } from "./lib/java-runtime.mjs";
import { findJavaExecutable, installManagedJava, isManagedJavaReady } from "./lib/managed-java.mjs";

const execFileAsync = promisify(execFile);
const APP_NAME = "BlockHost Manager";
const APP_USER_AGENT = "BlockHostManager/1.0.2";
const DEFAULT_COLOR = "#39c9ff";
const MINECRAFT_EULA_URL = "https://aka.ms/MinecraftEULA";
const JAVA_INSTALL_URL = "https://adoptium.net/temurin/releases/?package=jdk";
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
const recentExports = new Set();
const approvedWorldSources = new Map();
let javaInstallPromise = null;

let mainWindow;
let quitInProgress = false;
let quitAfterTransfers = false;
let activeTransfers = 0;

async function finishQueuedQuit() {
  if (!quitAfterTransfers || quitInProgress || activeTransfers > 0) return;
  await waitForOperations();
  if (activeTransfers > 0 || quitInProgress) return;
  quitInProgress = true;
  await stopAllServers();
  app.quit();
}

class MissingJavaError extends Error {
  constructor() {
    super("Java is not installed or is not available on PATH. Install a JDK and reopen BlockHost Manager.");
    this.name = "MissingJavaError";
  }
}

function getServersRoot() {
  return path.join(app.getPath("userData"), "servers");
}

function getExportsDirectory() {
  return path.join(app.getPath("documents"), "BlockHost Exports");
}

function getCachePath(...segments) {
  return path.join(
    app.getPath("userData"),
    "server-cache",
    ...segments.map((segment) => safeSegment(segment))
  );
}

function getAssetPath(...segments) {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(root, ...segments);
}

function getSavedServers() {
  return loadSavedServers(getServersRoot());
}

function getServer(id) {
  return getSavedServer(getServersRoot(), id);
}

function createServerFolder(name, id) {
  return createStoredServerFolder(getServersRoot(), name, id);
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

function getManagedRuntimeRoot() {
  return path.join(app.getPath("userData"), "runtime");
}

async function probeJava(command) {
  const result = await execFileAsync(command, ["-XshowSettings:properties", "-version"], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const details = assertSupportedJavaRuntime(parseJavaRuntimeDetails(`${result.stdout || ""}\n${result.stderr || ""}`));
  return { command, details };
}

async function getJavaRuntimeStatus() {
  const managedHome = path.join(getManagedRuntimeRoot(), "java-21");
  const managedCommand = isManagedJavaReady(managedHome) ? findJavaExecutable(managedHome, process.platform) : "";
  if (managedCommand) {
    try {
      const runtime = await probeJava(managedCommand);
      return { ready: true, source: "managed", autoInstallAvailable: true, ...runtime };
    } catch {}
  }
  try {
    const runtime = await probeJava("java");
    return { ready: true, source: "system", autoInstallAvailable: process.platform === "win32" && process.arch === "x64", ...runtime };
  } catch (error) {
    const reason = error.code === "ENOENT" ? new MissingJavaError().message : error.message;
    return {
      ready: false,
      source: "none",
      autoInstallAvailable: process.platform === "win32" && process.arch === "x64",
      reason,
    };
  }
}

async function assertJavaInstalled() {
  const status = await getJavaRuntimeStatus();
  if (!status.ready) throw new Error(status.reason || new MissingJavaError().message);
  return status;
}

async function installJavaDependency() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Automatic Java setup currently supports 64-bit Windows only");
  if (javaInstallPromise) return javaInstallPromise;
  javaInstallPromise = installManagedJava({
    runtimeRoot: getManagedRuntimeRoot(),
    validateJava: (command) => probeJava(command),
    onProgress: (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("dependencies:progress", progress);
    },
  }).then(() => getJavaRuntimeStatus()).finally(() => { javaInstallPromise = null; });
  return javaInstallPromise;
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
    const localJar = path.join(folder, "server.jar");
    fs.copyFileSync(cached.path, localJar, fs.constants.COPYFILE_EXCL);
    if (data.worldSourcePath) await importWorld(data.worldSourcePath, folder);
    const server = {
      id,
      name,
      type,
      typeLabel: serverTypeLabel(type),
      version: String(data.version),
      loaderVersion,
      color: normalizeColor(data.color),
      folderPath: folder,
      jarFile: "server.jar",
      jarPath: localJar,
      launchType: "jar",
      createdAt: new Date().toISOString(),
    };
    const savedServer = writeServerMetadata(folder, server);
    return { success: true, usedCache: cached.usedCache, server: savedServer };
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

async function installLoaderServer(data, type, loaderVersion, installerUrl) {
  const javaRuntime = await assertJavaInstalled();
  const id = Date.now();
  const name = normalizeServerName(data.name);
  const folder = createServerFolder(name, id);
  try {
    const installerName = `${type}-${loaderVersion}-installer.jar`;
    const cached = await cachedDownload(type, loaderVersion, {
      url: installerUrl,
      fileName: installerName,
    }, installerName);
    await execFileAsync(javaRuntime.command, ["-jar", cached.path, "--installServer"], {
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
    if (data.worldSourcePath) await importWorld(data.worldSourcePath, folder);

    const server = {
      id,
      name,
      type,
      typeLabel: serverTypeLabel(type),
      version: String(data.version),
      loaderVersion,
      color: normalizeColor(data.color),
      folderPath: folder,
      launchType: "javaArgsFile",
      launchArgsPath: argsRelative,
      createdAt: new Date().toISOString(),
    };
    const savedServer = writeServerMetadata(folder, server);
    return { success: true, usedCache: cached.usedCache, server: savedServer };
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

async function createServer(data = {}) {
  const type = normalizeServerType(data.type);
  const version = String(data.version || "").trim();
  if (!version) throw new Error("Minecraft version is required");
  const worldToken = String(data.worldImportToken || "");
  const approvedWorld = worldToken ? approvedWorldSources.get(worldToken) : null;
  if (worldToken && !approvedWorld) throw new Error("Choose the world import again before downloading the server");
  const input = { ...data, worldSourcePath: approvedWorld?.path || "" };
  let result;

  if (type === "vanilla") {
    result = await createJarServer(input, type, await vanillaDownload(input.versionUrl));
  } else if (type === "paper") {
    result = await createJarServer(input, type, await paperDownload(version));
  } else if (type === "fabric") {
    const loader = safeSegment(data.loaderVersion);
    const installer = safeSegment(data.installerVersion);
    const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
    result = await createJarServer(input, type, {
      url,
      fileName: `fabric-server-${version}-${loader}.jar`,
    }, loader);
  } else {
    const loader = safeSegment(data.loaderVersion || version);
    if (type === "forge") {
      const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${loader}/forge-${loader}-installer.jar`;
      result = await installLoaderServer(input, type, loader, url);
    } else {
      const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loader}/neoforge-${loader}-installer.jar`;
      result = await installLoaderServer(input, type, loader, url);
    }
  }
  if (worldToken) approvedWorldSources.delete(worldToken);
  return result;
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
    pid: runtime?.status !== "offline" ? runtime?.process?.pid || null : null,
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

function defaultMaxMemoryMb() {
  const halfSystemMemory = Math.floor(os.totalmem() / 1024 / 1024 / 2 / 512) * 512;
  return Math.max(512, Math.min(4096, halfSystemMemory));
}

function memoryLimitMb() {
  const available = Math.floor((os.totalmem() / 1024 / 1024) * 0.8 / 256) * 256;
  return Math.max(1024, available);
}

function memorySettings(server) {
  const limitMb = memoryLimitMb();
  const defaultMax = Math.min(defaultMaxMemoryMb(), limitMb);
  const maxMemoryMb = Math.max(512, Math.min(limitMb, Number(server?.maxMemoryMb) || defaultMax));
  const minMemoryMb = Math.max(512, Math.min(maxMemoryMb, Number(server?.minMemoryMb) || 512));
  return {
    minMemoryMb,
    maxMemoryMb,
    limitMb,
    systemMemoryMb: Math.floor(os.totalmem() / 1024 / 1024),
  };
}

function getServerMemory(id) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return memorySettings(server);
}

function updateServerIdentity(id, input = {}) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  const name = normalizeServerName(input.name);
  const color = normalizeColor(input.color);
  const updated = updateServerMetadata(server.folderPath, {
    name,
    color,
    lastModifiedAt: new Date().toISOString(),
  });
  return { ...server, ...updated, name, color };
}

function updateServerMemory(id, input = {}) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  const limitMb = memoryLimitMb();
  const minMemoryMb = Number(input.minMemoryMb);
  const maxMemoryMb = Number(input.maxMemoryMb);
  if (!Number.isSafeInteger(minMemoryMb) || !Number.isSafeInteger(maxMemoryMb)) throw new Error("Choose valid RAM values");
  if (minMemoryMb < 512 || maxMemoryMb > limitMb || minMemoryMb > maxMemoryMb) {
    throw new Error(`Choose between 512 MB and ${limitMb} MB, with minimum RAM no higher than maximum RAM`);
  }
  if (minMemoryMb % 256 || maxMemoryMb % 256) throw new Error("RAM values must use 256 MB steps");
  updateServerMetadata(server.folderPath, { minMemoryMb, maxMemoryMb, lastModifiedAt: new Date().toISOString() });
  Object.assign(server, { minMemoryMb, maxMemoryMb });
  return { ...memorySettings(server), appliesOnNextStart: Boolean(runningServers.get(server.id)?.process) };
}

function launchCommand(server, javaCommand = "java") {
  const memory = memorySettings(server);
  const common = [`-Dblockhost.serverId=${server.id}`, `-Xms${memory.minMemoryMb}M`, `-Xmx${memory.maxMemoryMb}M`];
  if (server.launchType === "javaArgsFile") {
    const absoluteArgs = path.isAbsolute(server.launchArgsPath)
      ? server.launchArgsPath
      : path.join(server.folderPath, server.launchArgsPath);
    if (!fs.existsSync(absoluteArgs)) throw new Error("Server launch files are missing");
    return [javaCommand, [...common, `@${absoluteArgs}`, "nogui"]];
  }
  if (!server.jarPath || !fs.existsSync(server.jarPath)) {
    throw new Error("Server JAR is missing; delete and download the server again");
  }
  return [javaCommand, [...common, "-jar", server.jarPath, "nogui"]];
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

  const javaRuntime = await assertJavaInstalled();
  const [command, args] = launchCommand(server, javaRuntime.command);
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
  const configuredMemory = memorySettings(server);
  appendLog(runtime, `[APP] Starting ${server.name} with ${configuredMemory.minMemoryMb} MB minimum and ${configuredMemory.maxMemoryMb} MB maximum RAM...`);

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
    runtime.process = null;
    appendLog(runtime, `[APP] Start failed: ${error.message}`);
  });
  child.on("exit", (code) => {
    runtime.status = "offline";
    runtime.stoppedAt = new Date().toISOString();
    runtime.exitCode = code;
    runtime.process = null;
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServerReady(id, timeoutMilliseconds = 240_000) {
  const serverId = normalizeServerId(id);
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const runtime = runningServers.get(serverId);
    if (runtime?.status === "running") return runtimeSnapshot(serverId);
    if (!runtime || runtime.status === "offline") {
      const lastLine = runtime?.logs?.at(-1);
      throw new Error(lastLine || "The server stopped before it finished starting");
    }
    await delay(250);
  }
  throw new Error("The server did not finish starting within four minutes");
}

async function restartAndWait(id) {
  const startedRuntime = await startServer(id);
  if (startedRuntime.requiresEula) {
    throw new Error("The Minecraft EULA must be accepted before the server can restart");
  }
  if (startedRuntime.requiresServerSwitch) {
    throw new Error("Another server started while these settings were being saved");
  }
  return waitForServerReady(id);
}

function getProperties(id) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return loadServerProperties(server.folderPath, server.version);
}

async function updateProperties(id, data = {}) {
  const serverId = normalizeServerId(id);
  return withServerOperation(serverId, "updating its properties", async () => {
    const server = getServer(serverId);
    if (!server) throw new Error("Saved server not found");

    const runtime = runningServers.get(serverId);
    const wasRunning = Boolean(runtime?.process && runtime.status !== "offline");
    const shouldRestart = wasRunning && Boolean(data.restart);
    if (shouldRestart) await stopServer(serverId);

    let saved;
    try {
      saved = saveServerProperties(server.folderPath, {
        mode: data.mode,
        values: data.values,
        customProperties: data.customProperties,
        rawText: data.rawText,
      }, server.version);
    } catch (error) {
      if (shouldRestart) {
        try {
          await restartAndWait(serverId);
        } catch (recoveryError) {
          throw new Error(
            `${error.message}. The original server could not be restarted: ${recoveryError.message}`
          );
        }
      }
      throw error;
    }

    if (shouldRestart) {
      try {
        await restartAndWait(serverId);
      } catch (startError) {
        try {
          await stopServer(serverId);
          rollbackServerProperties(saved.transaction);
        } catch (rollbackError) {
          throw new Error(
            `The new properties prevented startup, and automatic recovery failed: ${rollbackError.message}`
          );
        }

        try {
          await restartAndWait(serverId);
        } catch (recoveryError) {
          throw new Error(
            `The new properties were rolled back, but the server could not be restarted: ${recoveryError.message}`
          );
        }
        commitFileBackup(saved.transaction);
        throw new Error(
          `The server could not start with the new properties, so the previous properties were restored. ${startError.message}`
        );
      }
    }

    updateServerMetadata(server.folderPath, {
      lastModifiedAt: new Date().toISOString(),
    });
    commitFileBackup(saved.transaction);
    return {
      properties: loadServerProperties(server.folderPath, server.version),
      runtime: runtimeSnapshot(serverId),
      restarted: shouldRestart,
      appliesOnNextStart: wasRunning && !shouldRestart,
    };
  });
}

function getAddons(id) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return listServerAddons(server);
}

function addonSearchCachePath() {
  return path.join(app.getPath("userData"), "addon-search-cache.json");
}

function readAddonSearchCache() {
  try {
    const value = JSON.parse(fs.readFileSync(addonSearchCachePath(), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function searchAddonsWithCache(server, query, recommendations = false) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const key = `${server.type}:${server.version}:${recommendations ? "recommended" : normalizedQuery}`;
  const cache = readAddonSearchCache();
  try {
    const result = recommendations
      ? await recommendCompatibleAddons(server)
      : await searchCompatibleAddons(server, query);
    cache[key] = { savedAt: new Date().toISOString(), result };
    const entries = Object.entries(cache).slice(-100);
    atomicWriteFile(addonSearchCachePath(), `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
    return { ...result, cached: false, offline: false };
  } catch (error) {
    if (cache[key]?.result) {
      return { ...cache[key].result, cached: true, offline: true, offlineMessage: "Internet connection unavailable. Showing cached results." };
    }
    throw new Error(`Internet connection required to search add-ons. No files were changed. ${error.message}`);
  }
}

async function applyAddonChange(id, operation, mutation) {
  const serverId = normalizeServerId(id);
  return withServerOperation(serverId, operation, async () => {
    const server = getServer(serverId);
    if (!server) throw new Error("Saved server not found");
    const runtime = runningServers.get(serverId);
    const wasRunning = Boolean(runtime?.process && runtime.status !== "offline");
    if (wasRunning) await stopServer(serverId);

    let result;
    try {
      result = await mutation(server);
    } catch (error) {
      if (wasRunning) {
        try {
          await restartAndWait(serverId);
        } catch (recoveryError) {
          throw new Error(`${error.message}. The unchanged server could not be restarted: ${recoveryError.message}`);
        }
      }
      throw error;
    }

    if (wasRunning) {
      try {
        await restartAndWait(serverId);
      } catch (startError) {
        try {
          await stopServer(serverId);
          rollbackAddonTransaction(result.transaction);
        } catch (rollbackError) {
          throw new Error(`The add-on change prevented startup, and automatic recovery failed: ${rollbackError.message}`);
        }
        try {
          await restartAndWait(serverId);
        } catch (recoveryError) {
          throw new Error(`The add-on change was rolled back, but the server could not be restarted: ${recoveryError.message}`);
        }
        throw new Error(`The server could not start with the add-on change, so it was rolled back. ${startError.message}`);
      }
    }

    commitAddonTransaction(result.transaction);
    updateServerMetadata(server.folderPath, { lastModifiedAt: new Date().toISOString() });
    return {
      addons: listServerAddons(server),
      runtime: runtimeSnapshot(serverId),
      restarted: wasRunning,
      cancelled: false,
      warnings: result.warnings || [],
      removed: result.removed || [],
      updated: Number(result.updated) || 0,
    };
  });
}

async function installManualAddonFromDialog(id) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Install a server add-on",
    buttonLabel: "Install add-on",
    properties: ["openFile"],
    filters: [{ name: "Java add-ons", extensions: ["jar"] }],
  });
  if (selection.canceled || !selection.filePaths[0]) {
    return { cancelled: true, addons: listServerAddons(server), runtime: runtimeSnapshot(id), restarted: false };
  }
  return applyAddonChange(id, "installing an add-on", (currentServer) =>
    installManualAddon(currentServer, selection.filePaths[0])
  );
}

async function installManualAddonFromPath(id, filePath) {
  if (!filePath) throw new Error("No add-on file was provided");
  return applyAddonChange(id, "installing an add-on", (server) => installManualAddon(server, filePath));
}

function sendTransferProgress(kind, serverId, progress) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("transfers:progress", {
    kind,
    serverId: serverId || null,
    ...progress,
  });
}

function safeExportFileName(value) {
  const name = String(value || "Minecraft server")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100);
  return name || "Minecraft server";
}

function nextExportPath(server) {
  const directory = getExportsDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${safeExportFileName(server.name)} ${timestamp}`;
  let destination = path.join(directory, `${base}.blockhost`);
  let suffix = 2;
  while (fs.existsSync(destination)) {
    destination = path.join(directory, `${base} (${suffix}).blockhost`);
    suffix += 1;
  }
  return destination;
}

async function chooseWorldImportSource() {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a Minecraft world",
    buttonLabel: "Use this world",
    properties: ["openFile", "openDirectory"],
    filters: [{ name: "Minecraft world ZIPs", extensions: ["zip"] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const selectedPath = path.resolve(selection.filePaths[0]);
  const stats = fs.statSync(selectedPath);
  if (!stats.isDirectory() && path.extname(selectedPath).toLowerCase() !== ".zip") {
    throw new Error("Choose a Minecraft world folder or ZIP file");
  }
  const token = crypto.randomUUID();
  approvedWorldSources.set(token, { path: selectedPath, createdAt: Date.now() });
  for (const [key, value] of approvedWorldSources) {
    if (Date.now() - value.createdAt > 60 * 60 * 1000) approvedWorldSources.delete(key);
  }
  return { token, label: path.basename(selectedPath), kind: stats.isDirectory() ? "folder" : "zip" };
}

async function runTrackedTransfer(task) {
  activeTransfers += 1;
  try {
    return await task();
  } finally {
    activeTransfers -= 1;
    finishQueuedQuit();
  }
}

async function exportServerArchive(id, requestedDestination = "") {
  const serverId = normalizeServerId(id);
  const server = getServer(serverId);
  if (!server) throw new Error("Saved server not found");
  const runtime = runningServers.get(serverId);
  const wasRunning = Boolean(runtime?.process && runtime.status !== "offline");
  const destination = requestedDestination ? path.resolve(requestedDestination) : nextExportPath(server);
  let result;
  let exportError;
  let restartError;

  sendTransferProgress("export", serverId, { stage: "prepare", percent: 0, message: wasRunning ? "Stopping the server safely…" : "Preparing the export…" });
  if (wasRunning) await stopServer(serverId);
  try {
    result = await exportBlockhostServer(server, destination, {
      createdBy: `${APP_NAME} ${app.getVersion()}`,
      onProgress: (progress) => sendTransferProgress("export", serverId, progress),
    });
    recentExports.add(result.path);
  } catch (error) {
    exportError = error;
  } finally {
    if (wasRunning) {
      sendTransferProgress("export", serverId, { stage: "restart", percent: 99, message: "Restarting the server…" });
      try { await restartAndWait(serverId); }
      catch (error) { restartError = error; }
    }
  }

  if (exportError) {
    if (restartError) throw new Error(`${exportError.message}. Export failed and the server could not be restarted: ${restartError.message}`);
    throw exportError;
  }
  return {
    ...result,
    serverName: server.name,
    restarted: wasRunning && !restartError,
    restartError: restartError?.message || "",
  };
}

async function exportServerAs(id) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: "Export BlockHost server as",
    buttonLabel: "Export server",
    defaultPath: path.join(getExportsDirectory(), `${safeExportFileName(server.name)}.blockhost`),
    filters: [{ name: "BlockHost server archives", extensions: ["blockhost"] }],
  });
  if (selection.canceled || !selection.filePath) return { cancelled: true };
  const destination = selection.filePath.toLowerCase().endsWith(".blockhost")
    ? selection.filePath
    : `${selection.filePath}.blockhost`;
  return exportServerArchive(id, destination);
}

async function exportServerWorld(id) {
  const serverId = normalizeServerId(id);
  const server = getServer(serverId);
  if (!server) throw new Error("Saved server not found");
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: "Export Minecraft world",
    buttonLabel: "Export world",
    defaultPath: path.join(getExportsDirectory(), `${safeExportFileName(server.name)} world.zip`),
    filters: [{ name: "Minecraft world archives", extensions: ["zip"] }],
  });
  if (selection.canceled || !selection.filePath) return { cancelled: true };
  const destination = selection.filePath.toLowerCase().endsWith(".zip") ? selection.filePath : `${selection.filePath}.zip`;
  const runtime = runningServers.get(serverId);
  const wasRunning = Boolean(runtime?.process && runtime.status !== "offline");
  let result;
  let exportError;
  let restartError;
  sendTransferProgress("world-export", serverId, { stage: "prepare", percent: 0, message: wasRunning ? "Stopping the server safely…" : "Preparing the world export…" });
  if (wasRunning) await stopServer(serverId);
  try {
    result = await exportWorld(server.folderPath, destination, {
      onProgress: (progress) => sendTransferProgress("world-export", serverId, progress),
    });
    recentExports.add(result.path);
  } catch (error) {
    exportError = error;
  } finally {
    if (wasRunning) {
      sendTransferProgress("world-export", serverId, { stage: "restart", percent: 99, message: "Restarting the server…" });
      try { await restartAndWait(serverId); }
      catch (error) { restartError = error; }
    }
  }
  if (exportError) {
    if (restartError) throw new Error(`${exportError.message}. The world export failed and the server could not be restarted: ${restartError.message}`);
    throw exportError;
  }
  return {
    ...result,
    kind: "world-export",
    serverName: server.name,
    restarted: wasRunning && !restartError,
    restartError: restartError?.message || "",
  };
}

async function importServerArchive(filePath) {
  const selectedPath = path.resolve(String(filePath || ""));
  if (path.extname(selectedPath).toLowerCase() !== ".blockhost") throw new Error("Select a .blockhost server archive");
  const result = await importBlockhostServer(selectedPath, getServersRoot(), getSavedServers(), {
    onProgress: (progress) => sendTransferProgress("import", null, progress),
  });
  const server = getServer(result.server.id);
  if (!server) throw new Error("The server was restored but could not be loaded");
  return { ...result, server };
}

async function importServerFromDialog() {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Import a BlockHost server",
    buttonLabel: "Import server",
    properties: ["openFile"],
    filters: [{ name: "BlockHost server archives", extensions: ["blockhost"] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  return withServerOperation(0, "importing a server", () => importServerArchive(selection.filePaths[0]));
}

async function importExternalServerPath(filePath) {
  const result = await importExternalServer(filePath, getServersRoot(), getSavedServers(), {
    onProgress: (value) => sendTransferProgress("external-import", null, value),
  });
  const server = getServer(result.server.id);
  if (!server) throw new Error("The external server was imported but could not be loaded");
  return { ...result, server };
}

async function importExternalServerFromDialog() {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Import an existing Minecraft server",
    buttonLabel: "Import detected server",
    properties: ["openFile", "openDirectory"],
    filters: [{ name: "Minecraft server ZIPs", extensions: ["zip"] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  return withServerOperation(0, "importing an external server", () => importExternalServerPath(selection.filePaths[0]));
}

function openExportFolder(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!recentExports.has(resolved) || !fs.existsSync(resolved)) throw new Error("That export is no longer available");
  shell.showItemInFolder(resolved);
  return { opened: true };
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
  if (!isPathInside(root, server.folderPath)) throw new Error("Refusing to delete an unexpected folder");
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
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#07111d",
      symbolColor: "#7890a8",
      height: 40,
    },
    autoHideMenuBar: true,
    backgroundColor: "#08101d",
    icon: getAssetPath("assets", "app-icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();

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
  cleanupAbandonedTransfers(getServersRoot(), getExportsDirectory());
  cleanupAbandonedAddonTransactions(getServersRoot());
  cleanupAbandonedExternalImports(getServersRoot());
  createWindow();
  subscribeOperations((operations) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("operations:state", operations);
    finishQueuedQuit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitInProgress) return;
  if (activeTransfers > 0 || getActiveOperations().length > 0) {
    event.preventDefault();
    quitAfterTransfers = true;
    finishQueuedQuit();
    return;
  }
  if (!runningEntry()) return;
  event.preventDefault();
  quitInProgress = true;
  stopAllServers().finally(() => app.quit());
});

ipcMain.handle("servers:getVersionOptions", (_event, options) =>
  getVersionOptions(options?.type)
);
ipcMain.handle("dependencies:getJavaStatus", () => getJavaRuntimeStatus());
ipcMain.handle("dependencies:installJava", () => installJavaDependency());
ipcMain.handle("servers:create", (_event, data) =>
  withServerOperation(-1, "downloading a server", () => createServer(data))
);
ipcMain.handle("servers:getSaved", () => getSavedServers());
ipcMain.handle("servers:getRuntimeState", (_event, id) => runtimeSnapshot(id));
ipcMain.handle("servers:getUsage", () => getUsage());
ipcMain.handle("operations:getActive", () => getActiveOperations());
ipcMain.handle("servers:start", (_event, data) =>
  withServerOperation(data?.id, "starting", () => startServer(data?.id, {
    acceptEula: Boolean(data?.acceptEula),
    forceSwitch: Boolean(data?.forceSwitch),
  }))
);
ipcMain.handle("servers:stop", (_event, id) =>
  withServerOperation(id, "stopping", () => stopServer(id))
);
ipcMain.handle("servers:sendCommand", (_event, data) => sendCommand(data?.id, data?.command));
ipcMain.handle("servers:delete", (_event, id) =>
  withServerOperation(id, "being deleted", () => deleteServer(id))
);
ipcMain.handle("servers:getProperties", (_event, id) => getProperties(id));
ipcMain.handle("servers:updateProperties", (_event, data) =>
  updateProperties(data?.id, data)
);
ipcMain.handle("servers:getMemory", (_event, id) => getServerMemory(id));
ipcMain.handle("servers:updateMemory", (_event, data) =>
  withServerOperation(data?.id, "updating memory settings", () => updateServerMemory(data?.id, data))
);
ipcMain.handle("servers:updateIdentity", (_event, data) =>
  withServerOperation(data?.id, "updating server details", () => updateServerIdentity(data?.id, data))
);
ipcMain.handle("worlds:chooseImportSource", () => chooseWorldImportSource());
ipcMain.handle("worlds:export", (_event, id) =>
  withServerOperation(id, "exporting the world", () => runTrackedTransfer(() => exportServerWorld(id)))
);
ipcMain.handle("addons:list", (_event, id) => getAddons(id));
ipcMain.handle("addons:recommendations", (_event, id) => {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return searchAddonsWithCache(server, "", true);
});
ipcMain.handle("addons:search", (_event, data) => {
  const server = getServer(data?.id);
  if (!server) throw new Error("Saved server not found");
  return searchAddonsWithCache(server, data?.query);
});
ipcMain.handle("addons:install", (_event, data) =>
  applyAddonChange(data?.id, "installing an add-on", (server) =>
    installModrinthAddon(server, {
      projectId: String(data?.projectId || ""),
      title: String(data?.title || "Selected add-on"),
      iconUrl: String(data?.iconUrl || ""),
    })
  )
);
ipcMain.handle("addons:installManual", (_event, id) => installManualAddonFromDialog(id));
ipcMain.handle("addons:installManualPath", (_event, data) =>
  installManualAddonFromPath(data?.id, data?.filePath)
);
ipcMain.handle("addons:setEnabled", (_event, data) =>
  applyAddonChange(data?.id, data?.enabled ? "enabling an add-on" : "disabling an add-on", (server) =>
    setAddonEnabled(server, String(data?.addonId || ""), Boolean(data?.enabled), { cascade: Boolean(data?.cascade) })
  )
);
ipcMain.handle("addons:remove", (_event, data) =>
  applyAddonChange(data?.id, "removing an add-on", (server) =>
    removeAddon(server, String(data?.addonId || ""), { cascade: Boolean(data?.cascade) })
  )
);
ipcMain.handle("addons:checkUpdates", (_event, id) => {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return withServerOperation(id, "checking add-on updates", () => checkAddonUpdates(server));
});
ipcMain.handle("addons:update", (_event, data) =>
  applyAddonChange(data?.id, "updating an add-on", (server) =>
    updateModrinthAddon(server, String(data?.addonId || ""))
  )
);
ipcMain.handle("addons:updateAll", (_event, id) =>
  applyAddonChange(id, "updating all add-ons", (server) => updateAllModrinthAddons(server))
);
ipcMain.handle("addons:setReleaseChannel", (_event, data) =>
  withServerOperation(data?.id, "changing the add-on release channel", () => {
    const server = getServer(data?.id);
    if (!server) throw new Error("Saved server not found");
    const result = setAddonReleaseChannel(server, String(data?.releaseChannel || "stable"));
    commitAddonTransaction(result.transaction);
    return { addons: result.addons, runtime: runtimeSnapshot(data?.id), restarted: false };
  })
);
ipcMain.handle("addons:rollback", (_event, data) =>
  applyAddonChange(data?.id, "rolling back an add-on", (server) =>
    rollbackAddonVersion(server, String(data?.addonId || ""), String(data?.versionId || ""))
  )
);
ipcMain.handle("transfers:export", (_event, id) =>
  runTrackedTransfer(() => withServerOperation(id, "being exported", () => exportServerArchive(id)))
);
ipcMain.handle("transfers:exportAs", (_event, id) =>
  runTrackedTransfer(() => withServerOperation(id, "being exported", () => exportServerAs(id)))
);
ipcMain.handle("transfers:importDialog", () => runTrackedTransfer(() => importServerFromDialog()));
ipcMain.handle("transfers:importExternalDialog", () => runTrackedTransfer(() => importExternalServerFromDialog()));
ipcMain.handle("transfers:importPath", (_event, filePath) =>
  runTrackedTransfer(() => withServerOperation(0, "importing a server", () => importServerArchive(filePath)))
);
ipcMain.handle("transfers:importExternalPath", (_event, filePath) =>
  runTrackedTransfer(() => withServerOperation(0, "importing an external server", () => importExternalServerPath(filePath)))
);
ipcMain.handle("transfers:openExportFolder", (_event, filePath) => openExportFolder(filePath));
