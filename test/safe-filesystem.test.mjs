import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertPathInside,
  atomicWriteFile,
  restoreFileBackup,
  writeFileWithBackup,
} from "../src/lib/safe-filesystem.mjs";

test("atomicWriteFile replaces a file without leaving temporary siblings", () => {
  const folder = fs.mkdtempSync(path.join(process.cwd(), ".test-tmp-fs-"));
  try {
    const target = path.join(folder, "server.properties");
    fs.writeFileSync(target, "before\n");
    atomicWriteFile(target, "after\n");
    assert.equal(fs.readFileSync(target, "utf8"), "after\n");
    assert.deepEqual(fs.readdirSync(folder), ["server.properties"]);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("writeFileWithBackup can restore both existing and newly created files", () => {
  const folder = fs.mkdtempSync(path.join(process.cwd(), ".test-tmp-backup-"));
  try {
    const existing = path.join(folder, "existing.txt");
    fs.writeFileSync(existing, "original");
    const existingTransaction = writeFileWithBackup(existing, "changed");
    restoreFileBackup(existingTransaction);
    assert.equal(fs.readFileSync(existing, "utf8"), "original");

    const created = path.join(folder, "created.txt");
    const createdTransaction = writeFileWithBackup(created, "new");
    restoreFileBackup(createdTransaction);
    assert.equal(fs.existsSync(created), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("assertPathInside rejects traversal and the root itself", () => {
  const root = path.resolve("servers");
  assert.equal(assertPathInside(root, path.join(root, "one", "file.txt")), path.join(root, "one", "file.txt"));
  assert.throws(() => assertPathInside(root, path.dirname(root)), /outside/);
  assert.throws(() => assertPathInside(root, root), /outside/);
});
