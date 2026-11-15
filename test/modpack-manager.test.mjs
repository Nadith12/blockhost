import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import yazl from 'yazl';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parsePackManifest, inspectModpack, stageModpack, validatePackUrl, searchModpacks, modpackVersions, downloadPackVersion, publisherServerPack, downloadPublisherServerPack } from '../src/lib/modpack-manager.mjs';
import { detectDropSource } from '../src/lib/drop-source.mjs';
const payload = Buffer.from('verified modpack config');
const digest = crypto.createHash('sha512').update(payload).digest('hex');
const file = (name = 'config/test.json', extra = {}) => ({ path: name, hashes: { sha512: digest }, downloads: ['https://cdn.modrinth.com/example'], fileSize: payload.length, ...extra });
const manifest = (files = [file()], dependencies = { minecraft: '1.20.1', 'fabric-loader': '0.16.10' }) => ({ formatVersion: 1, game: 'minecraft', name: 'Test pack', versionId: '1.2', dependencies, files });
async function fixture(t, data = manifest(), overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockhost-pack-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'fixture.mrpack');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(data)), 'modrinth.index.json');
  for (const [name, text] of Object.entries(overrides)) zip.addBuffer(Buffer.from(text), name);
  const output = pipeline(zip.outputStream, createWriteStream(source));
  zip.end(); await output;
  return { source, root, destination: path.join(root, 'staged') };
}
async function modJar(entries) {
  const zip = new yazl.ZipFile();
  for (const [name, contents] of Object.entries(entries)) zip.addBuffer(Buffer.from(contents), name);
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const fetchImpl = async () => new Response(payload);

test('modpacks pin exact versions and skip declared client files', () => {
  const pack = parsePackManifest(manifest([file(), file('mods/client.jar', { env: { server: 'unsupported' } })]));
  assert.equal(pack.version, '1.20.1'); assert.equal(pack.loaderVersion, '0.16.10');
  assert.equal(pack.files.length, 1); assert.equal(pack.skipped, 1);
  assert.equal(parsePackManifest(manifest([], { minecraft: '1.20.1', forge: '47.3.0' })).loaderVersion, '1.20.1-47.3.0');
  assert.equal(parsePackManifest(manifest([], { minecraft: '1.21.1', neoforge: '21.1.80' })).loaderVersion, '21.1.80');
  assert.equal(parsePackManifest(manifest([], { minecraft: '1.20.1', 'quilt-loader': '0.20' })).type, 'quilt');
  assert.equal(parsePackManifest(manifest([], { minecraft: '1.16.5', forge: '36.2.0' })).loaderVersion, '1.16.5-36.2.0');
});

test('modpack paths reject traversal, ADS, Windows aliases and protected files', () => {
  for (const name of ['../escape', 'C:/bad', 'config/a:stream', 'config/../outside', 'config/CON.txt', 'config/COM¹.txt', 'config/trailing.', 'server-info.json', 'libraries/test.jar', 'config/launch.ps1']) assert.throws(() => parsePackManifest(manifest([file(name)])), undefined, name);
  assert.throws(() => parsePackManifest(manifest([file(), file('CONFIG/TEST.JSON')])), /duplicate/);
  assert.throws(() => parsePackManifest(manifest([file('mods/a.jar', { hashes: {} })])), /checksum/);
});

test('download URLs reject HTTP, local networks, credentials and misleading hosts', () => {
  for (const url of ['http://cdn.modrinth.com/a', 'https://127.0.0.1/a', 'https://cdn.modrinth.com.evil.test/a', 'https://user:pass@cdn.modrinth.com/a', 'https://cdn.modrinth.com:8080/a']) assert.throws(() => validatePackUrl(url));
  assert.equal(validatePackUrl('https://cdn.modrinth.com/a'), 'https://cdn.modrinth.com/a');
});

test('local packs and renamed ZIPs are detected without installing', async t => {
  const { source, root } = await fixture(t);
  assert.equal(await detectDropSource(source), 'modpack');
  const zip = path.join(root, 'renamed.zip'); await fs.copyFile(source, zip);
  assert.equal(await detectDropSource(zip), 'modpack');
  assert.equal((await inspectModpack(source)).name, 'Test pack');
});

test('staging verifies downloads and applies server overrides last, excluding client overrides', async t => {
  const { source, destination } = await fixture(t, manifest(), {
    'server-overrides/config/test.json': 'server settings',
    'overrides/config/test.json': 'shared settings',
    'client-overrides/config/client.json': 'client only',
  });
  await stageModpack(source, destination, { fetchImpl });
  assert.equal(await fs.readFile(path.join(destination, 'config/test.json'), 'utf8'), 'server settings');
  await assert.rejects(fs.stat(path.join(destination, 'config/client.json')), { code: 'ENOENT' });
});

test('Better MC layout keeps custom defaults and server data while skipping client preferences', async t => {
  const { source, destination } = await fixture(t, manifest([file('blueprints/farm.snbt')]), {
    'overrides/configureddefaults/options.txt': 'client video settings',
    'overrides/configureddefaults/config/server.toml': 'default configuration',
    'overrides/configureddefaults/README.md': 'defaults documentation',
    'overrides/configureddefaults/libraries/loader.jar': 'bundled loader',
    'overrides/othermod/data/example.json': 'shared data',
    'server-overrides/othermod/data/example.json': 'server data',
    'server-overrides/othermod/server-rules.txt': 'server rules',
    'client-overrides/othermod/client-rules.txt': 'client rules',
    'overrides/start.bat': 'unused launch script',
  });
  const pack = await inspectModpack(source);
  assert.equal(pack.skipped, 3);
  assert.equal(pack.fileCount, 5);
  await stageModpack(source, destination, { fetchImpl });
  for (const [file, expected] of Object.entries({
    'blueprints/farm.snbt': payload.toString(),
    'configureddefaults/config/server.toml': 'default configuration',
    'configureddefaults/README.md': 'defaults documentation',
    'othermod/data/example.json': 'server data',
    'othermod/server-rules.txt': 'server rules',
  })) assert.equal(await fs.readFile(path.join(destination, file), 'utf8'), expected);
  for (const file of ['configureddefaults/options.txt', 'configureddefaults/libraries', 'start.bat', 'othermod/client-rules.txt']) {
    await assert.rejects(fs.stat(path.join(destination, file)), { code: 'ENOENT' });
  }
});

test('preview refuses explicit server overrides that target BlockHost launch or metadata files', async t => {
  const { source } = await fixture(t, manifest([]), { 'server-overrides/.blockhost-addon-journal-file.json': '{}' });
  await assert.rejects(inspectModpack(source), /reserved for the server setup/);
});

test('preview rejects a file and directory conflict across override layers', async t => {
  const { source } = await fixture(t, manifest([file('config/test.json')]), {
    'server-overrides/CONFIG/TEST.JSON/value.txt': 'conflicting child',
  });
  await assert.rejects(inspectModpack(source), /same path as a file and a folder/);
});

test('case-insensitive override winners replace downloads without requesting unused URLs', async t => {
  const { source, destination } = await fixture(t, manifest([file('config/same.toml')]), {
    'overrides/config/same.toml': 'shared',
    'server-overrides/CONFIG/Same.toml': 'dedicated server',
  });
  await stageModpack(source, destination, { fetchImpl: async () => assert.fail('The manifest file was replaced') });
  assert.deepEqual(await fs.readdir(destination), ['CONFIG']);
  assert.equal(await fs.readFile(path.join(destination, 'CONFIG/Same.toml'), 'utf8'), 'dedicated server');
});

test('a stale manifest size is accepted only when the pinned SHA-512 matches', async t => {
  const { source, destination } = await fixture(t, manifest([file('config/test.json', { fileSize: payload.length - 2 })]));
  await stageModpack(source, destination, { fetchImpl });
  assert.deepEqual(await fs.readFile(path.join(destination, 'config/test.json')), payload);
  await assert.rejects(stageModpack(source, destination + '-bad', {
    fetchImpl: async () => new Response(Buffer.alloc(payload.length)),
  }), /config\/test.json.*checksum/);
  await assert.rejects(fs.stat(destination + '-bad'), { code: 'ENOENT' });
});

test('transient downloads retry and a missing file does not leave a partial installation', async t => {
  const { source, destination } = await fixture(t);
  let attempts = 0;
  await stageModpack(source, destination, {
    fetchImpl: async () => ++attempts === 1 ? new Response(null, { status: 503 }) : new Response(payload),
  });
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(stageModpack(source, destination + '-missing', {
    fetchImpl: async () => { attempts++; return new Response(null, { status: 404 }); },
  }), /config\/test.json.*404/);
  assert.equal(attempts, 1);
  await assert.rejects(fs.stat(destination + '-missing'), { code: 'ENOENT' });
});

test('only the exact Better MC release selects the publisher archive', async t => {
  const { destination } = await fixture(t);
  const release = publisherServerPack('M5BnAIQy');
  assert.equal(release.packVersion, 'v40');
  assert.equal(release.loaderVersion, '0.18.4');
  assert.equal(publisherServerPack('different-release'), undefined);
  assert.equal(publisherServerPack('M5BnAIQy', 'different-project'), undefined);
  assert.equal(publisherServerPack('M5BnAIQy', 'shFhR8Vx'), release);
  await assert.rejects(downloadPublisherServerPack('M5BnAIQy', destination, {
    fetchImpl: async url => { assert.equal(url, release.url); return new Response(payload); },
  }), /checksum/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  assert.throws(() => validatePackUrl(release.url), /unsupported download/);
});

test('online packs skip catalogued client-only JARs only when the exact SHA-512 matches', async t => {
  const versionId = 'aBcDe123';
  const mod = file('mods/client.jar', { downloads: ['https://cdn.modrinth.com/data/AABBCCDD/versions/' + versionId + '/client.jar'] });
  const { source, destination } = await fixture(t, manifest([mod]));
  let downloads = 0;
  const run = async (target, hash) => stageModpack(source, target, {
    checkCatalogue: true,
    fetchImpl: async url => {
      const request = new URL(url);
      if (request.hostname === 'api.modrinth.com') {
        assert.deepEqual(JSON.parse(request.searchParams.get('ids')), [versionId]);
        return Response.json([{ id: versionId, environment: 'client_only', files: [{ hashes: { sha512: hash } }] }]);
      }
      downloads++;
      return new Response(null, { status: 404 });
    },
  });
  await run(destination, digest);
  assert.equal(downloads, 0);
  await assert.rejects(run(destination + '-unknown', 'f'.repeat(128)), /client.jar.*404/);
  assert.equal(downloads, 1);
});

test('catalogue fallback keeps server-optional mods and respects the pack’s explicit server plan', async t => {
  const jar = await modJar({ 'fabric.mod.json': JSON.stringify({ id: 'shared-library', version: '1', environment: '*' }) });
  const hashes = { sha512: crypto.createHash('sha512').update(jar).digest('hex') };
  const files = [file('mods/required.jar', {
    hashes, fileSize: jar.length, env: { server: 'required' }, downloads: ['https://cdn.modrinth.com/data/project/versions/REQUIRED/library.jar'],
  }), file('mods/optional-on-server.jar', {
    hashes, fileSize: jar.length, downloads: ['https://cdn.modrinth.com/data/project/versions/OPTIONAL/library.jar'],
  })];
  const { source, destination } = await fixture(t, manifest(files));
  await stageModpack(source, destination, { checkCatalogue: true, fetchImpl: async url => {
    const request = new URL(url);
    if (request.hostname !== 'api.modrinth.com') return new Response(jar);
    assert.deepEqual(JSON.parse(request.searchParams.get('ids')), ['OPTIONAL']);
    return Response.json([{ id: 'OPTIONAL', environment: 'client_only_server_optional', files: [{ hashes }] }]);
  } });
  assert.deepEqual((await fs.readdir(path.join(destination, 'mods'))).sort(), ['optional-on-server.jar', 'required.jar']);
});

test('optional server files are opt-in', async t => {
  const { source, destination, root } = await fixture(t, manifest([file('config/optional.json', { env: { server: 'optional' } })]));
  let downloads = 0;
  const mock = async () => { downloads++; return new Response(payload); };
  await stageModpack(source, destination, { fetchImpl: mock });
  assert.equal(downloads, 0);
  await stageModpack(source, path.join(root, 'with-optional'), { fetchImpl: mock, includeOptional: true });
  assert.equal(downloads, 1);
});

test('failed verification and cancelled installs remove staging files', async t => {
  const { source, destination } = await fixture(t);
  await assert.rejects(stageModpack(source, destination, { fetchImpl: async () => new Response(Buffer.alloc(payload.length)) }), /checksum/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(stageModpack(source, destination, { fetchImpl, signal: controller.signal }));
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('redirects cannot send modpack requests to an untrusted host', async t => {
  const { source, destination } = await fixture(t);
  let calls = 0;
  await assert.rejects(stageModpack(source, destination, { fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); } }), /unsupported download/);
  assert.equal(calls, 1);
});

test('browse shows only projects with dedicated releases or pinned publisher server downloads', async () => {
  let request;
  const results = await searchModpacks('adventure', 18, async url => {
    const target = new URL(url);
    if (target.pathname === '/v2/search') {
      request = target;
      return Response.json({ total_hits: 40, hits: ['dedicated', 'mixed', 'sodiumplus', 'shFhR8Vx', 'gone'].map(id => ({
        project_type: 'modpack', project_id: id, title: id, description: 'A client-side optimization modpack', icon_url: 'https://bad.example/icon',
      })) });
    }
    const id = target.pathname.split('/').at(-2);
    if (id === 'gone') return new Response(null, { status: 404 });
    assert.ok(['mixed', 'dedicated', 'sodiumplus'].includes(id));
    const release = { id: 'release', name: 'SERVER fixture', version_type: 'release', project_id: id, loaders: ['fabric'], game_versions: ['1.20.1'],
      environment: id === 'mixed' ? 'client_and_server' : 'dedicated_server_only',
      files: [{ filename: 'pack.mrpack', url: 'https://cdn.modrinth.com/pack.mrpack', size: 5, hashes: { sha512: digest } }],
    };
    return Response.json(id === 'sodiumplus' ? [
      { ...release, id: 'client', name: 'Client fixture', environment: 'client_only' },
      { ...release, id: 'mislabeled', name: 'Optimization 2.4.8', version_type: 'release' },
      { ...release, version_type: 'alpha' },
    ] : [release]);
  });
  assert.equal(request.searchParams.get('offset'), '18');
  assert.match(request.searchParams.get('facets'), /project_type:modpack/);
  assert.match(request.searchParams.get('facets'), /environment:dedicated_server_only/);
  assert.deepEqual(results.results.map(item => item.id), ['dedicated', 'sodiumplus', 'shFhR8Vx']);
  assert.equal(results.results[1].serverRelease.name, 'SERVER fixture');
  assert.equal(results.results[1].description, undefined);
  assert.equal(results.results[2].serverRelease.name, 'v40');
  assert.equal(results.hasMore, true);
  assert.equal(results.results[0].iconUrl, '');
});

test('Modrinth checks project identity and permits only server-only releases with an unambiguous archive', async t => {
  const { source, root } = await fixture(t);
  const archive = await fs.readFile(source);
  const packFile = { filename: 'test.mrpack', primary: true, url: 'https://cdn.modrinth.com/data/pack/versions/server/test.mrpack',
    size: archive.length, hashes: { sha512: crypto.createHash('sha512').update(archive).digest('hex') } };
  const release = { project_id: 'pack', name: 'Test pack', loaders: ['fabric'], game_versions: ['1.20.1'],
    version_type: 'release', files: [packFile] };
  const versions = [
    { ...release, id: 'client', environment: 'client_only' },
    { ...release, id: 'unknown', environment: 'unknown' },
    { ...release, id: 'mixed', environment: 'client_and_server' },
    { ...release, id: 'legacy', server_side: 'required' },
    { ...release, id: 'clientfile', environment: 'dedicated_server_only', files: [{ ...packFile, environment: 'client_only' }] },
    { ...release, id: 'ambiguous', environment: 'dedicated_server_only', files: [packFile, { ...packFile, filename: 'another.mrpack' }] },
    { ...release, id: 'mislabeled', environment: 'dedicated_server_only' },
    { ...release, id: 'server', name: 'Test pack SERVER', environment: 'dedicated_server_only', files: [{ ...packFile, environment: 'client_only' }, { ...packFile, primary: false }] },
  ];
  let downloads = 0;
  const fetchImpl = async url => {
    if (url === packFile.url) { downloads++; return new Response(archive); }
    const target = new URL(url);
    if (target.pathname === '/v2/project/pack') return Response.json({ id: 'pack', project_type: 'modpack', environment: ['client_only', 'dedicated_server_only'] });
    if (target.pathname === '/v2/project/pack/version') return Response.json(versions);
    return Response.json(versions.find(version => target.pathname === '/v2/version/' + version.id));
  };
  assert.deepEqual((await modpackVersions('pack', fetchImpl)).map(item => item.id), ['server']);
  const target = path.join(root, 'verified.mrpack');
  await assert.rejects(downloadPackVersion('client', target, { fetchImpl, projectId: 'pack' }), /no dedicated-server/);
  await assert.rejects(downloadPackVersion('mixed', target, { fetchImpl, projectId: 'pack' }), /no dedicated-server/);
  await assert.rejects(downloadPackVersion('mislabeled', target, { fetchImpl, projectId: 'pack' }), /no dedicated-server/);
  await assert.rejects(downloadPackVersion('server', target, { fetchImpl, projectId: 'different' }), /selected modpack/);
  assert.equal(downloads, 0);
  assert.deepEqual(await downloadPackVersion('server', target, { fetchImpl, projectId: 'pack' }), { games: ['1.20.1'], loaders: ['fabric'] });
  assert.equal((await inspectModpack(target)).version, '1.20.1');
});

test('complete local server packs are inspected before publication and preserve create options', async t => {
  const { inspectExternalServerZip, importExternalServer } = await import('../src/lib/external-importer.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockhost-server-pack-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'server-pack.zip');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('launcher fixture'), 'server-pack/fabric-server-1.21.1.jar');
  zip.addBuffer(Buffer.from('world fixture'), 'server-pack/world/level.dat');
  zip.addBuffer(Buffer.from('{"enabled":true,"destination":"imported destination"}'), 'server-pack/.blockhost-backup.json');
  zip.addBuffer(Buffer.from('{}'), 'server-pack/.blockhost-addon-journal-imported.json');
  const output = pipeline(zip.outputStream, createWriteStream(source)); zip.end(); await output;
  const inspected = await inspectExternalServerZip(source, path.join(root, 'preview'));
  assert.equal(inspected.type, 'fabric'); assert.equal(inspected.version, '1.21.1'); assert.equal(inspected.hasWorld, true);
  const servers = path.join(root, 'servers');
  await assert.rejects(fs.stat(servers), { code: 'ENOENT' });
  await assert.rejects(importExternalServer(inspected.sourceFolder, servers, [], { beforeCommit: () => { throw new Error('cancelled'); } }), /cancelled/);
  assert.deepEqual(await fs.readdir(servers), []);
  const result = await importExternalServer(inspected.sourceFolder, servers, [], { name: 'Custom name', color: '#57dca4', modpack: { name: 'My pack', version: '1' } });
  assert.equal(result.server.name, 'Custom name'); assert.equal(result.server.color, '#57dca4'); assert.equal(result.server.modpack.name, 'My pack');
  await assert.rejects(fs.stat(path.join(result.path, '.blockhost-backup.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(result.path, '.blockhost-addon-journal-imported.json')), { code: 'ENOENT' });
});

test('publisher ZIP detection derives Forge pins without selecting its bundled Java arguments', async t => {
  const { inspectExternalServerZip } = await import('../src/lib/external-importer.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockhost-publisher-launcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'server.zip');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('-javaagent:foreign.jar'), 'libraries/net/minecraftforge/forge/1.20.1-47.3.12/win_args.txt');
  zip.addBuffer(Buffer.from('mod fixture'), 'mods/test.jar');
  const output = pipeline(zip.outputStream, createWriteStream(source));
  zip.end(); await output;
  const inspected = await inspectExternalServerZip(source, path.join(root, 'preview'), { rebuildLauncher: true });
  assert.equal(inspected.type, 'forge');
  assert.equal(inspected.version, '1.20.1');
  assert.equal(inspected.loaderVersion, '1.20.1-47.3.12');
  assert.equal(inspected.launchArgsPath, undefined);
});

test('modpacks accept launcher artwork but validate server world paths', async t => {
  const { source, destination } = await fixture(t, manifest([]), { 'overrides/instance.png': 'artwork', 'server-overrides/server.properties': 'level-name=../../outside\n' });
  await assert.rejects(stageModpack(source, destination), /folder|path|name/i);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('staging accepts Fabric metadata with literal line breaks and still filters client-only mods', async t => {
  async function jar(environment) {
    const description = 'A "quoted" name, a backslash \\ and a line\nbreak';
    const metadata = JSON.stringify({ id: 'fixture', environment, description }).replace('\\nbreak', '\nbreak');
    return modJar({ 'fabric.mod.json': '\uFEFF' + metadata });
  }
  const serverJar = await jar('*');
  const { source, destination } = await fixture(t, manifest([]), {
    'overrides/mods/server.jar': serverJar,
    'overrides/mods/client.jar': await jar('client'),
  });
  await stageModpack(source, destination);
  assert.deepEqual(await fs.readFile(path.join(destination, 'mods/server.jar')), serverJar);
  await assert.rejects(fs.stat(path.join(destination, 'mods/client.jar')), { code: 'ENOENT' });
});

test('staging preserves client-environment JARs explicitly included in the server plan', async t => {
  const jar = await modJar({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id: 'client_menu', name: 'Client Menu', version: '1.0', environment: 'client' }) });
  const required = file('mods/required.jar', {
    fileSize: jar.length, hashes: { sha512: crypto.createHash('sha512').update(jar).digest('hex') }, env: { server: 'required' },
  });
  const { source, destination } = await fixture(t, manifest([required]), {
    'server-overrides/mods/override.jar': jar, 'overrides/mods/unmarked.jar': jar,
  });
  await stageModpack(source, destination, { fetchImpl: async () => new Response(jar) });
  assert.deepEqual((await fs.readdir(path.join(destination, 'mods'))).sort(), ['override.jar', 'required.jar']);
});

test('pack staging filters the target loader’s side declaration for multi-loader JARs', async t => {
  const dual = await modJar({
    'fabric.mod.json': JSON.stringify({ id: 'dual', environment: 'client' }),
    'META-INF/mods.toml': '[[mods]]\nmodId="dual"\nversion="1.0"\n',
    'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'dual' }, minecraft: { environment: 'client' } }),
  });
  const forge = await fixture(t, manifest([], { minecraft: '1.20.1', forge: '47.4.10' }), { 'overrides/mods/dual.jar': dual });
  const quilt = await fixture(t, manifest([], { minecraft: '1.20.1', 'quilt-loader': '0.20' }), { 'overrides/mods/dual.jar': dual });
  await stageModpack(forge.source, forge.destination);
  await stageModpack(quilt.source, quilt.destination);
  assert.deepEqual(await fs.readFile(path.join(forge.destination, 'mods/dual.jar')), dual);
  await assert.rejects(fs.stat(path.join(quilt.destination, 'mods/dual.jar')), { code: 'ENOENT' });
});

test('local packs skip generated ModernFix caches and keep actual structures', async t => {
  const cachePath = 'modernfix/structureCacheV1/apotheosis_boss_1_580fe3e5eb.nbt';
  const { source, destination } = await fixture(t, manifest([file(cachePath)]), {
    ['overrides/' + cachePath]: 'shared cache',
    ['server-overrides/' + cachePath]: 'server cache',
    'overrides/structures/apotheosis_boss.nbt': 'original structure',
  });
  await stageModpack(source, destination, {
    fetchImpl: async () => assert.fail('Generated cache should not be downloaded'),
  });
  await assert.rejects(fs.stat(path.join(destination, cachePath)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(destination, 'structures/apotheosis_boss.nbt'), 'utf8'), 'original structure');
});

test('server starter ZIPs take precedence over CurseForge export manifests', async t => {
  const { inspectExternalServerZip } = await import('../src/lib/external-importer.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockhost-server-starter-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'server-pack.zip');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('{}'), 'manifest.json');
  zip.addBuffer(Buffer.from('MINECRAFT_VERSION=1.19.2\r\nMODLOADER=Forge\r\nMODLOADER_VERSION="43.5.1"\r\n'), 'variables.txt');
  zip.addBuffer(Buffer.from('exit 99'), 'start.bat');
  zip.addBuffer(Buffer.from('bundled mod'), 'mods/example.jar');
  const output = pipeline(zip.outputStream, createWriteStream(source));
  zip.end();
  await output;
  const kind = await detectDropSource(source);
  assert.equal(kind, 'server-starter');
  const pack = await inspectExternalServerZip(source, path.join(root, 'preview'), { starter: true });
  assert.equal(pack.version, '1.19.2');
  assert.equal(pack.type, 'forge');
  assert.equal(pack.loaderVersion, '1.19.2-43.5.1');
  assert.equal(await fs.readFile(path.join(pack.sourceFolder, 'mods/example.jar'), 'utf8'), 'bundled mod');
});

test('bundled server variants pin loaders without executing installers or scripts from the archive', async t => {
  const { inspectExternalServerZip } = await import('../src/lib/external-importer.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockhost-starter-variants-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const forgeManifest = JSON.stringify({
    manifestType: 'minecraftModpack', manifestVersion: 1,
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.4.0', primary: true }] },
  });
  const variants = [
    ['atm-settings', { 'Pack/ServerStart.bat': 'exit 99', 'Pack/Settings.cfg': 'MCVER=1.20.1\r\nFORGEVER=47.4.0', 'Pack/mods/test.jar': 'mod', 'readme.txt': 'notes' }, '1.20.1-47.4.0'],
    ['atm-script', { 'startserver.bat': 'set "MINECRAFT_VERSION=1.20.1"\r\nset "FORGE_VERSION=47.4.0"\r\nexit 99' }, '1.20.1-47.4.0'],
    ['forge-jar', { 'forge-1.20.1-47.4.0-installer.jar': 'placeholder', 'server.properties': '' }, '1.20.1-47.4.0'],
    ['neoforge-jar', { 'neoforge-21.1.172-installer.jar': 'placeholder' }, '21.1.172'],
    ['bundled-manifest', { 'manifest.json': forgeManifest, 'start.sh': 'exit 99' }, '1.20.1-47.4.0'],
    ['conflicting', { 'forge-1.20.1-47.4.0-installer.jar': '', 'neoforge-21.1.172-installer.jar': '' }, null],
    ['launcher-only', { 'manifest.json': forgeManifest, 'overrides/mods/test.jar': 'mod' }, 'modpack'],
    ['packwiz', { 'pack.toml': '', 'index.toml': '' }, 'packwiz'],
    ['prism', { 'mmc-pack.json': '{}' }, 'client-launcher'],
    ['ftb', { 'serverinstaller_123_456.exe': '' }, 'ftb-installer'],
  ];
  for (const [name, entries, expected] of variants) {
    const source = path.join(root, name + '.zip');
    const zip = new yazl.ZipFile();
    if (!['atm-settings', 'launcher-only', 'packwiz', 'prism', 'ftb'].includes(name)) zip.addBuffer(Buffer.from('mod'), 'mods/test.jar');
    for (const [entry, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), entry);
    const output = pipeline(zip.outputStream, createWriteStream(source));
    zip.end();
    await output;
    const kind = await detectDropSource(source);
    if (['modpack', 'packwiz', 'client-launcher', 'ftb-installer'].includes(expected)) {
      assert.equal(kind, expected, name);
      continue;
    }
    assert.equal(kind, 'server-starter', name);
    const inspected = inspectExternalServerZip(source, path.join(root, name), { starter: true });
    if (expected === null) await assert.rejects(inspected, /conflicting loader versions/);
    else assert.equal((await inspected).loaderVersion, expected, name);
  }
});
