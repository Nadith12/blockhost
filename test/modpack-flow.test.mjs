import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { recordModpackInventory, listServerAddons } from '../src/lib/addon-manager.mjs';
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const createSource = main.slice(main.indexOf('async function createModpackServer('), main.indexOf('async function applyPackContent('));
function harness({ fail = false } = {}) {
  const pack = { type: 'fabric', version: '1.20.1', loaderVersion: '0.16.10' };
  const approved = { temporary: path.resolve('isolated-pack-test'), archive: 'pack.zip', pack };
  const removed = [];
  let request, context, controller;
  const sandbox = { AbortController, path, getServerOperation: () => null, approvedPacks: new Map([['token', approved]]), packController: null,
    normalizeServerName: name => { assert.equal(name, 'My server'); },
    fs: { promises: { rm: async target => removed.push(target) } },
    stageModpack: async (_archive, _content, options) => { controller = options.signal; if (fail) throw new Error('download failed'); return pack; },
    fetchJson: async () => [{ stable: true, version: '1.0.3' }],
    sendTransferProgress: () => {},
    createServer: async (input, ctx) => { request = input; context = ctx; return { server: { id: 123 } }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(createSource + '\nthis.run = createModpackServer;', sandbox);
  return { sandbox, removed, get request() { return request; }, get context() { return context; }, get signal() { return controller; } };
}
test('server creation trusts the inspected pack versions, not renderer supplied versions', async () => {
  const h = harness();
  const result = await h.sandbox.run({ modpackToken: 'token', name: 'My server', type: 'vanilla', version: 'wrong', loaderVersion: 'wrong', worldImportToken: 'world-token', seed: '' });
  assert.equal(result.server.id, 123);
  assert.equal(h.request.type, 'fabric'); assert.equal(h.request.version, '1.20.1'); assert.equal(h.request.loaderVersion, '0.16.10');
  assert.equal(h.request.installerVersion, '1.0.3'); assert.equal(h.request.worldImportToken, 'world-token');
  assert.equal(h.request.modpackToken, ''); assert.equal(h.sandbox.approvedPacks.size, 0);
  assert.equal(h.sandbox.packController, null); assert.equal(h.context.signal, h.signal);
});
test('publisher packs use the verified server ZIP and pinned launcher instead of mrpack staging', async () => {
  const h = harness({ fail: true });
  const selection = h.sandbox.approvedPacks.get('token');
  selection.versionId = 'M5BnAIQy';
  Object.assign(selection.pack, { format: 'publisher-server', loaderVersion: '0.18.4' });
  const calls = [];
  h.sandbox.downloadPublisherServerPack = async (id, archive, { signal }) => {
    assert.equal(id, selection.versionId); assert.equal(archive, selection.archive);
    assert.equal(signal.aborted, false); calls.push('download');
  };
  h.sandbox.inspectExternalServerZip = async (archive, content, options) => {
    assert.equal(archive, selection.archive); assert.equal(options.starter, true); calls.push('extract');
    return { type: 'fabric', version: '1.20.1', loaderVersion: '0.18.4', sourceFolder: content };
  };
  await assert.rejects(h.sandbox.run({ modpackToken: 'token', name: 'My server', acceptPackEula: 'true' }), /Minecraft EULA/);
  assert.deepEqual(calls, []);
  await h.sandbox.run({ modpackToken: 'token', name: 'My server', loaderVersion: '0.19.3', acceptPackEula: true });
  assert.deepEqual(calls, ['download', 'extract']);
  assert.equal(h.request.loaderVersion, '0.18.4');
  assert.equal(h.context.pack.format, 'server-starter');
  assert.equal(h.context.verifyStartup, true);
  assert.equal(h.sandbox.approvedPacks.size, 0);
});

test('an online pack keeps a staged installation for repair and verifies it only after startup', async () => {
  const finishSource = main.slice(main.indexOf('async function finishServerCreation('), main.indexOf('async function createServer(data'));
  const calls = [];
  const diagnosis = { kind: 'dependency', problem: 'A required mod is missing.' };
  const sandbox = {
    acceptEula: () => calls.push('eula'),
    sendTransferProgress: () => {},
    assertJavaInstalled: async () => { calls.push('java'); return { command: 'verified-java' }; },
    javaAssignment: runtime => ({ version: runtime.command }),
    verifyPackServer: async () => {
      calls.push('boot');
      throw Object.assign(new Error('Missing mandatory dependency'), { diagnosis });
    },
    writeServerMetadata: (folder, server) => { calls.push('publish'); return server; },
  };
  vm.runInNewContext(finishSource + '\nthis.finish = finishServerCreation;', sandbox);
  const server = { folderPath: 'staged-server' };
  const context = { verifyStartup: true, signal: new AbortController().signal };
  assert.equal(await sandbox.finish(server, context), server);
  assert.equal(server.modpackSetup.status, 'repair');
  assert.equal(server.modpackSetup.diagnosis, diagnosis);
  assert.deepEqual(calls, ['eula', 'java', 'boot', 'publish']);
  sandbox.verifyPackServer = async (_server, runtime, signal) => {
    assert.equal(runtime.command, 'verified-java');
    assert.equal(signal, context.signal);
    calls.push('passed');
  };
  assert.equal(await sandbox.finish(server, context), server);
  assert.equal(server.modpackSetup.status, 'verified');
  assert.equal(server.modpackSetup.diagnosis, undefined);
  assert.deepEqual(calls.slice(4), ['eula', 'java', 'passed', 'publish']);

  const cancelled = new AbortController();
  sandbox.verifyPackServer = async () => {
    cancelled.abort();
    throw new Error('The cancelled check did not finish.');
  };
  await assert.rejects(sandbox.finish({ folderPath: 'cancelled' }, {
    verifyStartup: true, signal: cancelled.signal,
  }), { name: 'AbortError' });
  assert.deepEqual(calls.slice(8), ['eula', 'java']);
});

test('failed pack setup retains the preview for retry and publishes no server', async () => {
  const h = harness({ fail: true });
  await assert.rejects(h.sandbox.run({ modpackToken: 'token', name: 'My server' }), /download failed/);
  assert.equal(h.request, undefined); assert.equal(h.sandbox.approvedPacks.size, 1);
  assert.equal(h.sandbox.packController, null); assert.equal(h.removed.length, 1);
});
test('expired selection and simultaneous preview cannot start a pack install', async () => {
  const h = harness();
  await assert.rejects(h.sandbox.run({ modpackToken: 'missing', name: 'My server' }), /Choose the modpack again/);
  h.sandbox.getServerOperation = () => 'preparing';
  await assert.rejects(h.sandbox.run({ modpackToken: 'token', name: 'My server' }), /preview/);
  assert.equal(h.request, undefined);
});

test('starter pack adds files to the existing Forge directory and protects loader files', async t => {
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockhost-pack-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = path.join(root, 'pack');
  const folder = path.join(root, 'server');
  for (const dir of [content, folder]) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'libraries'));
  }
  fs.writeFileSync(path.join(folder, 'config', 'forge.toml'), 'loader config');
  fs.writeFileSync(path.join(folder, 'libraries', 'loader.jar'), 'installed loader');
  fs.writeFileSync(path.join(content, 'libraries', 'loader.jar'), 'bundled loader');
  fs.writeFileSync(path.join(content, 'config', 'pack.toml'), 'pack config');
  fs.writeFileSync(path.join(content, 'start.bat'), 'exit 99');
  const applySource = main.slice(main.indexOf('async function applyPackContent('), main.indexOf('async function createServer(data'));
  const sandbox = { fs, path, recordModpackInventory };
  vm.runInNewContext(applySource + '\nthis.apply = applyPackContent;', sandbox);
  const context = { content, signal: new AbortController().signal, pack: { format: 'server-starter' } };
  await sandbox.apply(folder, context);
  assert.equal(fs.readFileSync(path.join(folder, 'config', 'pack.toml'), 'utf8'), 'pack config');
  assert.equal(fs.readFileSync(path.join(folder, 'libraries', 'loader.jar'), 'utf8'), 'installed loader');
  assert.equal(fs.existsSync(path.join(folder, 'start.bat')), false);
  fs.unlinkSync(path.join(content, 'config', 'pack.toml'));
  fs.writeFileSync(path.join(content, 'config', 'forge.toml'), 'conflicting config');
  await assert.rejects(sandbox.apply(folder, context), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(folder, 'config', 'forge.toml'), 'utf8'), 'loader config');
});

