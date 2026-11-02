import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { atomicWriteFile, assertPathInside } from "./safe-filesystem.mjs";

const MODRINTH_API = "https://api.modrinth.com/v2";
const MODRINTH_DOWNLOAD_HOST = "cdn.modrinth.com";
const USER_AGENT = "nadithjayawardana1/BlockHost-Manager/1.0.0";
const MAX_ADDON_BYTES = 512 * 1024 * 1024;
const MAX_INSTALL_BYTES = 2 * 1024 * 1024 * 1024;
const LOCK_VERSION = 2;
const ADDON_HISTORY_DIRECTORY = ".blockhost-addon-history";
const VALID_RELEASE_CHANNELS = new Set(["stable", "beta", "alpha"]);

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

function readJarMetadataFiles(filePath) {
  const wanted = new Set([
    "fabric.mod.json",
    "meta-inf/mods.toml",
    "meta-inf/neoforge.mods.toml",
    "paper-plugin.yml",
    "plugin.yml",
  ]);
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError, archive) => {
      if (openError) {
        reject(new Error("The selected file is not a readable Java archive"));
        return;
      }
      const files = new Map();
      let entries = 0;
      const fail = (error) => {
        archive.close();
        reject(error);
      };
      archive.on("error", fail);
      archive.on("entry", (entry) => {
        entries += 1;
        if (entries > 100000) {
          fail(new Error("The selected JAR contains an unsafe number of files"));
          return;
        }
        const normalized = String(entry.fileName || "").replaceAll("\\", "/").toLowerCase();
        if (!wanted.has(normalized)) {
          archive.readEntry();
          return;
        }
        if (entry.uncompressedSize > 512 * 1024) {
          fail(new Error("The selected JAR contains oversized add-on metadata"));
          return;
        }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            fail(streamError);
            return;
          }
          const chunks = [];
          let size = 0;
          stream.on("data", (chunk) => {
            size += chunk.length;
            if (size <= 512 * 1024) chunks.push(chunk);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            if (size > 512 * 1024) {
              fail(new Error("The selected JAR contains oversized add-on metadata"));
              return;
            }
            files.set(normalized, Buffer.concat(chunks).toString("utf8"));
            archive.readEntry();
          });
        });
      });
      archive.on("end", () => resolve(files));
      archive.readEntry();
    });
  });
}

function yamlValue(text, key) {
  const match = String(text).match(new RegExp(`^${key}\\s*:\\s*["']?([^\\r\\n"']+)`, "mi"));
  return match?.[1]?.trim() || "";
}

function tomlValue(text, key) {
  const match = String(text).match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "mi"));
  return match?.[1]?.trim() || "";
}

export async function inspectAddonJar(filePath) {
  validateJar(filePath);
  const files = await readJarMetadataFiles(filePath);
  const result = {
    loader: "unknown",
    title: path.basename(filePath).replace(/\.jar$/i, ""),
    versionNumber: "Unknown",
    minecraftVersion: "",
    serverSide: "unknown",
    metadataSource: "none",
  };
  if (files.has("fabric.mod.json")) {
    let metadata;
    try {
      metadata = JSON.parse(files.get("fabric.mod.json"));
    } catch {
      throw new Error("The selected JAR contains invalid Fabric metadata");
    }
    result.loader = "fabric";
    result.title = String(metadata.name || metadata.id || result.title);
    result.versionNumber = String(metadata.version || "Unknown");
    result.minecraftVersion = String(metadata.depends?.minecraft || "");
    result.serverSide = metadata.environment === "client" ? "client" : "server";
    result.metadataSource = "fabric.mod.json";
  } else if (files.has("meta-inf/neoforge.mods.toml")) {
    const text = files.get("meta-inf/neoforge.mods.toml");
    result.loader = "neoforge";
    result.title = tomlValue(text, "displayName") || tomlValue(text, "modId") || result.title;
    result.versionNumber = tomlValue(text, "version") || "Unknown";
    result.metadataSource = "META-INF/neoforge.mods.toml";
  } else if (files.has("meta-inf/mods.toml")) {
    const text = files.get("meta-inf/mods.toml");
    result.loader = "forge";
    result.title = tomlValue(text, "displayName") || tomlValue(text, "modId") || result.title;
    result.versionNumber = tomlValue(text, "version") || "Unknown";
    result.metadataSource = "META-INF/mods.toml";
  } else if (files.has("paper-plugin.yml") || files.has("plugin.yml")) {
    const source = files.has("paper-plugin.yml") ? "paper-plugin.yml" : "plugin.yml";
    const text = files.get(source);
    result.loader = "paper";
    result.title = yamlValue(text, "name") || result.title;
    result.versionNumber = yamlValue(text, "version") || "Unknown";
    result.minecraftVersion = yamlValue(text, "api-version");
    result.serverSide = "server";
    result.metadataSource = source;
  }
  return result;
}

