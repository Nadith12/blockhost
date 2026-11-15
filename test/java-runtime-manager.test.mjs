import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yazl from "yazl";
import { pipeline } from "node:stream/promises";
import { JavaRuntimeManager, discoverJavaExecutables } from "../src/lib/java-runtime-manager.mjs";
import { javaRequirement, requiredJavaVersion } from "../src/lib/java-runtime.mjs";
import { inspectServerJava } from "../src/lib/java-requirements.mjs";
import { migrateServerMetadata } from "../src/lib/server-metadata.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blockhost-java-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function executable(root, name, major) {
  const file = path.join(root, name, "bin", "java.exe");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(major));
  return file;
}

async function probe(file) {
  const version = fs.readFileSync(file, "utf8");
  if (!/^\d+$/.test(version)) throw new Error("corrupted runtime");
  return { version, majorVersion: Number(version), is64Bit: true };
}

test("fallbacks select Java 8, 16, 17, 21, 25 and apply Paper's compatibility matrix", () => {
  for (const [minecraft, java] of [["1.16.5", 8], ["1.17", 16], ["1.17.1", 16], ["1.18", 17], ["1.20.4", 17], ["1.20.5", 21], ["1.21.11", 21], ["26.3", 25]]) {
    assert.equal(requiredJavaVersion(minecraft), java, minecraft);
  }
  assert.equal(requiredJavaVersion("1.16.5", "paper"), 16);
  assert.equal(requiredJavaVersion("1.20.1", "purpur"), 21);
  assert.equal(javaRequirement({ version: "1.17.1", type: "vanilla", minecraftJavaMajor: 17 }).requiredMajor, 17);
  assert.equal(migrateServerMetadata({ id: 1, type: "forge", version: "1.19.2" }).java.requiredMajor, 17);
});

test("Cisco uses Java 17 despite Java 26 on PATH and a modern server independently uses Java 21", async t => {
  const root = workspace(t);
  const java26 = executable(root, "system", 26);
  const java21 = executable(root, "modern", 21);
  const java17 = executable(root, "legacy", 17);
  assert.deepEqual(discoverJavaExecutables({ Path: [path.dirname(java26), path.dirname(java21)].join(path.delimiter), JAVA_HOME: path.dirname(path.dirname(java17)) }, "win32"), [java17, java26, java21]);

  const manager = new JavaRuntimeManager({ runtimeRoot: path.join(root, "managed"), discover: () => [java26, java21, java17], probe });
  const cisco = { version: "1.19.2", type: "forge", loaderVersion: "1.19.2-43.5.1", recommendedJavaMajor: 17 };
  const modern = { version: "1.21.11", type: "paper" };
  const [legacyRuntime, modernRuntime] = await Promise.all([manager.resolve(javaRequirement(cisco).requiredMajor), manager.resolve(javaRequirement(modern).requiredMajor)]);
  assert.equal(legacyRuntime.command, java17);
  assert.equal(modernRuntime.command, java21);
  await assert.rejects(manager.resolve(17, { customCommand: java26 }), /Custom Java could not be used/);
  assert.equal((await manager.resolve(17, { customCommand: java17 })).source, "custom");
  fs.unlinkSync(java17);
  await assert.rejects(manager.resolve(17, { customCommand: java17 }), /Custom Java could not be used/);
});

test("repairs corrupted runtimes and coalesces downloads by major without mixing versions", async t => {
  const root = workspace(t);
  executable(root, "java-17", "bad");
  fs.writeFileSync(path.join(root, "java-17", ".blockhost-java-ready"), "ready");
  const installs = [];
  const manager = new JavaRuntimeManager({
    runtimeRoot: root, discover: () => [], probe, platform: "win32", arch: "x64",
    install: async ({ javaVersion, validateJava }) => {
      installs.push(javaVersion);
      await new Promise(resolve => setImmediate(resolve));
      const file = executable(root, "java-" + javaVersion, javaVersion);
      const result = await validateJava(file);
      fs.writeFileSync(path.join(root, "java-" + javaVersion, ".blockhost-java-ready"), "ready");
      return { executable: file, ...result };
    },
  });
  const [a, b, c] = await Promise.all([manager.resolve(17), manager.resolve(17), manager.resolve(21)]);
  assert.deepEqual(installs.sort(), [17, 21]);
  assert.equal(a.command, b.command);
  assert.equal(c.details.majorVersion, 21);
  assert.equal((await manager.resolve(17)).details.majorVersion, 17);
  assert.equal(installs.length, 2);
});

