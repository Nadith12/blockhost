import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile, assertPathInside, isPathInside } from "./safe-filesystem.mjs";
import {
  metadataNeedsMigration,
  migrateServerMetadata,
} from "./server-metadata.mjs";

const SERVER_TYPES = new Set(["vanilla", "paper", "fabric", "forge", "neoforge"]);
const DEFAULT_COLOR = "#39c9ff";

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

export function normalizeServerType(value) {
  return SERVER_TYPES.has(value) ? value : "vanilla";
}

export function serverTypeLabel(type) {
  return {
    vanilla: "Vanilla",
    paper: "Paper",
    fabric: "Fabric",
    forge: "Forge",
    neoforge: "NeoForge",
  }[type] || "Vanilla";
}

export function normalizeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : DEFAULT_COLOR;
}

export function safeSegment(value, fallback = "item") {
  const result = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return result || fallback;
}

export function normalizeServerName(value) {
  const name = String(value || "").trim().slice(0, 80);
  if (!name) throw new Error("Server name is required");
  return name;
}

export function normalizeServerId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid server id");
  return id;
}

function portableLaunchPath(folderPath, value) {
  if (!value) return "";
  const text = String(value);
  const relative = path.isAbsolute(text) ? path.relative(folderPath, text) : text;
  if (!relative || !isPathInside(folderPath, path.join(folderPath, relative))) {
    throw new Error("Invalid server launch path");
  }
  return relative;
}

function portableMetadata(folderPath, server) {
  const migrated = migrateServerMetadata(server, { entryName: path.basename(folderPath) });
  migrated.launchArgsPath = migrated.launchType === "javaArgsFile"
    ? portableLaunchPath(folderPath, migrated.launchArgsPath)
    : "";
  migrated.jarFile = migrated.launchType === "jar"
    ? safeSegment(path.basename(migrated.jarFile || "server.jar"), "server.jar")
    : "";
  return migrated;
}

export function writeServerMetadata(folderPath, server) {
  const folder = path.resolve(folderPath);
  const metadata = portableMetadata(folder, server);
  atomicWriteFile(path.join(folder, "server-info.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export function updateServerMetadata(folderPath, changes) {
  const filePath = path.join(folderPath, "server-info.json");
  const current = readJson(filePath, {});
  return writeServerMetadata(folderPath, { ...current, ...changes });
}

function migrateLegacyJar(folderPath, metadata) {
  if ((metadata.launchType === "javaArgsFile" ? "javaArgsFile" : "jar") !== "jar") return false;
  const jarFile = safeSegment(path.basename(metadata.jarFile || "server.jar"), "server.jar");
  const localJar = assertPathInside(folderPath, path.join(folderPath, jarFile));
  if (fs.existsSync(localJar)) return false;
  const legacyPath = String(metadata.jarPath || "");
  if (!legacyPath || !path.isAbsolute(legacyPath) || !fs.existsSync(legacyPath)) return false;
  fs.copyFileSync(legacyPath, localJar, fs.constants.COPYFILE_EXCL);
  return true;
}

function loadServerFolder(folderPath, entryName) {
  const metadataPath = path.join(folderPath, "server-info.json");
  const source = readJson(metadataPath);
  if (!source) return null;
  const copiedLegacyJar = migrateLegacyJar(folderPath, source);
  const metadata = migrateServerMetadata(source, { entryName });
  const id = normalizeServerId(metadata.id || String(entryName).split("-").at(-1));
  const type = normalizeServerType(metadata.type);
  const launchType = metadata.launchType === "javaArgsFile" ? "javaArgsFile" : "jar";
  const jarFile = launchType === "jar" ? safeSegment(path.basename(metadata.jarFile || "server.jar"), "server.jar") : "";
  const launchArgsPath = launchType === "javaArgsFile" ? portableLaunchPath(folderPath, metadata.launchArgsPath) : "";
  const needsMigration = metadataNeedsMigration(source)
    || Object.hasOwn(source, "folderPath")
    || Object.hasOwn(source, "jarPath")
    || copiedLegacyJar;
  if (needsMigration) {
    const migrationBackup = path.join(folderPath, "server-info.pre-blockhost-v3.json");
    if (!fs.existsSync(migrationBackup)) atomicWriteFile(migrationBackup, fs.readFileSync(metadataPath));
    writeServerMetadata(folderPath, { ...source, ...metadata, jarFile, launchArgsPath });
  }
  return {
    ...metadata,
    id,
    type,
    typeLabel: serverTypeLabel(type),
    color: normalizeColor(metadata.color),
    folderPath,
    jarFile,
    jarPath: launchType === "jar" ? path.join(folderPath, jarFile) : "",
    launchType,
    launchArgsPath,
  };
}

export function getSavedServers(serversRoot) {
  const root = path.resolve(serversRoot);
  if (!fs.existsSync(root)) return [];
  const servers = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".blockhost-")) continue;
    const folderPath = path.join(root, entry.name);
    try {
      const server = loadServerFolder(folderPath, entry.name);
      if (server) servers.push(server);
    } catch {
      // Invalid or incomplete folders stay hidden instead of breaking the dashboard.
    }
  }
  return servers.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export function getSavedServer(serversRoot, value) {
  const id = normalizeServerId(value);
  return getSavedServers(serversRoot).find((server) => server.id === id) || null;
}

export function createServerFolder(serversRoot, name, id) {
  const root = path.resolve(serversRoot);
  fs.mkdirSync(root, { recursive: true });
  const folder = assertPathInside(root, path.join(root, `${safeSegment(name, "server")}-${normalizeServerId(id)}`));
  fs.mkdirSync(folder, { recursive: false });
  return folder;
}
