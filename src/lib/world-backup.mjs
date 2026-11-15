import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./safe-filesystem.mjs";
import { exportWorld } from "./world-manager.mjs";

const SETTINGS_FILE = ".blockhost-backup.json";
const MODES = new Set(["replace", "history"]);
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

function safeName(value) {
  return String(value || "Minecraft server").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "Minecraft-server";
}

function validDate(value) {
  return Number.isFinite(Date.parse(value)) ? String(value) : "";
}

export function normalizeBackupSettings(value = {}) {
  const interval = Math.round(Number(value.intervalMinutes) || 60);
  return {
    enabled: Boolean(value.enabled),
    destination: path.isAbsolute(String(value.destination || "")) ? path.resolve(String(value.destination)) : "",
    intervalMinutes: Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, interval)),
    mode: MODES.has(value.mode) ? value.mode : "replace",
    nextBackupAt: validDate(value.nextBackupAt),
    lastBackupAt: validDate(value.lastBackupAt),
    lastBackupPath: path.isAbsolute(String(value.lastBackupPath || "")) ? path.resolve(String(value.lastBackupPath)) : "",
    lastError: String(value.lastError || "").slice(0, 500),
  };
}

export function getBackupSettings(serverFolder) {
  try {
    return normalizeBackupSettings(JSON.parse(fs.readFileSync(path.join(serverFolder, SETTINGS_FILE), "utf8")));
  } catch {
    return normalizeBackupSettings();
  }
}

export function saveBackupSettings(serverFolder, changes, now = new Date()) {
  const current = getBackupSettings(serverFolder);
  const next = normalizeBackupSettings({ ...current, ...changes });
  if (next.enabled && !next.destination) throw new Error("Choose a backup folder before enabling automatic backups");
  if (next.enabled) {
    const scheduleChanged = current.intervalMinutes !== next.intervalMinutes || !current.enabled;
    if (scheduleChanged || !next.nextBackupAt) next.nextBackupAt = new Date(now.getTime() + next.intervalMinutes * 60_000).toISOString();
  } else next.nextBackupAt = "";
  atomicWriteFile(path.join(serverFolder, SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function backupIsDue(settings, now = new Date(), startedAt) {
  const normalized = normalizeBackupSettings(settings);
  const start = Date.parse(startedAt);
  if (!normalized.enabled || !normalized.destination || !Number.isFinite(start)) return false;
  const first = start + normalized.intervalMinutes * 60_000;
  return now.getTime() >= Math.max(first, Date.parse(normalized.nextBackupAt) || 0);
}

export function backupFileName(serverName, mode, now = new Date()) {
  const base = safeName(serverName);
  if (mode === "replace") return `${base}-latest.zip`;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${base}-${stamp}.zip`;
}

export async function createWorldBackup(server, settings, options = {}) {
  const config = normalizeBackupSettings(settings);
  if (!config.destination) throw new Error("Choose a backup folder first");
  fs.mkdirSync(config.destination, { recursive: true });
  const now = options.now || new Date();
  const fileName = backupFileName(server.name, config.mode, now);
  const target = path.join(config.destination, fileName);
  const temporary = path.join(config.destination, `.blockhost-${crypto.randomUUID()}.partial.zip`);
  try {
    const result = await exportWorld(server.folderPath, temporary, options);
    // Replace the old file directly. If the rename fails, the old ZIP stays put.
    fs.renameSync(temporary, target);
    return { ...result, path: target, fileName, completedAt: now.toISOString() };
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function recordBackupResult(serverFolder, settings, result, now = new Date()) {
  const next = normalizeBackupSettings({
    ...settings,
    lastBackupAt: result?.completedAt || now.toISOString(),
    lastBackupPath: result?.path || "",
    lastError: "",
    nextBackupAt: settings.enabled
      ? new Date(now.getTime() + settings.intervalMinutes * 60_000).toISOString()
      : "",
  });
  atomicWriteFile(path.join(serverFolder, SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function recordBackupError(serverFolder, settings, error) {
  const next = normalizeBackupSettings({
    ...settings,
    lastError: error?.message || String(error),
    nextBackupAt: settings.enabled
      ? new Date(Date.now() + settings.intervalMinutes * 60_000).toISOString()
      : "",
  });
  atomicWriteFile(path.join(serverFolder, SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
