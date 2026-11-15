import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import yauzl from 'yauzl';
import { validateRawPropertiesText } from './server-properties.mjs';
import { assertPathInside } from './safe-filesystem.mjs';
import { inspectAddonJar } from './addon-manager.mjs';

const API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'BlockHost/1.0.9 (https://github.com/Nadith12/blockhost)';
const MAX_FILE = 512 * 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'gitlab.com']);
const MANAGED_ROOTS = new Set(['libraries', 'versions', 'runtime', '.fabric', '.quilt', 'server-info.json', 'blockhost-modpack.json', 'addons-lock.json', 'eula.txt', 'user_jvm_args.txt', 'fabric-server-launcher.properties', 'quilt-server-launcher.properties', 'ops.json', 'whitelist.json', 'banned-ips.json', 'banned-players.json']);
const HOST_EXECUTABLE = /\.(exe|dll|bat|cmd|ps1|vbs|lnk|com|scr|sh)$/i;
// A publisher server build can differ from the same release's launcher export.
const PUBLISHER_SERVER_PACKS = new Map([['M5BnAIQy', Object.freeze({
  projectId: 'shFhR8Vx', name: 'Better MC [FABRIC] - BMC2', packVersion: 'v40', type: 'fabric', version: '1.20.1', loaderVersion: '0.18.4',
  fileCount: 1410, size: 601240675, expandedSize: 652225219, fileName: 'BMC2_Server_Pack_v40.zip',
  url: 'https://mediafilez.forgecdn.net/files/7522/918/BMC2_Server_Pack_v40.zip',
  sha512: 'dd41d933d4c24f28b141d436ca6496e81ed4f0e1fac0c8bd06335ea916f83274d39f6c051f9a0f4132c7ab39b94cd4a5dbffdb0cf2be73c9d29da6537667b456',
})]]);
const CLIENT_FILES = new Set(['options.txt', 'optionsof.txt', 'servers.dat', 'servers.dat_old', 'icon.png', 'instance.png', 'pack.png', 'modrinth.index.json']);
const SERVER_PACK_ENVIRONMENTS = new Set(['server_only', 'dedicated_server_only']);
const CLIENT_ENVIRONMENTS = new Set(['client_only', 'singleplayer_only']);
const PACK_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);
const PACK_ID = /^[a-z0-9_-]{1,100}$/i;
const PACK_PAGE_SIZE = 18;

export function packPath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\\x00-\x1f:]/.test(value) || value.startsWith('/')) throw new Error('The modpack contains an unsafe file path.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error('The modpack contains an unsafe Windows file name.');
  return value;
}

