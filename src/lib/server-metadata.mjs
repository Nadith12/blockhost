export const CURRENT_SERVER_SCHEMA_VERSION = 3;

const SERVER_TYPES = new Set(["vanilla", "paper", "fabric", "forge", "neoforge"]);
const DEFAULT_COLOR = "#39c9ff";

function normalizeType(value) {
  return SERVER_TYPES.has(value) ? value : "vanilla";
}

function normalizeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : DEFAULT_COLOR;
}

export function migrateServerMetadata(metadata, context = {}) {
  const source = metadata && typeof metadata === "object" ? metadata : {};
  const fallbackId = Number(String(context.entryName || "").split("-").at(-1));
  const id = Number(source.id || fallbackId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid server metadata id");

  const type = normalizeType(source.type);
  const {
    folderPath: _legacyFolderPath,
    jarPath: _legacyJarPath,
    typeLabel: _legacyTypeLabel,
    lastStoppedAt: _unusedLastStoppedAt,
    lastRunDurationMs: _unusedLastRunDurationMs,
    ...portableSource
  } = source;
  const launchType = source.launchType === "javaArgsFile" ? "javaArgsFile" : "jar";
  const migrated = {
    ...portableSource,
    schemaVersion: CURRENT_SERVER_SCHEMA_VERSION,
    id,
    name: String(source.name || context.entryName || "Minecraft server").trim() || "Minecraft server",
    type,
    version: String(source.version || "unknown"),
    loaderVersion: String(source.loaderVersion || ""),
    color: normalizeColor(source.color),
    launchType,
    jarFile: launchType === "jar" ? String(source.jarFile || "server.jar") : "",
    launchArgsPath: String(source.launchArgsPath || ""),
    createdAt: String(source.createdAt || ""),
    lastModifiedAt: String(source.lastModifiedAt || source.createdAt || ""),
    addonsManifestVersion: Number.isSafeInteger(Number(source.addonsManifestVersion))
      ? Number(source.addonsManifestVersion)
      : 1,
    minMemoryMb: Number.isSafeInteger(Number(source.minMemoryMb)) && Number(source.minMemoryMb) >= 512
      ? Number(source.minMemoryMb)
      : 512,
    maxMemoryMb: Number.isSafeInteger(Number(source.maxMemoryMb)) && Number(source.maxMemoryMb) >= 512
      ? Number(source.maxMemoryMb)
      : 0,
    lastStartedAt: Number.isFinite(Date.parse(source.lastStartedAt)) ? String(source.lastStartedAt) : "",
  };
  return migrated;
}

export function metadataNeedsMigration(metadata) {
  return Number(metadata?.schemaVersion) !== CURRENT_SERVER_SCHEMA_VERSION;
}
