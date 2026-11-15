import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from "electron";
import started from "electron-squirrel-startup";
import updaterPackage from "electron-updater";
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
  getServerOperation,
  subscribeOperations,
  waitForOperations,
  withServerOperation,
} from "./lib/operation-manager.mjs";
import {
  buildInitialServerProperties,
  loadServerProperties,
  rollbackServerProperties,
  saveServerProperties,
} from "./lib/server-properties.mjs";
import {
  addonReleaseChannel,
  checkAddonUpdates,
  cleanupAbandonedAddonTransactions,
  commitAddonTransaction,
  describeLocalInstalledAddons,
  findBundledPackDependency,
  identifyInstalledAddons,
  installManualAddon,
  installModrinthAddon,
  listServerAddons,
  recordModpackInventory,
  removeAddon,
  recommendCompatibleAddons,
  rollbackAddonTransaction,
  rollbackAddonVersion,
  scanServerAddons,
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
  inspectExternalServerZip,
} from "./lib/external-importer.mjs";
import { exportWorld, importWorld } from "./lib/world-manager.mjs";
import { searchModpacks, modpackVersions, downloadPackVersion, downloadPublisherServerPack, publisherServerPack, inspectModpack, stageModpack } from "./lib/modpack-manager.mjs";
import { verifyModpackStartup } from "./lib/modpack-startup.mjs";
import { detectDropSource } from "./lib/drop-source.mjs";
import { openAppPreferences } from "./lib/app-preferences.mjs";
import { appThemes, normalizeServerIcon } from "./lib/app-themes.mjs";
import { createAppUpdates } from "./lib/app-updates.mjs";
import { loadCommandData } from "./lib/command-data.mjs";
import { normalizeRawCommand } from "./lib/command-catalog.mjs";
import {
  backupIsDue,
  createWorldBackup,
  getBackupSettings,
  recordBackupError,
  recordBackupResult,
  saveBackupSettings,
} from "./lib/world-backup.mjs";
import { javaRequirement } from "./lib/java-runtime.mjs";
import { inspectServerJava, launcherJavaMinimum } from "./lib/java-requirements.mjs";
import { JavaRuntimeManager } from "./lib/java-runtime-manager.mjs";
import { cleanupManagedJavaArtifacts } from "./lib/managed-java.mjs";
import { probeServerPort, serverEndpoint, serverJoinAddress, serverPortIsListening } from "./lib/server-port.mjs";
import { attachErrorGroup, parseConsoleLine, updateOnlinePlayers } from "./lib/console-log.mjs";
import { createStartupMonitor, readStartupCrashReport } from "./lib/startup-monitor.mjs";
import { aggregateProcessTreeUsage } from "./lib/process-usage.mjs";
import { diagnosticLinks } from "./lib/diagnostic-links.mjs";

const execFileAsync = promisify(execFile);
const APP_NAME = "BlockHost Manager";
const APP_USER_AGENT = `BlockHostManager/${app.getVersion()} (https://github.com/Nadith12/blockhost)`;
const DEFAULT_COLOR = "#39c9ff";
delete process.env.CURSEFORGE_API_KEY;
const MINECRAFT_EULA_URL = "https://aka.ms/MinecraftEULA";
const JAVA_INSTALL_URL = "https://adoptium.net/temurin/releases/?package=jdk";
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "piston-data.mojang.com",
  "piston-meta.mojang.com",
  "fill.papermc.io",
  "fill-data.papermc.io",
  "api.papermc.io",
  "meta.fabricmc.net",
  "maven.fabricmc.net",
  "maven.quiltmc.org",
  "api.purpurmc.org",
  "maven.minecraftforge.net",
  "maven.neoforged.net",
]);
const runningServers = new Map();
const worldBackupsInProgress = new Map();
const RECOVERY_DELAYS_MS = [5_000, 10_000, 20_000];
const RECOVERY_RESET_MS = 5 * 60_000;
const recentExports = new Set();
const approvedWorldSources = new Map();
let javaManager;

let mainWindow;
let tray;
let quitInProgress = false;
let quitAfterTransfers = false;
let installingAppUpdate = false;
let quitPromptOpen = false;
let activeTransfers = 0;
let backupScheduler;
let backgroundNoticeShown = false;
let backgroundNotification;

async function finishQueuedQuit() {
  if (!quitAfterTransfers || quitInProgress || activeTransfers > 0) return;
  await waitForOperations();
  if (activeTransfers > 0 || quitInProgress) return;
  quitInProgress = true;
  await stopAllServers();
  app.quit();
}

function runningServerEntries() {
  return Array.from(runningServers.entries()).filter(([, runtime]) =>
    runtime.process && runtime.status !== "offline"
  );
}

let appUpdates;

function getAppUpdates() {
  if (appUpdates) return appUpdates;
  let publisher;
  if (app.isPackaged && process.platform === "win32" && !process.windowsStore) {
    try {
      const identity = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "blockhost-release.json"), "utf8"));
      if (typeof identity.publisher === "string" && identity.publisher.trim() && identity.publisher.length < 512) {
        publisher = identity.publisher;
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Could not read the BlockHost release identity:", error);
    }
  }
  const updater = publisher ? updaterPackage.autoUpdater : null;
  appUpdates = createAppUpdates({
    updater,
    publisher,
    version: app.getVersion(),
    notify: status => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:update-state", status);
    },
    canRestart: () => {
      if (quitInProgress || quitAfterTransfers || quitPromptOpen) return "BlockHost is already closing.";
      if (activeTransfers || worldBackupsInProgress.size || getActiveOperations().length) {
        return "Wait for downloads, backups or other server tasks to finish, then try again.";
      }
      if (runningServerEntries().length || [...runningServers.values()].some(runtime => runtime.status === "recovering")) {
        return "Stop all running servers and wait for them to save, then try again.";
      }
      return "";
    },
    install: () => {
      if (mainWindow && !mainWindow.isDestroyed() && appPreferences().snapshot().desktop.rememberWindow) {
        appPreferences().rememberWindow(mainWindow.getNormalBounds());
      }
      installingAppUpdate = true;
      quitInProgress = true;
      updater.quitAndInstall(true, true);
    },
    onError: error => {
      if (installingAppUpdate) {
        installingAppUpdate = false;
        quitInProgress = false;
      }
      console.error("BlockHost update failed:", error);
    },
  });
  if (updater) {
    const check = () => { if (!quitInProgress) void appUpdates.check(); };
    setTimeout(check, 15_000).unref();
    setInterval(check, 6 * 60 * 60_000).unref();
  }
  return appUpdates;
}

async function confirmRunningServersQuit(entries) {
  const names = entries
    .map(([serverId]) => getServer(serverId)?.name || `Server ${serverId}`)
    .join(", ");
  const count = entries.length;
  const options = {
    type: "warning",
    title: `Quit ${APP_NAME}?`,
    message: `${count === 1 ? "A Minecraft server is" : `${count} Minecraft servers are`} still running.`,
    detail: `${names}\n\nBlockHost will send Minecraft's stop command and wait for the server to save before quitting.`,
    buttons: ["Stop server and quit", "Keep BlockHost open"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const owner = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

async function requestApplicationQuit() {
  if (quitInProgress || quitPromptOpen) return;
  const running = runningServerEntries();
  if (running.length) {
    quitPromptOpen = true;
    let confirmed = false;
    try {
      confirmed = await confirmRunningServersQuit(running);
    } finally {
      quitPromptOpen = false;
    }
    if (!confirmed) return;
  }

  if (activeTransfers > 0 || getActiveOperations().length > 0) {
    quitAfterTransfers = true;
    finishQueuedQuit();
    return;
  }

  quitInProgress = true;
  try {
    await stopAllServers();
  } finally {
    app.quit();
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

function downloadCacheFiles() {
  const root = getCachePath();
  const directories = folder => fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory());
  if (!fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return directories(root).flatMap(type => {
    const directory = path.join(root, type.name);
    return directories(directory).flatMap(version => {
      const release = path.join(directory, version.name);
      return fs.readdirSync(release, { withFileTypes: true })
        .filter(entry => entry.isFile() && /\.jar(?:\.part)?$/i.test(entry.name))
        .map(entry => path.join(release, entry.name));
    });
  });
}

function clearDownloadCache() {
  if (activeTransfers || getActiveOperations().length) throw new Error("Wait for downloads and other server operations to finish before clearing the cache.");
  const root = path.resolve(getCachePath());
  for (const file of downloadCacheFiles()) {
    if (isPathInside(root, fs.realpathSync(file)) && fs.lstatSync(file).isFile()) fs.rmSync(file, { force: true });
  }
}

async function storageSummary() {
  const directorySize = async folder => {
    try { return await serverFolderBytes(folder); }
    catch (error) { return error.code === "ENOENT" ? 0 : null; }
  };
  const backupFolders = new Map();
  for (const server of getSavedServers()) {
    const folder = getBackupSettings(server.folderPath).destination;
    if (folder) backupFolders.set(process.platform === "win32" ? folder.toLowerCase() : folder, folder);
  }
  const backups = await Promise.all([...backupFolders.values()].map(async folder => {
    let bytes;
    try {
      const entries = await fs.promises.readdir(folder, { withFileTypes: true });
      bytes = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !/-(?:latest|\d{4}-\d\d-\d\dT(?:\d\d-){3}\d{3}Z)\.zip$/i.test(entry.name)) continue;
        const stat = await fs.promises.lstat(path.join(folder, entry.name)).catch(() => null);
        if (stat?.isFile()) bytes += stat.size;
      }
    } catch (error) { bytes = error.code === "ENOENT" ? 0 : null; }
    return { path: folder, bytes };
  }));
  const paths = [getServersRoot(), getManagedRuntimeRoot()];
  const [servers, java] = await Promise.all(paths.map(async folder => ({ path: folder, bytes: await directorySize(folder) })));
  let cacheBytes = null;
  try { cacheBytes = downloadCacheFiles().reduce((sum, file) => sum + (fs.lstatSync(file, { throwIfNoEntry: false })?.size || 0), 0); }
  catch { /* The UI can show that the size is unavailable. */ }
  return { servers, java, backups, cache: { path: getCachePath(), bytes: cacheBytes } };
}

function getAssetPath(fileName) {
  const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "assets");
  return path.join(root, fileName);
}

function getSavedServers() {
  return loadSavedServers(getServersRoot());
}

function getServer(id) {
  return getSavedServer(getServersRoot(), id);
}

async function serverFolderBytes(folder) {
  let bytes = 0;
  const pending = [folder];
  while (pending.length) {
    const directory = pending.pop();
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT" && directory !== folder) return [];
      throw error;
    });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile()) {
        // Minecraft can replace files while saving. Count files present at the time of the scan.
        const stats = await fs.promises.lstat(filePath).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (stats?.isFile()) bytes += stats.size;
      }
    }
  }
  return bytes;
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
  if (url.protocol !== "https:" || url.username || url.password || url.port || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error(`Downloads from ${url.hostname || "this host"} are not allowed`);
  }
  return url.toString();
}

