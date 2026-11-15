import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import { javaRequirement } from "./java-runtime.mjs";
import { inspectAddonJar } from "./addon-manager.mjs";

async function readJarEntry(jar, name, limit, { prefix = false, signal } = {}) {
  signal?.throwIfAborted();
  const zip = await yauzl.openPromise(jar, { lazyEntries: true });
  try {
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      if (entry.fileName !== name) continue;
      if (!prefix && entry.uncompressedSize > limit) return null;
      const chunks = [];
      let size = 0;
      for await (const chunk of await zip.openReadStreamPromise(entry)) {
        signal?.throwIfAborted();
        chunks.push(chunk.subarray(0, limit - size));
        size += chunk.length;
        if (prefix && size >= limit) break;
      }
      return Buffer.concat(chunks);
    }
    return null;
  } finally { zip.close(); }
}

export async function launcherJavaMinimum(jar, { signal } = {}) {
  signal?.throwIfAborted();
  if (!jar) return 0;
  try {
    const manifest = await readJarEntry(jar, "META-INF/MANIFEST.MF", 64 * 1024, { signal });
    const main = manifest?.toString("utf8").replace(/\r?\n /g, "").match(/^Main-Class:\s*([\w.$]+)\s*$/mi)?.[1];
    if (!main) return 0;
    const header = await readJarEntry(jar, main.replaceAll(".", "/") + ".class", 8, { prefix: true, signal });
    if (!header || header.length < 8 || header.readUInt32BE() !== 0xcafebabe) return 0;
    const version = header.readUInt16BE(6) - 44;
    return version >= 8 && version <= 99 ? version : 0;
  } catch {
    signal?.throwIfAborted();
    return 0;
  }
}

function javaConstraint(value) {
  const alternatives = Array.isArray(value) ? value : [value];
  const parsed = alternatives.map(item => typeof item === "string" ? item.trim().split(/\s+/) : []);
  if (parsed.some(parts => !parts.length || parts.some(part => !/^(?:[<>]=?|=)?\d+$/.test(part) && part !== "*"))) return null;
  return major => parsed.some(parts => parts.every(part => {
    if (part === "*") return true;
    const [, operator = "=", digits] = part.match(/^([<>]=?|=)?(\d+)$/);
    const target = Number(digits);
    if (operator === ">=") return major >= target;
    if (operator === ">") return major > target;
    if (operator === "<=") return major <= target;
    if (operator === "<") return major < target;
    return major === target;
  }));
}

const modCache = new Map();
const MOD_SCAN_BATCH_SIZE = 4;

async function inspectMod(file, loader, signal) {
  signal?.throwIfAborted();
  const { mtimeMs, size } = await fs.promises.stat(file);
  signal?.throwIfAborted();
  const cached = modCache.get(file);
  if (cached?.mtimeMs === mtimeMs && cached.size === size && cached.loader === loader) return cached.mod;
  const mod = await inspectAddonJar(file, loader, undefined, { signal }).catch(() => null);
  signal?.throwIfAborted();
  if (modCache.size >= 4096) modCache.clear();
  modCache.set(file, { mtimeMs, size, loader, mod });
  return mod;
}

export async function inspectServerJava(server, { signal } = {}) {
  signal?.throwIfAborted();
  const requirement = javaRequirement(server);
  const launcherMinimum = await launcherJavaMinimum(server.jarPath, { signal });
  signal?.throwIfAborted();
  let requiredMajor = Math.max(requirement.requiredMajor, launcherMinimum);
  let warning = requirement.warning;
  const recommended = Number(server.recommendedJavaMajor);
  const pinned = Number.isSafeInteger(recommended) && recommended === requirement.requiredMajor;
  if (pinned && launcherMinimum > recommended) {
    throw new Error("The pack recommends Java " + recommended + ", but its server launcher requires Java " + launcherMinimum + " or newer.");
  }
  const constraints = [];
  if (server.folderPath) {
    const directory = path.join(server.folderPath, "mods");
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    signal?.throwIfAborted();
    const files = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".jar"));
    for (let offset = 0; offset < files.length; offset += MOD_SCAN_BATCH_SIZE) {
      const batch = files.slice(offset, offset + MOD_SCAN_BATCH_SIZE);
      // Close all open JAR readers before the caller can roll back an add-on transaction.
      const inspected = await Promise.allSettled(batch.map(entry => inspectMod(path.join(directory, entry.name), server.type, signal)));
      signal?.throwIfAborted();
      for (const [index, result] of inspected.entries()) {
        if (result.status === "rejected") throw result.reason;
        const mod = result.value;
        if (!mod?.javaDependency || mod.environment === "client_only") continue;
        const check = javaConstraint(mod.javaDependency);
        if (check) constraints.push({ name: batch[index].name, check });
        else warning ||= "Some mods declare Java ranges that BlockHost could not evaluate. Verify this runtime against the pack’s requirements.";
      }
    }
    if (constraints.some(item => !item.check(requiredMajor))) {
      const candidates = pinned ? [] : Array.from({ length: 100 - requiredMajor }, (_, index) => requiredMajor + index);
      const match = candidates.find(major => constraints.every(item => item.check(major)));
      if (match === undefined) {
        const conflicting = constraints.filter(item => !item.check(requiredMajor)).map(item => item.name);
        throw new Error("The pack’s Java requirements conflict with Java " + requiredMajor + ": " + conflicting.slice(0, 5).join(", ") + ".");
      }
      requiredMajor = match;
    }
  }
  const versions = [...new Set([8, 11, 16, 17, 21, 25, requiredMajor])]
    .filter(major => major >= requiredMajor && constraints.every(item => item.check(major)))
    .sort((a, b) => a - b);
  return { requiredMajor, warning, versions };
}
