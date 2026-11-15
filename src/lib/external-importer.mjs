import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { discardImportedAddonJournals } from "./addon-manager.mjs";
import { LOADER_INSTALLER, START_SCRIPT, starterPackRoots } from "./drop-source.mjs";
import { atomicWriteFile, assertPathInside } from "./safe-filesystem.mjs";
import { normalizeServerIcon } from "./app-themes.mjs";

const MAX_ENTRIES = 100_000;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 500;
const RATIO_MINIMUM_BYTES = 1024 * 1024;
const EXTRA_DISK_BYTES = 64 * 1024 * 1024;
const EXCLUDED_NAMES = new Set([
  ".blockhost-addon-backup",
  ".blockhost-backup.json",
  ".blockhost-addon-staging",
  ".blockhost-import-staging",
  ".blockhost-transfer-staging",
  "session.lock",
]);

function progress(listener, stage, percent, message) {
  listener?.({ stage, percent: Math.max(0, Math.min(100, Math.round(percent))), message });
}

function safeSegment(value, fallback = "server") {
  const result = String(value || "").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return result || fallback;
}

function safeName(value) {
  const name = String(value || "Imported server").trim().slice(0, 80);
  return name || "Imported server";
}

function chooseName(requested, servers) {
  const base = safeName(requested);
  const used = new Set(servers.map((server) => String(server.name || "").toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? " (Imported)" : ` (Imported ${index})`;
    const candidate = `${base.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function nextId(serversRoot, servers) {
  const used = new Set(servers.map((server) => Number(server.id)));
  let id = Date.now();
  while (used.has(id) || fs.readdirSync(serversRoot, { withFileTypes: true }).some((entry) => entry.name.endsWith(`-${id}`))) id += 1;
  return id;
}

function availableBytes(directory) {
  try {
    const stats = fs.statfsSync(directory, { bigint: true });
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function assertDiskSpace(directory, required) {
  const available = availableBytes(directory);
  if (available !== null && available < BigInt(Math.ceil(required + EXTRA_DISK_BYTES))) {
    throw new Error("There is not enough free disk space to import this server");
  }
}

function portableEntryPath(value) {
  const text = String(value || "").replaceAll("\\", "/");
  if (!text || text.includes("\0") || text.startsWith("/") || /^[a-z]:/i.test(text)) throw new Error("The ZIP contains an unsafe absolute path");
  const directory = text.endsWith("/");
  const parts = text.split("/");
  if (directory) parts.pop();
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error("The ZIP contains an unsafe traversal path");
  return `${parts.join("/")}${directory ? "/" : ""}`;
}

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(new Error(`Could not open the server ZIP: ${error.message}`));
      else resolve(zip);
    });
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

async function extractZip(source, destination, onProgress, signal) {
  const zip = await openZip(source);
  let entries = 0;
  let uncompressed = 0;
  let compressed = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch {}
      reject(error);
    };
    zip.on("error", (error) => fail(new Error(`The server ZIP is damaged: ${error.message}`)));
    zip.on("close", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zip.on("entry", (entry) => {
      Promise.resolve().then(async () => {
        signal?.throwIfAborted();
        entries += 1;
        if (entries > MAX_ENTRIES) throw new Error("The server ZIP contains too many files");
        const entryPath = portableEntryPath(entry.fileName);
        if (entry.generalPurposeBitFlag & 1) throw new Error("Encrypted server ZIPs are not supported");
        if (![0, 8].includes(entry.compressionMethod)) throw new Error(`Unsupported ZIP compression for ${entryPath}`);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const fileType = mode & 0o170000;
        if (fileType && fileType !== 0o100000 && fileType !== 0o040000) throw new Error(`Links and device files are not allowed (${entryPath})`);
        uncompressed += entry.uncompressedSize;
        compressed += entry.compressedSize;
        if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("The server ZIP is too large to import safely");
        if (entry.uncompressedSize >= RATIO_MINIMUM_BYTES && entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_COMPRESSION_RATIO) {
          throw new Error(`Unsafe compression ratio in ${entryPath}`);
        }
        const output = assertPathInside(destination, path.join(destination, ...entryPath.replace(/\/$/, "").split("/")));
        if (entryPath.endsWith("/")) fs.mkdirSync(output, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(output), { recursive: true });
          await pipeline(await openEntryStream(zip, entry), fs.createWriteStream(output, { flags: "wx" }), { signal });
        }
        progress(onProgress, "extract", Math.min(65, 10 + entries / 20), `Extracting server files… (${entries})`);
      }).then(() => zip.readEntry()).catch(fail);
    });
    zip.readEntry();
  });
  if (uncompressed >= RATIO_MINIMUM_BYTES && uncompressed / Math.max(1, compressed) > MAX_COMPRESSION_RATIO) {
    throw new Error("The server ZIP has an unsafe overall compression ratio");
  }
  return uncompressed;
}

function copyDirectory(sourceRoot, destinationRoot, onProgress) {
  let totalSize = 0;
  let files = 0;
  function walk(source, destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name.toLowerCase()) || entry.name.endsWith(".blockhost-backup")) continue;
      const sourcePath = path.join(source, entry.name);
      const destinationPath = assertPathInside(destinationRoot, path.join(destination, entry.name));
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be imported (${entry.name})`);
      if (entry.isDirectory()) walk(sourcePath, destinationPath);
      else if (entry.isFile()) {
        const size = fs.statSync(sourcePath).size;
        totalSize += size;
        files += 1;
        if (totalSize > MAX_UNCOMPRESSED_BYTES || files > MAX_ENTRIES) throw new Error("The server folder is too large to import safely");
        fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
        progress(onProgress, "copy", Math.min(65, 10 + files / 20), `Copying server files… (${files})`);
      } else throw new Error(`Unsupported file type in the server folder (${entry.name})`);
    }
  }
  walk(sourceRoot, destinationRoot);
  return totalSize;
}

