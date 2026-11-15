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
const DOWNLOAD_HOSTS = new Set(["github.com", "api.adoptium.net", "cdn.azul.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
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
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]|[. ]$/.test(part))) {
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
  if (javaVersion === 16) {
    const url = "https://api.azul.com/metadata/v1/zulu/packages/?java_version=16&os=windows&arch=x64&archive_type=zip&java_package_type=jdk&javafx_bundled=false&availability_types=CA&release_status=ga&latest=true&include_fields=sha256_hash&page_size=1";
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("Java 16 provider returned HTTP " + response.status);
    const [asset] = await response.json();
    const link = new URL(asset?.download_url || "https://invalid.invalid");
    if (link.protocol !== "https:" || link.hostname !== "cdn.azul.com" || !/^[0-9a-f]{64}$/i.test(asset?.sha256_hash || "")) {
      throw new Error("The Java 16 provider did not supply a verified Windows x64 archive.");
    }
    return { link: link.href, checksum: asset.sha256_hash.toLowerCase(), size: 0 };
  }
  const assetsUrl = `https://api.adoptium.net/v3/assets/latest/${javaVersion}/hotspot?architecture=x64&heap_size=normal&image_type=jre&jvm_impl=hotspot&os=windows&page=0&page_size=1&project=jdk&release_type=ga&sort_method=DEFAULT&sort_order=DESC&vendor=eclipse`;
  const response = await fetchImpl(assetsUrl, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", "User-Agent": "BlockHostManager/1.0.6" },
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

async function downloadPackage(packageInfo, destination, fetchImpl, onProgress, javaVersion) {
  let url = new URL(packageInfo.link);
  const signal = AbortSignal.timeout(10 * 60_000);
  let response;
  for (let redirects = 0; redirects < 5; redirects++) {
    if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
      throw new Error("Java download redirected to an untrusted address.");
    }
    response = await fetchImpl(url.href, { redirect: "manual", signal, headers: { "User-Agent": "BlockHostManager/1.0.6" } });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Java download redirect is missing its destination.");
    url = new URL(location, url);
  }
  if (!response.ok || !response.body) throw new Error(`Java download failed with HTTP ${response.status}`);
  const hash = crypto.createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES || (packageInfo.size && received > packageInfo.size)) return callback(new Error("Java download exceeded its published size"));
      hash.update(chunk);
      emitProgress(onProgress, "download", packageInfo.size ? 5 + (received / packageInfo.size) * 60 : 5, "Downloading Java " + javaVersion + "… " + Math.floor(received / 1024 / 1024) + " MB");
      callback(null, chunk);
    },
  });
  const input = typeof response.body.getReader === "function" ? Readable.fromWeb(response.body) : response.body;
  await pipeline(input, meter, fs.createWriteStream(destination, { flags: "wx" }));
  if (packageInfo.size && received !== packageInfo.size) throw new Error("Java download size did not match the provider metadata");
  if (hash.digest("hex") !== packageInfo.checksum) throw new Error("Java download failed SHA-256 verification");
}

export async function installManagedJava(options) {
  const javaVersion = Number(options.javaVersion || 25);
  if (!Number.isSafeInteger(javaVersion) || javaVersion < 8 || javaVersion > 99) throw new Error("BlockHost cannot automatically install that Java version");
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const destination = assertPathInside(runtimeRoot, path.join(runtimeRoot, `java-${javaVersion}`));
  const archive = assertPathInside(runtimeRoot, path.join(runtimeRoot, `.java-download-${crypto.randomUUID()}.zip`));
  const staging = assertPathInside(runtimeRoot, path.join(runtimeRoot, ".java-install-" + crypto.randomUUID()));
  const payload = path.join(staging, "runtime");
  const previous = path.join(staging, "previous");
  const fetchImpl = options.fetchImpl || fetch;
  fs.mkdirSync(runtimeRoot, { recursive: true });
  try {
    emitProgress(options.onProgress, "metadata", 2, `Finding the official Java ${javaVersion} package…`);
    const packageInfo = await getPackageMetadata(javaVersion, fetchImpl);
    const disk = await fs.promises.statfs(runtimeRoot).catch(() => null);
    if (disk && disk.bavail * disk.bsize < packageInfo.size + MAX_EXTRACTED_BYTES) throw new Error("Not enough free disk space to install Java.");
    await downloadPackage(packageInfo, archive, fetchImpl, options.onProgress, javaVersion);
    fs.mkdirSync(payload, { recursive: true });
    await extractRuntime(archive, payload, options.onProgress);
    const executable = findJavaExecutable(payload, "win32");
    if (!executable) throw new Error("The downloaded package did not contain Java");
    emitProgress(options.onProgress, "validate", 95, "Checking the Java runtime…");
    const validation = await options.validateJava?.(executable);
    fs.writeFileSync(path.join(payload, READY_MARKER), "BlockHost managed Java " + javaVersion + "\n", { encoding: "utf8", flag: "wx" });
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    try { fs.renameSync(payload, destination); } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, destination);
      throw error;
    }
    emitProgress(options.onProgress, "finalize", 98, "Finishing Java setup…");
    return { executable: path.join(destination, path.relative(payload, executable)), destination, javaVersion, packageSize: packageInfo.size, details: validation?.details || null };
  } finally {
    if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
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
