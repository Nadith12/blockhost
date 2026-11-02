import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";
import { atomicWriteFile, assertPathInside } from "./safe-filesystem.mjs";

export const BLOCKHOST_FORMAT = "blockhost-server";
export const BLOCKHOST_FORMAT_VERSION = 1;

const MANIFEST_PATH = "manifest.json";
const SERVER_PREFIX = "server/";
const MAX_ENTRIES = 100_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 500;
const RATIO_CHECK_MIN_BYTES = 1024 * 1024;
const EXTRA_DISK_BYTES = 64 * 1024 * 1024;
const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const SERVER_TYPES = new Set(["vanilla", "paper", "fabric", "forge", "neoforge"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".blockhost-addon-backup",
  ".blockhost-addon-staging",
  ".blockhost-import-staging",
  ".blockhost-transfer-staging",
  "crash-reports",
  "logs",
]);

export function cleanupAbandonedTransfers(serversRoot, exportsDirectory) {
  const root = path.resolve(serversRoot);
  const staging = path.join(root, ".blockhost-import-staging");
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });

  const exportsRoot = path.resolve(exportsDirectory);
  if (!fs.existsSync(exportsRoot)) return;
  for (const entry of fs.readdirSync(exportsRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.blockhost\.partial-[0-9a-f-]+\.blockhost$/i.test(entry.name)) continue;
    const candidate = assertPathInside(exportsRoot, path.join(exportsRoot, entry.name));
    fs.rmSync(candidate, { force: true });
  }
}

function emitProgress(onProgress, stage, percent, message) {
  onProgress?.({ stage, percent: Math.max(0, Math.min(100, Math.round(percent))), message });
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

function portablePath(value, label = "archive path") {
  const text = String(value || "");
  if (!text || text.includes("\0") || text.includes("\\") || text.startsWith("/") || /^[a-z]:/i.test(text)) {
    throw new Error(`Invalid ${label}`);
  }
  const directory = text.endsWith("/");
  const parts = text.split("/");
  if (directory) parts.pop();
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid ${label}`);
  }
  return `${parts.join("/")}${directory ? "/" : ""}`;
}

function relativeLaunchPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return portablePath(normalized, "server launch path");
}

function safeSegment(value, fallback = "server") {
  const result = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return result || fallback;
}

function shouldExclude(relativePath, directory) {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.toLowerCase().split("/");
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part))) return true;
  if (directory) return false;
  const name = parts.at(-1);
  return name === "session.lock"
    || name === "server-info.pre-blockhost-v3.json"
    || name.endsWith(".blockhost-backup")
    || name.includes(".blockhost-partial-");
}

function collectServerFiles(server) {
  const root = path.resolve(server.folderPath);
  if (!fs.statSync(root).isDirectory()) throw new Error("The server folder is missing");
  const files = [];

  function walk(directory, relativeDirectory = "") {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      if (shouldExclude(relative, entry.isDirectory())) continue;
      const absolute = assertPathInside(root, path.join(directory, entry.name));
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be exported (${relative})`);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) files.push({ sourcePath: absolute, relativePath: relative.replaceAll("\\", "/") });
      else throw new Error(`Unsupported server file type (${relative})`);
    }
  }

  walk(root);
  return files;
}

function portableMetadata(server) {
  return {
    schemaVersion: 3,
    id: Number(server.id),
    name: String(server.name),
    type: String(server.type),
    version: String(server.version),
    loaderVersion: String(server.loaderVersion || ""),
    color: String(server.color || "#39c9ff"),
    launchType: server.launchType === "javaArgsFile" ? "javaArgsFile" : "jar",
    jarFile: server.launchType === "javaArgsFile" ? "" : "server.jar",
    launchArgsPath: server.launchType === "javaArgsFile" ? relativeLaunchPath(server.launchArgsPath) : "",
    createdAt: String(server.createdAt || ""),
    lastModifiedAt: String(server.lastModifiedAt || server.createdAt || ""),
    addonsManifestVersion: 1,
  };
}

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(new Error(`Could not open the BlockHost archive: ${error.message}`));
      else resolve(zip);
    });
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

