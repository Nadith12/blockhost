import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl";

const MAX_ZIP_ENTRIES = 100_000;

function zipPaths(source) {
  return new Promise((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(new Error("This ZIP could not be read. Choose a complete archive."));
      if (zip.entryCount > MAX_ZIP_ENTRIES) {
        zip.close();
        return reject(new Error("This archive contains too many entries."));
      }
      const files = [];
      zip.once("error", reject);
      zip.once("end", () => resolve(files));
      zip.on("entry", (entry) => {
        if (!entry.fileName.endsWith("/")) files.push(entry.fileName);
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

async function folderPaths(source) {
  const files = [];
  const scan = async (folder, prefix, depth) => {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isFile()) files.push(relative);
      else if (entry.isDirectory() && depth) await scan(path.join(folder, entry.name), relative + "/", depth - 1);
    }
  };
  await scan(source, "", 1);
  return files;
}

export const START_SCRIPT = /^(?:start|startserver|serverstart|run)\.(?:bat|cmd|ps1|sh)$/i;
export const LOADER_INSTALLER = /^(forge|neoforge)-([\da-z.-]+)-installer\.jar$/i;

export function starterPackRoots(files) {
  const roots = new Map();
  for (const file of files) {
    const parts = file.split("/");
    const modsIndex = parts.length - 2;
    if (modsIndex < 0 || modsIndex > 1 || parts[modsIndex].toLowerCase() !== "mods" || !/\.jar$/i.test(parts.at(-1))) continue;
    const root = parts.slice(0, modsIndex).join("/");
    roots.set(root.toLowerCase(), root);
  }
  const candidates = new Set();
  for (const file of files) {
    const parts = file.toLowerCase().split("/");
    const name = parts.pop();
    const root = parts.join("/");
    if (!roots.has(root)) continue;
    if (START_SCRIPT.test(name) || LOADER_INSTALLER.test(name)) candidates.add(roots.get(root));
  }
  return [...candidates];
}
function classifyPaths(files) {
  const names = new Set(files.map((file) => file.toLowerCase()));
  if (names.has("modrinth.index.json")) return "modpack";
  if (names.has("level.dat")) return "world";
  for (const file of names) {
    const parts = file.split("/");
    const root = parts.length === 2 ? parts[0] + "/" : "";
    if (parts.length <= 2 && /^(?:server(?:[-_.].*)?|minecraft_server.*|paper(?:[-_.]?\d.*)?|fabric.*server.*|quilt-server-launch|purpur(?:[-_.].*)?|forge-1\.\d+(?:\.\d+)?-[\d.]+(?:-universal)?)\.jar$/.test(parts.at(-1))) return "server";
    if (parts.length <= 2 && file.endsWith(".jar") && !/installer|packwiz/i.test(parts.at(-1)) && names.has(root + "server.properties")) return "server";
    if (/(^|\/)libraries\/net\/(?:minecraftforge\/forge|neoforged\/neoforge)\/[^/]+\/(?:win|unix)_args\.txt$/.test(file)) return "server";
  }
  if (starterPackRoots(files).length) return "server-starter";
  if ((names.has("pack.toml") && names.has("index.toml")) || [...names].some(name => /(^|\/)packwiz-installer[^/]*\.jar$/.test(name))) return "packwiz";
  if (names.has("mmc-pack.json") || names.has("bin/modpack.jar")) return "client-launcher";
  if ([...names].some(name => /^(?:[^/]+\/)?serverinstaller[^/]*\.exe$/i.test(name))) return "ftb-installer";
  if (names.has("manifest.json")) return "modpack";
  if ([...names].some((file) => /^[^/]+\/level\.dat$/.test(file))) return "world";
  if ([...names].some((file) => /\.jar$/i.test(file))) return "addon-bundle";
  return "unknown";
}

export async function detectDropSource(source) {
  const stats = await fs.promises.lstat(source);
  if (stats.isDirectory()) return classifyPaths(await folderPaths(source));
  if (!stats.isFile()) return "unknown";
  switch (path.extname(source).toLowerCase()) {
    case ".blockhost": return "blockhost";
    case ".exe": return /^serverinstaller/i.test(path.basename(source)) ? "ftb-installer" : "unknown";
    case ".mrpack":
    case ".zip": return classifyPaths(await zipPaths(source));
    case ".jar": {
      const files = (await zipPaths(source)).map((file) => file.toLowerCase());
      return files.some((file) => ["fabric.mod.json", "meta-inf/mods.toml", "meta-inf/neoforge.mods.toml", "paper-plugin.yml", "plugin.yml", "mcmod.info", "quilt.mod.json"].includes(file))
        ? "addon" : "unknown";
    }
    default: return "unknown";
  }
}

export async function detectDedicatedServerZip(source) {
  const files = await zipPaths(source);
  const paths = files.map((file) => file.toLowerCase());
  const launcherMetadata = paths.some((file) => /^(?:[^/]+\/)?(?:modrinth\.index\.json|mmc-pack\.json|instance\.cfg|bin\/modpack\.jar)$/.test(file));
  const kind = classifyPaths(files);
  // Some publisher server starters use the CurseForge manifest to pin their loader.
  const manifestRoots = new Set();
  const overrideRoots = new Set();
  const modRoots = new Set();
  function recordPath(root, file) {
    if (file === "manifest.json") manifestRoots.add(root);
    if (file.startsWith("overrides/")) overrideRoots.add(root);
    if (file.startsWith("mods/") && file.endsWith(".jar")) modRoots.add(root);
  }
  for (const file of paths) {
    recordPath("", file);
    const slash = file.indexOf("/");
    if (slash >= 0) recordPath(file.slice(0, slash + 1), file.slice(slash + 1));
  }
  const launcherOverrides = [...manifestRoots].some(root => overrideRoots.has(root) && !modRoots.has(root));
  if (launcherMetadata || launcherOverrides || kind === "modpack" || kind === "client-launcher") {
    throw new Error("This ZIP contains a client launcher manifest. Choose a dedicated Server Pack.");
  }
  if (kind !== "server" && kind !== "server-starter") {
    throw new Error("This Server Pack has no supported server launcher or starter layout.");
  }
  return kind;
}
