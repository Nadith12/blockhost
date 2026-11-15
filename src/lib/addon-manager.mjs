import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { atomicWriteFile, assertPathInside, isPathInside } from "./safe-filesystem.mjs";
import { declaredModEnvironment } from "./addon-sides.mjs";

const MODRINTH_API = "https://api.modrinth.com/v2";
const MODRINTH_DOWNLOAD_HOST = "cdn.modrinth.com";
const USER_AGENT = "nadithjayawardana1/BlockHost-Manager/1.0.6";
const MAX_ADDON_BYTES = 512 * 1024 * 1024;
const MAX_INSTALL_BYTES = 2 * 1024 * 1024 * 1024;
const JAR_INSPECTION_BATCH_SIZE = 8;
const BUFFERED_JAR_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const LOCK_VERSION = 2;
const ADDON_HISTORY_DIRECTORY = ".blockhost-addon-history";
const ADDON_JOURNAL = /^\.blockhost-addon-journal-(.+)\.json$/i;
const VALID_RELEASE_CHANNELS = new Set(["stable", "beta", "alpha"]);
const ADDON_SORTS = new Set(["relevance", "downloads", "updated", "newest"]);
const ADDON_CATEGORY_FACETS = new Map([
  ["performance", ["categories:optimization"]],
  ["administration", ["categories:management", "categories:utility"]],
  ["world", ["categories:worldgen", "categories:adventure"]],
  ["social", ["categories:social"]],
  ["gameplay", ["categories:game-mechanics", "categories:minigame"]],
  ["libraries", ["categories:library"]],
]);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function safeFileName(value) {
  const name = path.basename(String(value || "")).replace(/[^a-z0-9._+()-]+/gi, "-").slice(0, 180);
  if (!name || !name.toLowerCase().endsWith(".jar")) throw new Error("The add-on does not provide a valid JAR file");
  return name;
}