async function forEachZipEntry(filePath, handler) {
  const zip = await openZip(filePath);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch {}
      reject(error);
    };
    zip.on("error", (error) => fail(new Error(`The BlockHost archive is damaged: ${error.message}`)));
    zip.on("end", () => {});
    zip.on("close", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      Promise.resolve(handler(entry, zip)).then(() => zip.readEntry()).catch(fail);
    });
    zip.readEntry();
  });
}

async function readEntryBuffer(zip, entry, maximumBytes) {
  if (entry.uncompressedSize > maximumBytes) throw new Error("The BlockHost manifest is too large");
  const chunks = [];
  let size = 0;
  const stream = await openEntryStream(zip, entry);
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("The BlockHost manifest is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function hashZipEntry(zip, entry) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  const stream = await openEntryStream(zip, entry);
  for await (const chunk of stream) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

function validateZipEntry(entry) {
  const name = portablePath(entry.fileName, "archive entry path");
  if (entry.generalPurposeBitFlag & 1) throw new Error("Encrypted BlockHost archives are not supported");
  if (![0, 8].includes(entry.compressionMethod)) throw new Error(`Unsupported compression method for ${name}`);
  const directory = name.endsWith("/");
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = mode & 0o170000;
  if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new Error(`Links and device files are not allowed in BlockHost archives (${name})`);
  }
  if (!directory && entry.uncompressedSize >= RATIO_CHECK_MIN_BYTES) {
    const ratio = entry.compressedSize ? entry.uncompressedSize / entry.compressedSize : Infinity;
    if (ratio > MAX_COMPRESSION_RATIO) throw new Error(`Unsafe compression ratio in ${name}`);
  }
  return { name, directory };
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The BlockHost manifest is invalid");
  if (value.format !== BLOCKHOST_FORMAT) throw new Error("This is not a BlockHost server archive");
  if (value.formatVersion !== BLOCKHOST_FORMAT_VERSION) {
    throw new Error(`BlockHost archive version ${value.formatVersion} is not supported`);
  }
  if (!value.server || typeof value.server !== "object") throw new Error("The BlockHost archive has no server metadata");
  if (!SERVER_TYPES.has(value.server.type)) throw new Error("The BlockHost archive has an unsupported server type");
  if (!String(value.server.name || "").trim()) throw new Error("The BlockHost archive has no server name");
  if (!String(value.server.minecraftVersion || "").trim()) throw new Error("The BlockHost archive has no Minecraft version");
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_ENTRIES) {
    throw new Error("The BlockHost archive file list is invalid");
  }
  const files = new Map();
  let totalSize = 0;
  for (const file of value.files) {
    const filePath = portablePath(file?.path, "manifest file path");
    if (!filePath.startsWith(SERVER_PREFIX) || filePath.endsWith("/")) throw new Error(`Invalid server file path: ${filePath}`);
    const key = filePath.toLowerCase();
    if (files.has(key)) throw new Error(`Duplicate file in BlockHost manifest: ${filePath}`);
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid file size for ${filePath}`);
    const sha256 = String(file.sha256 || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid file hash for ${filePath}`);
    totalSize += size;
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("The BlockHost archive is too large to import safely");
    }
    files.set(key, { path: filePath, size, sha256 });
  }

  const launchType = value.server.launchType === "javaArgsFile" ? "javaArgsFile" : "jar";
  const requiredPath = launchType === "jar"
    ? "server/server.jar"
    : `${SERVER_PREFIX}${relativeLaunchPath(value.server.launchArgsPath)}`;
  if (!files.has(requiredPath.toLowerCase())) throw new Error("The BlockHost archive is missing its server launch files");
  return { manifest: value, files, totalSize, launchType };
}

