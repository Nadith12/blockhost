import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyModpackStartup } from "../src/lib/modpack-startup.mjs";

const original = [
  "server-ip=0.0.0.0",
  "# The backslash in this physical comment must not hide the duplicate.\\",
  "server-ip=0.0.0.0",
  "server-port=25565",
  "enable-query=true",
  "enable-rcon=true",
  "management-server-enabled=true",
  "level-name=Previous World",
  "! The publisher's real world follows this comment.\\",
  "level-name=Publisher World",
  "level-seed=1234",
  "motd=Trailing continuation\\",
].join("\r\n");
const worldName = "Publisher World";

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "blockhost-pack-boot-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const properties = path.join(folder, "server.properties");
  await fs.writeFile(properties, original);
  for (const suffix of ["", "_nether"]) {
    const world = path.join(folder, `${worldName}${suffix}`);
    await fs.mkdir(world);
    await fs.writeFile(path.join(world, "level.dat"), `publisher${suffix}`);
    await fs.writeFile(path.join(world, "session.lock"), "old lock");
  }
  return { folder, properties };
}

async function assertSetupIntact(folder, properties) {
  assert.equal(await fs.readFile(properties, "utf8"), original);
  assert.equal(await fs.readFile(path.join(folder, worldName, "level.dat"), "utf8"), "publisher");
  assert.equal(await fs.readFile(path.join(folder, `${worldName}_nether`, "level.dat"), "utf8"), "publisher_nether");
  assert.equal(await fs.readFile(path.join(folder, worldName, "session.lock"), "utf8"), "old lock");
  assert.equal((await fs.readdir(folder)).some(name => name.startsWith(".blockhost-test-world-")), false);
}

test("startup verification listens privately, observes readiness and stops before restoring the server settings", async t => {
  const { folder, properties } = await fixture(t);
  let ready = false;
  const result = await verifyModpackStartup(folder, process.execPath, ["-e", String.raw`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const net = require('node:net');
    const readline = require('node:readline');
    const properties = Object.fromEntries(fs.readFileSync('server.properties', 'utf8').split(/\r?\n/)
      .filter(line => line.includes('=')).map(line => line.split('=')));
    assert.equal(properties['server-ip'], '127.0.0.1');
    assert.equal(properties['level-seed'], '1234');
    for (const key of ['enable-query', 'enable-rcon', 'management-server-enabled']) assert.equal(properties[key], 'false');
    const world = properties['level-name'];
    assert.match(world, /^\.blockhost-test-world-/);
    assert.equal(fs.readFileSync(world + '/level.dat', 'utf8'), 'publisher');
    assert.equal(fs.readFileSync(world + '_nether/level.dat', 'utf8'), 'publisher_nether');
    assert.equal(fs.existsSync(world + '/session.lock'), false);
    fs.writeFileSync(world + '/level.dat', 'trial overwrites world');
    fs.writeFileSync(world + '_the_end/level.dat', 'trial creates a dimension');
    const server = net.createServer(socket => socket.destroy());
    server.listen(Number(properties['server-port']), properties['server-ip'], () => {
      console.log('[Server thread/INFO]: Done (0.1s)! For help, type "help"');
    });
    readline.createInterface({ input: process.stdin }).on('line', command => {
      assert.equal(command, 'stop');
      fs.writeFileSync('stopped', 'cleanly');
      server.close(() => process.exit(0));
    });
  `], { readyForMs: 0, signal: AbortSignal.timeout(6000), onReady: () => { ready = true; } });
  assert.equal(ready, true);
  assert.equal(result.forcedStopAfterSave, false);
  assert.equal(await fs.readFile(path.join(folder, "stopped"), "utf8"), "cleanly");
  await assertSetupIntact(folder, properties);
});