function isStoredJarName(name) {
  return typeof name === "string" && /\.jar$/i.test(name) && !/[<>:"/\\|?*\x00-\x1f]/.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name);
}

export function hashFile(filePath, algorithm = "sha512") {
  const hash = crypto.createHash(algorithm);
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function validateJar(filePath) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size < 4) throw new Error("The selected JAR is empty or unreadable");
  if (stats.size > MAX_ADDON_BYTES) throw new Error("The selected add-on exceeds the 512 MB safety limit");
  const descriptor = fs.openSync(filePath, "r");
  const signature = Buffer.alloc(4);
  try {
    fs.readSync(descriptor, signature, 0, 4, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
    throw new Error("The selected file is not a valid Java archive");
  }
  return stats;
}

const MOD_METADATA_FILES = new Map([
  ["fabric", "fabric.mod.json"],
  ["quilt", "quilt.mod.json"],
  ["neoforge", "meta-inf/neoforge.mods.toml"],
  ["forge", "meta-inf/mods.toml"],
]);

const JAR_METADATA_FILES = new Set([...MOD_METADATA_FILES.values(), "meta-inf/manifest.mf", "paper-plugin.yml", "plugin.yml"]);

async function readJarEntry(archive, entry, limit) {
  if (entry.uncompressedSize > limit) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of await archive.openReadStreamPromise(entry)) {
    bytes += chunk.length;
    if (bytes > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function jarIconPaths(value) {
  const paths = typeof value === "string" ? [value]
    : value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort((a, b) => Math.abs(parseInt(a, 10) - 64) - Math.abs(parseInt(b, 10) - 64)).map((key) => value[key]) : [];
  return paths.filter((name) => typeof name === "string" && /\.png$/i.test(name)).slice(0, 8);
}

async function embeddedJarIcon(archive, entries, paths) {
  for (const name of paths || []) {
    const entry = entries.get(name);
    if (!entry) continue;
    const data = await readJarEntry(archive, entry, MAX_ICON_BYTES).catch(() => null);
    if (!data || data.length < 33 || data.toString("hex", 0, 8) !== "89504e470d0a1a0a" || data.toString("ascii", 12, 16) !== "IHDR") continue;
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width > 0 && width <= 2048 && height > 0 && height <= 2048) return data;
  }
  return null;
}

function yamlValue(text, key) {
  const match = String(text).match(new RegExp(`^${key}\\s*:\\s*["']?([^\\r\\n"']+)`, "mi"));
  return match?.[1]?.trim() || "";
}

function tomlValue(text, key) {
  const match = text.match(new RegExp(String.raw`^[ \t]*${key}[ \t]*=[ \t]*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[ \t]*\r?$`, "m"));
  if (!match) return "";
  if (match[1].startsWith("'")) return match[1].slice(1, -1).trim();
  try { return JSON.parse(match[1]).trim(); } catch { return ""; }
}

function forgeJarMetadata(text, implementationVersion) {
  // Keep table headers and single-line strings, ignoring comments and multiline values.
  const fields = text.replace(/^\uFEFF/, "").replace(/"""(?:\\[\s\S]|[^\\])*?"{3,5}|'''[\s\S]*?'{3,5}|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|#[^\r\n]*/g,
    (token) => token.startsWith("#") || token.startsWith('"""') || token.startsWith("'''") ? "" : token);
  const sections = fields.split(/^[ \t]*(\[\[?[^\]\r\n]+\]\]?)[ \t]*\r?$/m);
  const modIndex = sections.findIndex((section, index) => index % 2 === 1 && /^\[\[\s*mods\s*\]\]$/.test(section));
  const mod = modIndex === -1 ? "" : sections[modIndex + 1];
  const modId = tomlValue(mod, "modId");
  const version = tomlValue(mod, "version").replaceAll("${file.jarVersion}", () => implementationVersion || "${file.jarVersion}");
  let minecraftVersion = "";
  for (let i = 1; modId && i < sections.length; i += 2) {
    const dependency = sections[i].match(/^\[\[\s*dependencies\s*\.\s*(?:"([a-z0-9_]+)"|'([a-z0-9_]+)'|([a-z0-9_]+))\s*\]\]$/i);
    const owner = dependency?.[1] || dependency?.[2] || dependency?.[3];
    if (owner === modId && tomlValue(sections[i + 1], "modId") === "minecraft") {
      minecraftVersion = tomlValue(sections[i + 1], "versionRange");
      break;
    }
  }
  return {
    modId,
    title: tomlValue(mod, "displayName") || modId,
    versionNumber: version.includes("${") ? "" : version,
    minecraftVersion,
    iconPaths: jarIconPaths(tomlValue(mod, "logoFile") || tomlValue(sections[0], "logoFile")),
  };
}

function manifestValue(manifest, key) {
  return manifest.match(new RegExp(`^${key}: (.*)$`, "mi"))?.[1].trim() || "";
}

export async function inspectAddonJar(filePath, preferredLoader, makeIcon, { signal } = {}) {
  signal?.throwIfAborted();
  const stats = validateJar(filePath);
  const options = { lazyEntries: true, autoClose: false };
  let archive;
  try {
    // Buffered reads avoid a filesystem round trip for every central-directory entry.
    if ((makeIcon || preferredLoader) && stats.size <= BUFFERED_JAR_BYTES) {
      const handle = await fs.promises.open(filePath, "r");
      try {
        const buffer = Buffer.allocUnsafe(stats.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        signal?.throwIfAborted();
        if (bytesRead === buffer.length) archive = await yauzl.fromBufferPromise(buffer, options);
      } finally { await handle.close(); }
    }
    archive ??= await yauzl.openPromise(filePath, options);
  } catch {
    signal?.throwIfAborted();
    throw new Error("The selected file is not a readable Java archive");
  }
  try {
    signal?.throwIfAborted();
    if (archive.entryCount > 100000) throw new Error("The selected JAR contains an unsafe number of files");
    const files = new Map();
    const entries = new Map();
    const preferredSource = MOD_METADATA_FILES.get(preferredLoader);
    let parsed;
    for await (const entry of archive.eachEntry()) {
      signal?.throwIfAborted();
      if (makeIcon && /\.png$/i.test(entry.fileName)) entries.set(entry.fileName, entry);
      const name = entry.fileName.toLowerCase();
      if (JAR_METADATA_FILES.has(name)) {
        const data = await readJarEntry(archive, entry, MAX_METADATA_BYTES);
        if (data) files.set(name, data.toString("utf8"));
        else if (name !== "meta-inf/manifest.mf") throw new Error("The selected JAR contains oversized add-on metadata");
        if (preferredSource && files.has(preferredSource) && files.has("meta-inf/manifest.mf")) parsed = parseJarMetadata(filePath, files, preferredLoader);
      }
      if (parsed && (!makeIcon || (parsed.iconPaths || []).every((file) => entries.has(file)))) break;
    }
    const { iconPaths, ...metadata } = parsed || parseJarMetadata(filePath, files, preferredLoader);
    if (makeIcon && iconPaths?.length) {
      const icon = await embeddedJarIcon(archive, entries, iconPaths);
      if (icon) metadata.iconUrl = makeIcon(icon);
    }
    signal?.throwIfAborted();
    return metadata;
  } finally { archive.close(); }
}

function parseJarMetadata(filePath, files, preferredLoader) {
  const preferredSource = MOD_METADATA_FILES.get(preferredLoader);
  const modSource = files.has(preferredSource) ? preferredSource : [...MOD_METADATA_FILES.values()].find((source) => files.has(source));
  const manifest = (files.get("meta-inf/manifest.mf") || "").replace(/\r\n?/g, "\n").split("\n\n", 1)[0].replaceAll("\n ", "");
  const implementationVersion = manifestValue(manifest, "Implementation-Version");
  const result = {
    loader: "unknown",
    title: path.basename(filePath).replace(/\.jar(?:\.disabled)?$/i, ""),
    versionNumber: "Unknown",
    minecraftVersion: "",
    serverSide: "unknown",
    metadataSource: "none",
  };
  if (modSource === "fabric.mod.json") {
    let metadata;
    try {
      // Match Fabric's reader for BOMs and literal control characters in quoted strings.
      const text = files.get("fabric.mod.json").replace(/^\uFEFF/, "");
      const normalized = text.replace(/"(?:[^"\\]|\\[\s\S])*"/g, (quoted) =>
        quoted.replace(/\\[\s\S]|[\u0000-\u001f]/g, (value) =>
          value.length === 1 ? JSON.stringify(value).slice(1, -1) : value
        )
      );
      metadata = JSON.parse(normalized);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Expected a metadata object");
    } catch {
      throw new Error("The selected JAR contains invalid Fabric metadata");
    }
    result.loader = "fabric";
    result.modId = metadata.id;
    result.title = String(metadata.name || metadata.id || result.title);
    result.versionNumber = String(metadata.version || "Unknown");
    result.minecraftVersion = String(metadata.depends?.minecraft || "");
    result.javaDependency = metadata.depends?.java;
    result.iconPaths = jarIconPaths(metadata.icon);
    result.serverSide = metadata.environment === "client" ? "client" : "server";
    result.environment = metadata.environment === "client" ? "client_only"
      : metadata.environment === "server" ? "dedicated_server_only"
      : metadata.environment === "*" || metadata.environment === undefined ? "both_supported" : "";
    result.metadataSource = "fabric.mod.json";
  } else if (modSource === "quilt.mod.json") {
    const document = JSON.parse(files.get("quilt.mod.json").replace(/^\uFEFF/, ""));
    const metadata = document.quilt_loader;
    result.loader = "quilt";
    result.modId = metadata?.id;
    result.title = String(metadata?.metadata?.name || metadata?.id || result.title);
    result.versionNumber = String(metadata?.version || "Unknown");
    result.iconPaths = jarIconPaths(metadata?.metadata?.icon);
    const side = document.minecraft?.environment;
    if (side === "client") {
      result.serverSide = "client";
      result.environment = "client_only";
    } else if (side === "dedicated_server" || side === "*") {
      result.serverSide = "server";
      result.environment = side === "dedicated_server" ? "dedicated_server_only" : "both_supported";
    }
    result.javaDependency = Array.isArray(metadata?.depends) ? metadata.depends.find(item => item?.id === "java" && !item.optional)?.versions : undefined;
    result.metadataSource = "quilt.mod.json";
  } else if (modSource) {
    const metadata = forgeJarMetadata(files.get(modSource), implementationVersion);
    result.loader = modSource === "meta-inf/mods.toml" ? "forge" : "neoforge";
    result.modId = metadata.modId;
    result.title = metadata.title || result.title;
    result.versionNumber = metadata.versionNumber || result.versionNumber;
    result.minecraftVersion = metadata.minecraftVersion;
    result.iconPaths = metadata.iconPaths;
    result.metadataSource = modSource.replace("meta-inf/", "META-INF/");
  } else if (files.has("paper-plugin.yml") || files.has("plugin.yml")) {
    const source = files.has("paper-plugin.yml") ? "paper-plugin.yml" : "plugin.yml";
    const text = files.get(source);
    result.loader = "paper";
    result.title = yamlValue(text, "name") || result.title;
    result.versionNumber = yamlValue(text, "version") || "Unknown";
    result.minecraftVersion = yamlValue(text, "api-version");
    result.serverSide = "server";
    result.metadataSource = source;
  } else {
    const title = manifestValue(manifest, "Implementation-Title");
    if (title || implementationVersion) {
      result.title = title || result.title;
      result.versionNumber = implementationVersion || result.versionNumber;
      result.metadataSource = "META-INF/MANIFEST.MF";
    }
  }
  return result;
}

export function getAddonProfile(server) {
  const type = String(server?.type || "");
  if (type === "paper" || type === "purpur") return { supported: true, kind: "plugins", singular: "plugin", loader: "paper", directory: "plugins", projectType: "plugin" };
  if (["fabric", "forge", "neoforge", "quilt"].includes(type)) {
    return { supported: true, kind: "mods", singular: "mod", loader: type, directory: "mods", projectType: "mod" };
  }
  return { supported: false, kind: "add-ons", singular: "add-on", loader: "", directory: "", projectType: "" };
}

function lockPath(server) {
  return assertPathInside(server.folderPath, path.join(server.folderPath, "addons-lock.json"));
}

function addonDirectory(server) {
  const profile = getAddonProfile(server);
  if (!profile.supported) throw new Error("Vanilla servers do not support managed mods or plugins");
  return assertPathInside(server.folderPath, path.join(server.folderPath, profile.directory));
}

function loadLock(server) {
  const value = readJson(lockPath(server), null);
  if (!value || !Array.isArray(value.entries)) {
    return { schemaVersion: LOCK_VERSION, preferences: { releaseChannel: "stable" }, entries: [] };
  }
  return {
    schemaVersion: LOCK_VERSION,
    preferences: {
      releaseChannel: VALID_RELEASE_CHANNELS.has(value.preferences?.releaseChannel)
        ? value.preferences.releaseChannel
        : "stable",
    },
    entries: value.entries.filter((entry) => isStoredJarName(entry?.fileName)).map((entry) => ({
      ...entry,
      dependencies: Array.isArray(entry.dependencies)
        ? entry.dependencies
        : Array.isArray(entry.requiredBy) ? entry.requiredBy : [],
      optionalDependencies: Array.isArray(entry.optionalDependencies) ? entry.optionalDependencies : [],
      history: Array.isArray(entry.history) ? entry.history : [],
    })),
  };
}

function writeLock(server, lock) {
  atomicWriteFile(lockPath(server), `${JSON.stringify({
    schemaVersion: LOCK_VERSION,
    preferences: {
      releaseChannel: VALID_RELEASE_CHANNELS.has(lock.preferences?.releaseChannel)
        ? lock.preferences.releaseChannel
        : "stable",
    },
    entries: lock.entries,
  }, null, 2)}\n`);
}

function actualFileName(entry) {
  return entry.enabled === false ? `${entry.fileName}.disabled` : entry.fileName;
}

function dependencyKey(entry) {
  return entry.source === "curseforge" ? `curseforge:${entry.projectId}` : entry.projectId;
}

function compareAddonTitles(a, b) {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

function installedFiles(server) {
  const directory = addonDirectory(server);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (/\.jar$/i.test(entry.name) || /\.jar\.disabled$/i.test(entry.name)))
    .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }));
}

const installedJarCache = new Map();

function installedJar(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  let cached = installedJarCache.get(file);
  if (cached?.signature === signature) return cached;
  cached = { signature, inspections: new Map() };
  installedJarCache.delete(file);
  installedJarCache.set(file, cached);
  if (installedJarCache.size > 1500) installedJarCache.delete(installedJarCache.keys().next().value);
  return cached;
}