export function getAddonProfile(server) {
  const type = String(server?.type || "");
  if (type === "paper") return { supported: true, kind: "plugins", singular: "plugin", loader: "paper", directory: "plugins", projectType: "plugin" };
  if (["fabric", "forge", "neoforge"].includes(type)) {
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
    entries: value.entries.filter((entry) => entry && typeof entry === "object").map((entry) => ({
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

function installedFiles(server) {
  const directory = addonDirectory(server);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (/\.jar$/i.test(entry.name) || /\.jar\.disabled$/i.test(entry.name)))
    .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }));
}

export function listServerAddons(server) {
  const profile = getAddonProfile(server);
  if (!profile.supported) return { ...profile, items: [] };
  const files = installedFiles(server);
  const lock = loadLock(server);
  const matched = new Set();
  const items = [];

  for (const entry of lock.entries) {
    const fileName = actualFileName(entry);
    const file = files.find((candidate) => candidate.name.toLowerCase() === fileName.toLowerCase());
    if (!file) continue;
    matched.add(file.path);
    items.push({
      id: String(entry.id || `${entry.source || "manual"}:${entry.sha512 || entry.fileName}`),
      title: String(entry.title || entry.fileName),
      versionNumber: String(entry.versionNumber || "Unknown"),
      fileName: entry.fileName,
      enabled: entry.enabled !== false,
      source: entry.source === "modrinth" ? "modrinth" : "manual",
      projectId: entry.projectId || null,
      versionId: entry.versionId || null,
      sha512: entry.sha512 || hashFile(file.path),
      managed: true,
      loader: entry.loader || profile.loader,
      minecraftVersion: entry.minecraftVersion || server.version,
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
    const sha512 = hashFile(file.path);
    items.push({
      id: `manual:${sha512}`,
      title: fileName.replace(/\.jar$/i, ""),
      versionNumber: "Unknown",
      fileName,
      enabled,
      source: "manual",
      projectId: null,
      versionId: null,
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

  const projectById = new Map(items.filter((item) => item.projectId).map((item) => [item.projectId, item]));
  for (const item of items) {
    item.dependents = items
      .filter((candidate) => candidate.dependencies.includes(item.projectId))
      .map((candidate) => ({ id: candidate.id, title: candidate.title }));
    const cascadeIds = new Set([item.id]);
    let changed = true;
    while (changed) {
      changed = false;
      const selectedProjects = new Set(items.filter((candidate) => cascadeIds.has(candidate.id)).map((candidate) => candidate.projectId).filter(Boolean));
      for (const candidate of items) {
        if (!cascadeIds.has(candidate.id) && candidate.dependencies.some((projectId) => selectedProjects.has(projectId))) {
          cascadeIds.add(candidate.id);
          changed = true;
        }
      }
    }
    item.removalDependents = items.filter((candidate) => candidate.id !== item.id && cascadeIds.has(candidate.id))
      .map((candidate) => ({ id: candidate.id, title: candidate.title }));
    item.missingDependencies = item.dependencies.filter((projectId) => !projectById.has(projectId));
  }
  items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  return { ...profile, releaseChannel: lock.preferences.releaseChannel, items };
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

async function findCompatibleAddons(server, query, fetchImpl, { recommendations = false } = {}) {
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
  const params = new URLSearchParams({
    facets: JSON.stringify(facets),
    index: "downloads",
    limit: recommendations ? "16" : "20",
  });
  if (search) params.set("query", search);
  const data = await modrinthJson(`/search?${params}`, {}, fetchImpl);
  return {
    ...profile,
    query: search,
    results: (data.hits || []).map((hit) => ({
      projectId: String(hit.project_id),
      title: String(hit.title || hit.slug || "Unnamed add-on"),
      description: String(hit.description || ""),
      author: String(hit.author || ""),
      downloads: Number(hit.downloads) || 0,
      iconUrl: normalizeModrinthIconUrl(hit.icon_url),
    })),
  };
}

export function searchCompatibleAddons(server, query, fetchImpl = fetch) {
  return findCompatibleAddons(server, query, fetchImpl);
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

async function projectVersion(projectId, server, profile, fetchImpl, releaseChannel = loadLock(server).preferences.releaseChannel) {
  const params = new URLSearchParams({
    loaders: JSON.stringify([profile.loader]),
    game_versions: JSON.stringify([String(server.version)]),
    include_changelog: "false",
  });
  const versions = await modrinthJson(`/project/${encodeURIComponent(projectId)}/version?${params}`, {}, fetchImpl);
  const version = chooseVersion(versions, server, profile, releaseChannel);
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
        const conflict = installed.entries.find((entry) => entry.projectId && entry.projectId === dependency.project_id);
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

  const rootVersion = await projectVersion(requested.projectId, server, profile, fetchImpl);
  await resolveVersion(rootVersion, String(requested.title || "Selected add-on"));
  const totalSize = resolved.reduce((sum, item) => sum + item.file.size, 0);
  if (totalSize > MAX_INSTALL_BYTES) throw new Error("The selected add-on and its dependencies exceed the 2 GB installation limit");
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
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: "wx" }));
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

export function cleanupAbandonedAddonTransactions(serversRoot) {
  if (!fs.existsSync(serversRoot)) return [];
  const recovered = [];
  for (const directory of fs.readdirSync(serversRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const serverFolder = path.join(serversRoot, directory.name);
    for (const name of fs.readdirSync(serverFolder).filter((entry) => /^\.blockhost-addon-journal-.+\.json$/i.test(entry))) {
      const journalPath = path.join(serverFolder, name);
      const value = readJson(journalPath, null);
      if (!value) {
        fs.rmSync(journalPath, { force: true });
        continue;
      }
      try {
        rollbackAddonTransaction({ ...value, server: { folderPath: serverFolder }, journalPath });
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
  const profile = getAddonProfile(server);
  if (!profile.supported) throw new Error("This server type does not support managed add-ons");
  if (!requested?.projectId) throw new Error("No add-on project was selected");
  const installSet = await resolveInstallSet(server, requested, fetchImpl);
  const transaction = beginTransaction(server);
  const directory = addonDirectory(server);
  const lock = loadLock(server);

  try {
    fs.mkdirSync(transaction.stagingDir, { recursive: true });
    const staged = [];
    for (const item of installSet) {
      const temporary = path.join(transaction.stagingDir, item.file.filename);
      const sha512 = await downloadVerified(item, temporary, fetchImpl);
      staged.push({ ...item, temporary, sha512 });
    }

    fs.mkdirSync(directory, { recursive: true });
    const replacingProjects = new Set(staged.map((item) => item.projectId));
    const existingItems = listServerAddons(server).items;
    for (const item of staged) {
      const duplicate = existingItems.find((candidate) =>
        candidate.sha512 === item.sha512 && !replacingProjects.has(candidate.projectId)
      );
      if (duplicate) throw new Error(`${item.title} is already installed as ${duplicate.fileName}`);
    }
    const historyByProject = new Map();
    for (const entry of lock.entries.filter((candidate) => replacingProjects.has(candidate.projectId))) {
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
        if (!existingEntry || !replacingProjects.has(existingEntry.projectId)) {
          throw new Error(`${item.file.filename} is already installed by another add-on`);
        }
        backupFile(transaction, destination);
      }
      fs.renameSync(item.temporary, destination);
      recordNewFile(transaction, destination);
    }

    const nextEntries = lock.entries.filter((entry) => !replacingProjects.has(entry.projectId));
    for (const item of staged) {
      nextEntries.push({
        id: `modrinth:${item.projectId}`,
        source: "modrinth",
        projectId: item.projectId,
        versionId: item.versionId,
        versionNumber: item.versionNumber,
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
        fileName: entry.fileName,
        sha512: entry.sha512,
        archivePath: path.relative(server.folderPath, currentArchive).replaceAll("\\", "/"),
        archivedAt: new Date().toISOString(),
      },
    ].slice(-10);
    entry.versionId = historyItem.versionId || null;
    entry.versionNumber = historyItem.versionNumber || "Unknown";
    entry.fileName = restoredFileName;
    entry.sha512 = historyItem.sha512 || hashFile(restoredPath);
    writeLock(server, lock);
    return { transaction, addons: listServerAddons(server) };
  } catch (error) {
    rollbackAddonTransaction(transaction);
    throw error;
  }
}
