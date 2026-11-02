import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yazl from "yazl";
import {
  detectExternalServer,
  importExternalServer,
} from "../src/lib/external-importer.mjs";

function temporary(label) {
  return fs.mkdtempSync(path.join(process.cwd(), `.test-tmp-${label}-`));
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

test("external folder import detects Paper, resets EULA, and commits atomically", async () => {
  const workspace = temporary("external-folder");
  const source = path.join(workspace, "Existing Paper");
  const servers = path.join(workspace, "servers");
  try {
    fs.mkdirSync(path.join(source, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(source, "paper-1.21.1-123.jar"), "jar");
    fs.writeFileSync(path.join(source, "server.properties"), "motd=Imported\n");
    fs.writeFileSync(path.join(source, "eula.txt"), "eula=true\n");
    const result = await importExternalServer(source, servers);
    assert.equal(result.server.type, "paper");
    assert.equal(result.server.version, "1.21.1");
    assert.equal(fs.existsSync(path.join(result.path, "eula.txt")), false);
    assert.equal(fs.existsSync(path.join(result.path, "server-info.json")), true);
    assert.equal(fs.readdirSync(servers).some((name) => name.startsWith(".blockhost-external")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("external detection refuses ambiguous launch JARs", () => {
  const folder = temporary("external-ambiguous");
  try {
    fs.writeFileSync(path.join(folder, "server-one.jar"), "one");
    fs.writeFileSync(path.join(folder, "server-two.jar"), "two");
    assert.throws(() => detectExternalServer(folder), /Multiple possible server launch JARs/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("external ZIP import rejects traversal without exposing a server", async () => {
  const workspace = temporary("external-traversal");
  const archive = path.join(workspace, "malicious.zip");
  const servers = path.join(workspace, "servers");
  try {
    await createZip(archive, [["aa/evil", "bad"]]);
    const original = fs.readFileSync(archive);
    const safeName = Buffer.from("aa/evil");
    const maliciousName = Buffer.from("../evil");
    let replaced = 0;
    for (let index = 0; index <= original.length - safeName.length; index += 1) {
      if (original.subarray(index, index + safeName.length).equals(safeName)) {
        maliciousName.copy(original, index);
        replaced += 1;
      }
    }
    assert.equal(replaced, 2);
    fs.writeFileSync(archive, original);
    await assert.rejects(importExternalServer(archive, servers), /traversal|unsafe|invalid relative path/i);
    assert.equal(fs.existsSync(servers) ? fs.readdirSync(servers).filter((name) => !name.startsWith(".blockhost")).length : 0, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
