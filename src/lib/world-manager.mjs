import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";
import { assertPathInside } from "./safe-filesystem.mjs";
import { parseProperties, serializeProperties } from "./server-properties.mjs";

const MAX_ENTRIES = 100_000;
const MAX_WORLD_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 500;
const RATIO_MINIMUM_BYTES = 1024 * 1024;
const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const MANIFEST_NAME = "blockhost-world.json";
const SKIPPED_FILES = new Set(["session.lock"]);

function emitProgress(listener, stage, percent, message) {
  listener?.({ stage, percent: Math.max(0, Math.min(100, Math.round(percent))), message });
}

function safeWorldName(value) {
  const name = String(value || "world").trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("The configured world folder name is unsafe");
  }
  return name;
}

function configuredWorldName(serverFolder) {
  const propertiesPath = path.join(serverFolder, "server.properties");
  if (!fs.existsSync(propertiesPath)) return "world";
  const parsed = parseProperties(fs.readFileSync(propertiesPath, "utf8"));
  return safeWorldName(parsed.values["level-name"] || "world");
}

function worldCandidates(serverFolder) {
  const name = configuredWorldName(serverFolder);
  return [
    { sourceName: name, archiveName: "world" },
    { sourceName: `${name}_nether`, archiveName: "world_nether" },
    { sourceName: `${name}_the_end`, archiveName: "world_the_end" },
  ].map((item) => ({ ...item, sourcePath: assertPathInside(serverFolder, path.join(serverFolder, item.sourceName)) }));
}

function collectWorldFiles(serverFolder) {
  const folders = worldCandidates(serverFolder).filter((item) => fs.existsSync(item.sourcePath) && fs.statSync(item.sourcePath).isDirectory());
  if (!folders.length || !fs.existsSync(path.join(folders[0].sourcePath, "level.dat"))) {
    throw new Error("This server has no generated world to export yet");
  }
  const files = [];
  let totalBytes = 0;
  let entries = 0;
  const walk = (folder, directory, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED_FILES.has(entry.name.toLowerCase())) continue;
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("The world contains too many files to export safely");
      const sourcePath = assertPathInside(folder.sourcePath, path.join(directory, entry.name));
      const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be exported (${nextRelative})`);
      if (entry.isDirectory()) walk(folder, sourcePath, nextRelative);
      else if (entry.isFile()) {
        const size = fs.statSync(sourcePath).size;
        totalBytes += size;
        if (totalBytes > MAX_WORLD_BYTES) throw new Error("The world is too large to export safely");
        files.push({
          sourcePath,
          archivePath: `${folder.archiveName}/${nextRelative.replaceAll("\\", "/")}`,
          mtime: fs.statSync(sourcePath).mtime,
        });
      } else throw new Error(`Unsupported world file type (${nextRelative})`);
    }
  };
  for (const folder of folders) walk(folder, folder.sourcePath);
  return { folders, files, totalBytes };
}

function writeZip(destination, entries, manifest) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(destination, { flags: "wx" });
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
    zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), MANIFEST_NAME, { mtime: ZIP_EPOCH });
    for (const entry of entries) zip.addFile(entry.sourcePath, entry.archivePath, { mtime: entry.mtime || ZIP_EPOCH, mode: 0o100644 });
    zip.end();
  });
}

export async function exportWorld(serverFolder, destination, options = {}) {
  const root = path.resolve(serverFolder);
  const target = path.resolve(destination);
  if (path.extname(target).toLowerCase() !== ".zip") throw new Error("World exports must use the .zip extension");
  if (fs.existsSync(target)) throw new Error("A world export with this name already exists");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.partial-${crypto.randomUUID()}`;
  try {
    emitProgress(options.onProgress, "scan", 5, "Scanning world files…");
    const collected = collectWorldFiles(root);
    const manifest = {
      format: "blockhost-world",
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      originalWorldName: configuredWorldName(root),
      folders: collected.folders.map((folder) => folder.archiveName),
    };
    emitProgress(options.onProgress, "archive", 35, `Creating world archive with ${collected.files.length} files…`);
    await writeZip(temporary, collected.files, manifest);
    fs.renameSync(temporary, target);
    emitProgress(options.onProgress, "complete", 100, "World export complete.");
    return { path: target, fileName: path.basename(target), fileCount: collected.files.length, totalBytes: collected.totalBytes };
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function portableEntryPath(value) {
  const text = String(value || "").replaceAll("\\", "/");
  if (!text || text.includes("\0") || text.startsWith("/") || /^[a-z]:/i.test(text)) throw new Error("The world ZIP contains an unsafe absolute path");
  const directory = text.endsWith("/");
  const parts = text.split("/");
  if (directory) parts.pop();
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) throw new Error("The world ZIP contains an unsafe traversal path");
  return `${parts.join("/")}${directory ? "/" : ""}`;
}

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(new Error(`Could not open the world ZIP: ${error.message}`));
      else resolve(zip);
    });
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

