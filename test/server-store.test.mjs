import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  getSavedServers,
  updateServerMetadata,
  writeServerMetadata,
} from "../src/lib/server-store.mjs";

function temporaryRoot() {
  return fs.mkdtempSync(path.join(process.cwd(), "test", ".store-tmp-"));
}

test("server metadata is portable and runtime paths are reconstructed", () => {
  const root = temporaryRoot();
  try {
    const folder = path.join(root, "portable-123");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "server.jar"), "jar");
    writeServerMetadata(folder, {
      id: 123,
      name: "Portable",
      type: "paper",
      version: "1.21.1",
      color: "#abcdef",
      launchType: "jar",
      folderPath: folder,
      jarPath: path.join(folder, "server.jar"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const persisted = JSON.parse(fs.readFileSync(path.join(folder, "server-info.json"), "utf8"));
    assert.equal(Object.hasOwn(persisted, "folderPath"), false);
    assert.equal(Object.hasOwn(persisted, "jarPath"), false);
    assert.equal(persisted.jarFile, "server.jar");
    const loaded = getSavedServers(root)[0];
    assert.equal(loaded.folderPath, folder);
    assert.equal(loaded.jarPath, path.join(folder, "server.jar"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy external cached JARs migrate into the server folder", () => {
  const root = temporaryRoot();
  try {
    const folder = path.join(root, "legacy-456");
    const cache = path.join(root, "cache.jar");
    fs.mkdirSync(folder);
    fs.writeFileSync(cache, "legacy-cache");
    fs.writeFileSync(path.join(folder, "server-info.json"), JSON.stringify({
      schemaVersion: 2,
      id: 456,
      name: "Legacy",
      type: "vanilla",
      version: "1.20.1",
      launchType: "jar",
      folderPath: folder,
      jarPath: cache,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));

    const loaded = getSavedServers(root)[0];
    assert.equal(fs.readFileSync(path.join(folder, "server.jar"), "utf8"), "legacy-cache");
    assert.equal(loaded.jarPath, path.join(folder, "server.jar"));
    const persisted = JSON.parse(fs.readFileSync(path.join(folder, "server-info.json"), "utf8"));
    assert.equal(persisted.schemaVersion, 3);
    assert.equal(Object.hasOwn(persisted, "folderPath"), false);
    assert.equal(Object.hasOwn(persisted, "jarPath"), false);
    const migrationBackup = JSON.parse(fs.readFileSync(path.join(folder, "server-info.pre-blockhost-v3.json"), "utf8"));
    assert.equal(migrationBackup.schemaVersion, 2);
    assert.equal(migrationBackup.jarPath, cache);

    updateServerMetadata(folder, { name: "Renamed server", color: "#123456", lastModifiedAt: "later" });
    const updated = JSON.parse(fs.readFileSync(path.join(folder, "server-info.json"), "utf8"));
    assert.equal(updated.lastModifiedAt, "later");
    assert.equal(updated.name, "Renamed server");
    assert.equal(updated.color, "#123456");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