test("a failed Java download can retry", async t => {
  const root = workspace(t);
  let attempts = 0;
  const manager = new JavaRuntimeManager({
    runtimeRoot: root, discover: () => [], probe, platform: "win32", arch: "x64",
    install: async ({ javaVersion, validateJava }) => {
      if (++attempts === 1) throw new Error("network unavailable");
      const executablePath = executable(root, "java-" + javaVersion, javaVersion);
      return { executable: executablePath, ...await validateJava(executablePath) };
    },
  });
  await assert.rejects(manager.resolve(17), /Could not set up Java 17: network unavailable/);
  assert.equal((await manager.resolve(17)).details.majorVersion, 17);
});

async function writeJar(file, entries) {
  const zip = new yazl.ZipFile();
  for (const [name, value] of Object.entries(entries)) zip.addBuffer(Buffer.from(value), name);
  const done = pipeline(zip.outputStream, fs.createWriteStream(file));
  zip.end();
  await done;
}

test("launcher bytecode and Fabric Java constraints affect the decision without running pack code", async t => {
  const root = workspace(t);
  const jar = path.join(root, "server.jar");
  const header = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]);
  await writeJar(jar, { "META-INF/MANIFEST.MF": "Main-Class: test.Launcher\n", "test/Launcher.class": header });
  const server = { version: "1.19.2", type: "fabric", jarPath: jar, folderPath: root };
  assert.equal((await inspectServerJava(server)).requiredMajor, 21);
  fs.mkdirSync(path.join(root, "mods"));
  await writeJar(path.join(root, "mods", "constraint.jar"), { "fabric.mod.json": JSON.stringify({ id: "constraint", depends: { java: ">=21 <25" } }) });
  await assert.rejects(inspectServerJava({ ...server, version: "26.1" }), /Java requirements conflict/);
  assert.equal((await inspectServerJava({ ...server, jarPath: "" })).requiredMajor, 21);
});

test("Java requirements use the selected loader descriptor for a multi-loader JAR", async t => {
  const folderPath = workspace(t);
  const mods = path.join(folderPath, "mods");
  fs.mkdirSync(mods);
  await writeJar(path.join(mods, "dual.jar"), {
    "fabric.mod.json": JSON.stringify({ id: "dual", depends: { java: ">=21" } }),
    "quilt.mod.json": JSON.stringify({ quilt_loader: { id: "dual", depends: [{ id: "java", versions: ">=17" }] } }),
  });
  const server = { folderPath, version: "1.20.1" };
  assert.equal((await inspectServerJava({ ...server, type: "quilt" })).requiredMajor, 17);
  assert.equal((await inspectServerJava({ ...server, type: "fabric" })).requiredMajor, 21);
});

test("cancelling a Java mod scan finishes the active batch without scanning the rest of the pack", async t => {
  const folderPath = workspace(t);
  const mods = path.join(folderPath, "mods");
  fs.mkdirSync(mods);
  await writeJar(path.join(mods, "one.jar"), {
    "fabric.mod.json": JSON.stringify({ id: "constraint", depends: { java: ">=21" } }),
  });
  for (let index = 0; index < 12; index++) fs.copyFileSync(path.join(mods, "one.jar"), path.join(mods, `copy-${index}.jar`));

  const controller = new AbortController();
  const reason = new Error("Cancelled Java requirements scan");
  const stat = fs.promises.stat;
  let reads = 0;
  let pending = 0;
  let tracking = true;
  t.mock.method(fs.promises, "stat", async (...args) => {
    if (path.dirname(args[0]) !== mods || !tracking) return stat(...args);
    reads += 1;
    pending += 1;
    try {
      await new Promise(resolve => setImmediate(resolve));
      controller.abort(reason);
      return await stat(...args);
    } finally { pending -= 1; }
  });
  const server = { folderPath, type: "fabric", version: "1.20.1" };
  await assert.rejects(inspectServerJava(server, { signal: controller.signal }), error => error === reason);
  assert.ok(reads >= 1 && reads <= 4);
  assert.equal(pending, 0);
  tracking = false;
  assert.equal((await inspectServerJava(server)).requiredMajor, 21);
});