async function fetchResponse(url, { download = false, headers } = {}) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    const address = download ? validateDownloadUrl(url) : url;
    const response = await fetch(address, {
      redirect: download ? "manual" : "follow",
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": APP_USER_AGENT, ...headers },
    });
    if (download && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("The official download redirected without an address.");
      url = new URL(location, address).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Request failed (${response.status})`);
    }
    return response;
  }
  throw new Error("Too many redirects from the official download source.");
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
    const response = await fetchResponse(safeUrl, { download: true });
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

async function publisherInstaller(url) {
  for (const [algorithm, length] of [["sha256", 64], ["sha1", 40]]) {
    try {
      const response = await fetchResponse(url + "." + algorithm, { download: true });
      const hash = (await response.text()).trim().toLowerCase();
      if (hash.length === length && /^[a-f0-9]+$/.test(hash)) return { url, [algorithm]: hash };
    } catch {
      // Some historical Maven releases publish only SHA-1.
    }
  }
  throw new Error("The official loader download has no verifiable checksum. Try again or choose another release.");
}

async function verifyFabricInstallation(folder, version, loader) {
  const [profile, manifest] = await Promise.all([
    fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader)}/server/json`),
    fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"),
  ]);
  const release = manifest.versions.find(item => item.id === version);
  if (!release || profile.inheritsFrom !== version || !Array.isArray(profile.libraries) || !profile.libraries.length || profile.libraries.length > 64) {
    throw new Error("The official Fabric profile did not match the selected release.");
  }
  const vanilla = await vanillaDownload(release.url);
  const serverJar = path.join(folder, "server.jar");
  if (!/^[a-f0-9]{40}$/i.test(vanilla.sha1) || fs.statSync(serverJar).size !== vanilla.size || await hashFile(serverJar, "sha1") !== vanilla.sha1) {
    throw new Error("Fabric’s downloaded Minecraft server failed Mojang checksum verification.");
  }
  await Promise.all(profile.libraries.map(async library => {
    const parts = String(library.name).split(":");
    const [group, artifact, revision, classifier] = parts;
    if (parts.length < 3 || parts.length > 4 || !/^[\w-]+(?:\.[\w-]+)*$/.test(group)
      || !parts.slice(1).every(part => /^[\w-][\w.+-]*$/.test(part))) {
      throw new Error("Fabric returned an invalid library name.");
    }
    const segments = [...group.split("."), artifact, revision, `${artifact}-${revision}${classifier ? "-" + classifier : ""}.jar`];
    const file = path.join(folder, "libraries", ...segments);
    const url = new URL(segments.map(encodeURIComponent).join("/"), library.url).href;
    const checksum = /^[a-f0-9]{128}$/i.test(library.sha512 || "")
      ? { sha512: library.sha512.toLowerCase() }
      : await publisherInstaller(url);
    const algorithm = ["sha512", "sha256", "sha1"].find(key => checksum[key]);
    if (await hashFile(file, algorithm) !== checksum[algorithm]) throw new Error(`Fabric library failed checksum verification (${artifact}).`);
  }));
}

function getManagedRuntimeRoot() {
  return path.join(app.getPath("userData"), "runtime");
}

function runtimeManager() {
  return javaManager ||= new JavaRuntimeManager({ runtimeRoot: getManagedRuntimeRoot() });
}

function javaChoicePath(server) {
  return path.join(app.getPath("userData"), "java-choices", String(normalizeServerId(server.id)) + ".json");
}

let preferences;

function appPreferences() {
  preferences ??= openAppPreferences(path.join(app.getPath("userData"), "app-preferences.json"));
  return preferences;
}

function applyWindowTheme(theme) {
  const { titlebar, symbols } = appThemes[theme];
  if (process.platform !== "darwin") mainWindow?.setTitleBarOverlay({ color: titlebar, symbolColor: symbols, height: 40 });
}

function javaChoice(server) {
  if (!server.id) return undefined;
  try {
    const { command, major } = JSON.parse(fs.readFileSync(javaChoicePath(server), "utf8"));
    if (Number.isSafeInteger(major) && major >= 8 && major <= 99) return { major };
    if (typeof command === "string" && path.isAbsolute(command)) return { command };
    throw new Error("Invalid Java setting.");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("The Java setting could not be read. Choose Automatic in Server settings.", { cause: error });
    return undefined;
  }
}

async function assertJavaInstalled(server, { installerMajor, onProgress, signal } = {}) {
  const { requiredMajor, warning, versions } = await inspectServerJava(server, { signal });
  signal?.throwIfAborted();
  const choice = installerMajor ? undefined : javaChoice(server);
  if (choice?.major && !versions.includes(choice.major)) {
    throw new Error("Java " + choice.major + " no longer matches this server. Choose Automatic or a compatible version in Server settings.");
  }
  const major = installerMajor || choice?.major || requiredMajor;
  let lastProgressKey = "";
  const runtime = await runtimeManager().resolve(major, {
    customCommand: choice?.command,
    onProgress: progress => {
      if (signal?.aborted) return;
      const progressKey = progress.stage + ":" + progress.percent;
      if (lastProgressKey === progressKey) return;
      lastProgressKey = progressKey;
      onProgress?.(progress);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("dependencies:progress", { ...progress, javaVersion: major });
    },
  });
  signal?.throwIfAborted();
  if (lastProgressKey && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("dependencies:progress", {
      stage: "complete", percent: 100, message: "Java " + major + " is ready.",
    });
  }
  return { ...runtime, requiredMajor, selectedMajor: major, selectionMode: choice?.major ? "version" : runtime.source === "custom" ? "custom" : "automatic", warning };
}

function javaAssignment(runtime) {
  return { requiredMajor: runtime.requiredMajor, selectionMode: runtime.selectionMode,
    runtimeId: runtime.source + "-java" + runtime.selectedMajor, version: runtime.details.version };
}

async function javaSettings(server, requirement) {
  let choice, error = "";
  try { choice = javaChoice(server); } catch (cause) { error = cause.message; }
  const choiceUnreadable = Boolean(error);
  try { requirement ||= await inspectServerJava(server); } catch (cause) { error ||= cause.message; }
  if (choice?.major && !requirement?.versions.includes(choice.major)) {
    error ||= "The saved Java version no longer matches this server. Choose Automatic or a compatible version.";
  }
  return { ...requirement, choice: choice?.major || (choice?.command || choiceUnreadable ? "previous" : "automatic"), error };
}