export async function inspectBlockhostArchive(filePath, options = {}) {
  const archivePath = path.resolve(filePath);
  if (path.extname(archivePath).toLowerCase() !== ".blockhost") throw new Error("Select a .blockhost server archive");
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) throw new Error("The selected BlockHost archive no longer exists");

  let manifestBuffer = null;
  const archiveEntries = new Map();
  let entryCount = 0;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  await forEachZipEntry(archivePath, async (entry, zip) => {
    const { name, directory } = validateZipEntry(entry);
    entryCount += 1;
    if (entryCount > MAX_ENTRIES + 10) throw new Error("The BlockHost archive contains too many entries");
    const key = name.toLowerCase();
    if (archiveEntries.has(key)) throw new Error(`Duplicate archive entry: ${name}`);
    archiveEntries.set(key, { entry, name, directory });
    if (!directory) {
      totalUncompressed += entry.uncompressedSize;
      totalCompressed += entry.compressedSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES + MAX_MANIFEST_BYTES) throw new Error("The BlockHost archive is too large to import safely");
    }
    if (key === MANIFEST_PATH) manifestBuffer = await readEntryBuffer(zip, entry, MAX_MANIFEST_BYTES);
  });
  if (!manifestBuffer) throw new Error("The BlockHost archive has no manifest");
  if (totalUncompressed >= RATIO_CHECK_MIN_BYTES && totalUncompressed / Math.max(1, totalCompressed) > MAX_COMPRESSION_RATIO) {
    throw new Error("The BlockHost archive has an unsafe compression ratio");
  }

  let parsed;
  try { parsed = JSON.parse(manifestBuffer.toString("utf8")); }
  catch { throw new Error("The BlockHost manifest is not valid JSON"); }
  const validated = validateManifest(parsed);

  for (const [key, item] of archiveEntries) {
    if (item.directory || key === MANIFEST_PATH) continue;
    const declared = validated.files.get(key);
    if (!declared) throw new Error(`The archive contains an undeclared file: ${item.name}`);
    if (declared.size !== item.entry.uncompressedSize) throw new Error(`File size does not match the manifest: ${item.name}`);
  }
  for (const declared of validated.files.values()) {
    if (!archiveEntries.has(declared.path.toLowerCase())) throw new Error(`The archive is missing ${declared.path}`);
  }

  if (options.verifyPayload) {
    let verified = 0;
    await forEachZipEntry(archivePath, async (entry, zip) => {
      const { name, directory } = validateZipEntry(entry);
      if (directory || name.toLowerCase() === MANIFEST_PATH) return;
      const declared = validated.files.get(name.toLowerCase());
      const actual = await hashZipEntry(zip, entry);
      if (actual.size !== declared.size || actual.sha256 !== declared.sha256) throw new Error(`File verification failed: ${name}`);
      verified += 1;
      emitProgress(options.onProgress, "verify", 75 + (verified / validated.files.size) * 25, `Verifying ${verified} of ${validated.files.size} files…`);
    });
  }

  return {
    manifest: validated.manifest,
    totalSize: validated.totalSize,
    fileCount: validated.files.size,
    files: validated.files,
  };
}

function availableBytes(directory) {
  try {
    const stats = fs.statfsSync(directory, { bigint: true });
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function assertDiskSpace(directory, requiredBytes) {
  const available = availableBytes(directory);
  if (available !== null && available < BigInt(Math.max(0, Math.ceil(requiredBytes)))) {
    throw new Error("There is not enough free disk space to complete this operation");
  }
}

async function renameWithRetries(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function removeEmptyDirectoryWithRetries(directory) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!fs.existsSync(directory)) return;
    if (fs.readdirSync(directory).length) return;
    try {
      fs.rmdirSync(directory);
      return;
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

async function writeZip(destination, entries, manifest) {
  const zip = new yazl.ZipFile();
  const output = fs.createWriteStream(destination, { flags: "wx" });
  const completed = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
  });
  zip.outputStream.pipe(output);
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), MANIFEST_PATH, { mtime: ZIP_EPOCH });
  for (const entry of entries) {
    if (entry.buffer) zip.addBuffer(entry.buffer, entry.archivePath, { mtime: ZIP_EPOCH });
    else zip.addFile(entry.sourcePath, entry.archivePath, { mtime: entry.mtime || ZIP_EPOCH, mode: 0o100644 });
  }
  zip.end();
  await completed;
}

