import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { isPathInside } from "../src/lib/safe-filesystem.mjs";

test("clearing downloaded files only touches the cache and waits for active operations", t => {
  const root = fs.mkdtempSync(path.resolve("test/.app-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "server-cache");
  const release = path.join(cache, "fabric", "1.20.1");
  const server = path.join(root, "servers", "example");
  const java = path.join(root, "runtime");
  for (const dir of [release, server, java]) fs.mkdirSync(dir, { recursive: true });
  const downloads = ["server.jar", "installer.jar.part"].map(name => path.join(release, name));
  const preserved = [path.join(cache, "unmanaged.jar"), path.join(release, "world-latest.zip"),
    path.join(server, "server.jar"), path.join(java, "java.exe")];
  for (const file of [...downloads, ...preserved]) fs.writeFileSync(file, "fixture");
  let active = true;
  const context = vm.createContext({ fs, path, isPathInside, getCachePath: () => cache, activeTransfers: 0,
    getActiveOperations: () => active ? ["download"] : [] });
  const source = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("function downloadCacheFiles()"), source.indexOf("async function storageSummary()")), context);
  assert.throws(() => context.clearDownloadCache(), /Wait for downloads/);
  assert.ok(downloads.every(file => fs.existsSync(file)));
  active = false;
  context.clearDownloadCache();
  assert.ok(downloads.every(file => !fs.existsSync(file)));
  assert.ok(preserved.every(file => fs.existsSync(file)));
});