async function prepareImportedJava(folder, metadata, onProgress, verifySignal) {
  const server = { ...metadata, folderPath: folder,
    jarPath: metadata.jarFile ? path.join(folder, metadata.jarFile) : "" };
  if (verifySignal) return checkNewPackStartup(server, verifySignal, onProgress);
  const runtime = await assertJavaInstalled({ ...server, id: undefined }, { onProgress });
  return { java: javaAssignment(runtime) };
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

  if (type === "purpur" || type === "quilt") {
    const versions = type === "purpur"
      ? (await fetchJson("https://api.purpurmc.org/v2/purpur")).versions
      : (await fetchJson("https://meta.quiltmc.org/v3/versions/game")).filter(game => game.stable).map(game => game.version);
    return versions.sort(compareVersions).map(version => ({ id: version, label: version, version }));
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
    const releases = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g), match => match[1])
      .filter(version => /^1\.\d+(?:\.\d+)?-\d+(?:\.\d+)+(?:-1\.[\d.]+)?$|^\d{2,}\.\d+(?:\.\d+)?-\d+(?:\.\d+)+$/.test(version))
      .sort(compareVersions);
    const seen = new Set();
    return releases.filter((loader, index) => {
      const game = loader.split("-")[0];
      const firstForGame = !seen.has(game);
      seen.add(game);
      return index < 220 || firstForGame;
    }).map((loaderVersion) => ({
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
  if (Number(match[1]) >= 26) return `${Number(match[1])}.${Number(match[2])}`;
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
  return { url: server.url, sha1: server.sha1 || "", size: server.size || 0, minecraftJavaMajor: data.javaVersion?.majorVersion };
}

function configureNewServerProperties(folder, seedValue = "", quickDefaults = {}, version, options) {
  const propertiesPath = path.join(folder, "server.properties");
  const text = fs.existsSync(propertiesPath) ? fs.readFileSync(propertiesPath, "utf8") : "# Minecraft server properties\n";
  atomicWriteFile(propertiesPath, buildInitialServerProperties(text, seedValue, quickDefaults, version, options));
}

async function paperDownload(version, expectedSha256 = "") {
  if (!/^[0-9a-z][0-9a-z._-]{0,50}$/i.test(version)) {
    throw new Error("Invalid Paper version");
  }
  const builds = await fetchJson(
    `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`
  );
  const build = expectedSha256
    ? builds.find((item) => item.downloads?.["server:default"]?.checksums?.sha256 === expectedSha256)
    : builds.find((item) => item.channel === "STABLE") || builds[0];
  const file = build?.downloads?.["server:default"];
  if (!file?.url) throw new Error("No Paper download is available for this version");
  return {
    url: file.url,
    sha256: file.checksums?.sha256 || "",
    size: file.size || 0,
    fileName: file.name || `paper-${version}.jar`,
  };
}

async function findOriginalServerDownload(server) {
  if (server.type === "vanilla") {
    const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
    const version = manifest.versions.find((item) => item.id === server.version);
    if (version) return vanillaDownload(version.url);
  }
  if (server.type === "paper") {
    return paperDownload(server.version, await hashFile(server.jarPath, "sha256"));
  }
  return null;
}

async function createJarServer(data, type, info, loaderVersion = "") {
  const id = Date.now();
  const name = normalizeServerName(data.name);
  const folder = createServerFolder(name, id);
  try {
    const cached = await cachedDownload(type, data.version, info, `${type}-${data.version}.jar`);
    const localJar = path.join(folder, "server.jar");
    fs.copyFileSync(cached.path, localJar, fs.constants.COPYFILE_EXCL);
    await applyPackContent(folder, data.packContext);
    if (data.worldSourcePath) await importWorld(data.worldSourcePath, folder);
    configureNewServerProperties(folder, data.seed, data.quickDefaults, data.version, { publisherPack: data.packContext?.verifyStartup });
    const server = {
      id,
      name,
      type,
      typeLabel: serverTypeLabel(type),
      version: String(data.version),
      loaderVersion,
      color: normalizeColor(data.color),
      icon: normalizeServerIcon(data.icon),
      ...data.initialMemory,
      folderPath: folder,
      jarFile: "server.jar",
      jarPath: localJar,
      launchType: "jar",
      minecraftJavaMajor: info.minecraftJavaMajor,
      recommendedJavaMajor: data.packContext?.pack.recommendedJavaMajor,
      ...(info.sha1 || info.sha256 ? {
        serverDownload: { url: info.url, sha1: info.sha1, sha256: info.sha256 },
      } : {}),
      ...(data.packContext ? { modpack: { name: data.packContext.pack.name, version: data.packContext.pack.packVersion } } : {}),
      createdAt: new Date().toISOString(),
    };
    const savedServer = await finishServerCreation(server, data.packContext);
    return { success: true, usedCache: cached.usedCache, server: savedServer };
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

async function installLoaderServer(data, type, loaderVersion, installerInfo) {
  const javaTarget = { version: data.version, type, recommendedJavaMajor: data.packContext?.pack.recommendedJavaMajor };
  const id = Date.now();
  const name = normalizeServerName(data.name);
  const folder = createServerFolder(name, id);
  try {
    const installerName = `${type}-${type === "fabric" ? data.installerVersion : loaderVersion}-installer.jar`;
    const cached = await cachedDownload(type, loaderVersion, {
      ...(typeof installerInfo === "string" ? { url: installerInfo } : installerInfo),
      fileName: installerName,
    }, installerName);
    const installerMajor = Math.max(javaRequirement(javaTarget).requiredMajor, await launcherJavaMinimum(cached.path));
    const installerRuntime = await assertJavaInstalled(javaTarget, { installerMajor });
    const installerArgs = type === "fabric"
      ? ["server", "-mcversion", data.version, "-loader", loaderVersion, "-downloadMinecraft"]
      : type === "quilt"
        ? ["install", "server", data.version, loaderVersion, "--download-server", "--install-dir=."]
        : ["--installServer"];
    await execFileAsync(installerRuntime.command, ["-jar", cached.path, ...installerArgs], {
      cwd: folder,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      ...(data.packContext ? { timeout: 10 * 60_000 } : {}),
    });
    data.packContext?.signal.throwIfAborted();
    if (type === "fabric") await verifyFabricInstallation(folder, data.version, loaderVersion);

    const argsName = process.platform === "win32" ? "win_args.txt" : "unix_args.txt";
    const argsRelative = type === "forge"
      ? path.join("libraries", "net", "minecraftforge", "forge", loaderVersion, argsName)
      : path.join("libraries", "net", "neoforged", "neoforge", loaderVersion, argsName);
    const usesArgs = (type === "forge" || type === "neoforge") && fs.existsSync(path.join(folder, argsRelative));
    const jarFile = type === "fabric" ? "fabric-server-launch.jar" : type === "quilt" ? "quilt-server-launch.jar" : [
      "forge-" + loaderVersion + ".jar", "forge-" + loaderVersion + "-universal.jar",
    ].find(file => fs.existsSync(path.join(folder, file)));
    if (!usesArgs && (!jarFile || !fs.existsSync(path.join(folder, jarFile)))) {
      throw new Error(`${serverTypeLabel(type)} installed without a server launch file`);
    }
    await applyPackContent(folder, data.packContext);
    if (data.worldSourcePath) await importWorld(data.worldSourcePath, folder);
    configureNewServerProperties(folder, data.seed, data.quickDefaults, data.version, { publisherPack: data.packContext?.verifyStartup });

    const server = {
      id,
      name,
      type,
      typeLabel: serverTypeLabel(type),
      version: String(data.version),
      loaderVersion,
      color: normalizeColor(data.color),
      icon: normalizeServerIcon(data.icon),
      ...data.initialMemory,
      folderPath: folder,
      launchType: usesArgs ? "javaArgsFile" : "jar",
      launchArgsPath: usesArgs ? argsRelative : "",
      jarFile: usesArgs ? undefined : jarFile,
      jarPath: usesArgs ? undefined : path.join(folder, jarFile),
      recommendedJavaMajor: javaTarget.recommendedJavaMajor,
      ...(data.packContext ? { modpack: { name: data.packContext.pack.name, version: data.packContext.pack.packVersion } } : {}),
      createdAt: new Date().toISOString(),
    };
    const savedServer = await finishServerCreation(server, data.packContext);
    return { success: true, usedCache: cached.usedCache, server: savedServer };
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

const approvedPacks = new Map();
function packStagingRoot() { return path.join(app.getPath("userData"), "modpack-staging"); }
let packController = null;

async function preparePack(source, versionId = "", projectId = "") {
  if (packController) throw new Error("Wait for the current modpack setup to finish.");
  if (versionId && !projectId) throw new Error("Choose the modpack project and release again.");
  await fs.promises.mkdir(packStagingRoot(), { recursive: true });
  const temporary = await fs.promises.mkdtemp(path.join(packStagingRoot(), "pack-"));
  const archive = path.join(temporary, "pack.zip");
  try {
    const publisher = publisherServerPack(versionId, projectId);
    const archiveKind = publisher ? "publisher-server" : versionId ? "modpack" : await detectDropSource(source);
    if (archiveKind === "client-launcher") throw new Error("This ZIP is a launcher instance. Download the author’s server pack for this release, or choose a server-compatible Modrinth .mrpack.");
    if (archiveKind === "packwiz") throw new Error("This is a packwiz source pack. Export it as a Modrinth .mrpack or import the folder after installing it for the server.");
    if (archiveKind === "ftb-installer") throw new Error("Use the official FTB Server Installer to prepare the server, then import the installed server folder in BlockHost.");
    // The pinned publisher metadata is enough for preview. Download that ZIP after Create server.
    let release;
    if (versionId && !publisher) release = await downloadPackVersion(versionId, archive, { projectId });
    else if (!versionId) {
      const stat = await fs.promises.stat(source);
      const maxBytes = archiveKind === "server" || archiveKind === "server-starter" ? 4 * 1024 ** 3 : 512 * 1024 ** 2;
      if (!stat.isFile() || stat.size > maxBytes) throw new Error("This archive exceeds the size limit for its pack format.");
      await fs.promises.copyFile(source, archive, fs.constants.COPYFILE_EXCL);
    }
    const starter = archiveKind === "server-starter";
    let pack;
    if (publisher) {
      pack = { ...publisher, format: "publisher-server", totalBytes: publisher.size, files: [], skipped: 0, optional: 0 };
    } else if (archiveKind === "server" || starter) {
      const inspected = await inspectExternalServerZip(archive, path.join(temporary, "external"), {
        starter,
      });
      if (!inspected.version || inspected.version === "unknown") throw new Error("The Minecraft version could not be determined from this server ZIP. Use a .mrpack with declared versions, or import this as an existing server from the sidebar.");
      pack = { ...inspected, format: starter ? "server-starter" : "server-zip",
        name: path.basename(source, path.extname(source)), packVersion: "Server pack",
        files: [], skipped: 0, optional: 0 };
    } else pack = await inspectModpack(archive);
    if (release && (!release.games.includes(pack.version) || !release.loaders.includes(pack.type))) {
      throw new Error("The Modrinth archive does not match the selected release’s Minecraft version and loader.");
    }
    if (packController) throw new Error("Wait for the current modpack setup to finish.");
    // Only one selected pack is needed. Keep it immutable until installation.
    for (const previous of approvedPacks.values()) await fs.promises.rm(previous.temporary, { recursive: true, force: true });
    approvedPacks.clear();
    const token = crypto.randomUUID();
    approvedPacks.set(token, { temporary, archive, pack, versionId });
    return { token, name: pack.name, packVersion: pack.packVersion, type: pack.type, version: pack.version, loaderVersion: pack.loaderVersion, format: pack.format || "mrpack", source: versionId ? "modrinth" : "local", requiresStartupCheck: Boolean(versionId), hasWorld: Boolean(pack.hasWorld), fileCount: pack.fileCount ?? pack.files.length, totalBytes: pack.totalBytes, skipped: pack.skipped, optional: pack.optional };
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function createModpackServer(data) {
  if (getServerOperation(-2)) throw new Error("Wait for the pack preview to finish first.");
  const approved = approvedPacks.get(String(data.modpackToken || ""));
  if (!approved) throw new Error("Choose the modpack again before creating the server.");
  if (packController) throw new Error("A modpack is already being installed.");
  const verifyStartup = Boolean(approved.versionId);
  if (verifyStartup && data.acceptPackEula !== true) throw new Error("Accept the Minecraft EULA to run the dedicated-server startup check.");
  normalizeServerName(data.name);
  if (data.worldImportToken && data.seed) throw new Error("Choose a seed or an existing world, not both.");
  const controller = new AbortController();
  packController = controller;
  const content = path.join(approved.temporary, "content");
  try {
    if (approved.pack.hasWorld && (data.seed || data.worldImportToken)) throw new Error("This server pack already includes its world. Remove the seed or world selection before continuing.");
    if (approved.pack.format === "server-zip") {
      const world = data.worldImportToken ? approvedWorldSources.get(data.worldImportToken) : null;
      if (data.worldImportToken && !world) throw new Error("Choose the world import again.");
      const result = await importExternalServer(approved.pack.sourceFolder, getServersRoot(), getSavedServers(), {
        name: data.name, color: normalizeColor(data.color), icon: normalizeServerIcon(data.icon),
        modpack: { name: approved.pack.name, version: approved.pack.packVersion },
        signal: controller.signal,
        onProgress: progress => sendTransferProgress("modpack", null, progress),
        prepareMetadata: async (folder, metadata) => ({
          ...await prepareImportedJava(folder, { ...metadata, ...data.initialMemory }, progress => sendTransferProgress("modpack", null, progress),
            verifyStartup ? controller.signal : undefined),
          ...data.initialMemory,
        }),
        beforeCommit: async folder => {
          controller.signal.throwIfAborted();
          if (world) await importWorld(world.path, folder);
          configureNewServerProperties(folder, data.seed, data.quickDefaults, approved.pack.version, { preserveAccess: true });
          recordModpackInventory(folder, approved.pack);
          controller.signal.throwIfAborted();
        },
      });
      if (world) approvedWorldSources.delete(data.worldImportToken);
      approvedPacks.delete(data.modpackToken);
      await fs.promises.rm(approved.temporary, { recursive: true, force: true }).catch(() => {});
      const server = getServer(result.server.id);
      return { ...result, server, repairRequired: server.modpackSetup?.status === "repair" };
    }
    const publisher = approved.pack.format === "publisher-server";
    let pack = approved.pack;
    const onProgress = progress => sendTransferProgress("modpack", null, progress);
    if (publisher) {
      onProgress({ message: "Downloading the publisher’s server pack…", percent: 0 });
      await downloadPublisherServerPack(approved.versionId, approved.archive, { signal: controller.signal, onProgress });
      onProgress({ message: "Extracting the verified publisher server pack…", percent: 76 });
      const inspected = await inspectExternalServerZip(approved.archive, content, { starter: true, signal: controller.signal });
      if (inspected.type !== pack.type || inspected.version !== pack.version || inspected.loaderVersion !== pack.loaderVersion || inspected.hasWorld) {
        throw new Error("The publisher’s server archive does not match the selected release.");
      }
      pack = { ...pack, ...inspected, format: "server-starter" };
    } else if (pack.format !== "server-starter") {
      pack = await stageModpack(approved.archive, content, {
        includeOptional: Boolean(data.includeOptional), checkCatalogue: Boolean(approved.versionId), signal: controller.signal, onProgress,
      });
    }
    const input = { ...data, modpackToken: "", type: pack.type, version: pack.version, loaderVersion: pack.loaderVersion };
    if (pack.type === "fabric") {
      const installers = await fetchJson("https://meta.fabricmc.net/v2/versions/installer");
      input.installerVersion = (installers.find(item => item.stable) || installers[0])?.version;
      if (!input.installerVersion) throw new Error("Fabric installers are temporarily unavailable.");
    }
    controller.signal.throwIfAborted();
    sendTransferProgress("modpack", null, { message: "Installing the server loader. This can take a few minutes…", percent: 92 });
    const result = await createServer(input, { content: pack.sourceFolder || content, pack, signal: controller.signal, verifyStartup });
    approvedPacks.delete(data.modpackToken);
    await fs.promises.rm(approved.temporary, { recursive: true, force: true }).catch(() => {});
    return { ...result, repairRequired: result.server.modpackSetup?.status === "repair" };
  } finally {
    await fs.promises.rm(content, { recursive: true, force: true }).catch(() => {});
    if (approved.pack.format === "publisher-server") await fs.promises.rm(approved.archive, { force: true }).catch(() => {});
    packController = null;
  }
}

async function applyPackContent(folder, context) {
  if (!context) return;
  context.signal.throwIfAborted();
  if (context.pack.format === "server-starter") {
    const launcherFiles = new Set([
      "libraries", "versions", "runtime", ".fabric", ".quilt", "eula.txt",
      "user_jvm_args.txt", "fabric-server-launcher.properties", "quilt-server-launcher.properties",
      "server-info.json", "addons-lock.json", "blockhost-modpack.json",
      "ops.json", "whitelist.json", "banned-ips.json", "banned-players.json",
    ]);
    async function copyContents(source, destination) {
      for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
        context.signal.throwIfAborted();
        const name = entry.name.toLowerCase();
        if (source === context.content && (launcherFiles.has(name) || name.startsWith(".blockhost-") || /\.(?:jar|bat|cmd|ps1|sh|exe|dll|lnk|com|scr|vbs)$/.test(name))) continue;
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isDirectory()) {
          await fs.promises.mkdir(to, { recursive: true });
          await copyContents(from, to);
        } else if (entry.isFile()) {
          await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        } else {
          throw new Error("Unsupported server pack entry: " + path.relative(context.content, from));
        }
      }
    }
    // Dedicated packs may rely on the loader seeing side-disabled mods during dependency resolution.
    await copyContents(context.content, folder);
  } else {
    await fs.promises.cp(context.content, folder, { recursive: true, force: true });
  }
  context.signal.throwIfAborted();
  recordModpackInventory(folder, context.pack);
}

async function finishServerCreation(server, packContext) {
  packContext?.signal.throwIfAborted();
  if (packContext?.verifyStartup) {
    Object.assign(server, await checkNewPackStartup(server, packContext.signal));
  } else {
    server.java = javaAssignment(await assertJavaInstalled(server));
  }
  packContext?.signal.throwIfAborted();
  return writeServerMetadata(server.folderPath, server);
}

function packLaunchDiagnosis(error, kind) {
  const message = String(error.message || error).slice(0, 1000);
  return {
    kind,
    problem: kind === "java" ? "BlockHost couldn’t prepare Java for this server." : "BlockHost couldn’t start this pack.",
    cause: message,
    fix: kind === "java"
      ? "Open Java settings, choose Automatic or a compatible version, then retry."
      : "Retry startup. If the launch files are missing, choose another publisher server release.",
    evidence: [message],
  };
}

async function checkNewPackStartup(server, signal, onProgress) {
  signal.throwIfAborted();
  // The creation form already collected consent for this particular installation.
  acceptEula(server);
  let runtime;
  try {
    runtime = await assertJavaInstalled({ ...server, id: undefined }, { onProgress, signal });
  } catch (error) {
    signal.throwIfAborted();
    return { modpackSetup: { status: "repair", diagnosis: packLaunchDiagnosis(error, "java") } };
  }
  const java = javaAssignment(runtime);
  try {
    await verifyPackServer(server, runtime, signal, (message, percent) =>
      sendTransferProgress("modpack", null, { message, percent }));
    return { java, modpackSetup: { status: "verified" } };
  } catch (error) {
    signal.throwIfAborted();
    const diagnosis = error.diagnosis || packLaunchDiagnosis(error, "launch");
    return { java, modpackSetup: { status: "repair", diagnosis } };
  }
}

async function createServer(data = {}, packContext = null) {
  if (data.modpackToken) return createModpackServer(data);
  const type = normalizeServerType(data.type);
  const version = String(data.version || "").trim();
  if (!version) throw new Error("Minecraft version is required");
  const worldToken = String(data.worldImportToken || "");
  const seed = String(data.seed ?? "").trim();
  if (worldToken && seed) throw new Error("Choose an existing world or enter a world seed. Clear one to continue.");
  const approvedWorld = worldToken ? approvedWorldSources.get(worldToken) : null;
  if (worldToken && !approvedWorld) throw new Error("Choose the world import again before downloading the server");
  const input = {
    ...data,
    seed,
    worldSourcePath: approvedWorld?.path || "",
    packContext,
  };
  let result;

  if (type === "vanilla") {
    result = await createJarServer(input, type, await vanillaDownload(input.versionUrl));
  } else if (type === "paper") {
    result = await createJarServer(input, type, await paperDownload(version));
  } else if (type === "purpur") {
    const game = encodeURIComponent(version);
    const release = await fetchJson("https://api.purpurmc.org/v2/purpur/" + game);
    const build = String(release.builds?.latest || "");
    if (!/^\d+$/.test(build)) throw new Error("No Purpur build is available for this version.");
    result = await createJarServer(input, type, { url: "https://api.purpurmc.org/v2/purpur/" + game + "/" + build + "/download", fileName: "purpur-" + build + ".jar" });
  } else if (type === "quilt") {
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(version)) throw new Error("Invalid Quilt Minecraft version.");
    const [installers, compatible] = await Promise.all([
      fetchJson("https://meta.quiltmc.org/v3/versions/installer"),
      fetchJson("https://meta.quiltmc.org/v3/versions/loader/" + encodeURIComponent(version)),
    ]);
    const installer = installers[0];
    const versions = compatible.map(item => item.loader.version).sort(compareVersions);
    const loader = data.loaderVersion || versions.find(value => !value.includes("-")) || versions[0];
    if (!versions.includes(loader) || !installer?.url || !/^[a-f0-9]{64}$/i.test(installer.hashes?.sha256 || "")) throw new Error("A compatible verified Quilt installer is unavailable.");
    result = await installLoaderServer(input, type, loader, { url: installer.url, sha256: installer.hashes.sha256, size: installer.file_size });
  } else if (type === "fabric") {
    const loader = safeSegment(data.loaderVersion);
    const installer = safeSegment(data.installerVersion);
    if (packContext) {
      const url = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installer}/fabric-installer-${installer}.jar`;
      result = await installLoaderServer({ ...input, installerVersion: installer }, type, loader, await publisherInstaller(url));
    } else {
      const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
      result = await createJarServer(input, type, { url, fileName: `fabric-server-${version}-${loader}.jar` }, loader);
    }
  } else {
    const loader = safeSegment(data.loaderVersion || version);
    if (type === "forge") {
      const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${loader}/forge-${loader}-installer.jar`;
      result = await installLoaderServer(input, type, loader, packContext ? await publisherInstaller(url) : url);
    } else {
      const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loader}/neoforge-${loader}-installer.jar`;
      result = await installLoaderServer(input, type, loader, packContext ? await publisherInstaller(url) : url);
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

async function verifyPackServer(server, runtime, signal, reportProgress = () => {}) {
  signal.throwIfAborted();
  const [command, args] = launchCommand(server, runtime.command);
  reportProgress("Starting the modpack on localhost to verify it…", 95);
  await verifyModpackStartup(server.folderPath, command, args, {
    signal,
    startupOptions: appPreferences().snapshot().options,
    onReady: () => reportProgress("The startup check passed. Stopping the test server…", 98),
  });
  signal.throwIfAborted();
}

function appendLog(runtime, value, source = "app") {
  const line = String(value).trimEnd();
  if (!line) return;
  runtime.nextLogId = (runtime.nextLogId || 0) + 1;
  const parsed = parseConsoleLine(line, {
    id: runtime.nextLogId,
    source,
    receivedAt: new Date().toISOString(),
  });
  const entry = attachErrorGroup(parsed, runtime.errorGrouping || (runtime.errorGrouping = {}));
  runtime.onlinePlayers = updateOnlinePlayers(runtime.onlinePlayers, entry);
  runtime.logs.push(entry);
  if (runtime.logs.length > 2000) runtime.logs.splice(0, runtime.logs.length - 2000);
  if (mainWindow && !mainWindow.isDestroyed() && runtime.serverId) {
    mainWindow.webContents.send("servers:consoleEntry", { serverId: runtime.serverId, entry });
  }
}

function savePackSetup(server, runtime, diagnosis) {
  if (!server.modpackSetup && (!server.modpack || !diagnosis)) return;
  const modpackSetup = diagnosis ? { status: "repair", diagnosis } : { status: "verified" };
  runtime.modpackSetup = modpackSetup;
  if (!diagnosis && server.modpackSetup?.status === "verified") return;
  try {
    updateServerMetadata(server.folderPath, { modpackSetup });
  } catch (error) {
    appendLog(runtime, `[APP] Could not save the modpack status: ${error.message}`);
  }
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
    joinAddress: runtime?.status === "running" ? serverJoinAddress(runtime) : "",
    stoppedAt: runtime?.stoppedAt || null,
    lastStartedAt: runtime?.startedAt || server?.lastStartedAt || null,
    exitCode: runtime?.exitCode ?? null,
    startupFailed: Boolean(runtime?.startupFailed),
    startupDiagnosis: runtime?.startupDiagnosis || null,
    modpackSetup: runtime?.modpackSetup || server?.modpackSetup || null,
    checkingModpack: Boolean(runtime?.repairController),
    logs: runtime?.logs || [],
    onlinePlayers: runtime?.onlinePlayers ? [...runtime.onlinePlayers].sort((a, b) => a.localeCompare(b)) : [],
    eulaAccepted: server ? eulaAccepted(server) : false,
    eulaUrl: MINECRAFT_EULA_URL,
  };
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
  const icon = normalizeServerIcon(input.icon ?? server.icon);
  const updated = updateServerMetadata(server.folderPath, {
    name,
    color,
    icon,
    lastModifiedAt: new Date().toISOString(),
  });
  return { ...server, ...updated, name, color, icon };
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

function launchCommand(server, javaCommand) {
  if (!path.isAbsolute(javaCommand)) throw new Error("The verified Java executable could not be resolved.");
  const memory = memorySettings(server);
  const common = [`-Dblockhost.serverId=${server.id}`, `-Xms${memory.minMemoryMb}M`, `-Xmx${memory.maxMemoryMb}M`];
  if (server.type === "fabric") common.push("-Dfabric.noGui=true");
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

async function retryPackStartup(server, bundledDependency) {
  const serverId = server.id;
  const controller = new AbortController();
  const runtime = {
    serverId, status: "starting", startedAt: new Date().toISOString(), logs: [],
    repairController: controller,
  };
  runningServers.set(serverId, runtime);
  let javaRuntime, repairTransaction;
  let passed = false;
  try {
    appendLog(runtime, "[APP] Checking the repaired installation with a temporary test world.");
    controller.signal.throwIfAborted();
    if (bundledDependency) {
      repairTransaction = setAddonEnabled(server, bundledDependency.id, true).transaction;
      appendLog(runtime, "[APP] Testing the bundled dependency: " + bundledDependency.name);
    }
    javaRuntime = await assertJavaInstalled(server, { signal: controller.signal });
    await verifyPackServer(server, javaRuntime, controller.signal, message => appendLog(runtime, "[APP] " + message));
    controller.signal.throwIfAborted();
    if (repairTransaction) commitAddonTransaction(repairTransaction);
    passed = true;
  } catch (error) {
    let rollbackError;
    if (repairTransaction) {
      try { rollbackAddonTransaction(repairTransaction); }
      catch (cause) { rollbackError = cause; }
    }
    if (controller.signal.aborted && !rollbackError) {
      runtime.status = "offline";
      appendLog(runtime, "[APP] Modpack startup check cancelled.");
    } else {
      runtime.status = "startup-failed";
      runtime.startupFailed = true;
      const diagnosis = error.diagnosis || packLaunchDiagnosis(error, javaRuntime ? "launch" : "java");
      runtime.startupDiagnosis = rollbackError ? {
        kind: "setup",
        problem: "BlockHost could not restore the disabled dependency.",
        fix: "Check the mod in Add-ons before retrying.",
        evidence: [rollbackError.message],
      } : repairTransaction ? {
        ...server.modpackSetup.diagnosis,
        problem: "The bundled dependency did not resolve startup and was disabled again.",
        evidence: [diagnosis.problem, ...(diagnosis.evidence || [])],
      } : diagnosis;
      savePackSetup(server, runtime, runtime.startupDiagnosis);
      appendLog(runtime, "[APP] " + runtime.startupDiagnosis.problem);
    }
  } finally {
    runtime.repairController = null;
  }
  if (!passed) return runtimeSnapshot(serverId);
  runtime.status = "offline";
  savePackSetup(server, runtime);
  return startServer(serverId, { packChecked: true, javaRuntime });
}

async function startServer(id, options = {}) {
  const serverId = normalizeServerId(id);
  const current = runningServers.get(serverId);
  if (current?.process && current.status !== "offline") return runtimeSnapshot(serverId);
  if (!options.recoverFrom && current?.status === "recovering") cancelServerRecovery(current);
  await current?.shutdownBackup;

  const server = getServer(serverId);
  if (!server) throw new Error("Saved server not found");

  const endpoint = serverEndpoint(loadServerProperties(server.folderPath, server.version).values);
  const portStatus = await probeServerPort(endpoint);
  if (!portStatus.available) {
    return {
      ...runtimeSnapshot(serverId),
      requiresPortConflict: true,
      portConflict: {
        port: endpoint.port,
        host: endpoint.displayHost,
        reason: portStatus.code,
      },
    };
  }

  if (!eulaAccepted(server)) {
    if (!options.acceptEula) return { ...runtimeSnapshot(serverId), requiresEula: true };
    acceptEula(server);
  }

  if (server.modpackSetup?.status === "repair" && !options.packChecked && !options.recoverFrom) {
    const bundledDependency = options.repairBundledDependency ? await findBundledPackDependency(server) : null;
    if (options.repairBundledDependency && !bundledDependency) return { ...runtimeSnapshot(serverId), bundledDependencyUnavailable: true };
    return retryPackStartup(server, bundledDependency);
  }
  if (options.repairBundledDependency) return { ...runtimeSnapshot(serverId), bundledDependencyUnavailable: true };

  let javaRuntime, command, args;
  try {
    javaRuntime = options.javaRuntime || await assertJavaInstalled(server);
    [command, args] = launchCommand(server, javaRuntime.command);
  } catch (error) {
    if (options.recoverFrom) throw error;
    const runtime = {
      serverId, status: "startup-failed", startedAt: new Date().toISOString(), startupFailed: true,
      logs: [], startupDiagnosis: packLaunchDiagnosis(error, javaRuntime ? "launch" : "java"),
    };
    runningServers.set(serverId, runtime);
    savePackSetup(server, runtime, runtime.startupDiagnosis);
    appendLog(runtime, `[APP] Server startup failed: ${error.message}`);
    notifyServerEvent("notifyCrash", server, "Startup failed", "Open the Console for details.");
    return runtimeSnapshot(serverId);
  }
  if (quitInProgress || quitAfterTransfers || (options.recoverFrom && current?.status !== "recovering")) {
    return runtimeSnapshot(serverId);
  }
  const rechecked = await probeServerPort(endpoint);
  const portReserved = [...runningServers.values()].some(runtime => runtime.serverId !== serverId && runtime.process && runtime.port === endpoint.port);
  if (!rechecked.available || portReserved) {
    return { ...runtimeSnapshot(serverId), requiresPortConflict: true,
      portConflict: { port: endpoint.port, host: endpoint.displayHost, reason: portReserved ? "EADDRINUSE" : rechecked.code } };
  }
  if (quitInProgress || quitAfterTransfers || (options.recoverFrom && current?.status !== "recovering")) return runtimeSnapshot(serverId);
  updateServerMetadata(server.folderPath, { java: javaAssignment(javaRuntime) });
  const recovered = options.recoverFrom;
  const startupStarted = Date.now();
  const startupOptions = appPreferences().snapshot().options;
  const monitor = createStartupMonitor(startupStarted, startupOptions);
  const runtime = {
    serverId,
    status: "starting",
    host: endpoint.host,
    port: endpoint.port,
    process: null,
    startedAt: new Date(startupStarted).toISOString(),
    stoppedAt: null,
    exitCode: null,
    logs: recovered?.logs || [],
    nextLogId: recovered?.nextLogId || 0,
    errorGrouping: recovered?.errorGrouping || {},
    recoveryAttempts: recovered ? recovered.recoveryAttempts + 1 : 0,
    readyAt: 0,
    onlinePlayers: new Set(),
    outputBuffers: { stdout: "", stderr: "" },
  };
  const child = spawn(command, args, {
    cwd: server.folderPath,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  runtime.process = child;
  runningServers.set(serverId, runtime);
  try {
    updateServerMetadata(server.folderPath, { lastStartedAt: runtime.startedAt });
  } catch (error) {
    appendLog(runtime, `[APP] Could not save the server start time: ${error.message}`);
  }
  const configuredMemory = memorySettings(server);
  appendLog(runtime, "[APP] Java " + (javaRuntime.details?.version || javaRuntime.requiredMajor) + " (" + javaRuntime.source + ").");
  if (javaRuntime.warning) appendLog(runtime, "[APP] " + javaRuntime.warning);
  appendLog(runtime, `[APP] Starting ${server.name} with ${configuredMemory.minMemoryMb} MB minimum and ${configuredMemory.maxMemoryMb} MB maximum RAM...`);

  let reportPending = false;
  let nextReportCheck = 0;
  const analyzeReport = async () => {
    if (reportPending) return;
    reportPending = true;
    nextReportCheck = Date.now() + 15_000;
    const lines = await readStartupCrashReport(server.folderPath, startupStarted);
    reportPending = false;
    if (!lines.length || runtime.readyAt || runtime.stopRequested || runningServers.get(serverId) !== runtime) return;
    if (runtime.status === "startup-stalled") markStartupFailure("A crash report was written during this startup attempt.", lines);
    else if (runtime.startupFailed) {
      const status = runtime.process || spawnFailed ? "startup-failed" : "crashed";
      runtime.startupDiagnosis = monitor.diagnose(status, runtime.startupExitReason, lines);
      if (!runtime.process) savePackSetup(server, runtime, runtime.startupDiagnosis);
    }
  };
  function markStartupFailure(reason, reportLines) {
    runtime.status = "startup-failed";
    runtime.startupFailed = true;
    runtime.startupDiagnosis = monitor.diagnose(runtime.status, reason, reportLines);
    appendLog(runtime, `[APP] Server startup failed: ${runtime.startupDiagnosis.problem}`);
    if (!runtime.failureNotified) {
      runtime.failureNotified = true;
      notifyServerEvent("notifyCrash", server, "Startup failed", runtime.startupDiagnosis.problem);
    }
  }
  function markReady() {
    if (!runtime.process || runtime.stopRequested || runtime.readyAt || runningServers.get(serverId) !== runtime) return;
    runtime.status = "running";
    runtime.readyAt = Date.now();
    runtime.startupFailed = false;
    runtime.startupDiagnosis = null;
    savePackSetup(server, runtime);
    clearInterval(startupTimer);
    notifyServerEvent("notifyReady", server, "Server ready", "Players can now join.");
    if (runtime.recoveryAttempts) appendLog(runtime, "[APP] Server recovered successfully.");
  }
  let readyMessage = false;
  let checkingPort = false;
  const checkStartup = () => {
    if (!runtime.process || runtime.readyAt || runtime.stopRequested) return;
    const finding = monitor.check(Date.now());
    if (server.modpack && readyMessage && finding !== "startup-failed" && !checkingPort) {
      checkingPort = true;
      void serverPortIsListening(endpoint).then(listening => {
        if (listening && monitor.check(Date.now()) !== "startup-failed") markReady();
      }).catch(() => {}).finally(() => { checkingPort = false; });
    }
    if (finding === "startup-failed") {
      if (runtime.status !== finding) {
        markStartupFailure();
        void analyzeReport();
      } else if (!runtime.startupDiagnosis?.kind || runtime.startupDiagnosis.kind === "unknown") {
        runtime.startupDiagnosis = monitor.diagnose(finding);
      }
    } else if (runtime.status !== "startup-failed") {
      const status = finding === "starting" ? finding : "startup-stalled";
      if (status !== runtime.status || finding !== runtime.startupStallReason) {
        runtime.status = status;
        runtime.startupStallReason = finding;
        runtime.startupDiagnosis = status === "startup-stalled" ? monitor.diagnose(status, finding) : null;
        if (runtime.startupDiagnosis) void analyzeReport();
      }
    }
    if (runtime.startupDiagnosis && Date.now() >= nextReportCheck) void analyzeReport();
  };
  const startupTimer = setInterval(checkStartup, 2000);
  let spawnFailed = false;
  const handleOutput = (source) => (chunk) => {
    const lines = `${runtime.outputBuffers[source]}${chunk.toString()}`.split(/\r?\n/);
    runtime.outputBuffers[source] = lines.pop() || "";
    lines.forEach((line) => {
      appendLog(runtime, line, source);
      if (runtime.readyAt || runtime.stopRequested) return;
      if (monitor.observe(line, Date.now())) {
        readyMessage = true;
        if (!server.modpack) markReady();
      }
    });
    checkStartup();
  };
  const flushOutput = () => {
    for (const source of ["stdout", "stderr"]) {
      if (runtime.outputBuffers[source]) {
        appendLog(runtime, runtime.outputBuffers[source], source);
        if (!runtime.readyAt && !runtime.stopRequested) monitor.observe(runtime.outputBuffers[source], Date.now());
      }
      runtime.outputBuffers[source] = "";
    }
  };
  child.stdout.on("data", handleOutput("stdout"));
  child.stderr.on("data", handleOutput("stderr"));
  child.stdin.on("error", (error) => {
    if (runtime.status === "running" && error.code !== "EPIPE") appendLog(runtime, `[APP] Server input failed: ${error.message}`);
  });
  child.on("error", (error) => {
    spawnFailed = !child.pid;
    appendLog(runtime, `[APP] Server process error: ${error.message}`);
    if (spawnFailed && !runtime.stopRequested) markStartupFailure(error.message);
  });
  child.on("close", (code, signal) => {
    clearInterval(startupTimer);
    flushOutput();
    runtime.status = "offline";
    runtime.stoppedAt ||= new Date().toISOString();
    runtime.exitCode = code;
    runtime.process = null;
    runtime.onlinePlayers.clear();
    const unexpected = !runtime.stopRequested && (!runtime.readyAt || Boolean(signal) || code !== 0);
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    runtime.startupFailed = !runtime.stopRequested && !runtime.readyAt;
    runtime.status = spawnFailed && unexpected ? "startup-failed" : unexpected ? "crashed" : "offline";
    if (!runtime.startupFailed) runtime.startupDiagnosis = null;
    if (unexpected && !runtime.failureNotified) notifyServerEvent("notifyCrash", server, runtime.status === "crashed" ? "Server crashed" : "Startup failed", reason);
    if (runtime.startupFailed) {
      runtime.startupExitReason = spawnFailed ? runtime.startupDiagnosis?.cause : `The process ended before Minecraft was ready (${reason}).`;
      const diagnosis = monitor.diagnose(runtime.status, runtime.startupExitReason);
      if (!runtime.startupDiagnosis || diagnosis.kind !== "unknown" || runtime.startupDiagnosis.kind === "stall") runtime.startupDiagnosis = diagnosis;
      savePackSetup(server, runtime, runtime.startupDiagnosis);
      appendLog(runtime, `[APP] Server startup failed before Minecraft was ready (${reason}).`);
      void analyzeReport();
    }
    else appendLog(runtime, unexpected ? `[APP] Server crashed (${reason}).` : `[APP] Server stopped (${reason}).`);
    if (unexpected && (!runtime.startupFailed || (runtime.recoveryAttempts && monitor.check(Date.now()) !== "startup-failed"))) scheduleServerRecovery(runtime);
    if (!spawnFailed && !signal && code === 0) runtime.shutdownBackup = runStopBackup(serverId);
  });
  return runtimeSnapshot(serverId);
}

function cancelServerRecovery(runtime) {
  if (runtime?.status !== "recovering") return;
  clearTimeout(runtime.recoveryTimer);
  runtime.status = "offline";
  appendLog(runtime, "[APP] Automatic recovery canceled.");
}

function scheduleServerRecovery(runtime) {
  if (quitInProgress || quitAfterTransfers) return;
  if (runtime.readyAt && Date.now() - runtime.readyAt >= RECOVERY_RESET_MS) runtime.recoveryAttempts = 0;
  const wait = RECOVERY_DELAYS_MS[runtime.recoveryAttempts];
  if (!wait) {
    appendLog(runtime, "[APP] Automatic recovery stopped after three attempts. Review the console before starting again.");
    return;
  }

  runtime.status = "recovering";
  appendLog(runtime, `[APP] Restarting in ${wait / 1000} seconds (attempt ${runtime.recoveryAttempts + 1} of ${RECOVERY_DELAYS_MS.length}).`);
  const recover = async () => {
    const id = runtime.serverId;
    if (runningServers.get(id) !== runtime || runtime.status !== "recovering") return;
    if (quitInProgress || quitAfterTransfers) {
      cancelServerRecovery(runtime);
      return;
    }
    if (getServerOperation(id) || quitPromptOpen) {
      runtime.recoveryTimer = setTimeout(recover, 1000);
      return;
    }
    try {
      const result = await withServerOperation(id, "recovering after a crash", () => startServer(id, { recoverFrom: runtime }));
      if (runtime.status !== "recovering" || runningServers.get(id) !== runtime) return;
      if (result.requiresPortConflict) throw new Error(`Port ${result.portConflict.port} is in use`);
      if (result.requiresEula) throw new Error("Minecraft's EULA needs to be accepted");
      cancelServerRecovery(runtime);
    } catch (error) {
      if (runningServers.get(id) !== runtime || runtime.status !== "recovering") return;
      runtime.status = "offline";
      appendLog(runtime, `[APP] Automatic recovery failed: ${error.message}.`);
    }
  };
  runtime.recoveryTimer = setTimeout(recover, wait);
}

function performWorldBackup(id) {
  const serverId = normalizeServerId(id);
  const existing = worldBackupsInProgress.get(serverId);
  if (existing) return existing;
  const pending = writeWorldBackup(serverId).finally(() => worldBackupsInProgress.delete(serverId));
  worldBackupsInProgress.set(serverId, pending);
  return pending;
}

async function writeWorldBackup(serverId) {
  const server = getServer(serverId);
  if (!server) throw new Error("Saved server not found");
  const settings = getBackupSettings(server.folderPath);
  if (!settings.enabled && !settings.destination) throw new Error("Configure a backup folder first");
  const runtime = runningServers.get(serverId);
  const running = Boolean(runtime?.process && runtime.status === "running");
  if (runtime?.process && !running) throw new Error("Wait for the server to finish starting or stopping before backing it up");
  try {
    if (running) {
      runtime.process.stdin.write("save-off\n");
      runtime.process.stdin.write("save-all flush\n");
      appendLog(runtime, "[APP] Saving world before automatic backup…");
      await delay(1500);
    }
    const result = await createWorldBackup(server, settings);
    const updated = recordBackupResult(server.folderPath, getBackupSettings(server.folderPath), result);
    notifyServerEvent("notifyBackup", server, "World backup complete", result.fileName);
    if (runtime) appendLog(runtime, `[APP] World backup complete: ${result.fileName}`);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("backups:completed", { serverId, settings: updated, result });
    return { settings: updated, result };
  } catch (error) {
    recordBackupError(server.folderPath, getBackupSettings(server.folderPath), error);
    if (runtime) appendLog(runtime, `[APP] World backup failed: ${error.message}`);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("backups:failed", { serverId, message: error.message });
    throw error;
  } finally {
    if (running && runtime?.process && runtime.status === "running") {
      try { runtime.process.stdin.write("save-on\n"); } catch {}
    }
  }
}

async function runStopBackup(serverId) {
  const server = getServer(serverId);
  if (!server) return;
  const settings = getBackupSettings(server.folderPath);
  if (!settings.enabled || !settings.destination) return;
  try {
    await worldBackupsInProgress.get(serverId)?.catch(() => {});
    if (getBackupSettings(server.folderPath).enabled) await performWorldBackup(serverId);
  } catch { /* Error is recorded and surfaced without undoing a safe stop. */ }
}

async function stopServer(id) {
  const serverId = normalizeServerId(id);
  const runtime = runningServers.get(serverId);
  cancelServerRecovery(runtime);
  if (!runtime?.process || runtime.status === "offline") {
    await runtime?.shutdownBackup;
    return runtimeSnapshot(serverId);
  }

  runtime.stopRequested = true;
  runtime.status = "stopping";
  appendLog(runtime, "[APP] Stopping server...");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (runtime.process && !runtime.process.killed) {
        appendLog(runtime, "[APP] Graceful stop timed out; terminating process.");
        runtime.process.kill();
      }
    }, 15_000);
    runtime.process.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      runtime.process.stdin.write("stop\n");
    } catch {
      runtime.process.kill();
    }
  });
  await runtime.shutdownBackup;
  return runtimeSnapshot(serverId);
}

function stopServerRequest(id) {
  const serverId = normalizeServerId(id);
  const runtime = runningServers.get(serverId);
  if (runtime?.repairController) {
    runtime.status = "stopping";
    runtime.repairController.abort();
    return runtimeSnapshot(serverId);
  }
  return runtime?.status === "recovering"
    ? stopServer(serverId)
    : withServerOperation(serverId, "stopping", () => stopServer(serverId));
}

async function runDueBackups() {
  if (quitInProgress || quitAfterTransfers) return;
  for (const server of getSavedServers()) {
    const settings = getBackupSettings(server.folderPath);
    const runtime = runningServers.get(server.id);
    if (!runtime?.process || runtime.status !== "running" || !backupIsDue(settings, new Date(), runtime.startedAt)) continue;
    try {
      await withServerOperation(server.id, "backing up the world", () => performWorldBackup(server.id));
    } catch { /* Busy servers retry on the next scheduler pass; backup errors are persisted. */ }
  }
}

function startBackupScheduler() {
  clearInterval(backupScheduler);
  backupScheduler = setInterval(() => runDueBackups(), 60_000);
  backupScheduler.unref?.();
  setTimeout(() => runDueBackups(), 5_000).unref?.();
}

async function chooseBackupDestination(id) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Choose automatic backup folder",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  return { cancelled: false, destination: path.resolve(selection.filePaths[0]) };
}

function updateBackupSettings(id, changes) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return saveBackupSettings(server.folderPath, changes);
}

function sendCommand(id, value) {
  const serverId = normalizeServerId(id);
  const command = normalizeRawCommand(value);
  const runtime = runningServers.get(serverId);
  if (!runtime?.process || runtime.status !== "running") throw new Error("Server is not running");
  if (!command) return runtimeSnapshot(serverId);
  if (/^\/?(?:minecraft:)?stop$/i.test(command)) runtime.stopRequested = true;
  runtime.process.stdin.write(`${command}\n`);
  appendLog(runtime, `> ${command}`, "command");
  return runtimeSnapshot(serverId);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServerReady(id, timeoutMilliseconds = appPreferences().snapshot().options.startupDeadlineMinutes * 60_000) {
  const serverId = normalizeServerId(id);
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const runtime = runningServers.get(serverId);
    if (runtime?.status === "running") return runtimeSnapshot(serverId);
    if (!runtime?.process || runtime.status === "startup-failed") {
      if (runtime?.startupDiagnosis) throw new Error(runtime.startupDiagnosis.problem);
      const lastLine = runtime?.logs?.at(-1);
      throw new Error(lastLine?.raw || lastLine || "The server stopped before it finished starting");
    }
    await delay(250);
  }
  throw new Error("The server did not finish before the configured startup deadline.");
}

async function restartAndWait(id) {
  const startedRuntime = await startServer(id);
  if (startedRuntime.requiresEula) {
    throw new Error("The Minecraft EULA must be accepted before the server can restart");
  }
  if (startedRuntime.requiresPortConflict) {
    throw new Error("Port " + startedRuntime.portConflict.port + " is already in use.");
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

function addonServer(id) {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return server;
}

function addonThumbnail(png) {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return "";
  const { width, height } = image.getSize();
  return image.resize(width >= height ? { width: 48 } : { height: 48 }).toDataURL();
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

async function searchAddonsWithCache(server, query, recommendations = false, options = {}) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const releaseChannel = addonReleaseChannel(server);
  const category = String(options.category || "all");
  const sort = String(options.sort || "relevance");
  const key = `${server.type}:${server.version}:${releaseChannel}:${recommendations ? "recommended-v2" : `${category}:${sort}:${normalizedQuery}`}`;
  const cache = readAddonSearchCache();
  try {
    const result = recommendations
      ? await recommendCompatibleAddons(server)
      : await searchCompatibleAddons(server, query, { category, sort });
    cache[key] = { savedAt: new Date().toISOString(), result };
    const entries = Object.entries(cache).slice(-100);
    atomicWriteFile(addonSearchCachePath(), `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
    return { ...result, searchContract: 2, cached: false, offline: false };
  } catch (error) {
    if (cache[key]?.result) {
      return { ...cache[key].result, searchContract: 2, cached: true, offline: true, offlineMessage: "Internet connection unavailable. Showing cached results." };
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
      addons: await describeLocalInstalledAddons(server, undefined, addonThumbnail),
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

async function chooseWorldImportSource(kind) {
  const folder = kind === "folder";
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: folder ? "Choose a Minecraft world folder" : "Choose a Minecraft world ZIP",
    buttonLabel: "Use this world",
    properties: [folder ? "openDirectory" : "openFile"],
    filters: [{ name: "Minecraft world ZIPs", extensions: ["zip"] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const selectedPath = selection.filePaths[0];
  if (await detectDropSource(selectedPath) !== "world") throw new Error("Choose a Minecraft world containing level.dat.");
  return approveWorldImport(selectedPath);
}

function approveWorldImport(source) {
  const selectedPath = path.resolve(source);
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
      resolveServerDownload: findOriginalServerDownload,
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

async function exportServer(id) {
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
    prepareMetadata: (folder, metadata) => prepareImportedJava(folder, metadata, progress => sendTransferProgress("import", null, progress)),
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
    prepareMetadata: (folder, metadata) => prepareImportedJava(folder, metadata, progress => sendTransferProgress("external-import", null, progress)),
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
  const script = `
    $perf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)
    $perfById = @{}
    foreach ($perfRow in $perf) { $perfById[[int]$perfRow.IDProcess] = $perfRow }
    $processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize)
    $items = foreach ($process in $processes) {
      $row = $perfById[[int]$process.ProcessId]
      if ($process.ProcessId) {
        [PSCustomObject]@{
          pid = [int]$process.ProcessId
          parentPid = [int]$process.ParentProcessId
          cpuRaw = if ($row) { [double]$row.PercentProcessorTime } else { 0 }
          ramBytes = [int64]$process.WorkingSetSize
        }
      }
    }
    @($items) | ConvertTo-Json -Compress
  `;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: 10000,
  });
  const result = JSON.parse(stdout.trim() || "[]");
  const rows = Array.isArray(result) ? result : result ? [result] : [];
  return aggregateProcessTreeUsage(rows, pids, os.cpus().length);
}

async function getUnixUsage(pids) {
  const { stdout } = await execFileAsync("ps", ["-p", pids.join(","), "-o", "pid=,pcpu=,rss="], {
    maxBuffer: 1024 * 1024,
    timeout: 10000,
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
  fs.rmSync(javaChoicePath(server), { force: true });
  return { deleted: true };
}

async function stopAllServers() {
  const ids = Array.from(runningServers.keys());
  await Promise.all(ids.map((id) => stopServer(id)));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  tray = new Tray(getAssetPath("app-icon-32.png"));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open BlockHost Manager", click: showMainWindow },
    { type: "separator" },
    { label: "Quit", click: () => requestApplicationQuit() },
  ]));
  tray.on("click", showMainWindow);
  tray.on("balloon-click", showMainWindow);
}

const serverNotifications = new Map();

function notifyServerEvent(preference, server, title, body) {
  const notificationTitle = `${title} · ${server.name}`;
  const showTrayNotification = () => {
    if (process.platform !== "win32" || !tray || tray.isDestroyed()) return;
    try { tray.displayBalloon({ title: notificationTitle, content: body }); }
    catch { /* The system tray may be unavailable. */ }
  };
  try {
    if (!appPreferences().snapshot().desktop[preference]) return;
    if (!Notification.isSupported()) return showTrayNotification();
    const key = `${server.id}:${preference}`;
    serverNotifications.get(key)?.close();
    const notification = new Notification({ title: notificationTitle, body, icon: getAssetPath("app-icon.png") });
    serverNotifications.set(key, notification);
    notification.on("click", showMainWindow);
    const release = () => {
      if (serverNotifications.get(key) === notification) serverNotifications.delete(key);
    };
    notification.on("close", release);
    notification.on("failed", () => {
      release();
      showTrayNotification();
    });
    notification.show();
  } catch { /* Desktop notification failures must not interrupt server operations. */ }
}

function savedWindowBounds() {
  const saved = appPreferences().windowBounds();
  if (!appPreferences().snapshot().desktop.rememberWindow || !saved
    || !["x", "y", "width", "height"].every(key => Number.isSafeInteger(saved[key]))
    || saved.width < 900 || saved.height < 650) return {};
  const { workArea } = screen.getDisplayMatching(saved);
  const width = Math.max(900, Math.min(saved.width, workArea.width));
  const height = Math.max(650, Math.min(saved.height, workArea.height));
  return {
    width, height,
    x: Math.max(workArea.x, Math.min(saved.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(saved.y, workArea.y + workArea.height - height)),
  };
}

function showBackgroundRunningNotice() {
  if (backgroundNoticeShown || !appPreferences().snapshot().desktop.notifyTray) return;
  backgroundNoticeShown = true;
  const title = `${APP_NAME} is still running`;
  const content = "BlockHost is in the system tray. To exit, choose Quit from its tray menu.";
  const icon = getAssetPath("app-icon.png");
  if (process.platform === "win32" && tray && !tray.isDestroyed() && typeof tray.displayBalloon === "function") {
    try {
      tray.displayBalloon({ title, content, icon, iconType: "custom", noSound: true });
      return;
    } catch { /* Fall back to Electron's notification API below. */ }
  }
  if (!Notification.isSupported()) return;
  backgroundNotification = new Notification({
    title,
    body: content,
    icon,
    silent: true,
  });
  backgroundNotification.on("click", showMainWindow);
  backgroundNotification.show();
}

function createWindow() {
  const { titlebar, symbols } = appThemes[appPreferences().snapshot().theme];
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    ...savedWindowBounds(),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: titlebar,
      symbolColor: symbols,
      height: 40,
    },
    autoHideMenuBar: true,
    backgroundColor: "#08101d",
    icon: getAssetPath("app-icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  let saveBoundsTimer;
  const saveBounds = () => {
    clearTimeout(saveBoundsTimer);
    try {
      if (appPreferences().snapshot().desktop.rememberWindow && mainWindow && !mainWindow.isDestroyed()) {
        appPreferences().rememberWindow(mainWindow.getNormalBounds());
      }
    } catch { /* A preferences write must not interfere with closing the window. */ }
  };
  const queueBoundsSave = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(saveBounds, 300);
  };
  mainWindow.on("resize", queueBoundsSave);
  mainWindow.on("move", queueBoundsSave);
  mainWindow.on("minimize", () => {
    if (appPreferences().snapshot().desktop.minimizeToTray && runningServerEntries().length) {
      mainWindow.hide();
      showBackgroundRunningNotice();
    }
  });
  mainWindow.on("close", (event) => {
    saveBounds();
    if (quitInProgress) return;
    event.preventDefault();
    mainWindow.hide();
    showBackgroundRunningNotice();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === MINECRAFT_EULA_URL || url.startsWith("https://adoptium.net/") || diagnosticLinks.some((link) => link.url === url)) {
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

const hasSingleInstanceLock = !started && app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) showMainWindow();
    else app.whenReady().then(showMainWindow);
  });

  app.whenReady().then(() => {
    fs.rmSync(packStagingRoot(), { recursive: true, force: true });
    cleanupAbandonedTransfers(getServersRoot(), getExportsDirectory());
    cleanupAbandonedAddonTransactions(getServersRoot());
    cleanupAbandonedExternalImports(getServersRoot());
    cleanupManagedJavaArtifacts(getManagedRuntimeRoot()).catch(() => {});
    startBackupScheduler();
    createTray();
    createWindow();
    getAppUpdates();
    subscribeOperations((operations) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("operations:state", operations);
      finishQueuedQuit();
    });
    app.on("activate", () => {
      showMainWindow();
    });
  });
}

app.on("will-quit", () => {
  if (hasSingleInstanceLock) {
    try { fs.rmSync(packStagingRoot(), { recursive: true, force: true }); } catch {}
  }
});

app.on("before-quit", (event) => {
  if (quitInProgress) return;
  event.preventDefault();
  requestApplicationQuit();
});

ipcMain.handle("servers:getVersionOptions", (_event, options) =>
  getVersionOptions(options?.type)
);
ipcMain.handle("app:getSettings", () => {
  const settings = appPreferences().snapshot();
  applyWindowTheme(settings.theme);
  return { ...settings, memoryLimitMb: memoryLimitMb() };
});
ipcMain.handle("app:getUpdateStatus", () => getAppUpdates().snapshot());
ipcMain.handle("app:checkUpdate", () => getAppUpdates().check());
ipcMain.handle("app:restartForUpdate", () => getAppUpdates().restart());
ipcMain.handle("app:setTheme", (_event, theme) => {
  const settings = appPreferences().setTheme(theme);
  applyWindowTheme(settings.theme);
  return settings;
});
ipcMain.handle("app:setOptions", (_event, options) => appPreferences().setOptions(options, memoryLimitMb()));
ipcMain.handle("app:setDesktopOptions", (_event, options) => {
  const settings = appPreferences().setDesktopOptions(options);
  if (settings.desktop.rememberWindow && mainWindow && !mainWindow.isDestroyed()) {
    appPreferences().rememberWindow(mainWindow.getNormalBounds());
  }
  return settings;
});
ipcMain.handle("app:setQuickDefaults", (_event, options) => appPreferences().setQuickDefaults(options));
ipcMain.handle("app:rememberServer", (_event, id) => {
  const server = getServer(id);
  if (server) appPreferences().rememberServer(server.id);
});
ipcMain.handle("app:getStorage", () => storageSummary());
ipcMain.handle("app:clearDownloadCache", () => {
  clearDownloadCache();
  return storageSummary();
});
ipcMain.handle("app:copyText", (_event, value) => {
  const text = String(value || "");
  if (!text) throw new Error("There is no console output to copy");
  if (Buffer.byteLength(text, "utf8") > 5 * 1024 * 1024) throw new Error("The selected console output is too large to copy at once");
  clipboard.writeText(text);
  return { copied: true, characters: text.length };
});
ipcMain.handle("servers:javaSettings", async (_event, id) => {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return javaSettings(server);
});
ipcMain.handle("servers:setJavaVersion", async (_event, data) => withServerOperation(data?.id, "choosing Java", async () => {
  const server = getServer(data?.id);
  if (!server) throw new Error("Saved server not found");
  if (data.version === "automatic") {
    fs.rmSync(javaChoicePath(server), { force: true });
    return javaSettings(server);
  }
  const requirement = await inspectServerJava(server);
  const major = Number(data.version);
  if (!requirement.versions.includes(major)) throw new Error("Choose a compatible Java version.");
  atomicWriteFile(javaChoicePath(server), JSON.stringify({ major }));
  return javaSettings(server, requirement);
}));
ipcMain.handle("servers:create", (_event, data) =>
  withServerOperation(-1, "downloading a server", () => {
    const { options: { maxMemoryMb }, quickDefaults } = appPreferences().snapshot();
    const initialMemory = maxMemoryMb ? { maxMemoryMb: Math.min(maxMemoryMb, memoryLimitMb()) } : null;
    return createServer({ ...data, initialMemory, quickDefaults });
  })
);
ipcMain.handle("servers:getSaved", () => getSavedServers());
ipcMain.handle("servers:getFolderBytes", (_event, id) => {
  const server = getServer(id);
  if (!server) throw new Error("The server folder is unavailable.");
  return serverFolderBytes(server.folderPath);
});
ipcMain.handle("servers:openFolder", async (_event, id) => {
  const server = getServer(id);
  if (!server || !isPathInside(getServersRoot(), server.folderPath)
    || !fs.lstatSync(server.folderPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("The server folder is unavailable.");
  }
  const error = await shell.openPath(server.folderPath);
  if (error) throw new Error(`Could not open the server folder. ${error}`);
});
ipcMain.handle("servers:getRuntimeState", (_event, id) => runtimeSnapshot(id));
ipcMain.handle("servers:getUsage", () => getUsage());
ipcMain.handle("operations:getActive", () => getActiveOperations());
ipcMain.handle("servers:start", (_event, data) =>
  withServerOperation(data?.id, "starting", () => startServer(data?.id, {
    acceptEula: Boolean(data?.acceptEula),
    repairBundledDependency: data?.repairBundledDependency === true,
  }))
);
ipcMain.handle("servers:stop", (_event, id) =>
  stopServerRequest(id)
);
ipcMain.handle("servers:sendCommand", (_event, data) => sendCommand(data?.id, data?.command));
ipcMain.handle("servers:commandData", (_event, id) => loadCommandData(getServer(id)?.version));
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
ipcMain.handle("worlds:chooseImportSource", (_event, kind) => chooseWorldImportSource(kind));
ipcMain.handle("transfers:detectDrop", async (_event, source) => {
  if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("This dropped file could not be read.");
  const kind = await detectDropSource(source);
  if (["modpack", "server-starter", "packwiz", "ftb-installer", "client-launcher"].includes(kind)) return { kind: "modpack", pack: await withServerOperation(-2, "preparing a modpack", () => preparePack(source)) };
  return kind === "world" ? { kind, world: approveWorldImport(source) } : { kind };
});
ipcMain.handle("worlds:export", (_event, id) =>
  withServerOperation(id, "exporting the world", () => runTrackedTransfer(() => exportServerWorld(id)))
);
ipcMain.handle("backups:getSettings", (_event, id) => {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return getBackupSettings(server.folderPath);
});
ipcMain.handle("backups:chooseDestination", (_event, id) => chooseBackupDestination(id));
ipcMain.handle("backups:updateSettings", (_event, data) =>
  withServerOperation(data?.id, "updating backup settings", () => updateBackupSettings(data?.id, data?.settings || {}))
);
ipcMain.handle("backups:runNow", (_event, id) =>
  withServerOperation(id, "backing up the world", () => performWorldBackup(id))
);
ipcMain.handle("modpacks:search", (_event, data) => searchModpacks(data?.query, data?.offset));
ipcMain.handle("modpacks:versions", (_event, id) => modpackVersions(id));
ipcMain.handle("modpacks:prepareOnline", (_event, id, projectId) => withServerOperation(-2, "preparing a modpack", () =>
  preparePack(null, id, projectId)));
ipcMain.handle("modpacks:chooseLocal", async () => {
  const selection = await dialog.showOpenDialog(mainWindow, { title: "Choose a modpack", properties: ["openFile"], filters: [{ name: "Modpacks", extensions: ["mrpack", "zip"] }] });
  if (selection.canceled || !selection.filePaths[0]) return null;
  return withServerOperation(-2, "preparing a modpack", () => preparePack(selection.filePaths[0]));
});
ipcMain.handle("modpacks:cancel", () => { packController?.abort(); return true; });
ipcMain.handle("addons:list", (_event, id) => scanServerAddons(addonServer(id)));
ipcMain.handle("addons:inspect", (_event, id) => describeLocalInstalledAddons(addonServer(id), undefined, addonThumbnail));
ipcMain.handle("addons:identify", (_event, id) => identifyInstalledAddons(addonServer(id)));
ipcMain.handle("addons:recommendations", (_event, id) => {
  const server = getServer(id);
  if (!server) throw new Error("Saved server not found");
  return searchAddonsWithCache(server, "", true);
});
ipcMain.handle("addons:search", (_event, data) => {
  const server = getServer(data?.id);
  if (!server) throw new Error("Saved server not found");
  return searchAddonsWithCache(server, data?.query, false, {
    category: data?.category,
    sort: data?.sort,
  });
});
ipcMain.handle("addons:openProject", (_event, projectId) => {
  const id = String(projectId || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Invalid add-on project link");
  return shell.openExternal(`https://modrinth.com/project/${encodeURIComponent(id)}`);
});
ipcMain.handle("addons:install", (_event, data) =>
  applyAddonChange(data?.id, "installing an add-on", (server) => {
    const requested = {
      projectId: String(data?.projectId || ""),
      versionId: String(data?.versionId || ""),
      title: String(data?.title || "Selected add-on"),
      iconUrl: String(data?.iconUrl || ""),
    };
    return installModrinthAddon(server, requested);
  })
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
  return withServerOperation(id, "checking add-on updates", async () => describeLocalInstalledAddons(server, await checkAddonUpdates(server), addonThumbnail));
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
  withServerOperation(data?.id, "changing the add-on release channel", async () => {
    const server = getServer(data?.id);
    if (!server) throw new Error("Saved server not found");
    const result = setAddonReleaseChannel(server, String(data?.releaseChannel || "stable"));
    commitAddonTransaction(result.transaction);
    return { addons: await describeLocalInstalledAddons(server, result.addons, addonThumbnail), runtime: runtimeSnapshot(data?.id), restarted: false };
  })
);
ipcMain.handle("addons:rollback", (_event, data) =>
  applyAddonChange(data?.id, "rolling back an add-on", (server) =>
    rollbackAddonVersion(server, String(data?.addonId || ""), String(data?.versionId || ""))
  )
);
ipcMain.handle("transfers:export", (_event, id) =>
  runTrackedTransfer(() => withServerOperation(id, "being exported", () => exportServer(id)))
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