function installedSha512(file) {
  const cached = installedJar(file);
  if (!cached) return null;
  return cached.sha512 ??= hashFile(file);
}

export async function scanServerAddons(server) {
  if (!getAddonProfile(server).supported) return listServerAddons(server);
  const recorded = new Set(loadLock(server).entries.filter((entry) => entry.sha512 && ["modrinth", "curseforge"].includes(entry.source))
    .map((entry) => actualFileName(entry).toLowerCase()));
  const files = installedFiles(server).filter((file) => !recorded.has(file.name.toLowerCase()) && !installedJarCache.get(file.path)?.sha512);
  for (let offset = 0; offset < files.length; offset += JAR_INSPECTION_BATCH_SIZE) {
    await Promise.all(files.slice(offset, offset + JAR_INSPECTION_BATCH_SIZE).map(async ({ path: file }) => {
      const cached = installedJar(file);
      if (!cached || cached.sha512) return;
      const hash = crypto.createHash("sha512");
      try {
        for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      cached.sha512 = hash.digest("hex");
    }));
  }
  return listServerAddons(server);
}

export function addonReleaseChannel(server) {
  return loadLock(server).preferences.releaseChannel;
}

export function recordModpackInventory(folderPath, pack) {
  const server = { folderPath, type: pack.type, version: pack.version };
  const files = getAddonProfile(server).supported ? installedFiles(server) : [];
  atomicWriteFile(path.join(folderPath, "blockhost-modpack.json"), JSON.stringify({
    name: pack.name, version: pack.packVersion, minecraft: pack.version, loader: pack.type, loaderVersion: pack.loaderVersion,
    modFiles: files.map(file => file.name.replace(/\.disabled$/i, "")),
  }, null, 2));
}

function modpackInventory(server) {
  if (!server.modpack) return null;
  try {
    const file = path.join(server.folderPath, "blockhost-modpack.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifest.name !== server.modpack.name || manifest.version !== server.modpack.version || !Array.isArray(manifest.modFiles)) return null;
    return new Set(manifest.modFiles.filter(name => typeof name === "string").map(name => name.toLowerCase()));
  } catch {
    return null;
  }
}

export function listServerAddons(server) {
  const profile = getAddonProfile(server);
  if (!profile.supported) return { ...profile, items: [] };
  const files = installedFiles(server);
  const filesByName = new Map(files.map((file) => [file.name.toLowerCase(), file]));
  const lock = loadLock(server);
  const matched = new Set();
  const items = [];
  const inventory = modpackInventory(server);

  for (const entry of lock.entries) {
    const fileName = actualFileName(entry);
    const file = filesByName.get(fileName.toLowerCase());
    if (!file) continue;
    matched.add(file.path);
    const source = ["modrinth", "curseforge"].includes(entry.source) ? entry.source : "manual";
    const sha512 = source !== "manual" && entry.sha512 ? entry.sha512 : installedSha512(file.path);
    if (!sha512) continue;
    items.push({
      id: String(entry.id || `${entry.source || "manual"}:${entry.sha512 || entry.fileName}`),
      title: String(entry.title || entry.fileName),
      versionNumber: String(entry.versionNumber || "Unknown"),
      fileName: entry.fileName,
      fromModpack: Boolean(inventory && [entry.fileName, ...(entry.history || []).map(version => version.fileName)]
        .some(name => typeof name === "string" && inventory.has(name.toLowerCase()))),
      enabled: entry.enabled !== false,
      source,
      projectId: entry.projectId || null,
      versionId: entry.versionId || null,
      environment: profile.kind === "plugins" ? "server_only" : declaredModEnvironment(entry),
      sha512,
      managed: true,
      loader: entry.loader || (source === "manual" ? "unknown" : profile.loader),
      minecraftVersion: entry.minecraftVersion || (source === "manual" ? "" : server.version),
      dependencies: Array.isArray(entry.dependencies) ? entry.dependencies : [],
      optionalDependencies: Array.isArray(entry.optionalDependencies) ? entry.optionalDependencies : [],
      history: Array.isArray(entry.history) ? entry.history : [],
      warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
      iconUrl: normalizeModrinthIconUrl(entry.iconUrl),
    });
  }

  for (const file of files) {
    if (matched.has(file.path)) continue;
    const enabled = !file.name.toLowerCase().endsWith(".disabled");
    const fileName = enabled ? file.name : file.name.slice(0, -".disabled".length);
    const sha512 = installedSha512(file.path);
    if (!sha512) continue;
    items.push({
      id: `manual:${sha512}`,
      title: fileName.replace(/\.jar$/i, ""),
      versionNumber: "Unknown",
      fileName,
      fromModpack: inventory?.has(fileName.toLowerCase()) || false,
      enabled,
      source: "manual",
      projectId: null,
      versionId: null,
      environment: profile.kind === "plugins" ? "server_only" : "",
      sha512,
      managed: false,
      loader: "unknown",
      minecraftVersion: "",
      dependencies: [],
      optionalDependencies: [],
      history: [],
      warnings: [],
      iconUrl: "",
    });
  }

  const projectIds = new Set(items.filter((item) => item.projectId).map(dependencyKey));
  const dependentsByProject = new Map();
  const itemOrder = new Map(items.map((item, index) => [item, index]));
  for (const item of items) {
    for (const dependency of new Set(item.dependencies)) {
      if (!dependentsByProject.has(dependency)) dependentsByProject.set(dependency, []);
      dependentsByProject.get(dependency).push(item);
    }
  }
  for (const item of items) {
    const dependents = dependentsByProject.get(dependencyKey(item)) || [];
    item.dependents = dependents
      .map((candidate) => ({ id: candidate.id, title: candidate.title }));
    const cascade = new Set([item]);
    for (const current of cascade) {
      if (!current.projectId) continue;
      for (const candidate of dependentsByProject.get(dependencyKey(current)) || []) {
        cascade.add(candidate);
      }
    }
    item.removalDependents = [...cascade].filter((candidate) => candidate.id !== item.id)
      .sort((a, b) => itemOrder.get(a) - itemOrder.get(b))
      .map((candidate) => ({ id: candidate.id, title: candidate.title }));
    item.missingDependencies = item.dependencies.filter((projectId) => !projectIds.has(projectId));
  }
  items.sort(compareAddonTitles);
  return { ...profile, releaseChannel: lock.preferences.releaseChannel, packInventoryKnown: inventory !== null, items };
}

function matchesBundledDependencyVersion(requirement, version) {
  if (typeof requirement !== "string" || version === "Unknown") return false;
  const range = requirement.trim();
  if (range === "*" || range === "any version") return true;
  const exact = /^(?:version )?=?([a-z0-9.+_-]+)$/i.exec(range)?.[1] || /^\[([a-z0-9.+_-]+)\]$/i.exec(range)?.[1];
  return exact === version;
}

export async function findBundledPackDependency(server, listing) {
  const setup = server.modpackSetup;
  const requirements = setup?.diagnosis?.requirements;
  if (setup?.status !== "repair" || setup.diagnosis?.kind !== "dependency" || !Array.isArray(requirements)) return null;
  const missing = requirements.filter(requirement => requirement?.kind === "missing" && typeof requirement.modId === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(requirement.modId));
  const modId = missing[0]?.modId;
  if (!modId || missing.some(requirement => requirement.modId !== modId)) return null;
  const profile = getAddonProfile(server);
  const inventory = modpackInventory(server);
  if (profile.kind !== "mods" || !inventory || !fs.lstatSync(addonDirectory(server), { throwIfNoEntry: false })?.isDirectory()) return null;
  const files = installedFiles(server).filter(file => /\.jar\.disabled$/i.test(file.name) && inventory.has(file.name.slice(0, -".disabled".length).toLowerCase()));
  let match;
  for (let offset = 0; offset < files.length; offset += JAR_INSPECTION_BATCH_SIZE) {
    const candidates = await Promise.all(files.slice(offset, offset + JAR_INSPECTION_BATCH_SIZE).map(async file => {
      const metadata = await inspectAddonJar(file.path, profile.loader).catch(() => null);
      if (metadata?.loader !== profile.loader || metadata.modId !== modId) return null;
      if (metadata.environment === "client_only" && profile.loader !== "fabric") return null;
      if (!missing.every(requirement => matchesBundledDependencyVersion(requirement.version, metadata.versionNumber))) return null;
      return { fileName: file.name, name: metadata.title.trim().slice(0, 100) || modId };
    }));
    for (const candidate of candidates.filter(Boolean)) {
      if (match) return null;
      match = candidate;
    }
  }
  if (!match) return null;
  const { items } = listing || listServerAddons(server);
  const item = items.find(item => !item.enabled && actualFileName(item) === match.fileName);
  if (!item || items.some(other => other !== item && other.id === item.id)) return null;
  return { id: item.id, modId, name: match.name };
}

const pngDataUrl = (png) => `data:image/png;base64,${png.toString("base64")}`;

export async function describeLocalInstalledAddons(server, listing = listServerAddons(server), makeIcon = pngDataUrl) {
  if (!listing.supported) return listing;
  const files = new Map(installedFiles(server).map((file) => [file.name.toLowerCase(), file.path]));
  for (let offset = 0; offset < listing.items.length; offset += JAR_INSPECTION_BATCH_SIZE) {
    await Promise.all(listing.items.slice(offset, offset + JAR_INSPECTION_BATCH_SIZE).map(async (item) => {
      const file = files.get(actualFileName(item).toLowerCase());
      if (!file) return;
      const manual = item.source === "manual";
      if (!manual && item.environment && item.iconUrl) return;
      const loader = listing.loader;
      const cached = installedJar(file);
      if (!cached) return;
      if (!cached.inspections.has(loader)) cached.inspections.set(loader, inspectAddonJar(file, loader, makeIcon).catch(() => null));
      const metadata = await cached.inspections.get(loader);
      if (!metadata) return;
      if (manual && metadata.metadataSource !== "none") {
        item.title = metadata.title;
        item.versionNumber = metadata.versionNumber;
        if (metadata.loader !== "unknown") item.loader = metadata.loader;
        item.minecraftVersion = metadata.minecraftVersion || item.minecraftVersion;
      }
      item.environment ||= metadata.environment || "";
      item.iconUrl ||= metadata.iconUrl || "";
    }));
  }
  listing.items.sort(compareAddonTitles);
  const bundledDependency = await findBundledPackDependency(server, listing).catch(() => null);
  if (bundledDependency) listing.bundledDependency = { modId: bundledDependency.modId, name: bundledDependency.name };
  return listing;
}

const catalogueCache = { modrinthHashes: new Map(), modrinthVersions: new Map(), modrinthProjects: new Map() };
const CATALOGUE_BATCH_SIZE = 40;

async function catalogueRecords(cache, keys, load) {
  const records = new Map();
  const pending = [];
  for (const key of new Set(keys)) {
    const cached = cache.get(key);
    if (cached?.expires > Date.now()) {
      if (cached.value) records.set(key, cached.value);
    } else pending.push(key);
  }
  for (let offset = 0; offset < pending.length; offset += CATALOGUE_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + CATALOGUE_BATCH_SIZE);
    let fresh;
    try { fresh = await load(batch); } catch { break; }
    for (const key of batch) {
      const value = fresh.get(key);
      if (value) records.set(key, value);
      cache.delete(key);
      cache.set(key, { value, expires: Date.now() + (value ? 24 * 60 : 5) * 60 * 1000 });
      if (cache.size > 4000) cache.delete(cache.keys().next().value);
    }
  }
  return records;
}

async function modrinthCatalogueRecords(route, ids, cache, fetchImpl) {
  return catalogueRecords(cache, ids, async (batch) => {
    const params = new URLSearchParams({ ids: JSON.stringify(batch) });
    const data = await modrinthJson(`/${route}?${params}`, { signal: AbortSignal.timeout(3500) }, fetchImpl);
    return new Map(data.filter((item) => batch.includes(item?.id)).map((item) => [item.id, item]));
  });
}

function cataloguePatch(item, match, server) {
  const manual = item.source === "manual";
  const loaders = Array.isArray(match.loaders) ? match.loaders : [];
  const versions = Array.isArray(match.gameVersions) ? match.gameVersions : [];
  return {
    id: item.id, fileName: item.fileName, enabled: item.enabled, sha512: item.sha512,
    catalogue: { source: match.source, projectId: match.projectId, versionId: match.versionId },
    title: manual && typeof match.title === "string" ? match.title.slice(0, 200) : "",
    versionNumber: typeof match.versionNumber === "string" ? match.versionNumber.slice(0, 180) : "",
    loader: loaders.includes(server.type) ? server.type : loaders.length === 1 ? String(loaders[0]) : "",
    minecraftVersion: versions.includes(server.version) ? server.version : versions.length === 1 ? String(versions[0]) : "",
    environment: match.environment || "",
    iconUrl: match.iconUrl || "",
  };
}

export async function identifyInstalledAddons(server, listing = listServerAddons(server), { fetchImpl = fetch } = {}) {
  if (!listing.supported) return [];
  const manual = listing.items.filter((item) => item.source === "manual" && /^[a-f0-9]{128}$/.test(item.sha512));
  const modrinth = listing.items.filter((item) => item.source === "modrinth" && item.projectId && (!item.environment || !item.iconUrl));
  const [hashes, versions] = await Promise.all([
    catalogueRecords(catalogueCache.modrinthHashes, manual.map((item) => item.sha512), async (batch) => {
      const data = await modrinthJson("/version_files", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: batch, algorithm: "sha512" }), signal: AbortSignal.timeout(3500),
      }, fetchImpl);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Modrinth file matches");
      return new Map(batch.filter((hash) => data[hash]?.id && data[hash].project_id &&
        data[hash].files?.some((file) => file?.hashes?.sha512?.toLowerCase() === hash)).map((hash) => [hash, data[hash]]));
    }),
    modrinthCatalogueRecords("versions", modrinth.filter((item) => item.versionId && !item.environment).map((item) => item.versionId), catalogueCache.modrinthVersions, fetchImpl),
  ]);

  const projectsToLoad = modrinth.filter((item) => !item.iconUrl || !declaredModEnvironment(versions.get(item.versionId))).map((item) => item.projectId);
  projectsToLoad.push(...[...hashes.values()].map((version) => version.project_id));
  const projects = await modrinthCatalogueRecords("projects", projectsToLoad, catalogueCache.modrinthProjects, fetchImpl);
  const patches = [];
  for (const item of listing.items) {
    if (item.source === "curseforge") continue;
    const version = item.source === "manual" ? hashes.get(item.sha512) : versions.get(item.versionId);
    const projectId = item.projectId || version?.project_id;
    const project = projects.get(projectId);
    if (projectId && (project || version?.project_id === projectId)) {
      const release = version?.project_id === projectId ? version : null;
      patches.push(cataloguePatch(item, { source: "modrinth", projectId, versionId: item.versionId || release?.id,
        title: project?.title, iconUrl: normalizeModrinthIconUrl(project?.icon_url), versionNumber: release?.version_number,
        environment: declaredModEnvironment(release) || declaredModEnvironment(project),
        gameVersions: release?.game_versions, loaders: release?.loaders }, server));
    }
  }
  return patches;
}

