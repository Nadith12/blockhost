import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import yazl from "yazl";
import { detectDedicatedServerZip, detectDropSource } from "../src/lib/drop-source.mjs";

async function writeZip(source, entries, options) {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    if (entry.endsWith("/")) zip.addEmptyDirectory(entry);
    else zip.addBuffer(Buffer.from("fixture"), entry);
  }
  zip.end(options);
  await pipeline(zip.outputStream, fs.createWriteStream(source));
}

test("drop detection distinguishes a world from a server ZIP containing one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blockhost-drop-"));
  try {
    for (const [name, entries, expected] of [
      ["backup.zip", ["world/level.dat", "world/region/r.0.0.mca"], "world"],
      ["survival.zip", ["pack/world/level.dat", "pack/custom.jar", "pack/server.properties"], "server"],
      ["mods.zip", ["mods/map.jar"], "addon-bundle"],
      ["map.jar", ["fabric.mod.json"], "addon"],
      ["other.zip", ["readme.txt"], "unknown"],
    ]) {
      const source = path.join(root, name);
      await writeZip(source, entries);
      assert.equal(await detectDropSource(source), expected, name);
    }
    const world = path.join(root, "save");
    fs.mkdirSync(world);
    fs.writeFileSync(path.join(world, "level.dat"), "fixture");
    assert.equal(await detectDropSource(world), "world");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CurseForge launcher overrides must have server mods in the same archive root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blockhost-dedicated-drop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const client = path.join(root, "client.zip");
  await writeZip(client, ["server.jar", "mods/server.jar", "Client/manifest.json", "Client/overrides/config/map.toml"]);
  await assert.rejects(detectDedicatedServerZip(client), /client launcher manifest/);

  const server = path.join(root, "server.zip");
  await writeZip(server, ["Pack/manifest.json", "Pack/overrides/settings.txt", "Pack/mods/map.jar", "Pack/start.sh"]);
  assert.equal(await detectDedicatedServerZip(server), "server-starter");
});

test("drop detection rejects oversized ZIP counts before walking directory entries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blockhost-zip-count-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "directories.zip");
  await writeZip(source, ["directory/"], { forceZip64Format: true });

  // Set the ZIP64 entry count without building a large fixture.
  const bytes = fs.readFileSync(source);
  const endRecord = bytes.lastIndexOf(Buffer.from("504b0606", "hex"));
  assert.notEqual(endRecord, -1);
  bytes.writeBigUInt64LE(100_001n, endRecord + 24);
  bytes.writeBigUInt64LE(100_001n, endRecord + 32);
  fs.writeFileSync(source, bytes);

  await assert.rejects(detectDropSource(source), /too many entries/);
});
