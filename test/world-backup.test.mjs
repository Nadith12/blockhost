import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { backupFileName, backupIsDue, createWorldBackup, getBackupSettings, saveBackupSettings } from "../src/lib/world-backup.mjs";

function workspace() { return fs.mkdtempSync(path.join(process.cwd(), "test/.world-backup-")); }

test("backup settings validate destinations and calculate the next interval", () => {
  const root = workspace();
  try {
    assert.throws(() => saveBackupSettings(root, { enabled: true }), /Choose a backup folder/);
    const now = new Date("2026-01-02T03:00:00.000Z");
    const settings = saveBackupSettings(root, { enabled: true, destination: path.join(root, "backups"), schedule: "on-stop", intervalMinutes: 30 }, now);
    assert.equal(settings.nextBackupAt, "2026-01-02T03:30:00.000Z");
    assert.equal(settings.mode, "replace");
    assert.equal(Object.hasOwn(settings, "schedule"), false);
    assert.equal(backupIsDue(settings, new Date("2026-01-02T03:31:00.000Z")), false, "an offline server is never due");
    assert.equal(backupIsDue(settings, new Date("2026-01-02T03:29:00.000Z"), now.toISOString()), false);
    assert.equal(backupIsDue(settings, new Date("2026-01-02T03:31:00.000Z"), now.toISOString()), true);
    assert.equal(backupIsDue(settings, new Date("2026-01-02T03:31:00.000Z"), "2026-01-02T03:15:00.000Z"), false, "a new run waits a full interval");
    assert.equal(saveBackupSettings(root, { mode: "history" }).mode, "history");
    saveBackupSettings(root, { mode: "replace" });
    assert.deepEqual(getBackupSettings(root), settings);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("world backups can stack or replace the latest archive", async () => {
  const root = workspace();
  try {
    const serverFolder = path.join(root, "server");
    const destination = path.join(root, "backups");
    fs.mkdirSync(path.join(serverFolder, "world"), { recursive: true });
    fs.writeFileSync(path.join(serverFolder, "world", "level.dat"), "first");
    const server = { name: "My World", folderPath: serverFolder };
    const first = await createWorldBackup(server, { destination, mode: "history" }, { now: new Date("2026-01-02T03:04:05.000Z") });
    assert.equal(first.fileName, backupFileName("My World", "history", new Date("2026-01-02T03:04:05.000Z")));
    assert.equal(fs.existsSync(first.path), true);
    const latest = await createWorldBackup(server, { destination, mode: "replace" });
    fs.writeFileSync(path.join(serverFolder, "world", "level.dat"), "second");
    const replaced = await createWorldBackup(server, { destination, mode: "replace" });
    assert.equal(replaced.path, latest.path);
    assert.deepEqual(fs.readdirSync(destination).sort(), [first.fileName, latest.fileName].sort());
    const savedZip = fs.readFileSync(replaced.path);
    fs.unlinkSync(path.join(serverFolder, "world", "level.dat"));
    await assert.rejects(() => createWorldBackup(server, { destination, mode: "replace" }), /no generated world/);
    assert.deepEqual(fs.readFileSync(replaced.path), savedZip);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
