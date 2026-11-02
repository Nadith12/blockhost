import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_SERVER_SCHEMA_VERSION,
  metadataNeedsMigration,
  migrateServerMetadata,
} from "../src/lib/server-metadata.mjs";

test("legacy metadata migrates without losing unknown fields", () => {
  const migrated = migrateServerMetadata({
    id: 123,
    name: "Legacy",
    type: "paper",
    version: "1.21.1",
    color: "#abcdef",
    customFutureField: { keep: true },
  }, { folderPath: "C:/servers/legacy", entryName: "legacy-123" });

  assert.equal(migrated.schemaVersion, CURRENT_SERVER_SCHEMA_VERSION);
  assert.equal(migrated.id, 123);
  assert.equal(migrated.type, "paper");
  assert.equal(Object.hasOwn(migrated, "folderPath"), false);
  assert.equal(Object.hasOwn(migrated, "jarPath"), false);
  assert.equal(migrated.jarFile, "server.jar");
  assert.equal(migrated.minMemoryMb, 512);
  assert.equal(migrated.maxMemoryMb, 0);
  assert.deepEqual(migrated.customFutureField, { keep: true });
  assert.equal(metadataNeedsMigration({}), true);
  assert.equal(metadataNeedsMigration(migrated), false);
});

test("metadata rejects unsafe ids and normalizes unsupported values", () => {
  assert.throws(() => migrateServerMetadata({ id: "not-an-id" }), /Invalid server metadata id/);
  const migrated = migrateServerMetadata({ id: 5, type: "unknown", color: "red" });
  assert.equal(migrated.type, "vanilla");
  assert.equal(migrated.color, "#39c9ff");
  const memory = migrateServerMetadata({ id: 6, minMemoryMb: 1024, maxMemoryMb: 6144 });
  assert.equal(memory.minMemoryMb, 1024);
  assert.equal(memory.maxMemoryMb, 6144);
});
