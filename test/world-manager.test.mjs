import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yazl from "yazl";
import { exportWorld, importWorld } from "../src/lib/world-manager.mjs";

function temporary(label) {
  return fs.mkdtempSync(path.join(process.cwd(), `test/.world-${label}-`));
}

function createZip(filePath, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(filePath);
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
    for (const [name, contents] of entries) zip.addBuffer(Buffer.from(contents), name);
    zip.end();
  });
}

test("world export and creation-time import preserve dimensions and normalize level-name", async () => {
  const workspace = temporary("roundtrip");
  try {
    const sourceServer = path.join(workspace, "source-server");
    const destinationServer = path.join(workspace, "destination-server");
    const archive = path.join(workspace, "world-backup.zip");
    fs.mkdirSync(path.join(sourceServer, "My World", "region"), { recursive: true });
    fs.mkdirSync(path.join(sourceServer, "My World_nether", "DIM-1"), { recursive: true });
    fs.writeFileSync(path.join(sourceServer, "My World", "level.dat"), "level");
    fs.writeFileSync(path.join(sourceServer, "My World", "region", "r.0.0.mca"), "region");
    fs.writeFileSync(path.join(sourceServer, "My World_nether", "DIM-1", "chunk.dat"), "nether");
    fs.writeFileSync(path.join(sourceServer, "server.properties"), "motd=Test\nlevel-name=My World\n");

    const exported = await exportWorld(sourceServer, archive);
    assert.equal(exported.fileCount, 3);
    fs.mkdirSync(destinationServer);
    const imported = await importWorld(archive, destinationServer);
    assert.deepEqual(imported.folders, ["world", "world_nether"]);
    assert.equal(fs.readFileSync(path.join(destinationServer, "world", "region", "r.0.0.mca"), "utf8"), "region");
    assert.equal(fs.readFileSync(path.join(destinationServer, "world_nether", "DIM-1", "chunk.dat"), "utf8"), "nether");
    assert.match(fs.readFileSync(path.join(destinationServer, "server.properties"), "utf8"), /^level-name=world$/m);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("world ZIP import rejects traversal and leaves no world behind", async () => {
  const workspace = temporary("traversal");
  const archive = path.join(workspace, "malicious.zip");
  const destination = path.join(workspace, "server");
  try {
    fs.mkdirSync(destination);
    await createZip(archive, [["aa/evil", "bad"]]);
    const bytes = fs.readFileSync(archive);
    const safeName = Buffer.from("aa/evil");
    const maliciousName = Buffer.from("../evil");
    for (let index = 0; index <= bytes.length - safeName.length; index += 1) {
      if (bytes.subarray(index, index + safeName.length).equals(safeName)) maliciousName.copy(bytes, index);
    }
    fs.writeFileSync(archive, bytes);
    await assert.rejects(importWorld(archive, destination), /traversal|unsafe|invalid relative path/i);
    assert.equal(fs.existsSync(path.join(destination, "world")), false);
    assert.equal(fs.readdirSync(destination).some((name) => name.startsWith(".blockhost-world-import-")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