test('pack inventory separates included mods from later additions', t => {
  const folderPath = fs.mkdtempSync(path.resolve('test/.pack-inventory-'));
  t.after(() => fs.rmSync(folderPath, { recursive: true, force: true }));
  const mods = path.join(folderPath, 'mods');
  fs.mkdirSync(mods);
  fs.writeFileSync(path.join(mods, 'included.jar.disabled'), 'included fixture');
  const server = { folderPath, type: 'fabric', modpack: { name: 'Pack', version: '2.3' } };
  assert.equal(listServerAddons(server).packInventoryKnown, false);
  recordModpackInventory(folderPath, { name: 'Pack', packVersion: '2.3', type: 'fabric' });
  fs.writeFileSync(path.join(mods, 'added.jar'), 'later fixture');
  const model = listServerAddons(server);
  assert.equal(model.packInventoryKnown, true);
  assert.deepEqual(model.items.filter(item => item.fromModpack).map(item => item.fileName), ['included.jar']);
});

test('publisher starter staging preserves client-environment JARs for the loader to resolve', async t => {
  const { tmpdir } = await import('node:os');
  const { pipeline } = await import('node:stream/promises');
  const { default: yazl } = await import('yazl');
  const { removePackClientMods } = await import('../src/lib/modpack-manager.mjs');
  const root = fs.mkdtempSync(path.join(tmpdir(), 'blockhost-pack-side-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = path.join(root, 'pack');
  const folder = path.join(root, 'server');
  fs.mkdirSync(path.join(content, 'mods'), { recursive: true });
  fs.mkdirSync(folder);

  const file = 'client-menu.jar';
  const archive = new yazl.ZipFile();
  archive.addBuffer(Buffer.from(JSON.stringify({
    schemaVersion: 1, id: 'client-menu', name: 'Client Menu', version: '1.0', environment: 'client',
  })), 'fabric.mod.json');
  const output = pipeline(archive.outputStream, fs.createWriteStream(path.join(content, 'mods', file)));
  archive.end();
  await output;

  const start = main.indexOf('async function applyPackContent(');
  const end = main.indexOf('\nasync function ', start + 1);
  const sandbox = { fs, path, recordModpackInventory, removePackClientMods };
  vm.runInNewContext(main.slice(start, end) + '\nthis.apply = applyPackContent;', sandbox);
  await sandbox.apply(folder, {
    content, signal: new AbortController().signal, pack: { format: 'server-starter', type: 'fabric', version: '1.20.1' },
    verifyStartup: true,
  });
  assert.deepEqual(fs.readFileSync(path.join(folder, 'mods', file)), fs.readFileSync(path.join(content, 'mods', file)));
});