async function modrinthJson(route, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${MODRINTH_API}${route}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(12000),
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...options.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 410) throw new Error("The add-on service API has changed. Update BlockHost Manager before trying again.");
    if (response.status === 429) throw new Error("The add-on service is temporarily rate-limited. Try again in a minute.");
    throw new Error(`The add-on service returned HTTP ${response.status}`);
  }
  return response.json();
}

function serverEnvironmentFacets() {
  return [
    "environment:server_only",
    "environment:server_only_client_optional",
    "environment:dedicated_server_only",
    "environment:client_and_server",
    "environment:client_or_server",
    "environment:client_or_server_prefers_both",
  ];
}

function recommendedServerEnvironmentFacets() {
  return [
    "environment:server_only",
    "environment:server_only_client_optional",
    "environment:dedicated_server_only",
  ];
}

function normalizeModrinthIconUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname === "cdn.modrinth.com" ? url.toString() : "";
  } catch {
    return "";
  }
}

async function findCompatibleAddons(server, query, fetchImpl, { recommendations = false, category = "all", sort = "relevance" } = {}) {
  const profile = getAddonProfile(server);
  if (!profile.supported) return { ...profile, query: "", results: [] };
  const search = String(query || "").trim().slice(0, 100);
  const typeFacet = profile.projectType === "plugin" ? "all_project_types:plugin" : "project_type:mod";
  const facets = [
    [typeFacet],
    [`categories:${profile.loader}`],
    [`versions:${server.version}`],
    recommendations ? recommendedServerEnvironmentFacets() : serverEnvironmentFacets(),
  ];
  const categoryFacets = ADDON_CATEGORY_FACETS.get(String(category));
  if (categoryFacets) facets.push(categoryFacets);
  const requestedSort = ADDON_SORTS.has(sort) ? sort : "relevance";
  const index = recommendations ? "downloads" : (!search && requestedSort === "relevance" ? "downloads" : requestedSort);
  const params = new URLSearchParams({
    facets: JSON.stringify(facets),
    index,
    limit: recommendations ? "16" : "20",
  });
  if (search) params.set("query", search);
  const data = await modrinthJson(`/search?${params}`, {}, fetchImpl);
  const hits = data.hits || [];
  let verifiedVersions = new Map();
  if (recommendations && hits.length) {
    const releaseChannel = loadLock(server).preferences.releaseChannel;
    const pending = [...hits];
    const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
      const verified = [];
      while (pending.length) {
        const hit = pending.shift();
        try {
          const version = await projectVersion(hit.project_id, server, profile, fetchImpl, releaseChannel, { optional: true });
          if (version) {
            await resolveInstallSet(server, {
              projectId: String(hit.project_id),
              title: String(hit.title || hit.slug || "Recommended add-on"),
              versionId: String(version.id),
              verifiedVersion: version,
            }, fetchImpl);
            verified.push([String(hit.project_id), version]);
          }
        } catch (error) {
          verified.push([String(hit.project_id), { preflightError: error }]);
        }
      }
      return verified;
    });
    const checked = (await Promise.all(workers)).flat();
    const failures = checked.filter(([, version]) => version?.preflightError);
    const compatible = checked.filter(([, version]) => version && !version.preflightError);
    if (!compatible.length && failures.length === hits.length) throw failures[0][1].preflightError;
    verifiedVersions = new Map(compatible);
  }
  return {
    ...profile,
    query: search,
    category: categoryFacets ? String(category) : "all",
    sort: index,
    results: hits.filter((hit) => !recommendations || verifiedVersions.has(String(hit.project_id))).map((hit) => ({
      projectId: String(hit.project_id),
      versionId: String(verifiedVersions.get(String(hit.project_id))?.id || ""),
      versionNumber: String(verifiedVersions.get(String(hit.project_id))?.version_number || ""),
      title: String(hit.title || hit.slug || "Unnamed add-on"),
      description: String(hit.description || ""),
      author: String(hit.author || ""),
      downloads: Number(hit.downloads) || 0,
      iconUrl: normalizeModrinthIconUrl(hit.icon_url),
      environment: declaredModEnvironment(verifiedVersions.get(String(hit.project_id))) || declaredModEnvironment(hit),
    })),
  };
}