function contentPath(value, sharedOverride = false) {
  const name = packPath(value);
  const lower = name.toLowerCase();
  // Configured Defaults copies these paths to the instance root when they are absent.
  const target = lower.replace(/^configureddefaults\//, '');
  const root = target.split('/')[0];
  // ModernFix rebuilds this cache from the pack's original structures.
  if (target.startsWith('modernfix/structurecachev1/') || CLIENT_FILES.has(root) || root === 'shaderpacks' || root === 'screenshots') return null;
  const managed = MANAGED_ROOTS.has(root) || root.startsWith('.blockhost-') || root.endsWith('.jar')
    || (root === 'server.properties' && lower !== 'server.properties');
  if (managed || HOST_EXECUTABLE.test(target)) {
    // Shared overrides sometimes ship launch helpers for other installers. BlockHost installs its own.
    if (sharedOverride) return null;
    throw new Error("The modpack tries to install a file reserved for the server setup: " + name + ". Choose a release that uses the pack format without custom launch files.");
  }
  return lower === 'server.properties' ? lower : name;
}

function installationPlan(files, overrides, includeOptional) {
  const targets = new Map();
  for (const file of files) {
    if (includeOptional || !file.optional) targets.set(file.path.toLowerCase(), file);
  }
  // Later layers replace the same logical file regardless of ZIP entry order or case.
  for (const server of [false, true]) {
    for (const file of overrides) {
      if (file.server === server) targets.set(file.path.toLowerCase(), file);
    }
  }
  const directories = new Map();
  return Array.from(targets, ([key, file]) => {
    const parts = file.path.split('/');
    let directory = '', directoryKey = '';
    for (const part of parts.slice(0, -1)) {
      directoryKey += part.toLowerCase() + '/';
      if (targets.has(directoryKey.slice(0, -1))) throw new Error('The modpack uses the same path as a file and a folder: ' + key);
      if (!directories.has(directoryKey)) directories.set(directoryKey, directory + part + '/');
      directory = directories.get(directoryKey);
    }
    return { ...file, path: directory + parts.at(-1) };
  });
}

export function parsePackManifest(manifest) {
  if (manifest?.formatVersion !== 1 || manifest.game !== 'minecraft' || !Array.isArray(manifest.files) || manifest.files.length > 10000) throw new Error('This is not a supported Modrinth modpack.');
  const dependencies = manifest.dependencies || {};
  const version = dependencies.minecraft;
  if (typeof version !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(version)) throw new Error('The modpack does not declare a valid Minecraft version.');
  const loaders = Object.keys(dependencies).filter(key => key !== 'minecraft');
  if (loaders.length !== 1 || !['fabric-loader', 'forge', 'neoforge', 'quilt-loader'].includes(loaders[0])) throw new Error('This pack needs an unsupported loader. Choose a Fabric, Forge, NeoForge, or Quilt pack.');
  const type = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' }[loaders[0]];
  let loaderVersion = dependencies[loaders[0]];
  if (typeof loaderVersion !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(loaderVersion)) throw new Error('The modpack declares an invalid loader version.');
  if (type === 'forge' && !loaderVersion.startsWith(version + '-')) loaderVersion = `${version}-${loaderVersion}`;
  const seen = new Set();
  let total = 0, skipped = 0, optional = 0;
  const files = [];
  for (const item of manifest.files) {
    packPath(item.path);
    if (item.env?.server === 'unsupported') { skipped++; continue; }
    if (item.env?.server && !['required', 'optional'].includes(item.env.server)) throw new Error('Invalid server environment in pack manifest.');
    const name = contentPath(item.path);
    if (!name) { skipped++; continue; }
    if (seen.has(name.toLowerCase())) throw new Error('The modpack has duplicate file paths.');
    seen.add(name.toLowerCase());
    if (!Number.isSafeInteger(item.fileSize) || item.fileSize < 0 || item.fileSize > MAX_FILE) throw new Error('A modpack file exceeds the 512 MB limit.');
    total += item.fileSize;
    if (total > MAX_TOTAL) throw new Error('This modpack exceeds the 4 GB installation limit.');
    if (!/^[a-f0-9]{128}$/i.test(item.hashes?.sha512 || '')) throw new Error(`Missing SHA-512 checksum for ${name}.`);
    if (!Array.isArray(item.downloads) || !item.downloads.length) throw new Error(`Missing download for ${name}.`);
    const downloads = item.downloads.filter(url => { try { validatePackUrl(url); return true; } catch { return false; } });
    if (!downloads.length) throw new Error(`No supported HTTPS download source for ${name}.`);
    if (item.env?.server === 'optional') optional++;
    files.push({ path: name, size: item.fileSize, sha512: item.hashes.sha512.toLowerCase(), downloads,
      serverEnvironment: item.env?.server, optional: item.env?.server === 'optional' });
  }
  return { name: String(manifest.name || 'Modpack').slice(0, 100), packVersion: String(manifest.versionId || '').slice(0, 100), type, version, loaderVersion, files, totalBytes: total, skipped, optional };
}

export function validatePackUrl(value, api = false, publisher = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !(api ? url.hostname === 'api.modrinth.com' : publisher ? url.hostname === 'mediafilez.forgecdn.net' : HOSTS.has(url.hostname))) throw new Error('This pack uses an unsupported download address.');
  return url.href;
}

