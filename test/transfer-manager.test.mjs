import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yazl from "yazl";
import {
  BLOCKHOST_FORMAT,
  cleanupAbandonedTransfers,
  exportBlockhostServer,
  importBlockhostServer,
  inspectBlockhostArchive,
} from "../src/lib/transfer-manager.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(process.cwd(), "test", ".transfer-tmp-"));
}

async function createArchive(filePath, manifest, entries) {
  const zip = new yazl.ZipFile();
  const output = fs.createWriteStream(filePath);
  const complete = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
  });
  zip.outputStream.pipe(output);
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
  for (const [name, contents] of entries) zip.addBuffer(Buffer.from(contents), name);
  zip.end();
  await complete;
}

test("export creates a verified self-contained archive and excludes runtime files", async () => {
  const root = temporaryDirectory();
  try {
    const serverFolder = path.join(root, "server");
    const cacheFolder = path.join(root, "cache");
    fs.mkdirSync(path.join(serverFolder, "world"), { recursive: true });
    fs.mkdirSync(path.join(serverFolder, "logs"), { recursive: true });
    fs.mkdirSync(cacheFolder, { recursive: true });
    fs.writeFileSync(path.join(serverFolder, "world", "level.dat"), "world-data");
    fs.writeFileSync(path.join(serverFolder, "server.properties"), "motd=Transfer test\n");
    fs.writeFileSync(path.join(serverFolder, "eula.txt"), "eula=true\n");
    fs.writeFileSync(path.join(serverFolder, "logs", "latest.log"), "do not export");
    fs.writeFileSync(path.join(serverFolder, "server-info.json"), JSON.stringify({ folderPath: serverFolder }));
    const cachedJar = path.join(cacheFolder, "vanilla.jar");
    fs.writeFileSync(cachedJar, "self-contained-server-jar");
    const destination = path.join(root, "Survival.blockhost");

    const result = await exportBlockhostServer({
      id: 123,
      name: "Survival",
      type: "vanilla",
      version: "1.21.1",
      loaderVersion: "",
      color: "#39c9ff",
      launchType: "jar",
      launchArgsPath: "",
      jarPath: cachedJar,
      folderPath: serverFolder,
      createdAt: "2026-01-01T00:00:00.000Z",
    }, destination, { createdBy: "Test" });

    assert.equal(result.path, destination);
    const inspected = await inspectBlockhostArchive(destination, { verifyPayload: true });
    const paths = Array.from(inspected.files.values(), (file) => file.path);
    assert.equal(inspected.manifest.format, BLOCKHOST_FORMAT);
    assert(paths.includes("server/server.jar"));
    assert(paths.includes("server/world/level.dat"));
    assert(paths.includes("server/server-info.json"));
    assert(!paths.some((file) => file.startsWith("server/logs/")));
    assert(!JSON.stringify(inspected.manifest).includes(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("import restores to a new machine path, resolves names, and resets EULA", async () => {
  const root = temporaryDirectory();
  try {
    const source = path.join(root, "source");
    const cache = path.join(root, "outside-cache.jar");
    fs.mkdirSync(path.join(source, "world"), { recursive: true });
    fs.writeFileSync(path.join(source, "world", "level.dat"), "portable-world");
    fs.writeFileSync(path.join(source, "eula.txt"), "eula=true\n");
    fs.writeFileSync(cache, "portable-jar");
    const archive = path.join(root, "portable.blockhost");
    await exportBlockhostServer({
      id: 5,
      name: "Survival",
      type: "fabric",
      version: "1.21.1",
      loaderVersion: "0.16.10",
      color: "#123456",
      launchType: "jar",
      jarPath: cache,
      folderPath: source,
      createdAt: "2026-01-01T00:00:00.000Z",
    }, archive);

    const destinationRoot = path.join(root, "new-machine", "servers");
    const imported = await importBlockhostServer(archive, destinationRoot, [{ id: 5, name: "Survival" }]);
    assert.equal(imported.server.name, "Survival (Imported)");
    assert.notEqual(imported.server.id, 5);
    assert(fs.existsSync(path.join(imported.path, "world", "level.dat")));
    assert(fs.existsSync(path.join(imported.path, "server.jar")));
    assert(!fs.existsSync(path.join(imported.path, "eula.txt")));
    const metadata = JSON.parse(fs.readFileSync(path.join(imported.path, "server-info.json"), "utf8"));
    assert.equal(Object.hasOwn(metadata, "folderPath"), false);
    assert.equal(Object.hasOwn(metadata, "jarPath"), false);
    assert.equal(metadata.jarFile, "server.jar");
    assert.equal(metadata.type, "fabric");
    assert(!fs.existsSync(path.join(destinationRoot, ".blockhost-import-staging")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("import rejects bad hashes without exposing a partial server", async () => {
  const root = temporaryDirectory();
  try {
    const archive = path.join(root, "bad.blockhost");
    const jar = Buffer.from("tampered");
    await createArchive(archive, {
      format: BLOCKHOST_FORMAT,
      formatVersion: 1,
      server: {
        name: "Bad archive",
        type: "vanilla",
        minecraftVersion: "1.21.1",
        launchType: "jar",
      },
      files: [{ path: "server/server.jar", size: jar.length, sha256: "0".repeat(64) }],
    }, [["server/server.jar", jar]]);
    const destinationRoot = path.join(root, "servers");
    await assert.rejects(() => importBlockhostServer(archive, destinationRoot), /verification failed/i);
    const visible = fs.existsSync(destinationRoot)
      ? fs.readdirSync(destinationRoot).filter((name) => name !== ".blockhost-import-staging")
      : [];
    assert.deepEqual(visible, []);
    assert(!fs.existsSync(path.join(destinationRoot, ".blockhost-import-staging")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest validation rejects traversal and unsupported future versions", async () => {
  const root = temporaryDirectory();
  try {
    const baseServer = {
      name: "Unsafe",
      type: "vanilla",
      minecraftVersion: "1.21.1",
      launchType: "jar",
    };
    const traversal = path.join(root, "traversal.blockhost");
    await createArchive(traversal, {
      format: BLOCKHOST_FORMAT,
      formatVersion: 1,
      server: baseServer,
      files: [
        { path: "server/server.jar", size: 3, sha256: "0".repeat(64) },
        { path: "server/../outside.txt", size: 1, sha256: "0".repeat(64) },
      ],
    }, [["server/server.jar", "jar"]]);
    await assert.rejects(() => inspectBlockhostArchive(traversal), /manifest file path/i);

    const future = path.join(root, "future.blockhost");
    await createArchive(future, {
      format: BLOCKHOST_FORMAT,
      formatVersion: 999,
      server: baseServer,
      files: [{ path: "server/server.jar", size: 3, sha256: "0".repeat(64) }],
    }, [["server/server.jar", "jar"]]);
    await assert.rejects(() => inspectBlockhostArchive(future), /version 999 is not supported/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup recovery removes only abandoned transfer artifacts", () => {
  const root = temporaryDirectory();
  try {
    const servers = path.join(root, "servers");
    const exportsDirectory = path.join(root, "exports");
    fs.mkdirSync(path.join(servers, ".blockhost-import-staging", "unfinished"), { recursive: true });
    fs.mkdirSync(exportsDirectory, { recursive: true });
    const partial = path.join(exportsDirectory, "Survival.blockhost.partial-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.blockhost");
    const completed = path.join(exportsDirectory, "Survival.blockhost");
    fs.writeFileSync(partial, "partial");
    fs.writeFileSync(completed, "completed");

    cleanupAbandonedTransfers(servers, exportsDirectory);
    assert(!fs.existsSync(path.join(servers, ".blockhost-import-staging")));
    assert(!fs.existsSync(partial));
    assert(fs.existsSync(completed));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