export function searchCompatibleAddons(server, query, optionsOrFetch = {}, fetchImpl = fetch) {
  const options = typeof optionsOrFetch === "function" ? {} : optionsOrFetch;
  const requester = typeof optionsOrFetch === "function" ? optionsOrFetch : fetchImpl;
  return findCompatibleAddons(server, query, requester, options);
}

export function recommendCompatibleAddons(server, fetchImpl = fetch) {
  return findCompatibleAddons(server, "", fetchImpl, { recommendations: true });
}

function compatibleVersion(version, server, profile) {
  return Array.isArray(version?.game_versions)
    && version.game_versions.includes(String(server.version))
    && Array.isArray(version.loaders)
    && version.loaders.includes(profile.loader)
    && ["listed", "unlisted", undefined].includes(version.status);
}

function chooseVersion(versions, server, profile, releaseChannel = "stable") {
  const compatible = versions.filter((version) => compatibleVersion(version, server, profile));
  const allowed = releaseChannel === "alpha"
    ? ["release", "beta", "alpha"]
    : releaseChannel === "beta" ? ["release", "beta"] : ["release"];
  for (const type of allowed) {
    const match = compatible.find((version) => version.version_type === type);
    if (match) return match;
  }
  return null;
}

async function projectVersion(projectId, server, profile, fetchImpl, releaseChannel = loadLock(server).preferences.releaseChannel, options = {}) {
  const params = new URLSearchParams({
    loaders: JSON.stringify([profile.loader]),
    game_versions: JSON.stringify([String(server.version)]),
    include_changelog: "false",
  });
  const versions = await modrinthJson(`/project/${encodeURIComponent(projectId)}/version?${params}`, {}, fetchImpl);
  const version = chooseVersion(versions, server, profile, releaseChannel);
  if (!version && options.optional) return null;
  if (!version) throw new Error(`No compatible ${releaseChannel} ${profile.singular} release is available for Minecraft ${server.version}`);
  return version;
}

function selectVersionFile(version) {
  const jars = (version.files || []).filter((file) => /\.jar$/i.test(file.filename || "") && !/(sources|javadoc|dev)\.jar$/i.test(file.filename || ""));
  const file = jars.find((candidate) => candidate.primary) || jars[0];
  if (!file) throw new Error(`Version ${version.version_number || version.id} has no installable JAR`);
  const url = new URL(file.url);
  if (url.protocol !== "https:" || url.hostname !== MODRINTH_DOWNLOAD_HOST) {
    throw new Error("The add-on service returned an untrusted download URL");
  }
  const size = Number(file.size) || 0;
  if (size <= 0 || size > MAX_ADDON_BYTES) throw new Error("The add-on file has an invalid or unsafe size");
  return { ...file, filename: safeFileName(file.filename), size };
}

async function resolveInstallSet(server, requested, fetchImpl) {
  const profile = getAddonProfile(server);
  const installed = loadLock(server);
  const resolved = [];
  const resolving = new Set();
  const completed = new Set();

  async function resolveVersion(version, title = "Required dependency") {
    if (!compatibleVersion(version, server, profile)) {
      throw new Error(`${title} does not support ${profile.loader} on Minecraft ${server.version}`);
    }
    if (completed.has(version.id)) return;
    if (resolving.has(version.id)) return;
    resolving.add(version.id);

    for (const dependency of version.dependencies || []) {
      if (dependency.dependency_type === "incompatible") {
        const conflict = installed.entries.find((entry) => entry.projectId && dependencyKey(entry) === dependency.project_id);
        if (conflict) throw new Error(`${title} is incompatible with installed add-on ${conflict.title || conflict.fileName}`);
        continue;
      }
      if (dependency.dependency_type !== "required") continue;
      let dependencyVersion;
      if (dependency.version_id) {
        dependencyVersion = await modrinthJson(`/version/${encodeURIComponent(dependency.version_id)}`, {}, fetchImpl);
      } else if (dependency.project_id) {
        dependencyVersion = await projectVersion(dependency.project_id, server, profile, fetchImpl);
      } else {
        throw new Error(`${title} requires ${dependency.file_name || "an external dependency"} that cannot be installed automatically`);
      }
      await resolveVersion(dependencyVersion, dependency.file_name || "Required dependency");
    }

    resolving.delete(version.id);
    completed.add(version.id);
    resolved.push({
      projectId: String(version.project_id),
      versionId: String(version.id),
      versionNumber: String(version.version_number || version.name || "Unknown"),
      environment: declaredModEnvironment(version),
      title,
      file: selectVersionFile(version),
      dependencies: (version.dependencies || [])
        .filter((dependency) => dependency.dependency_type === "required")
        .map((dependency) => dependency.project_id || dependency.version_id || dependency.file_name)
        .filter(Boolean),
      optionalDependencies: (version.dependencies || [])
        .filter((dependency) => dependency.dependency_type === "optional")
        .map((dependency) => dependency.project_id || dependency.version_id || dependency.file_name)
        .filter(Boolean),
    });
  }

  const releaseChannel = installed.preferences.releaseChannel;
  let rootVersion;
  if (requested.verifiedVersion) {
    rootVersion = requested.verifiedVersion;
  } else if (requested.versionId) {
    rootVersion = await modrinthJson(`/version/${encodeURIComponent(requested.versionId)}`, {}, fetchImpl);
    if (!compatibleVersion(rootVersion, server, profile) || !chooseVersion([rootVersion], server, profile, releaseChannel)) {
      throw new Error(`The recommended ${profile.singular} release is no longer compatible with ${profile.loader} on Minecraft ${server.version}`);
    }
  } else {
    rootVersion = await projectVersion(requested.projectId, server, profile, fetchImpl, releaseChannel);
  }
  await resolveVersion(rootVersion, String(requested.title || "Selected add-on"));
  return resolved.map((item) => ({
    ...item,
    iconUrl: item.projectId === String(requested.projectId)
      ? normalizeModrinthIconUrl(requested.iconUrl)
      : "",
  }));
}