function measureDirectory(sourceRoot) {
  let totalSize = 0;
  let entries = 0;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name.toLowerCase()) || entry.name.endsWith(".blockhost-backup")) continue;
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("The server folder contains too many files");
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be imported (${entry.name})`);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) {
        totalSize += fs.statSync(candidate).size;
        if (totalSize > MAX_UNCOMPRESSED_BYTES) throw new Error("The server folder is too large to import safely");
      } else throw new Error(`Unsupported file type in the server folder (${entry.name})`);
    }
  }
  walk(sourceRoot);
  return totalSize;
}

async function measureZip(source) {
  const zip = await openZip(source);
  let entries = 0;
  let uncompressed = 0;
  let compressed = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch {}
      reject(error);
    };
    zip.on("error", (error) => fail(new Error(`The server ZIP is damaged: ${error.message}`)));
    zip.on("close", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zip.on("entry", (entry) => {
      try {
        entries += 1;
        if (entries > MAX_ENTRIES) throw new Error("The server ZIP contains too many files");
        const entryPath = portableEntryPath(entry.fileName);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const fileType = mode & 0o170000;
        if (fileType && fileType !== 0o100000 && fileType !== 0o040000) throw new Error(`Links and device files are not allowed (${entryPath})`);
        if (entry.generalPurposeBitFlag & 1) throw new Error("Encrypted server ZIPs are not supported");
        if (![0, 8].includes(entry.compressionMethod)) throw new Error(`Unsupported ZIP compression for ${entryPath}`);
        uncompressed += entry.uncompressedSize;
        compressed += entry.compressedSize;
        if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("The server ZIP is too large to import safely");
        if (entry.uncompressedSize >= RATIO_MINIMUM_BYTES && entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_COMPRESSION_RATIO) {
          throw new Error(`Unsafe compression ratio in ${entryPath}`);
        }
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
  if (uncompressed >= RATIO_MINIMUM_BYTES && uncompressed / Math.max(1, compressed) > MAX_COMPRESSION_RATIO) {
    throw new Error("The server ZIP has an unsafe overall compression ratio");
  }
  return uncompressed;
}

function containsServerMarkers(directory) {
  const names = new Set(fs.readdirSync(directory).map((name) => name.toLowerCase()));
  return names.has("server.properties") || names.has("eula.txt") || names.has("mods") || names.has("plugins")
    || Array.from(names).some((name) => name.endsWith(".jar"));
}

function findServerRoot(extracted) {
  let current = extracted;
  for (let depth = 0; depth < 5; depth += 1) {
    if (containsServerMarkers(current)) return current;
    const children = fs.readdirSync(current, { withFileTypes: true });
    const directories = children.filter((entry) => entry.isDirectory());
    const files = children.filter((entry) => entry.isFile());
    if (directories.length !== 1 || files.length) break;
    current = path.join(current, directories[0].name);
  }
  return current;
}

function collectRelativeFiles(root) {
  const result = [];
  function walk(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(child, childRelative);
      else if (entry.isFile()) result.push(childRelative.replaceAll("\\", "/"));
    }
  }
  walk(root);
  return result;
}

function inferVersion(paths) {
  for (const value of paths) {
    const match = value.match(/(?:^|[^\d])(1\.\d+(?:\.\d+)?)(?:[^\d]|$)/);
    if (match) return match[1];
  }
  return "unknown";
}

export function detectExternalServer(serverRoot) {
  const files = collectRelativeFiles(serverRoot);
  const lowerFiles = files.map((value) => value.toLowerCase());
  const argsCandidates = files.filter((value) => /(^|\/)libraries\/net\/(minecraftforge\/forge|neoforged\/neoforge)\/[^/]+\/(win|unix)_args\.txt$/i.test(value));
  const argsByPlatform = argsCandidates.filter((value) => /\/win_args\.txt$/i.test(value));
  const args = argsByPlatform.length ? argsByPlatform : argsCandidates;
  const uniqueArgs = args.filter((value, index) => args.findIndex((candidate) => path.dirname(candidate).toLowerCase() === path.dirname(value).toLowerCase()) === index);
  if (uniqueArgs.length > 1) throw new Error(`Multiple loader launch configurations were found: ${uniqueArgs.join(", ")}`);
  if (uniqueArgs.length === 1) {
    const launchArgsPath = uniqueArgs[0];
    const type = launchArgsPath.toLowerCase().includes("/neoforged/") ? "neoforge" : "forge";
    const segment = launchArgsPath.split("/").at(-2) || "";
    return { type, version: inferVersion([segment, ...files]), loaderVersion: segment, launchType: "javaArgsFile", launchArgsPath, jarFile: "" };
  }

  const topLevelJars = files.filter((value) => !value.includes("/") && /\.jar$/i.test(value) && !/installer|sources|javadoc/i.test(value));
  const fabricJars = topLevelJars.filter((value) => /fabric.*server|fabric-server|fabric-loader/i.test(value));
  const paperJars = topLevelJars.filter((value) => /paper/i.test(value));
  const quiltJar = topLevelJars.find(value => /^quilt-server-launch\.jar$/i.test(value));
  const purpurJar = topLevelJars.find(value => /^purpur(?:[-_.]|\.jar$)/i.test(value));
  const forgeJar = topLevelJars.find(value => /^forge-1\.\d+(?:\.\d+)?-[\d.]+(?:-universal)?\.jar$/i.test(value));
  let candidates = topLevelJars;
  let type = "vanilla";
  if (quiltJar || purpurJar || forgeJar) {
    candidates = [quiltJar || purpurJar || forgeJar];
    type = quiltJar ? "quilt" : purpurJar ? "purpur" : "forge";
  } else if (fabricJars.length === 1) {
    candidates = fabricJars;
    type = "fabric";
  } else if (fabricJars.length > 1) throw new Error(`Multiple Fabric launch JARs were found: ${fabricJars.join(", ")}`);
  else if (paperJars.length === 1) {
    candidates = paperJars;
    type = "paper";
  } else if (paperJars.length > 1) throw new Error(`Multiple Paper launch JARs were found: ${paperJars.join(", ")}`);
  else if (fs.existsSync(path.join(serverRoot, "plugins")) && topLevelJars.length === 1) type = "paper";

  if (candidates.length !== 1) {
    if (!candidates.length) throw new Error("No supported top-level server launch JAR was found");
    throw new Error(`Multiple possible server launch JARs were found: ${candidates.join(", ")}. Keep only the intended launch JAR and try again.`);
  }
  return {
    type,
    version: inferVersion([candidates[0], ...lowerFiles.filter(value => /(?:minecraft|versions\/|hashed\/|intermediary\/)/i.test(value)), ...lowerFiles]),
    loaderVersion: type === "fabric" ? inferVersion(lowerFiles.filter((value) => value.includes("fabric-loader"))) : "",
    launchType: "jar",
    launchArgsPath: "",
    jarFile: path.basename(candidates[0]),
  };
}

async function renameWithRetries(source, destination, signal) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    signal?.throwIfAborted();
    if (fs.existsSync(destination)) throw new Error("The imported server destination already exists");
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

function readPackSettings(root, file) {
  const source = path.join(root, file);
  if (fs.statSync(source).size > 1024 * 1024) throw new Error("Server pack settings are too large.");
  return fs.readFileSync(source, "utf8");
}

function starterAssignments(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:(?:export|set)\s+)?"?([a-z_][\w]*)\s*=\s*(.*?)"?$/i);
    if (!match) continue;
    const key = match[1].toUpperCase();
    const value = match[2].replace(/^["\x27]|["\x27]$/g, "");
    values.set(key, values.has(key) && values.get(key) !== value ? "" : value);
  }
  return values;
}

function pinnedStarter(type, version, loaderVersion) {
  if (!["forge", "neoforge", "fabric", "quilt"].includes(type)) throw new Error("This server pack needs a supported loader: Forge, NeoForge, Fabric, or Quilt.");
  if (!/^\d+(?:\.\d+){1,2}$/.test(version || "") || !/^\d+(?:\.\d+){1,4}(?:-[\da-z.]+)?$/i.test(loaderVersion || "")) {
    throw new Error("This server pack must pin both Minecraft and its loader to a specific version.");
  }
  if (type === "forge") {
    if (!loaderVersion.startsWith(version + "-")) loaderVersion = version + "-" + loaderVersion;
  }
  return { type, version, loaderVersion };
}

function readStarterVersions(root) {
  const names = new Map(fs.readdirSync(root).map(name => [name.toLowerCase(), name]));
  if (names.has("variables.txt")) {
    const settings = starterAssignments(readPackSettings(root, names.get("variables.txt")));
    if (settings.has("MODLOADER")) return { ...pinnedStarter(settings.get("MODLOADER").toLowerCase(), settings.get("MINECRAFT_VERSION"), settings.get("MODLOADER_VERSION")), recommendedJavaMajor: Number(settings.get("RECOMMENDED_JAVA_VERSION")) || undefined };
  }
  if (names.has("settings.cfg")) {
    const settings = starterAssignments(readPackSettings(root, names.get("settings.cfg")));
    if (settings.has("MCVER") || settings.has("FORGEVER")) return pinnedStarter("forge", settings.get("MCVER"), settings.get("FORGEVER"));
  }
  const candidates = [];
  for (const name of names.keys()) {
    if (START_SCRIPT.test(name)) {
      const settings = starterAssignments(readPackSettings(root, names.get(name)));
      for (const [key, type] of [["FORGE_VERSION", "forge"], ["NEOFORGE_VERSION", "neoforge"]]) {
        if (settings.get(key) && settings.get("MINECRAFT_VERSION")) candidates.push(pinnedStarter(type, settings.get("MINECRAFT_VERSION"), settings.get(key)));
      }
    }
    const installer = name.match(LOADER_INSTALLER);
    if (!installer) continue;
    const [, type, release] = installer;
    if (type === "forge") {
      const separator = release.indexOf("-");
      if (separator > 0) candidates.push(pinnedStarter(type, release.slice(0, separator), release.slice(separator + 1)));
    } else {
      const match = release.match(/^(20|21)\.(\d+)\.\d+(?:-[\da-z.]+)?$/i);
      if (match) candidates.push(pinnedStarter(type, "1." + match[1] + (match[2] === "0" ? "" : "." + match[2]), release));
    }
  }
  const unique = new Map(candidates.map(pack => [JSON.stringify(pack), pack]));
  if (unique.size > 1) throw new Error("This server pack declares conflicting loader versions. Import a prepared server folder with one installed loader.");
  if (unique.size === 1) return unique.values().next().value;
  if (names.has("manifest.json")) {
    const text = readPackSettings(root, names.get("manifest.json"));
    let manifest;
    try { manifest = JSON.parse(text.replace(/^\uFEFF/, "")); } catch {}
    if (manifest?.manifestType === "minecraftModpack" && manifest.manifestVersion === 1 && Array.isArray(manifest.minecraft?.modLoaders)) {
      const primary = manifest.minecraft.modLoaders.filter(loader => loader?.primary === true);
      const loader = primary.length === 1 ? primary[0].id : undefined;
      const match = typeof loader === "string" && loader.match(/^(forge|neoforge|fabric|quilt)-(.+)$/);
      if (match) return pinnedStarter(match[1], manifest.minecraft.version, match[2]);
    }
  }
  throw new Error("BlockHost could not determine the loader version for this server pack. Set it up with the author’s installer, then import the installed server folder.");
}

function publisherLauncher(root) {
  // Read the version assignments when available. Their scripts are never run.
  const names = new Set(fs.readdirSync(root).map(name => name.toLowerCase()));
  if (names.has("variables.txt") || names.has("settings.cfg") || names.has("manifest.json")) {
    try { return readStarterVersions(root); } catch {}
  }
  const detected = detectExternalServer(root);
  if (detected.type === "forge") {
    const match = (detected.loaderVersion || detected.jarFile).match(/^(?:forge-)?(1\.\d+(?:\.\d+)?)-(\d+(?:\.\d+){1,4})(?:-universal\.jar|\.jar)?$/i);
    if (match) return pinnedStarter("forge", match[1], match[2]);
  }
  if (detected.type === "neoforge") {
    const match = detected.loaderVersion.match(/^(20|21)\.(\d+)\.\d+(?:-[\da-z.]+)?$/i);
    if (match) return pinnedStarter("neoforge", "1." + match[1] + (match[2] === "0" ? "" : "." + match[2]), detected.loaderVersion);
  }
  if (detected.type === "fabric") {
    const match = detected.jarFile.match(/^fabric-server-mc\.(1\.\d+(?:\.\d+)?)-loader\.(\d+(?:\.\d+){1,4})-launcher\.[\w.-]+\.jar$/i);
    if (match) return pinnedStarter("fabric", match[1], match[2]);
  }
  throw new Error("The publisher archive does not identify an exact Minecraft and loader version. Choose another release, or import a server folder prepared with the publisher’s installer.");
}

export async function inspectExternalServerZip(source, destination, { starter = false, rebuildLauncher = false, signal } = {}) {
  fs.mkdirSync(destination, { recursive: false });
  const expectedBytes = await measureZip(source);
  assertDiskSpace(destination, expectedBytes);
  const totalBytes = await extractZip(source, destination, undefined, signal);
  let serverRoot = findServerRoot(destination);
  if (starter) {
    const roots = starterPackRoots(collectRelativeFiles(destination));
    if (roots.length !== 1) throw new Error("Choose a ZIP containing one server pack.");
    serverRoot = assertPathInside(destination, path.join(destination, roots[0]), { allowRoot: true });
  }
  const detected = starter ? readStarterVersions(serverRoot)
    : rebuildLauncher ? publisherLauncher(serverRoot) : detectExternalServer(serverRoot);
  const files = collectRelativeFiles(serverRoot);
  return { ...detected, sourceFolder: serverRoot, totalBytes, fileCount: files.length, hasWorld: files.some(name => /(^|\/)level\.dat$/i.test(name)) };
}

export async function importExternalServer(sourcePath, serversRoot, existingServers = [], options = {}) {
  const source = path.resolve(sourcePath);
  if (!fs.existsSync(source)) throw new Error("The selected server source no longer exists");
  const stats = fs.statSync(source);
  if (!stats.isDirectory() && !(stats.isFile() && path.extname(source).toLowerCase() === ".zip")) {
    throw new Error("Select a Minecraft server folder or ZIP file");
  }
  const root = path.resolve(serversRoot);
  fs.mkdirSync(root, { recursive: true });
  const stagingParent = assertPathInside(root, path.join(root, ".blockhost-external-import-staging"));
  const staging = assertPathInside(stagingParent, path.join(stagingParent, crypto.randomUUID()));
  const extracted = path.join(staging, "source");
  let destination = "";
  let published = false;
  try {
    options.signal?.throwIfAborted();
    const expectedBytes = stats.isDirectory() ? measureDirectory(source) : await measureZip(source);
    assertDiskSpace(root, expectedBytes);
    fs.mkdirSync(extracted, { recursive: true });
    progress(options.onProgress, "inspect", 3, "Inspecting the external server…");
    const totalBytes = stats.isDirectory()
      ? copyDirectory(source, extracted, options.onProgress)
      : await extractZip(source, extracted, options.onProgress, options.signal);
    options.signal?.throwIfAborted();
    const serverRoot = findServerRoot(extracted);
    const detected = detectExternalServer(serverRoot);
    discardImportedAddonJournals(serverRoot);
    await options.beforeCommit?.(serverRoot);
    const requestedName = options.name || path.basename(source, path.extname(source));
    const name = chooseName(requestedName, existingServers);
    const id = nextId(root, existingServers);
    destination = assertPathInside(root, path.join(root, `${safeSegment(name)}-${id}`));
    if (fs.existsSync(destination)) throw new Error("The imported server destination already exists");
    const now = new Date().toISOString();
    const metadata = {
      schemaVersion: 3,
      id,
      name,
      type: detected.type,
      version: detected.version,
      loaderVersion: detected.loaderVersion,
      color: /^#[a-f0-9]{6}$/i.test(options.color || "") ? options.color : "#39c9ff",
      icon: normalizeServerIcon(options.icon),
      ...(options.modpack ? { modpack: options.modpack } : {}),
      launchType: detected.launchType,
      jarFile: detected.jarFile,
      launchArgsPath: detected.launchArgsPath,
      createdAt: now,
      lastModifiedAt: now,
      addonsManifestVersion: 2,
      importedAt: now,
      importSource: "external",
    };
    const eula = path.join(serverRoot, "eula.txt");
    if (fs.existsSync(eula)) fs.rmSync(eula, { force: true });
    fs.rmSync(path.join(serverRoot, ".blockhost-backup.json"), { force: true });
    Object.assign(metadata, await options.prepareMetadata?.(serverRoot, metadata));
    atomicWriteFile(path.join(serverRoot, "server-info.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    progress(options.onProgress, "commit", 92, "Adding the detected server to BlockHost…");
    await renameWithRetries(serverRoot, destination, options.signal);
    published = true;
    progress(options.onProgress, "complete", 100, "External server import complete.");
    return { server: metadata, path: destination, totalBytes, detected };
  } catch (error) {
    if (published && fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    try { if (fs.existsSync(stagingParent) && !fs.readdirSync(stagingParent).length) fs.rmdirSync(stagingParent); } catch {}
  }
}

export function cleanupAbandonedExternalImports(serversRoot) {
  const staging = path.join(path.resolve(serversRoot), ".blockhost-external-import-staging");
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
}