async function extractZip(source, destination, onProgress) {
  const zip = await openZip(source);
  let entries = 0;
  let totalBytes = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch {}
      reject(error);
    };
    zip.on("error", (error) => fail(new Error(`The world ZIP is damaged: ${error.message}`)));
    zip.on("close", () => { if (!settled) { settled = true; resolve(); } });
    zip.on("entry", (entry) => {
      Promise.resolve().then(async () => {
        entries += 1;
        if (entries > MAX_ENTRIES) throw new Error("The world ZIP contains too many files");
        const entryPath = portableEntryPath(entry.fileName);
        if (entry.generalPurposeBitFlag & 1) throw new Error("Encrypted world ZIPs are not supported");
        if (![0, 8].includes(entry.compressionMethod)) throw new Error(`Unsupported ZIP compression for ${entryPath}`);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const fileType = mode & 0o170000;
        if (fileType && fileType !== 0o100000 && fileType !== 0o040000) throw new Error(`Links and device files are not allowed (${entryPath})`);
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_WORLD_BYTES) throw new Error("The world ZIP is too large to import safely");
        if (entry.uncompressedSize >= RATIO_MINIMUM_BYTES && entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_COMPRESSION_RATIO) {
          throw new Error(`Unsafe compression ratio in ${entryPath}`);
        }
        const output = assertPathInside(destination, path.join(destination, ...entryPath.replace(/\/$/, "").split("/")));
        if (entryPath.endsWith("/")) fs.mkdirSync(output, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(output), { recursive: true });
          await pipeline(await openEntryStream(zip, entry), fs.createWriteStream(output, { flags: "wx" }));
        }
        emitProgress(onProgress, "extract", Math.min(70, 10 + entries / 20), `Extracting world files… (${entries})`);
      }).then(() => zip.readEntry()).catch(fail);
    });
    zip.readEntry();
  });
}

function copyTree(sourceRoot, destinationRoot) {
  let totalBytes = 0;
  let entries = 0;
  const walk = (source, destination) => {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (SKIPPED_FILES.has(entry.name.toLowerCase())) continue;
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("The world contains too many files");
      const sourcePath = path.join(source, entry.name);
      const destinationPath = assertPathInside(destinationRoot, path.join(destination, entry.name));
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be imported (${entry.name})`);
      if (entry.isDirectory()) walk(sourcePath, destinationPath);
      else if (entry.isFile()) {
        totalBytes += fs.statSync(sourcePath).size;
        if (totalBytes > MAX_WORLD_BYTES) throw new Error("The world is too large to import safely");
        fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      } else throw new Error(`Unsupported world file type (${entry.name})`);
    }
  };
  walk(sourceRoot, destinationRoot);
}

function findWorldSet(sourceRoot) {
  let main;
  let container;
  if (fs.existsSync(path.join(sourceRoot, "level.dat"))) {
    main = sourceRoot;
    container = path.dirname(sourceRoot);
  } else {
    const children = fs.readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(sourceRoot, entry.name, "level.dat")))
      .map((entry) => path.join(sourceRoot, entry.name));
    const preferred = children.find((candidate) => path.basename(candidate).toLowerCase() === "world")
      || children.find((candidate) => !/_nether$|_the_end$/i.test(path.basename(candidate)));
    if (!preferred) throw new Error("No Minecraft world with level.dat was found in the selected source");
    const ordinary = children.filter((candidate) => !/_nether$|_the_end$/i.test(path.basename(candidate)));
    if (ordinary.length > 1 && !children.some((candidate) => path.basename(candidate).toLowerCase() === "world")) {
      throw new Error("The selected source contains multiple possible worlds. Choose one world folder directly.");
    }
    main = preferred;
    container = sourceRoot;
  }
  const name = path.basename(main);
  const companions = [
    { source: path.join(container, `${name}_nether`), destination: "world_nether" },
    { source: path.join(container, `${name}_the_end`), destination: "world_the_end" },
  ].filter((item) => fs.existsSync(item.source) && fs.statSync(item.source).isDirectory());
  return [{ source: main, destination: "world" }, ...companions];
}

export async function importWorld(sourcePath, serverFolder, options = {}) {
  const source = path.resolve(sourcePath);
  const root = path.resolve(serverFolder);
  if (!fs.existsSync(source)) throw new Error("The selected world source no longer exists");
  const staging = assertPathInside(root, path.join(root, `.blockhost-world-import-${crypto.randomUUID()}`));
  const extracted = path.join(staging, "source");
  try {
    fs.mkdirSync(extracted, { recursive: true });
    if (fs.statSync(source).isDirectory()) {
      emitProgress(options.onProgress, "copy", 10, "Reading the selected world folder…");
      copyTree(source, extracted);
    } else if (path.extname(source).toLowerCase() === ".zip") {
      await extractZip(source, extracted, options.onProgress);
    } else throw new Error("Choose a Minecraft world folder or ZIP file");

    const worldSet = findWorldSet(extracted);
    for (const item of worldSet) {
      const destination = assertPathInside(root, path.join(root, item.destination));
      if (fs.existsSync(destination)) throw new Error(`The destination already contains ${item.destination}`);
      copyTree(item.source, destination);
    }
    const propertiesPath = path.join(root, "server.properties");
    const existing = fs.existsSync(propertiesPath) ? fs.readFileSync(propertiesPath, "utf8") : "";
    const parsed = parseProperties(existing);
    fs.writeFileSync(propertiesPath, serializeProperties(parsed, { "level-name": "world" }), "utf8");
    emitProgress(options.onProgress, "complete", 100, "World imported successfully.");
    return { folders: worldSet.map((item) => item.destination), sourceName: path.basename(source) };
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}