export async function exportBlockhostServer(server, destination, options = {}) {
  const onProgress = options.onProgress;
  const target = path.resolve(destination);
  if (path.extname(target).toLowerCase() !== ".blockhost") throw new Error("BlockHost exports must use the .blockhost extension");
  if (fs.existsSync(target)) throw new Error("An export with this name already exists");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.partial-${crypto.randomUUID()}.blockhost`;

  try {
    emitProgress(onProgress, "scan", 3, "Scanning the server files…");
    const metadata = portableMetadata(server);
    const metadataBuffer = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    let sourceFiles = collectServerFiles(server).filter((file) => {
      const lower = file.relativePath.toLowerCase();
      if (lower === "server-info.json") return false;
      return !(metadata.launchType === "jar" && lower === "server.jar");
    });
    if (metadata.launchType === "jar") {
      const jarPath = path.resolve(server.jarPath || path.join(server.folderPath, "server.jar"));
      if (!fs.existsSync(jarPath) || !fs.statSync(jarPath).isFile()) throw new Error("The server JAR is missing and cannot be exported");
      sourceFiles.push({ sourcePath: jarPath, relativePath: "server.jar" });
    }

    const seen = new Set();
    const entries = [{ buffer: metadataBuffer, archivePath: "server/server-info.json" }];
    for (const file of sourceFiles) {
      const archivePath = `${SERVER_PREFIX}${portablePath(file.relativePath, "server file path")}`;
      const key = archivePath.toLowerCase();
      if (seen.has(key) || key === "server/server-info.json") throw new Error(`Duplicate server file: ${archivePath}`);
      seen.add(key);
      entries.push({ sourcePath: file.sourcePath, archivePath, mtime: fs.statSync(file.sourcePath).mtime });
    }

    const totalSourceBytes = entries.reduce((sum, entry) => sum + (entry.buffer?.length || fs.statSync(entry.sourcePath).size), 0);
    if (totalSourceBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("This server is too large to export safely");
    assertDiskSpace(path.dirname(target), totalSourceBytes + EXTRA_DISK_BYTES);

    const files = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const actual = entry.buffer
        ? { size: entry.buffer.length, sha256: sha256Buffer(entry.buffer) }
        : await hashFile(entry.sourcePath);
      files.push({ path: entry.archivePath, size: actual.size, sha256: actual.sha256 });
      emitProgress(onProgress, "hash", 5 + ((index + 1) / entries.length) * 30, `Preparing ${index + 1} of ${entries.length} files…`);
    }

    const manifest = {
      format: BLOCKHOST_FORMAT,
      formatVersion: BLOCKHOST_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      createdBy: String(options.createdBy || "BlockHost Manager"),
      server: {
        name: metadata.name,
        type: metadata.type,
        minecraftVersion: metadata.version,
        loaderVersion: metadata.loaderVersion,
        color: metadata.color,
        launchType: metadata.launchType,
        launchArgsPath: metadata.launchArgsPath,
      },
      files,
    };

    emitProgress(onProgress, "archive", 40, "Creating the self-contained archive…");
    await writeZip(temporary, entries, manifest);
    emitProgress(onProgress, "verify", 75, "Verifying the completed archive…");
    await inspectBlockhostArchive(temporary, { verifyPayload: true, onProgress });
    await renameWithRetries(temporary, target);
    emitProgress(onProgress, "complete", 100, "Export complete.");
    return { path: target, fileName: path.basename(target), fileCount: files.length, totalBytes: totalSourceBytes };
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function chooseImportedName(requestedName, existingNames) {
  const clean = String(requestedName || "Imported server").trim().slice(0, 80) || "Imported server";
  const used = new Set(existingNames.map((name) => String(name).toLowerCase()));
  if (!used.has(clean.toLowerCase())) return clean;
  let index = 1;
  while (true) {
    const suffix = index === 1 ? " (Imported)" : ` (Imported ${index})`;
    const candidate = `${clean.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
    index += 1;
  }
}

function nextServerId(serversRoot, existingIds) {
  const used = new Set(existingIds.map(Number));
  let id = Date.now();
  while (used.has(id) || fs.readdirSync(serversRoot, { withFileTypes: true }).some((entry) => entry.name.endsWith(`-${id}`))) id += 1;
  return id;
}