async function downloadVerified(item, destination, fetchImpl) {
  const response = await fetchImpl(item.file.url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok || !response.body) throw new Error(`Could not download ${item.title} (HTTP ${response.status})`);
  const expectedLength = Number(response.headers.get("content-length") || 0);
  if (expectedLength && expectedLength !== item.file.size) throw new Error(`${item.title} download size did not match its manifest`);
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > item.file.size) return callback(new Error(`${item.title} exceeds its declared download size`));
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination, { flags: "wx" }));
  const stats = validateJar(destination);
  if (stats.size !== item.file.size) throw new Error(`${item.title} download was incomplete`);
  const expectedSha512 = item.file.hashes?.sha512;
  const expectedSha1 = item.file.hashes?.sha1;
  if (expectedSha512 && hashFile(destination, "sha512") !== expectedSha512.toLowerCase()) {
    throw new Error(`${item.title} failed SHA-512 verification`);
  }
  if (!expectedSha512 && expectedSha1 && hashFile(destination, "sha1") !== expectedSha1.toLowerCase()) {
    throw new Error(`${item.title} failed SHA-1 verification`);
  }
  if (!expectedSha512 && !expectedSha1) throw new Error(`${item.title} did not provide a verifiable file hash`);
  return hashFile(destination, "sha512");
}

function beginTransaction(server) {
  const id = crypto.randomUUID();
  const stagingDir = assertPathInside(server.folderPath, path.join(server.folderPath, ".blockhost-addon-staging", id));
  const backupDir = assertPathInside(server.folderPath, path.join(server.folderPath, ".blockhost-addon-backup", id));
  const file = lockPath(server);
  const transaction = {
    server,
    id,
    stagingDir,
    backupDir,
    journalPath: assertPathInside(server.folderPath, path.join(server.folderPath, `.blockhost-addon-journal-${id}.json`)),
    previousLockExisted: fs.existsSync(file),
    previousLockText: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "",
    newFiles: [],
    backups: [],
    renames: [],
  };
  persistTransaction(transaction);
  return transaction;
}

function persistTransaction(transaction) {
  if (!transaction?.journalPath || transaction.children) return;
  atomicWriteFile(transaction.journalPath, `${JSON.stringify({
    id: transaction.id,
    stagingDir: transaction.stagingDir,
    backupDir: transaction.backupDir,
    journalPath: transaction.journalPath,
    previousLockExisted: transaction.previousLockExisted,
    previousLockText: transaction.previousLockText,
    newFiles: transaction.newFiles,
    backups: transaction.backups,
    renames: transaction.renames,
  }, null, 2)}\n`);
}

function backupFile(transaction, original) {
  if (!fs.existsSync(original)) return;
  fs.mkdirSync(transaction.backupDir, { recursive: true });
  const backup = path.join(transaction.backupDir, `${transaction.backups.length}-${path.basename(original)}`);
  fs.renameSync(original, backup);
  transaction.backups.push({ original, backup });
  persistTransaction(transaction);
}

function recordNewFile(transaction, filePath) {
  transaction.newFiles.push(filePath);
  persistTransaction(transaction);
}

function recordRename(transaction, from, to) {
  transaction.renames.push({ from, to });
  persistTransaction(transaction);
}

function removeTransactionDirectories(transaction) {
  for (const directory of [transaction.stagingDir, transaction.backupDir]) {
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    const parent = path.dirname(directory);
    try {
      fs.rmdirSync(parent);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
    }
  }
}

export function rollbackAddonTransaction(transaction) {
  if (!transaction) return;
  if (Array.isArray(transaction.children)) {
    for (const child of [...transaction.children].reverse()) rollbackAddonTransaction(child);
    return;
  }
  for (const rename of [...transaction.renames].reverse()) {
    if (fs.existsSync(rename.to) && !fs.existsSync(rename.from)) fs.renameSync(rename.to, rename.from);
  }
  for (const file of transaction.newFiles) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
  for (const item of [...transaction.backups].reverse()) {
    if (fs.existsSync(item.original)) fs.rmSync(item.original, { force: true });
    if (fs.existsSync(item.backup)) {
      fs.mkdirSync(path.dirname(item.original), { recursive: true });
      fs.renameSync(item.backup, item.original);
    }
  }
  const file = lockPath(transaction.server);
  if (transaction.previousLockExisted) atomicWriteFile(file, transaction.previousLockText);
  else if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  removeTransactionDirectories(transaction);
  if (transaction.journalPath && fs.existsSync(transaction.journalPath)) fs.rmSync(transaction.journalPath, { force: true });
}

export function commitAddonTransaction(transaction) {
  if (!transaction) return;
  if (Array.isArray(transaction.children)) {
    transaction.children.forEach(commitAddonTransaction);
    return;
  }
  removeTransactionDirectories(transaction);
  if (transaction.journalPath && fs.existsSync(transaction.journalPath)) fs.rmSync(transaction.journalPath, { force: true });
}

export function discardImportedAddonJournals(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!ADDON_JOURNAL.test(entry.name)) continue;
    if (!entry.isFile()) throw new Error("The archive contains invalid add-on recovery state.");
    fs.rmSync(assertPathInside(folder, path.join(folder, entry.name)), { force: true });
  }
}

function recoveryPath(root, candidate, directories) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)
    || !directories.some(directory => isPathInside(directory, candidate))) {
    throw new Error("Invalid add-on recovery path");
  }
  let resolved = assertPathInside(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.includes(":")) throw new Error("Invalid add-on recovery path");
  while (path.relative(root, resolved)) {
    if (fs.lstatSync(resolved, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Invalid add-on recovery link");
    resolved = path.dirname(resolved);
  }
  return path.resolve(candidate);
}

function recoverAddonTransaction(folder, name, value) {
  const id = name.match(ADDON_JOURNAL)?.[1];
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || value.id !== id
    || typeof value.previousLockExisted !== "boolean" || typeof value.previousLockText !== "string"
    || !Array.isArray(value.newFiles) || !Array.isArray(value.renames) || !Array.isArray(value.backups)) {
    throw new Error("Invalid add-on recovery journal");
  }
  const stagingRoot = path.join(folder, ".blockhost-addon-staging");
  const backupRoot = path.join(folder, ".blockhost-addon-backup");
  const stagingDir = recoveryPath(folder, path.join(stagingRoot, id), [stagingRoot]);
  const backupDir = recoveryPath(folder, path.join(backupRoot, id), [backupRoot]);
  const addons = ["mods", "plugins"].map(directory => path.join(folder, directory));
  const writable = [...addons, path.join(folder, ADDON_HISTORY_DIRECTORY)];
  return {
    server: { folderPath: folder }, journalPath: path.join(folder, name), stagingDir, backupDir,
    previousLockExisted: value.previousLockExisted, previousLockText: value.previousLockText,
    newFiles: value.newFiles.map(file => recoveryPath(folder, file, writable)),
    renames: value.renames.map(item => ({
      from: recoveryPath(folder, item?.from, addons), to: recoveryPath(folder, item?.to, addons),
    })),
    backups: value.backups.map(item => ({
      original: recoveryPath(folder, item?.original, addons), backup: recoveryPath(folder, item?.backup, [backupDir]),
    })),
  };
}

