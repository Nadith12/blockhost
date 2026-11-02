import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { assertPathInside } from "./safe-filesystem.mjs";

const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const DOWNLOAD_HOSTS = new Set(["github.com", "api.adoptium.net"]);
const READY_MARKER = ".blockhost-java-ready";

function emitProgress(listener, stage, percent, message) {
  listener?.({ stage, percent: Math.max(0, Math.min(100, Math.round(percent))), message });
}

function safeEntryPath(value) {
  const text = String(value || "").replaceAll("\\", "/");
  if (!text || text.includes("\0") || text.startsWith("/") || /^[a-z]:/i.test(text)) {
    throw new Error("The Java archive contains an unsafe absolute path");
  }
  const directory = text.endsWith("/");
  const parts = text.split("/");
  if (directory) parts.pop();
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("The Java archive contains an unsafe traversal path");
  }
  return `${parts.join("/")}${directory ? "/" : ""}`;
}

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(new Error(`Could not open the Java archive: ${error.message}`));
      else resolve(zip);
    });
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

async function extractRuntime(archivePath, destination, onProgress) {
  const zip = await openZip(archivePath);
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
    zip.on("error", (error) => fail(new Error(`The Java archive is damaged: ${error.message}`)));
    zip.on("close", () => { if (!settled) { settled = true; resolve(); } });
    zip.on("entry", (entry) => {
      Promise.resolve().then(async () => {
        entries += 1;
        if (entries > MAX_ENTRIES) throw new Error("The Java archive contains too many files");
        const entryPath = safeEntryPath(entry.fileName);
        if (entry.generalPurposeBitFlag & 1) throw new Error("Encrypted Java archives are not supported");
        if (![0, 8].includes(entry.compressionMethod)) throw new Error(`Unsupported Java archive compression (${entryPath})`);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const fileType = mode & 0o170000;
        if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
          throw new Error(`Links and device files are not allowed in the Java archive (${entryPath})`);
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error("The extracted Java runtime is unexpectedly large");
        const output = assertPathInside(destination, path.join(destination, ...entryPath.replace(/\/$/, "").split("/")));
        if (entryPath.endsWith("/")) fs.mkdirSync(output, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(output), { recursive: true });
          await pipeline(await openEntryStream(zip, entry), fs.createWriteStream(output, { flags: "wx" }));
        }
        emitProgress(onProgress, "extract", Math.min(90, 70 + entries / 80), `Preparing Java… (${entries} files)`);
      }).then(() => zip.readEntry()).catch(fail);
    });
    zip.readEntry();
  });
}

export function findJavaExecutable(rootPath, platform = process.platform) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) return "";
  const expected = platform === "win32" ? "java.exe" : "java";
  const stack = [{ directory: root, depth: 0 }];
  while (stack.length) {
    const { directory, depth } = stack.pop();
    if (depth > 5) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === expected && path.basename(directory).toLowerCase() === "bin") {
        return candidate;
      }
      if (entry.isDirectory()) stack.push({ directory: candidate, depth: depth + 1 });
    }
  }
  return "";
}

export function isManagedJavaReady(rootPath) {
  return fs.existsSync(path.join(path.resolve(rootPath), READY_MARKER));
}

async function getPackageMetadata(javaVersion, fetchImpl) {
  const assetsUrl = `https://api.adoptium.net/v3/assets/latest/${javaVersion}/hotspot?architecture=x64&heap_size=normal&image_type=jre&jvm_impl=hotspot&os=windows&page=0&page_size=1&project=jdk&release_type=ga&sort_method=DEFAULT&sort_order=DESC&vendor=eclipse`;
  const response = await fetchImpl(assetsUrl, {
    headers: { Accept: "application/json", "User-Agent": "BlockHostManager/1.0.4" },
  });
  if (!response.ok) throw new Error(`Java provider returned HTTP ${response.status}`);
  const assets = await response.json();
  const packageInfo = assets?.[0]?.binary?.package;
  const link = String(packageInfo?.link || "");
  const checksum = String(packageInfo?.checksum || "").toLowerCase();
  const size = Number(packageInfo?.size);
  let parsed;
  try { parsed = new URL(link); } catch { throw new Error("Java provider returned an invalid download URL"); }
  if (parsed.protocol !== "https:" || !DOWNLOAD_HOSTS.has(parsed.hostname)) throw new Error("Java provider returned an untrusted download URL");
  if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error("Java provider did not supply a valid SHA-256 checksum");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ARCHIVE_BYTES) throw new Error("Java provider returned an invalid package size");
  return { link, checksum, size };
}