async function extractArchive(archivePath, destinationRoot, inspected, onProgress) {
  let extracted = 0;
  const seen = new Set();
  await forEachZipEntry(archivePath, async (entry, zip) => {
    const { name, directory } = validateZipEntry(entry);
    if (name.toLowerCase() === MANIFEST_PATH) return;
    if (!name.startsWith(SERVER_PREFIX)) throw new Error(`Unexpected archive entry: ${name}`);
    const relative = name.slice(SERVER_PREFIX.length);
    if (!relative) return;
    const output = assertPathInside(destinationRoot, path.join(destinationRoot, ...relative.split("/")));
    if (directory) {
      fs.mkdirSync(output, { recursive: true });
      return;
    }
    const declared = inspected.files.get(name.toLowerCase());
    if (!declared) throw new Error(`Undeclared archive entry: ${name}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const hash = crypto.createHash("sha256");
    let size = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > declared.size) callback(new Error(`File is larger than declared: ${name}`));
        else {
          hash.update(chunk);
          callback(null, chunk);
        }
      },
    });
    await pipeline(await openEntryStream(zip, entry), verifier, fs.createWriteStream(output, { flags: "wx" }));
    const digest = hash.digest("hex");
    if (size !== declared.size || digest !== declared.sha256) throw new Error(`File verification failed: ${name}`);
    seen.add(name.toLowerCase());
    extracted += 1;
    emitProgress(onProgress, "extract", 20 + (extracted / inspected.fileCount) * 65, `Restoring ${extracted} of ${inspected.fileCount} files…`);
  });
  if (seen.size !== inspected.fileCount) throw new Error("The BlockHost archive did not restore every declared file");
}

export async function importBlockhostServer(archivePath, serversRoot, existingServers = [], options = {}) {
  const root = path.resolve(serversRoot);
  fs.mkdirSync(root, { recursive: true });
  emitProgress(options.onProgress, "inspect", 3, "Checking the BlockHost archive…");
  const inspected = await inspectBlockhostArchive(archivePath);
  assertDiskSpace(root, inspected.totalSize + EXTRA_DISK_BYTES);

  const name = chooseImportedName(inspected.manifest.server.name, existingServers.map((server) => server.name));
  const id = nextServerId(root, existingServers.map((server) => server.id));
  const destination = assertPathInside(root, path.join(root, `${safeSegment(name)}-${id}`));
  const stagingParent = assertPathInside(root, path.join(root, ".blockhost-import-staging"));
  const staging = assertPathInside(stagingParent, path.join(stagingParent, crypto.randomUUID()));
  const extractedServer = path.join(staging, "server");
  if (fs.existsSync(destination)) throw new Error("The imported server destination already exists");

  try {
    fs.mkdirSync(extractedServer, { recursive: true });
    emitProgress(options.onProgress, "extract", 15, "Restoring the server into a safe staging area…");
    await extractArchive(path.resolve(archivePath), extractedServer, inspected, options.onProgress);

    const manifestServer = inspected.manifest.server;
    const launchType = manifestServer.launchType === "javaArgsFile" ? "javaArgsFile" : "jar";
    const launchArgsPath = launchType === "javaArgsFile" ? relativeLaunchPath(manifestServer.launchArgsPath) : "";
    const launchFile = launchType === "jar"
      ? path.join(extractedServer, "server.jar")
      : path.join(extractedServer, ...launchArgsPath.split("/"));
    if (!fs.existsSync(launchFile) || !fs.statSync(launchFile).isFile()) throw new Error("The imported server launch files are missing");

    const sourceMetadataPath = path.join(extractedServer, "server-info.json");
    let sourceMetadata = {};
    try { sourceMetadata = JSON.parse(fs.readFileSync(sourceMetadataPath, "utf8")); } catch {}
    const now = new Date().toISOString();
    const metadata = {
      schemaVersion: 3,
      id,
      name,
      type: String(manifestServer.type || "vanilla"),
      version: String(manifestServer.minecraftVersion || "unknown"),
      loaderVersion: String(manifestServer.loaderVersion || ""),
      color: /^#[0-9a-f]{6}$/i.test(String(manifestServer.color || "")) ? manifestServer.color : "#39c9ff",
      launchType,
      jarFile: launchType === "jar" ? "server.jar" : "",
      launchArgsPath,
      createdAt: now,
      lastModifiedAt: now,
      addonsManifestVersion: Number(sourceMetadata.addonsManifestVersion) || 1,
      importedAt: now,
    };
    atomicWriteFile(sourceMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const eula = path.join(extractedServer, "eula.txt");
    if (fs.existsSync(eula)) fs.rmSync(eula, { force: true });

    emitProgress(options.onProgress, "commit", 92, "Adding the restored server to BlockHost…");
    await renameWithRetries(extractedServer, destination);
    emitProgress(options.onProgress, "complete", 100, "Import complete.");
    return { server: metadata, path: destination, fileCount: inspected.fileCount, totalBytes: inspected.totalSize };
  } catch (error) {
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    await removeEmptyDirectoryWithRetries(stagingParent);
  }
}