async function request(url, { api = false, publisher = false, fetchImpl = fetch, signal, timeoutMs = 120000 } = {}) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    validatePackUrl(url, api, publisher);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { 'User-Agent': USER_AGENT } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('The pack download redirected without an address.');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error("Modpack download failed (HTTP " + response.status + ").");
      error.status = response.status;
      error.retryable = RETRYABLE_STATUS.has(response.status);
      throw error;
    }
    return response;
  }
  throw new Error('Too many modpack download redirects.');
}

async function apiJson(route, fetchImpl = fetch, signal) {
  const response = await request(`${API}${route}`, { api: true, fetchImpl, signal });
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('The modpack catalogue response is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function pinnedServerReleases(projectId) {
  return [...PUBLISHER_SERVER_PACKS].filter(([, pack]) => pack.projectId === projectId).map(([id, pack]) => ({
    id, name: pack.packVersion, channel: 'release', games: [pack.version], loaders: [pack.type], compatibility: 'Publisher Server Pack',
  }));
}

function hasClientOnlyRelease(project, versions = []) {
  return (Array.isArray(project.environment) && project.environment.some(environment => CLIENT_ENVIRONMENTS.has(environment)))
    || (project.client_side === 'required' && project.server_side === 'unsupported')
    || versions.some(version => CLIENT_ENVIRONMENTS.has(version.environment));
}

function dedicatedServerReleases(project, projectId, versions) {
  const needsServerLabel = hasClientOnlyRelease(project, versions);
  return versions.filter(version => version.project_id === projectId && !publisherServerPack(version.id, projectId) && serverReleaseFile(version, needsServerLabel)).map(version => ({
    id: version.id, name: version.name, channel: version.version_type, games: version.game_versions,
    loaders: version.loaders, compatibility: 'Server-only distribution',
  }));
}

export async function searchModpacks(query = '', offset = 0, fetchImpl = fetch) {
  const index = Math.max(0, Math.min(1000, Math.trunc(Number(offset) || 0)));
  const pinnedProjects = new Set([...PUBLISHER_SERVER_PACKS.values()].map(pack => pack.projectId));
  const facets = [['project_type:modpack'], [...PACK_LOADERS].map(loader => `categories:${loader}`),
    [...[...SERVER_PACK_ENVIRONMENTS].map(environment => `environment:${environment}`), ...[...pinnedProjects].map(id => `project_id:${id}`)]];
  const params = new URLSearchParams({ query: String(query).slice(0, 100), facets: JSON.stringify(facets),
    index: query ? 'relevance' : 'downloads', limit: String(PACK_PAGE_SIZE), offset: String(index) });
  const signal = AbortSignal.timeout(12000);
  const data = await apiJson(`/search?${params}`, fetchImpl, signal);
  const hits = (data.hits || []).filter(hit => hit.project_type === 'modpack' && PACK_ID.test(hit.project_id || ''));
  // The search facets aggregate across releases. Check the exact releases before showing a project.
  const supported = new Map([...pinnedProjects].map(id => [id, pinnedServerReleases(id)[0]]));
  const candidates = hits.filter(hit => !supported.has(hit.project_id));
  for (let start = 0; start < candidates.length; start += 4) {
    await Promise.all(candidates.slice(start, start + 4).map(async hit => {
      const releases = await apiJson(`/project/${hit.project_id}/version?include_changelog=false`, fetchImpl, signal).catch(error => {
        if ([404, 410].includes(error.status)) return [];
        throw error;
      });
      const dedicated = dedicatedServerReleases(hit, hit.project_id, releases);
      const featured = dedicated.find(release => release.channel === 'release') || dedicated[0];
      if (featured) supported.set(hit.project_id, featured);
    }));
  }
  const total = Math.min(1000 + PACK_PAGE_SIZE, data.total_hits);
  const results = hits.filter(hit => supported.has(hit.project_id)).map(hit => ({
    id: hit.project_id, title: hit.title, serverRelease: supported.get(hit.project_id), author: hit.author,
    iconUrl: hit.icon_url?.startsWith('https://cdn.modrinth.com/') ? hit.icon_url : '', downloads: hit.downloads,
  }));
  return { total, results, hasMore: index + PACK_PAGE_SIZE <= 1000 && index + PACK_PAGE_SIZE < total };
}

export async function modpackVersions(projectId, fetchImpl = fetch) {
  if (!PACK_ID.test(projectId || '')) throw new Error('Invalid modpack project.');
  const project = await apiJson(`/project/${projectId}`, fetchImpl);
  if (project.project_type !== 'modpack' || !PACK_ID.test(project.id || '')) throw new Error('This project is not a Modrinth modpack.');
  const versions = await apiJson(`/project/${project.id}/version?include_changelog=false`, fetchImpl);
  return [...pinnedServerReleases(project.id), ...dedicatedServerReleases(project, project.id, versions)].slice(0, 100);
}

function serverReleaseFile(version, needsServerLabel) {
  if (!PACK_ID.test(version.id || '') || !['listed', 'unlisted', undefined].includes(version.status) ||
    !version.loaders?.some(loader => PACK_LOADERS.has(loader)) || !version.game_versions?.length ||
    !SERVER_PACK_ENVIRONMENTS.has(version.environment) || version.server_side === 'unsupported') return null;
  const files = (version.files || []).filter(file => {
    if (!/\.mrpack$/i.test(file.filename || '') || (file.environment && !SERVER_PACK_ENVIRONMENTS.has(file.environment)) || file.server_side === 'unsupported' ||
      !/^[a-f0-9]{128}$/i.test(file.hashes?.sha512 || '') || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE) return false;
    // A mixed project's client release can carry an incorrect dedicated environment flag.
    if (needsServerLabel && !SERVER_PACK_ENVIRONMENTS.has(file.environment)
      && ![version.name, file.filename].some(label => /(^|[^a-z0-9])server(?=$|[^a-z0-9])/i.test(label || ''))) return false;
    try { return new URL(validatePackUrl(file.url)).hostname === 'cdn.modrinth.com'; } catch { return false; }
  });
  const primary = files.filter(file => file.primary);
  return files.length === 1 ? files[0] : primary.length === 1 ? primary[0] : null;
}

export async function downloadPackVersion(versionId, destination, options = {}) {
  if (!PACK_ID.test(versionId || '')) throw new Error('Invalid modpack release.');
  const version = await apiJson(`/version/${versionId}`, options.fetchImpl, options.signal);
  if (version.id !== versionId || !PACK_ID.test(version.project_id || '') || (options.projectId && version.project_id !== options.projectId)) {
    throw new Error('The Modrinth release does not belong to the selected modpack.');
  }
  const project = await apiJson(`/project/${version.project_id}`, options.fetchImpl, options.signal);
  if (project.project_type !== 'modpack' || project.id !== version.project_id) throw new Error('This release has no dedicated-server Modrinth pack download.');
  const versions = Array.isArray(project.environment) || hasClientOnlyRelease(project) ? []
    : await apiJson(`/project/${version.project_id}/version?include_changelog=false`, options.fetchImpl, options.signal);
  const file = serverReleaseFile(version, hasClientOnlyRelease(project, versions));
  if (!file) throw new Error('This release has no dedicated-server Modrinth pack download.');
  await downloadVerified({ path: file.filename, downloads: [file.url], size: file.size, sha512: file.hashes.sha512 }, destination, options);
  return { games: version.game_versions, loaders: version.loaders };
}

export function publisherServerPack(versionId, projectId) {
  const pack = PUBLISHER_SERVER_PACKS.get(versionId);
  return projectId === undefined || pack?.projectId === projectId ? pack : undefined;
}

export async function downloadPublisherServerPack(versionId, destination, options = {}) {
  const pack = publisherServerPack(versionId);
  if (!pack) throw new Error('No verified publisher server archive is available for this release.');
  const disk = await fs.promises.statfs(path.dirname(destination));
  if (disk.bavail * disk.bsize < pack.size + 2 * pack.expandedSize + MAX_FILE) throw new Error('Not enough free disk space for this server pack.');
  let lastPercent = -1;
  await downloadVerified({ path: pack.fileName, downloads: [pack.url], size: pack.size, sha512: pack.sha512 }, destination, {
    ...options, publisher: true, maxBytes: MAX_TOTAL, timeoutMs: 20 * 60_000,
    onBytes(size) {
      const percent = Math.floor(size / pack.size * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      options.onProgress?.({ percent: Math.floor(percent * 0.75), message: 'Downloading the publisher’s server pack… ' + percent + '%' });
    },
  });
}

async function downloadVerified(file, destination, options = {}) {
  const { signal, accountBytes, maxBytes = MAX_FILE, onBytes } = options;
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) throw new Error('The pack file is too large.');
  let lastError;
  for (const url of file.downloads) {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const output = await fs.promises.open(destination, 'wx');
      let size = 0;
      let charged = 0;
      try {
        const response = await request(url, options);
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          const error = new Error(`Pack download failed (HTTP ${response.status}).`);
          error.retryable = RETRYABLE_STATUS.has(response.status);
          throw error;
        }
        const hash = crypto.createHash('sha512');
        const meter = new Transform({ transform(chunk, _encoding, callback) {
          size += chunk.length;
          try {
            if (size > maxBytes || (!accountBytes && size > file.size)) throw new Error('Download exceeds its size limit.');
            accountBytes?.(chunk.length);
            charged += chunk.length;
            onBytes?.(size);
          } catch (error) { return callback(error); }
          hash.update(chunk); callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), meter, output.createWriteStream(), { signal });
        // The .mrpack manifest size is a progress estimate. The pinned hash verifies the actual file.
        if ((!accountBytes && size !== file.size) || hash.digest('hex') !== file.sha512.toLowerCase()) throw new Error('Modpack checksum verification failed.');
        return;
      } catch (error) {
        lastError = error;
      } finally {
        await output.close();
      }
      await fs.promises.rm(destination, { force: true });
      accountBytes?.(-charged);
      signal?.throwIfAborted();
      const retryable = lastError.retryable || lastError.name === 'TimeoutError'
        || (lastError instanceof TypeError && ['fetch failed', 'terminated'].includes(lastError.message));
      if (!retryable || attempt === 2) break;
      await delay(300 * (attempt + 1), undefined, { signal });
    }
  }
  const reason = lastError?.message || 'No download source available.';
  throw new Error('Could not download ' + file.path + '. ' + reason, { cause: lastError });
}