async function downloadPackage(packageInfo, destination, fetchImpl, onProgress) {
  const response = await fetchImpl(packageInfo.link, { headers: { "User-Agent": "BlockHostManager/1.0.4" } });
  if (!response.ok || !response.body) throw new Error(`Java download failed with HTTP ${response.status}`);
  const hash = crypto.createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES || received > packageInfo.size) return callback(new Error("Java download exceeded its published size"));
      hash.update(chunk);
      emitProgress(onProgress, "download", 5 + (received / packageInfo.size) * 60, `Downloading Java 21… ${Math.floor(received / 1024 / 1024)} MB`);
      callback(null, chunk);
    },
  });
  const input = typeof response.body.getReader === "function" ? Readable.fromWeb(response.body) : response.body;
  await pipeline(input, meter, fs.createWriteStream(destination, { flags: "wx" }));
  if (received !== packageInfo.size) throw new Error("Java download size did not match the provider metadata");
  if (hash.digest("hex") !== packageInfo.checksum) throw new Error("Java download failed SHA-256 verification");
}

export async function installManagedJava(options) {
  const javaVersion = Number(options.javaVersion || 25);
  if (![21, 25].includes(javaVersion)) throw new Error("BlockHost cannot automatically install that Java version");
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const destination = assertPathInside(runtimeRoot, path.join(runtimeRoot, `java-${javaVersion}`));
  const archive = assertPathInside(runtimeRoot, path.join(runtimeRoot, `.java-download-${crypto.randomUUID()}.zip`));
  const fetchImpl = options.fetchImpl || fetch;
  fs.mkdirSync(runtimeRoot, { recursive: true });
  try {
    emitProgress(options.onProgress, "metadata", 2, `Finding the official Java ${javaVersion} package…`);
    const packageInfo = await getPackageMetadata(javaVersion, fetchImpl);
    await downloadPackage(packageInfo, archive, fetchImpl, (progress) => options.onProgress?.({
      ...progress,
      message: progress.stage === "download" ? progress.message.replace("Java 21", `Java ${javaVersion}`) : progress.message,
    }));
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    try {
      await extractRuntime(archive, destination, options.onProgress);
      const executable = findJavaExecutable(destination, "win32");
      if (!executable) throw new Error("The downloaded package did not contain Java");
      emitProgress(options.onProgress, "validate", 95, "Checking the Java runtime…");
      const validation = await options.validateJava?.(executable);
      fs.writeFileSync(path.join(destination, READY_MARKER), `BlockHost managed Java ${javaVersion}\n`, { encoding: "utf8", flag: "wx" });
      emitProgress(options.onProgress, "complete", 100, `Java ${javaVersion} is ready.`);
      return { executable, destination, javaVersion, packageSize: packageInfo.size, details: validation?.details || null };
    } catch (error) {
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  } finally {
    if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
  }
}

export async function cleanupManagedJavaArtifacts(runtimeRoot) {
  const root = path.resolve(runtimeRoot);
  if (!fs.existsSync(root)) return;
  const abandoned = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => /^\.java-(?:install|download)-[0-9a-f-]+(?:\.zip)?$/i.test(entry.name))
    .map((entry) => assertPathInside(root, path.join(root, entry.name)));
  await Promise.allSettled(abandoned.map((candidate) => fs.promises.rm(candidate, { recursive: true, force: true })));
}