export function cleanupAbandonedAddonTransactions(serversRoot) {
  if (!fs.existsSync(serversRoot)) return [];
  const recovered = [];
  for (const directory of fs.readdirSync(serversRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const serverFolder = path.resolve(serversRoot, directory.name);
    for (const name of fs.readdirSync(serverFolder).filter((entry) => ADDON_JOURNAL.test(entry))) {
      const journalPath = path.join(serverFolder, name);
      try {
        const stat = fs.lstatSync(journalPath);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) continue;
        const value = readJson(journalPath, null);
        if (!value) continue;
        rollbackAddonTransaction(recoverAddonTransaction(serverFolder, name, value));
        recovered.push(serverFolder);
      } catch {
        // Preserve the journal and backups so a future launch can retry recovery.
      }
    }
    for (const temporaryName of [".blockhost-addon-staging"]) {
      const temporary = path.join(serverFolder, temporaryName);
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return recovered;
}

export async function installModrinthAddon(server, requested, fetchImpl = fetch) {
  if (!getAddonProfile(server).supported) throw new Error("This server type does not support managed add-ons");
  if (!requested?.projectId) throw new Error("No add-on project was selected");
  return stageAddonInstall(server, await resolveInstallSet(server, requested, fetchImpl), fetchImpl);
}

async function stageAddonInstall(server, installSet, fetchImpl) {
  const profile = getAddonProfile(server);
  if (installSet.reduce((sum, item) => sum + item.file.size, 0) > MAX_INSTALL_BYTES) {
    throw new Error("The selected add-on and its dependencies exceed the 2 GB installation limit");
  }
  const transaction = beginTransaction(server);
  const directory = addonDirectory(server);
  const lock = loadLock(server);

  try {
    fs.mkdirSync(transaction.stagingDir, { recursive: true });
    const staged = [];
    for (const item of installSet) {
      const file = { ...item.file, filename: safeFileName(item.file.filename) };
      const temporary = path.join(transaction.stagingDir, file.filename);
      const sha512 = await downloadVerified(item, temporary, fetchImpl);
      staged.push({ ...item, file, temporary, sha512 });
    }

    fs.mkdirSync(directory, { recursive: true });
    const replacingProjects = new Set(staged.map((item) => item.projectId));
    const replaces = (item) => item.source === "modrinth" && replacingProjects.has(item.projectId);
    const existingItems = listServerAddons(server).items;
    for (const item of staged) {
      const duplicate = existingItems.find((candidate) =>
        candidate.sha512 === item.sha512 && !replaces(candidate)
      );
      if (duplicate) throw new Error(`${item.title} is already installed as ${duplicate.fileName}`);
    }
    const historyByProject = new Map();
    for (const entry of lock.entries.filter(replaces)) {
      const currentPath = path.join(directory, actualFileName(entry));
      if (fs.existsSync(currentPath)) {
        const historyDirectory = assertPathInside(server.folderPath, path.join(server.folderPath, ADDON_HISTORY_DIRECTORY, safeFileName(`${entry.projectId}.jar`).replace(/\.jar$/i, "")));
        fs.mkdirSync(historyDirectory, { recursive: true });
        const historyName = safeFileName(`${entry.versionId || entry.sha512 || Date.now()}--${entry.fileName}`);
        const historyPath = path.join(historyDirectory, historyName);
        if (!fs.existsSync(historyPath)) {
          fs.copyFileSync(currentPath, historyPath, fs.constants.COPYFILE_EXCL);
          recordNewFile(transaction, historyPath);
        }
        historyByProject.set(entry.projectId, [
          ...(Array.isArray(entry.history) ? entry.history : []),
          {
            versionId: entry.versionId || null,
            versionNumber: entry.versionNumber || "Unknown",
            environment: entry.environment || "",
            fileName: entry.fileName,
            sha512: entry.sha512 || hashFile(currentPath),
            archivePath: path.relative(server.folderPath, historyPath).replaceAll("\\", "/"),
            archivedAt: new Date().toISOString(),
          },
        ].slice(-10));
      }
      backupFile(transaction, currentPath);
    }

    for (const item of staged) {
      const destination = path.join(directory, item.file.filename);
      const collision = fs.existsSync(destination);
      if (collision) {
        const existingEntry = lock.entries.find((entry) => actualFileName(entry).toLowerCase() === item.file.filename.toLowerCase());
        if (!existingEntry || !replaces(existingEntry)) {
          throw new Error(`${item.file.filename} is already installed by another add-on`);
        }
        backupFile(transaction, destination);
      }
      fs.renameSync(item.temporary, destination);
      recordNewFile(transaction, destination);
    }

    const nextEntries = lock.entries.filter((entry) => !replaces(entry));
    for (const item of staged) {
      nextEntries.push({
        id: `modrinth:${item.projectId}`,
        source: "modrinth",
        projectId: item.projectId,
        versionId: item.versionId,
        versionNumber: item.versionNumber,
        environment: item.environment,
        title: item.title === "Required dependency" ? item.file.filename.replace(/\.jar$/i, "") : item.title,
        fileName: item.file.filename,
        sha512: item.sha512,
        enabled: true,
        loader: profile.loader,
        minecraftVersion: String(server.version),
        sourceUrl: item.file.url,
        dependencies: item.dependencies,
        optionalDependencies: item.optionalDependencies,
        iconUrl: item.iconUrl,
        history: historyByProject.get(item.projectId) || [],
        installedAt: new Date().toISOString(),
      });
    }
    writeLock(server, { schemaVersion: LOCK_VERSION, entries: nextEntries });
    return { transaction, installed: staged.length, addons: listServerAddons(server) };
  } catch (error) {
    rollbackAddonTransaction(transaction);
    throw error;
  }
}

export async function installManualAddon(server, sourcePath) {
  const profile = getAddonProfile(server);
  if (!profile.supported) throw new Error("This server type does not support managed add-ons");
  if (!sourcePath || path.extname(sourcePath).toLowerCase() !== ".jar") throw new Error("Select a .jar add-on file");
  validateJar(sourcePath);
  const metadata = await inspectAddonJar(sourcePath);
  if (metadata.serverSide === "client") throw new Error("This is a client-only mod and cannot be installed on a dedicated server");
  if (metadata.loader !== "unknown" && metadata.loader !== profile.loader) {
    throw new Error(`This JAR targets ${metadata.loader}, but this server uses ${profile.loader}`);
  }
  const fileName = safeFileName(path.basename(sourcePath));
  const sha512 = hashFile(sourcePath);
  const transaction = beginTransaction(server);
  const directory = addonDirectory(server);
  const destination = path.join(directory, fileName);
  const lock = loadLock(server);
  const duplicate = listServerAddons(server).items.find((item) => item.sha512 === sha512);
  if (duplicate) throw new Error(`This exact JAR is already installed as ${duplicate.fileName}`);
  const warnings = [];
  if (metadata.loader === "unknown") warnings.push("No recognized loader metadata was found; compatibility could not be confirmed.");
  if (metadata.minecraftVersion && /^\d+\.\d+(?:\.\d+)?$/.test(metadata.minecraftVersion) && metadata.minecraftVersion !== String(server.version)) {
    warnings.push(`The JAR declares Minecraft ${metadata.minecraftVersion}, while this server uses ${server.version}.`);
  }

  try {
    if (fs.existsSync(destination)) throw new Error(`${fileName} is already installed`);
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(transaction.stagingDir, { recursive: true });
    const temporary = path.join(transaction.stagingDir, fileName);
    fs.copyFileSync(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
    validateJar(temporary);
    if (hashFile(temporary) !== sha512) throw new Error("The selected JAR changed while it was being copied");
    fs.renameSync(temporary, destination);
    recordNewFile(transaction, destination);
    lock.entries.push({
      id: `manual:${sha512}`,
      source: "manual",
      projectId: null,
      versionId: null,
      versionNumber: metadata.versionNumber,
      title: metadata.title,
      fileName,
      sha512,
      enabled: true,
      loader: metadata.loader,
      minecraftVersion: metadata.minecraftVersion,
      metadataSource: metadata.metadataSource,
      environment: metadata.environment || "",
      dependencies: [],
      optionalDependencies: [],
      history: [],
      warnings,
      installedAt: new Date().toISOString(),
    });
    writeLock(server, lock);
    return { transaction, addons: listServerAddons(server), warnings };
  } catch (error) {
    rollbackAddonTransaction(transaction);
    throw error;
  }
}

function findAddon(server, addonId) {
  const listing = listServerAddons(server);
  const item = listing.items.find((addon) => addon.id === addonId);
  if (!item) throw new Error("Installed add-on not found");
  return { listing, item };
}

function ensureLockEntry(lock, item) {
  let entry = lock.entries.find((candidate) => String(candidate.id) === item.id);
  if (!entry) {
    entry = {
      id: item.id,
      source: "manual",
      title: item.title,
      versionNumber: item.versionNumber,
      fileName: item.fileName,
      sha512: item.sha512,
      enabled: item.enabled,
      loader: item.loader || "unknown",
      minecraftVersion: item.minecraftVersion || "",
      dependencies: [],
      optionalDependencies: [],
      history: [],
      installedAt: new Date().toISOString(),
    };
    lock.entries.push(entry);
  }
  return entry;
}

export function setAddonEnabled(server, addonId, enabled, { cascade = false } = {}) {
  const { listing, item } = findAddon(server, addonId);
  if (item.enabled === Boolean(enabled)) return { transaction: null, addons: listServerAddons(server) };
  const directory = addonDirectory(server);
  const dependentItems = !enabled ? item.removalDependents || [] : [];
  if (dependentItems.length && !cascade) {
    throw new Error(`${item.title} is required by ${dependentItems.map((entry) => entry.title).join(", ")}. Disable them together to keep dependencies valid.`);
  }
  const targetIds = new Set([item.id, ...(cascade ? dependentItems.map((entry) => entry.id) : [])]);
  const targets = listing.items.filter((candidate) => targetIds.has(candidate.id) && candidate.enabled !== Boolean(enabled));
  const transaction = beginTransaction(server);
  const lock = loadLock(server);
  try {
    for (const target of targets) {
      const from = path.join(directory, target.enabled ? target.fileName : `${target.fileName}.disabled`);
      const to = path.join(directory, enabled ? target.fileName : `${target.fileName}.disabled`);
      if (fs.existsSync(to)) throw new Error(`Cannot change state because ${path.basename(to)} already exists`);
      fs.renameSync(from, to);
      recordRename(transaction, from, to);
      const entry = ensureLockEntry(lock, target);
      entry.enabled = Boolean(enabled);
    }
    writeLock(server, lock);
    return { transaction, addons: listServerAddons(server) };
  } catch (error) {
    rollbackAddonTransaction(transaction);
    throw error;
  }
}

export function removeAddon(server, addonId, { cascade = false } = {}) {
  const { listing, item } = findAddon(server, addonId);
  const dependentItems = item.removalDependents || [];
  if (dependentItems.length && !cascade) {
    throw new Error(`${item.title} is required by ${dependentItems.map((entry) => entry.title).join(", ")}. Remove them together to keep dependencies valid.`);
  }
  const directory = addonDirectory(server);
  const transaction = beginTransaction(server);
  const lock = loadLock(server);
  try {
    const selectedIds = new Set([item.id, ...(cascade ? dependentItems.map((entry) => entry.id) : [])]);
    const selected = listing.items.filter((candidate) => selectedIds.has(candidate.id));
    for (const candidate of selected) {
      const filePath = path.join(directory, candidate.enabled ? candidate.fileName : `${candidate.fileName}.disabled`);
      backupFile(transaction, filePath);
    }
    const selectedFiles = new Set(selected.map((candidate) => candidate.fileName.toLowerCase()));
    lock.entries = lock.entries.filter((entry) =>
      !selectedIds.has(String(entry.id)) && !selectedFiles.has(String(entry.fileName || "").toLowerCase())
    );
    writeLock(server, lock);
    return { transaction, removed: selected.map((candidate) => candidate.title), addons: listServerAddons(server) };
  } catch (error) {
    rollbackAddonTransaction(transaction);
    throw error;
  }
}

export async function checkAddonUpdates(server, fetchImpl = fetch) {
  const profile = getAddonProfile(server);
  const listing = listServerAddons(server);
  if (!profile.supported) return listing;
  const updateMap = new Map();
  for (const item of listing.items.filter((addon) => addon.source === "modrinth" && addon.projectId)) {
    try {
      const version = await projectVersion(item.projectId, server, profile, fetchImpl);
      if (version.id !== item.versionId) {
        updateMap.set(item.id, {
          available: true,
          versionId: version.id,
          versionNumber: version.version_number || version.name,
        });
      }
    } catch {
      updateMap.set(item.id, { available: false, unavailable: true });
    }
  }
  listing.items = listing.items.map((item) => ({ ...item, update: updateMap.get(item.id) || null }));
  return listing;
}

export async function updateModrinthAddon(server, addonId, fetchImpl = fetch) {
  const { item } = findAddon(server, addonId);
  if (item.source !== "modrinth" || !item.projectId) throw new Error("Manually installed add-ons cannot be updated automatically");
  return installModrinthAddon(server, { projectId: item.projectId, title: item.title, iconUrl: item.iconUrl }, fetchImpl);
}

export function setAddonReleaseChannel(server, releaseChannel) {
  if (!VALID_RELEASE_CHANNELS.has(releaseChannel)) throw new Error("Choose stable, beta, or alpha updates");
  const transaction = beginTransaction(server);
  try {
    const lock = loadLock(server);
    lock.preferences.releaseChannel = releaseChannel;
    writeLock(server, lock);
    return { transaction, addons: listServerAddons(server) };
  } catch (error) {
    rollbackAddonTransaction(transaction);
    throw error;
  }
}

export async function updateAllModrinthAddons(server, fetchImpl = fetch) {
  const checked = await checkAddonUpdates(server, fetchImpl);
  const updates = checked.items.filter((item) => item.update?.available && item.source === "modrinth");
  const transaction = { children: [] };
  try {
    for (const item of updates) {
      const result = await updateModrinthAddon(server, item.id, fetchImpl);
      if (result.transaction) transaction.children.push(result.transaction);
    }
    return { transaction, updated: updates.length, addons: listServerAddons(server) };
  } catch (error) {
    rollbackAddonTransaction(transaction);
    throw error;
  }
}

export function rollbackAddonVersion(server, addonId, versionId) {
  const { item } = findAddon(server, addonId);
  const lock = loadLock(server);
  const entry = lock.entries.find((candidate) => String(candidate.id) === item.id);
  if (!entry) throw new Error("Only add-ons recorded in the lock file can be rolled back");
  const historyItem = (entry.history || []).find((candidate) => String(candidate.versionId || candidate.sha512) === String(versionId));
  if (!historyItem) throw new Error("The selected add-on version is no longer available locally");
  const archivedPath = assertPathInside(server.folderPath, path.join(server.folderPath, historyItem.archivePath));
  if (!fs.existsSync(archivedPath)) throw new Error("The archived add-on file is missing");
  validateJar(archivedPath);
  if (historyItem.sha512 && hashFile(archivedPath) !== historyItem.sha512) {
    throw new Error("The archived add-on failed hash verification");
  }

  const transaction = beginTransaction(server);
  const directory = addonDirectory(server);
  const currentPath = path.join(directory, actualFileName(entry));
  const restoredFileName = safeFileName(historyItem.fileName || entry.fileName);
  const restoredPath = path.join(directory, entry.enabled === false ? `${restoredFileName}.disabled` : restoredFileName);
  try {
    const archiveDirectory = path.dirname(archivedPath);
    const currentArchive = path.join(archiveDirectory, safeFileName(`${entry.versionId || entry.sha512 || Date.now()}--${entry.fileName}`));
    if (!fs.existsSync(currentArchive)) {
      fs.copyFileSync(currentPath, currentArchive, fs.constants.COPYFILE_EXCL);
      recordNewFile(transaction, currentArchive);
    }
    backupFile(transaction, currentPath);
    if (fs.existsSync(restoredPath)) throw new Error(`${path.basename(restoredPath)} is already installed`);
    fs.copyFileSync(archivedPath, restoredPath, fs.constants.COPYFILE_EXCL);
    recordNewFile(transaction, restoredPath);
    entry.history = [
      ...(entry.history || []),
      {
        versionId: entry.versionId || null,
        versionNumber: entry.versionNumber || "Unknown",
        environment: entry.environment || "",
        fileName: entry.fileName,
        sha512: entry.sha512,
        archivePath: path.relative(server.folderPath, currentArchive).replaceAll("\\", "/"),
        archivedAt: new Date().toISOString(),
      },
    ].slice(-10);
    entry.versionId = historyItem.versionId || null;
    entry.versionNumber = historyItem.versionNumber || "Unknown";
    entry.environment = historyItem.environment || "";
    entry.fileName = restoredFileName;
    entry.sha512 = historyItem.sha512 || hashFile(restoredPath);
    writeLock(server, lock);
    return { transaction, addons: listServerAddons(server) };
  } catch (error) {
    rollbackAddonTransaction(transaction);
    throw error;
  }
}