async function walkZip(source, visit) {
  return new Promise((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) return reject(new Error('This modpack archive is damaged or incomplete.'));
      let count = 0, total = 0, failed = false;
      const names = new Set();
      const fail = error => { failed = true; zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        Promise.resolve().then(async () => {
          const name = packPath(entry.fileName.replace(/\/$/, ''));
          if (++count > 50000 || (total += entry.uncompressedSize) > MAX_TOTAL || entry.uncompressedSize > MAX_FILE) throw new Error('The modpack archive exceeds safe extraction limits.');
          if ((entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000 || entry.generalPurposeBitFlag & 1) throw new Error('Linked or encrypted files cannot be imported.');
          if (names.has(name.toLowerCase())) throw new Error('The archive contains duplicate paths.');
          names.add(name.toLowerCase());
          if (!entry.fileName.endsWith('/')) await visit(entry, () => new Promise((res, rej) => zip.openReadStream(entry, (err, stream) => err ? rej(err) : res(stream))));
          if (!failed) zip.readEntry();
        }).catch(fail);
      });
      zip.readEntry();
    });
  });
}

export async function inspectModpack(source) {
  const stat = await fs.promises.stat(source);
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Choose a modpack archive smaller than 512 MB.');
  let manifest, curseforge;
  const overrideEntries = [];
  await walkZip(source, async (entry, open) => {
    if (entry.fileName === "modrinth.index.json" || entry.fileName === "manifest.json") {
      if (entry.uncompressedSize > 8 * 1024 * 1024) throw new Error("Modpack manifest is too large.");
      const chunks = [];
      for await (const chunk of await open()) chunks.push(chunk);
      const json = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      if (entry.fileName === "modrinth.index.json") manifest = JSON.parse(json);
      else {
        try { curseforge = JSON.parse(json); } catch {}
      }
    } else if (/^(overrides|server-overrides)\//.test(entry.fileName)) {
      overrideEntries.push(entry);
    }
  });
  if (!manifest) {
    if (curseforge?.manifestType === "minecraftModpack" && Array.isArray(curseforge.files)) {
      throw new Error("Client-side modpack detected. This ZIP is for the CurseForge launcher. Download and select the server-side modpack (Server Pack ZIP) for the same release.");
    }
    throw new Error("Choose a server-side modpack: a server-compatible Modrinth .mrpack or the author’s Server Pack ZIP.");
  }
  const pack = parsePackManifest(manifest);
  const overrides = [];
  let skipped = pack.skipped;
  for (const entry of overrideEntries) {
    const server = entry.fileName.startsWith("server-overrides/");
    const name = contentPath(entry.fileName.replace(/^[^/]+\//, ""), !server);
    if (name) overrides.push({ archivePath: entry.fileName, path: name, size: entry.uncompressedSize, server });
    else skipped++;
  }
  const plan = installationPlan(pack.files, overrides, true);
  const totalBytes = plan.reduce((sum, item) => sum + item.size, 0);
  if (totalBytes > MAX_TOTAL) throw new Error('This modpack exceeds the 4 GB installation limit.');
  return { ...pack, fileCount: plan.length, totalBytes, skipped, overrides };
}

async function filterCatalogueClientMods(files, { fetchImpl, signal }) {
  const downloadsByVersion = new Map();
  for (const file of files) {
    if (file.serverEnvironment || !/^mods\/[^/]+\.jar$/i.test(file.path)) continue;
    for (const address of file.downloads) {
      const url = new URL(address);
      const versionId = url.hostname === 'cdn.modrinth.com' && url.pathname.match(/^\/data\/[a-z0-9]+\/versions\/([a-z0-9]{8})\//i)?.[1];
      if (versionId) {
        if (!downloadsByVersion.has(versionId)) downloadsByVersion.set(versionId, new Set());
        downloadsByVersion.get(versionId).add(file.sha512);
      }
    }
  }
  const ids = [...downloadsByVersion.keys()];
  const clientFiles = new Set();
  const deadline = AbortSignal.timeout(8000);
  const lookupSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let i = 0; i < ids.length; i += 80) {
    const params = new URLSearchParams({ ids: JSON.stringify(ids.slice(i, i + 80)) });
    try {
      const releases = await apiJson('/versions?' + params, fetchImpl, lookupSignal);
      for (const release of releases) {
        const hashes = downloadsByVersion.get(release.id);
        const clientOnly = CLIENT_ENVIRONMENTS.has(release.environment) || (!release.environment && release.server_side === 'unsupported');
        if (!hashes || !clientOnly) continue;
        for (const file of release.files || []) {
          const hash = file.hashes?.sha512?.toLowerCase();
          if (hashes.has(hash)) clientFiles.add(hash);
        }
      }
    } catch {
      signal?.throwIfAborted();
      break;
    }
  }
  return files.filter(file => file.serverEnvironment || !clientFiles.has(file.sha512) || !/^mods\/[^/]+\.jar$/i.test(file.path));
}

export async function removePackClientMods(folder, loader, signal, serverFiles = new Set()) {
  const mods = path.join(folder, 'mods');
  const files = (await fs.promises.readdir(mods, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter(entry => entry.isFile() && /\.jar$/i.test(entry.name) && !serverFiles.has(`mods/${entry.name.toLowerCase()}`));
  for (let index = 0; index < files.length; index += 6) {
    const remove = await Promise.all(files.slice(index, index + 6).map(async entry => {
      signal?.throwIfAborted();
      const target = path.join(mods, entry.name);
      const metadata = await inspectAddonJar(target, loader).catch(error => {
        throw new Error('Could not inspect mod ' + entry.name + '. ' + error.message, { cause: error });
      });
      // Forge or NeoForge may run Fabric mods through a bridge. Its loader decides which apply.
      const nativeDescriptor = metadata.loader === loader || (loader === 'quilt' && metadata.loader === 'fabric');
      return nativeDescriptor && metadata.environment === 'client_only' ? target : null;
    }));
    signal?.throwIfAborted();
    for (const target of remove.filter(Boolean)) await fs.promises.rm(target);
  }
}

export async function stageModpack(source, destination, options = {}) {
  const pack = await inspectModpack(source);
  const plan = installationPlan(pack.files, pack.overrides, options.includeOptional);
  let files = plan.filter(file => !file.archivePath);
  if (options.checkCatalogue) {
    options.onProgress?.({ message: 'Checking which releases support dedicated servers…', percent: 0 });
    files = await filterCatalogueClientMods(files, options);
  }
  const overrides = new Map(plan.filter(file => file.archivePath).map(file => [file.archivePath, file]));
  const total = plan.reduce((sum, file) => sum + file.size, 0);
  const disk = await fs.promises.statfs(path.dirname(destination));
  const spaceBudget = Math.min(MAX_TOTAL, disk.bavail * disk.bsize - 512 * 1024 * 1024);
  if (spaceBudget < total) throw new Error('Not enough free disk space for this modpack.');
  let bytes = [...overrides.values()].reduce((sum, file) => sum + file.size, 0);
  const accountBytes = (delta) => {
    if (bytes + delta > spaceBudget) throw new Error('The modpack exceeds its installation size limit or available disk space.');
    bytes += delta;
  };
  await fs.promises.mkdir(destination, { recursive: false });
  try {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const downloads = { ...options, signal, accountBytes };
    let next = 0, completed = 0, failure;
    const workers = Array.from({ length: Math.min(6, files.length) }, async () => {
      try {
        while (next < files.length) {
          signal.throwIfAborted();
          const file = files[next++];
          const target = assertPathInside(destination, path.join(destination, file.path));
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await downloadVerified(file, target, downloads);
          completed++;
          options.onProgress?.({ message: "Downloaded " + completed + " of " + files.length + ": " + file.path, percent: Math.round(completed / files.length * 85) });
        }
      } catch (error) {
        failure ??= error;
        controller.abort();
      }
    });
    await Promise.all(workers);
    if (failure) throw failure;
    options.signal?.throwIfAborted();
    options.onProgress?.({ message: 'Applying modpack overrides…', percent: 85 });
    await walkZip(source, async (entry, open) => {
      options.signal?.throwIfAborted();
      const item = overrides.get(entry.fileName);
      if (!item) return;
      const target = assertPathInside(destination, path.join(destination, item.path));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await pipeline(await open(), fs.createWriteStream(target, { flags: 'wx' }), { signal: options.signal });
    });
    options.onProgress?.({ message: 'Checking which mods run on the server…', percent: 88 });
    const serverFiles = new Set(plan.filter(file => file.server || file.serverEnvironment).map(file => file.path.toLowerCase()));
    await removePackClientMods(destination, pack.type, options.signal, serverFiles);
    const properties = path.join(destination, 'server.properties');
    if (await fs.promises.stat(properties).catch(() => null)) validateRawPropertiesText(await fs.promises.readFile(properties, 'utf8'), pack.version);
    options.onProgress?.({ message: 'Pack files verified. Installing the matching server loader…', percent: 90 });
    return pack;
  } catch (error) {
    await fs.promises.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