for (const savedAfterStop of [true, false]) {
  test(`a lingering test process ${savedAfterStop ? "passes after Minecraft acknowledges the save" : "fails without a post-stop save"} and is reaped`, async t => {
    const { folder, properties } = await fixture(t);
    let closed = false;
    const verification = verifyModpackStartup(folder, process.execPath, ["-e", String.raw`
      const fs = require('node:fs');
      const net = require('node:net');
      const readline = require('node:readline');
      const port = Array.from(fs.readFileSync('server.properties', 'utf8').matchAll(/^server-port=(\d+)$/gm)).at(-1)[1];
      const save = () => console.log('[Server thread/INFO]: ThreadedAnvilChunkStorage: All dimensions are saved');
      net.createServer(socket => socket.destroy()).listen(Number(port), '127.0.0.1', () => {
        if (process.argv[1] === 'false') save();
        console.log('[Server thread/INFO]: Done (0.1s)! For help, type "help"');
      });
      readline.createInterface({ input: process.stdin }).on('line', command => {
        if (command === 'stop' && process.argv[1] === 'true') save();
      });
    `, String(savedAfterStop)], {
      readyForMs: 0, shutdownTimeoutMs: 600, savedShutdownGraceMs: 100, signal: AbortSignal.timeout(6000),
      spawnImpl(...args) {
        const child = spawn(...args);
        child.once("close", () => { closed = true; });
        return child;
      },
    });
    if (savedAfterStop) assert.equal((await verification).forcedStopAfterSave, true);
    else await assert.rejects(verification, error => {
      assert.equal(error.diagnosis.kind, "shutdown");
      return true;
    });
    assert.equal(closed, true);
    await assertSetupIntact(folder, properties);
  });
}

test("a loader dependency failure surfaces the missing mod and restores the settings", async t => {
  const { folder, properties } = await fixture(t);
  await assert.rejects(verifyModpackStartup(folder, process.execPath, ["-e", `
    const fs = require('node:fs');
    const world = Array.from(fs.readFileSync('server.properties', 'utf8').matchAll(/^level-name=(.+)$/gm)).at(-1)[1];
    fs.writeFileSync(world + '/level.dat', 'trial overwrites world');
    console.error('[main/ERROR]: Missing or unsupported mandatory dependencies:');
    console.error("Mod ID: 'creativecore', Requested by: 'playerrevive', Expected range: '2.11.20', Actual version: '[MISSING]'");
    process.exitCode = 1;
  `], { readyForMs: 0, signal: AbortSignal.timeout(6000) }), error => {
    assert.match(error.message, /dependency is missing[\s\S]+creativecore/);
    assert.equal(error.diagnosis.kind, "dependency");
    assert.equal(error.diagnosis.requirements[0].modId, "creativecore");
    return true;
  });
  await assertSetupIntact(folder, properties);
});

test("a readiness line without a listening port does not pass verification", async t => {
  const { folder, properties } = await fixture(t);
  let child;
  await assert.rejects(verifyModpackStartup(folder, process.execPath, ["-e", `
    console.log('Done (0.1s)! For help, type "help"');
    setInterval(() => {}, 1000);
  `], {
    readyForMs: 0, signal: AbortSignal.timeout(6000),
    spawnImpl: (...args) => (child = spawn(...args)),
  }), /without a listening test port/);
  assert.equal(child.killed, true);
  await assertSetupIntact(folder, properties);
});

test("cancelling startup reaps the staged process before restoring the settings", async t => {
  const { folder, properties } = await fixture(t);
  const controller = new AbortController();
  let closed = false;
  await assert.rejects(verifyModpackStartup(folder, process.execPath, ["-e", `
    const fs = require('node:fs');
    const world = Array.from(fs.readFileSync('server.properties', 'utf8').matchAll(/^level-name=(.+)$/gm)).at(-1)[1];
    fs.writeFileSync(world + '/level.dat', 'trial overwrites world');
    console.log('Starting Minecraft server');
    setInterval(() => {}, 1000);
  `], {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
    spawnImpl(...args) {
      const child = spawn(...args);
      child.stdout.once("data", () => controller.abort());
      child.once("close", () => { closed = true; });
      return child;
    },
  }), { name: "AbortError" });
  assert.equal(closed, true);
  await assertSetupIntact(folder, properties);
});

test("a linked world is rejected before Java runs and leaves its target untouched", async t => {
  const { folder, properties } = await fixture(t);
  await fs.symlink(path.join(folder, worldName), path.join(folder, `${worldName}_the_end`), "junction");
  await assert.rejects(verifyModpackStartup(folder, process.execPath, [], {
    spawnImpl() { assert.fail("Java must not start"); },
  }), error => {
    assert.equal(error.diagnosis.kind, "setup");
    return true;
  });
  await assertSetupIntact(folder, properties);
  assert.equal((await fs.lstat(path.join(folder, `${worldName}_the_end`))).isSymbolicLink(), true);
});
