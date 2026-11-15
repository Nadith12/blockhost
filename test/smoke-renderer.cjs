// Run after npm run package: npx electron test/smoke-renderer.cjs
// Uses fake servers and an isolated profile; never starts Java or reads user data.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const resources = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../out/BlockHost Manager-win32-x64/resources');
const bundle = path.join(resources, 'app.asar/.vite');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'blockhost-renderer-smoke-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Renderer smoke test timed out'); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  const { parseConsoleLine } = await import(pathToFileURL(path.resolve(__dirname, '../src/lib/console-log.mjs')));
  const logs = Array.from({ length: 2000 }, (_, index) => parseConsoleLine(
    index === 1999 ? '[12:00:00 WARN]: Smoke warning' : `Smoke line ${index}`,
    { id: index + 1, receivedAt: '2026-11-05T01:00:00Z' }
  ));
  const runtime = { serverId: 1, status: 'running', startedAt: new Date().toISOString(), logs, onlinePlayers: ['Alex', 'Steve'] };
  const beginnerRuntime = { serverId: 2, status: 'offline', logs: [], onlinePlayers: [] };
  const repairState = {
    status: 'repair',
    diagnosis: {
      kind: 'dependency', problem: 'A required mod is missing.',
      requirements: [{ kind: 'missing', modId: 'fixture-library', requiredBy: 'Adventure Mod', version: '2.0' }],
      evidence: ['Fabric loader stack trace'],
    },
  };
  const repairRuntime = { serverId: 3, status: 'offline', logs: [], modpackSetup: repairState };
  const servers = [
    { id: 1, name: 'Smoke fixture', type: 'fabric', typeLabel: 'Fabric', version: '1.21.11', color: '#39c9ff', modpack: { name: 'Installed fixture pack', version: '2.3' } },
    { id: 4, name: 'Offline fixture', type: 'vanilla', typeLabel: 'Vanilla', version: '1.21.11', color: '#fb7185' },
  ];
  ipcMain.handle('servers:getSaved', () => servers);
  ipcMain.handle('servers:commandData', () => ({
    tree: { children: { give: { type: 'literal', children: {
      targets: { type: 'argument', parser: 'minecraft:entity', children: {
        item: { type: 'argument', parser: 'minecraft:item_stack' },
      } },
    } } } },
    registries: { item: ['blue_wool', 'blue_dye', 'stone'] },
  }));
  ipcMain.handle('servers:getRuntimeState', (_event, id) => id === 3 ? repairRuntime : id === 2 ? beginnerRuntime
    : id === 4 ? { serverId: 4, status: 'offline', logs: [], onlinePlayers: [] } : runtime);
  const startRequests = [];
  const bundledDependencyRetries = [];
  const manualDependencyFiles = [];
  let finishPackCheck;
  let packCheckCancellations = 0;
  ipcMain.handle('servers:start', (_event, { id, acceptEula, repairBundledDependency }) => {
    startRequests.push({ id, accepted: Boolean(acceptEula) });
    if (id === 3) {
      if (repairBundledDependency) bundledDependencyRetries.push(id);
      if (!manualDependencyFiles.length) {
        Object.assign(repairRuntime, { status: 'startup-failed', startupFailed: true, startedAt: new Date().toISOString() });
        return repairRuntime;
      }
      if (!packCheckCancellations) {
        Object.assign(repairRuntime, { status: 'starting', startupFailed: false, checkingModpack: true });
        return new Promise(resolve => { finishPackCheck = resolve; });
      }
      Object.assign(repairRuntime, {
        status: 'starting', startupFailed: false, checkingModpack: false, modpackSetup: { status: 'verified' },
      });
      setTimeout(() => Object.assign(repairRuntime, { status: 'running', joinAddress: 'localhost:25571' }), 300);
      return repairRuntime;
    }
    if (!acceptEula) return { ...beginnerRuntime, requiresEula: true };
    Object.assign(beginnerRuntime, { status: 'running', joinAddress: 'localhost:25570' });
    return beginnerRuntime;
  });
  ipcMain.handle('servers:getUsage', () => ({ processes: [{ serverId: 1, cpuPercent: 2, ramBytes: 1073741824 }] }));
  ipcMain.handle('servers:getProperties', () => ({ values: { 'max-players': 20 }, schema: [] }));
  ipcMain.handle('servers:getVersionOptions', () => [
    { id: '1.21.11', label: '1.21.11', version: '1.21.11' },
    { id: 'fabric-fixture', label: '1.20.1', version: '1.20.1' },
  ]);
  ipcMain.handle('worlds:chooseImportSource', () => ({ token: 'test-world', label: 'Test world', kind: 'folder' }));
  ipcMain.handle('servers:getFolderBytes', () => 1073741824);
  ipcMain.handle('transfers:detectDrop', () => ({ kind: 'world', world: { token: 'dropped-world', label: 'Dropped world.zip', kind: 'zip' } }));
  ipcMain.handle('servers:getMemory', () => ({ minMemoryMb: 512, maxMemoryMb: 4096, limitMb: 8192, systemMemoryMb: 16384 }));
  ipcMain.handle('backups:getSettings', () => ({}));
  let savedAccent, savedIcon;
  ipcMain.handle('servers:updateIdentity', (_event, details) => {
    savedAccent = details.color;
    savedIcon = details.icon;
    return details;
  });
  ipcMain.handle('operations:getActive', () => []);
  ipcMain.handle('servers:javaSettings', () => ({ choice: 'automatic', requiredMajor: 21, versions: [21, 25] }));
  ipcMain.handle('servers:setJavaVersion', (_event, data) => ({ choice: data.version, requiredMajor: 21, versions: [21, 25] }));
  ipcMain.handle('servers:stop', (_event, id) => {
    if (id === 3 && finishPackCheck) {
      packCheckCancellations += 1;
      Object.assign(repairRuntime, { status: 'offline', checkingModpack: false });
      finishPackCheck(repairRuntime);
      finishPackCheck = null;
      return { ...repairRuntime, status: 'stopping' };
    }
    runtime.status = 'offline';
    return runtime;
  });
  const addonFixture = {
    supported: true, kind: 'mods', releaseChannel: 'stable', packInventoryKnown: true,
    items: [
      { id: 'both', title: 'Both sides', fileName: 'both-1.0.jar', enabled: true, environment: 'client_and_server', fromModpack: true },
      { id: 'server', title: 'Server tool', fileName: 'server-1.0.jar', enabled: true, environment: 'server_only' },
      { id: 'disabled', title: 'Disabled client mod', fileName: 'disabled.jar', enabled: false, environment: 'client_and_server' },
    ],
  };
  const bundledDependency = { modId: 'fixture-library', name: 'Bundled Library' };
  ipcMain.handle('addons:list', () => addonFixture);
  ipcMain.handle('addons:inspect', async (_event, id) => {
    await new Promise(resolve => setTimeout(resolve, 100));
    const iconUrl = nativeImage.createFromPath(path.join(resources, 'app-icon-32.png')).toDataURL();
    return { ...addonFixture, ...(id === 3 && manualDependencyFiles.length ? { bundledDependency } : {}),
      items: addonFixture.items.map(item => item.id === 'both' ? { ...item, iconUrl } : item) };
  });
  ipcMain.handle('addons:identify', () => [
    { id: 'both', fileName: 'both-1.0.jar', enabled: true, catalogue: { source: 'modrinth', projectId: 'fixtureProject' } },
  ]);
  ipcMain.handle('addons:recommendations', () => ({ results: [] }));
  const dependencySearches = [];
  ipcMain.handle('addons:search', (_event, data) => {
    dependencySearches.push({ id: data.id, query: data.query });
    return { searchContract: 2, results: [{ title: 'Fixture Library', projectId: 'fixture-library-project', downloads: 3 }] };
  });
  ipcMain.handle('addons:installManual', (_event, id) => {
    manualDependencyFiles.push(id);
    return { addons: { ...addonFixture, bundledDependency } };
  });
  const packFixture = { token: 'pack-token', name: 'Test adventure pack', packVersion: '2.0', type: 'fabric', version: '1.20.1', loaderVersion: '0.16.10', fileCount: 12, totalBytes: 5000000, skipped: 4, optional: 2, requiresStartupCheck: true };
  const packQueries = [];
  ipcMain.handle('modpacks:search', (_event, data) => {
    packQueries.push(data.query);
    return { total: 1, results: [{ id: 'testpack', title: 'Test adventure pack', description: 'A server pack for testing.', author: 'BlockHost', downloads: 200 }] };
  });
  ipcMain.handle('modpacks:versions', () => [{ id: 'release', name: '2.0', channel: 'release', games: ['1.20.1'], loaders: ['fabric'] }]);
  const packAttempts = [];
  ipcMain.handle('modpacks:prepareOnline', (_event, id, projectId) => {
    assert.equal(projectId, 'testpack');
    packAttempts.push(id);
    if (packAttempts.length === 1) throw new Error('Modpack download failed (HTTP 503).');
    return packFixture;
  });
  ipcMain.handle('modpacks:chooseLocal', () => ({ ...packFixture, requiresStartupCheck: false }));
  const { openAppPreferences } = await import('../src/lib/app-preferences.mjs');
  const preferenceFile = path.join(app.getPath('userData'), 'app-preferences.json');
  const settings = openAppPreferences(preferenceFile);
  ipcMain.handle('app:getSettings', () => ({ ...settings.snapshot(), memoryLimitMb: 8192 }));
  ipcMain.handle('app:getUpdateStatus', () => ({ version: '2.0.0', status: 'idle' }));
  ipcMain.handle('app:checkUpdate', () => ({ version: '2.0.0', status: 'ready', availableVersion: '2.1.0' }));
  ipcMain.handle('app:restartForUpdate', () => ({
    version: '2.0.0', status: 'ready', availableVersion: '2.1.0', message: 'Stop all running servers and wait for them to save, then try again.',
  }));
  ipcMain.handle('app:setTheme', (_event, theme) => settings.setTheme(theme));
  ipcMain.handle('app:setOptions', (_event, options) => settings.setOptions(options, 8192));
  ipcMain.handle('app:setDesktopOptions', (_event, options) => settings.setDesktopOptions(options));
  ipcMain.handle('app:setQuickDefaults', (_event, options) => settings.setQuickDefaults(options));
  ipcMain.handle('app:rememberServer', (_event, id) => settings.rememberServer(id));
  const storageFixture = { servers: { path: 'Servers fixture', bytes: 1024 }, java: { path: 'Java fixture', bytes: 2048 },
    backups: [{ path: 'Backup fixture', bytes: 4096 }], cache: { path: 'Cache fixture', bytes: 8192 } };
  ipcMain.handle('app:getStorage', () => storageFixture);
  ipcMain.handle('app:clearDownloadCache', () => ({ ...storageFixture, cache: { ...storageFixture.cache, bytes: 0 } }));
  let testedPack, createdPack, createdStandard, retainedPack;
  ipcMain.handle('servers:create', (_event, data) => {
    if (data.modpackToken) {
      if (data.acceptPackEula) {
        if (testedPack) {
          retainedPack = data;
          const server = { id: 3, name: data.name, type: data.type, typeLabel: 'Fabric', version: data.version, color: data.color,
            modpack: { name: packFixture.name, version: packFixture.packVersion }, modpackSetup: repairState };
          servers.push(server);
          return { server, repairRequired: true };
        }
        testedPack = data;
        throw new Error('The publisher archive uses an unsupported format.\nTechnical archive detail.');
      }
      createdPack = data;
      return { server: { id: 1 } };
    }
    createdStandard = data;
    const server = { id: 2, name: data.name, type: data.type, typeLabel: 'Fabric', version: data.version, color: data.color, icon: data.icon };
    servers.push(server);
    _event.sender.send('dependencies:progress', { stage: 'complete', javaReady: true });
    return { server };
  });
  let copiedModList;
  ipcMain.handle('app:copyText', (_event, value) => { copiedModList = value; return { copied: true }; });
  for (const name of ['app-icon.png', 'app-icon-32.png']) {
    assert.equal(nativeImage.createFromPath(path.join(resources, name)).isEmpty(), false, `Missing packaged ${name}`);
  }
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(bundle, 'build/preload.js'), contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false, offscreen: true,
  } });
  const errors = [];
  let paintedFrame;
  window.webContents.on('paint', (_event, _rect, frame) => { paintedFrame = frame; });
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  await window.loadFile(path.join(bundle, 'renderer/main_window/index.html'));
  await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (read, label = read.toString()) => {
      for (let i = 0; i < 100; i++) {
        const value = read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Timed out waiting for server navigation: ' + label
        + ' (page ' + stage.querySelector('main')?.dataset.page + ', tracks '
        + JSON.stringify(tracks().slice(0, 2).map(track => [track.playState, track.currentTime, track.playbackRate, track.pending])) + ')');
    };
    const stage = document.getElementById('serverPages');
    const scene = document.getElementById('scene');
    const artwork = () => getComputedStyle(scene, '::before').backgroundImage;
    const originalArtwork = artwork();
    const card = (id = 1) => stage.querySelector('.library-card[data-server-id="' + id + '"]');
    const glass = () => stage.querySelector('.server-motion-glass');
    const tracks = () => stage.getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().duration === 520);
    const seek = (progress) => {
      for (const animation of tracks()) {
        animation.pause();
        animation.currentTime = 520 * progress;
      }
    };
    const center = rect => [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const origin = center((await waitFor(card, 'initial library')).getBoundingClientRect());
    card().click();
    await waitFor(glass, 'first opening');
    seek(0);
    const workspace = stage.querySelector('.server-workspace');
    const title = workspace.querySelector('.server-heading');
    const metrics = [...workspace.querySelectorAll('.metrics article')];
    const titleOrigin = center(title.getBoundingClientRect());
    if (Math.hypot(titleOrigin[0] - origin[0], titleOrigin[1] - origin[1]) > 2) throw new Error('The heading should start at the source card');
    const initialShape = getComputedStyle(glass()).clipPath;
    seek(.34);
    const midShape = getComputedStyle(glass()).clipPath;
    if (!midShape.includes(' C ') || midShape === initialShape
      || !getComputedStyle(glass().parentElement).filter.includes('blur(')
      || getComputedStyle(workspace).filter !== 'none'
      || getComputedStyle(metrics[0]).transform === getComputedStyle(metrics[1]).transform) {
      throw new Error('The glass and individual workspace tiles should move independently');
    }
    const matrix = new DOMMatrix(getComputedStyle(title).transform);
    if (Math.abs(matrix.a - matrix.d) > .001) throw new Error('The title stretches unevenly during opening');
    if (workspace.closest('.library-shell') !== scene || artwork() !== originalArtwork
      || !getComputedStyle(metrics[0]).backdropFilter.includes('blur')
      || document.activeElement.id !== 'pageTitle') throw new Error('Workspace scene, glass or focus is incorrect');

    const surface = glass();
    stage.querySelector('#backToLibrary').click();
    await waitFor(() => tracks()[0]?.playbackRate < 0, 'reversal to closing');
    if (glass() !== surface || !workspace.inert) throw new Error('Closing mid-opening should reverse the same motion');
    stage.querySelector('.server-motion-return').click();
    await waitFor(() => tracks()[0]?.playbackRate > 0, 'reversal to opening');
    if (glass() !== surface || workspace.inert) throw new Error('Clicking the source card mid-close should reopen it');
    await waitFor(() => !glass());
    await waitFor(() => stage.querySelector('#quickPropertiesForm'));

    stage.querySelector('#backToLibrary').click();
    await waitFor(glass, 'closing from the workspace');
    await waitFor(() => tracks()[0]?.playbackRate < 0, 'closing playback');
    await waitFor(card, 'library after closing');
    if (document.activeElement !== card() || artwork() !== originalArtwork) throw new Error('The library did not restore its scene and focused card');

    const rightOrigin = center(card(4).getBoundingClientRect());
    card(4).click();
    await waitFor(glass, 'second opening');
    seek(0);
    const rightTitle = center(stage.querySelector('.server-heading').getBoundingClientRect());
    if (Math.hypot(rightTitle[0] - rightOrigin[0], rightTitle[1] - rightOrigin[1]) > 2) throw new Error('The motion ignored the second card position');
    for (const animation of tracks()) animation.finish();
    await waitFor(() => !glass());

    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? { matches: true } : matchMedia(query);
    try {
      stage.querySelector('#backToLibrary').click();
      if (!card(4) || glass()) throw new Error('Reduced motion should skip the collapse animation');
      card().click();
      if (!stage.querySelector('.server-workspace') || glass()) throw new Error('Reduced motion should open the workspace immediately');
      stage.querySelector('#backToLibrary').click();
      if (document.activeElement !== card() || glass()) throw new Error('Reduced motion should restore the originating card');
    } finally {
      window.matchMedia = matchMedia;
    }
  })()`);
  const beginner = await window.webContents.executeJavaScript(`(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 25));
    for (let i = 0; i < 80 && !document.querySelector('.library-card'); i++) await wait();
    if (document.getElementById('app').dataset.theme !== 'minecraft') throw new Error('Minecraft should be the default theme');
    const activeCard = document.querySelector('.library-card[data-server-id="1"]');
    const offlineCard = document.querySelector('.library-card[data-server-id="4"]');
    if (activeCard.querySelector('.library-card-status').textContent !== 'Active'
      || offlineCard.querySelector('.library-card-status').textContent !== 'Offline'
      || activeCard.querySelector('.library-card-meta').textContent !== 'Fabric · Minecraft 1.21.11'
      || activeCard.textContent.includes('Open server')) throw new Error('Unexpected server card details');
    if (!getComputedStyle(activeCard).backdropFilter.includes('blur')
      || getComputedStyle(activeCard).backgroundImage === getComputedStyle(offlineCard).backgroundImage) {
      throw new Error('Expected glass cards tinted by each server color');
    }
    const library = document.querySelector('main[aria-label="Server library"]');
    const actions = library.querySelector('.library-actions');
    const startsInLibrary = !document.querySelector('#pageTitle, .sidebar, .library-art')
      && actions.children.length === 3
      && [...actions.children].map(action => (action.querySelector('summary') || action).textContent.trim()).join('|')
        === '＋ New server|Import server|Modpacks';
    const noTitlebarLogo = !document.querySelector('.window-titlebar img');
    const dialog = document.getElementById('appSettingsDialog');
    const noEarlyPrompt = !dialog.open;
    document.getElementById('openAppSettings').click();
    for (let i = 0; i < 80 && !dialog.open; i++) await wait();
    const updateCheck = dialog.querySelector('#checkAppUpdate');
    dialog.querySelector('#appUpdates').open = true;
    for (let i = 0; i < 80 && updateCheck.hidden; i++) await wait();
    updateCheck.click();
    const restartUpdate = dialog.querySelector('#restartAppUpdate');
    for (let i = 0; i < 80 && restartUpdate.hidden; i++) await wait();
    if (restartUpdate.hidden || !dialog.querySelector('#appUpdateStatus').textContent.includes('2.1.0')) {
      throw new Error('Update availability was not shown in Settings');
    }
    restartUpdate.click();
    for (let i = 0; i < 80 && restartUpdate.disabled; i++) await wait();
    if (restartUpdate.disabled || !dialog.querySelector('#appUpdateStatus').textContent.startsWith('Stop all running servers')) {
      throw new Error('Update restart did not surface an actionable busy state');
    }
    dialog.querySelector('#appUpdates').open = false;
    dialog.querySelector('[value="minecraft"]').click();
    for (let i = 0; i < 80 && document.getElementById('app').dataset.theme !== 'minecraft'; i++) await wait();
    await document.fonts.load('16px "Pixelify Sans"');
    const bounds = dialog.getBoundingClientRect();
    const shell = library.closest('.library-shell');
    const glassScene = () => getComputedStyle(shell, '::before');
    const glassPane = getComputedStyle(shell, '::after');
    const sceneBounds = shell.getBoundingClientRect();
    const actionLeft = actions.getBoundingClientRect().left;
    shell.dispatchEvent(new PointerEvent('pointermove', {
      pointerType: 'mouse', clientX: sceneBounds.right, clientY: sceneBounds.bottom,
    }));
    if (shell.style.getPropertyValue('--library-view-x') !== '-10px'
      || shell.style.getPropertyValue('--library-view-y') !== '-7px'
      || actions.getBoundingClientRect().left !== actionLeft) throw new Error('Only the scenery should follow the pointer');
    shell.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    if (shell.style.getPropertyValue('--library-view-x') || shell.style.getPropertyValue('--library-view-y')) {
      throw new Error('Scenery should recenter when the pointer leaves');
    }
    const minecraftTheme = getComputedStyle(document.getElementById('app')).fontFamily.includes('Pixelify Sans')
      && getComputedStyle(actions).backdropFilter.includes('blur')
      && glassScene().backgroundSize === 'cover'
      && glassScene().filter === 'none'
      && glassPane.backdropFilter.includes('blur(3px)')
      && glassPane.backgroundImage.startsWith('radial-gradient(')
      && glassPane.backgroundColor !== 'rgba(0, 0, 0, 0)'
      && glassPane.borderStyle === 'none'
      && glassPane.transform === 'none'
      && Math.abs(bounds.left + bounds.width / 2 - innerWidth / 2) < 3;
    const themes = Array.from(dialog.querySelectorAll('[name="appTheme"]'));
    const themeFonts = {
      minecraft: 'Pixelify Sans',
      monarch: 'Spectral',
      ocean: 'DM Sans',
      frost: 'Barlow',
      midnight: 'IBM Plex Mono',
    };
    const cardGradient = () => getComputedStyle(document.querySelector('.library-card')).backgroundImage;
    const isDiagonal = (image) => image.startsWith('linear-gradient(to right bottom,') || image.startsWith('linear-gradient(to bottom right,');
    if (themes.length !== 10) throw new Error('Expected ten themes');
    if (!themes.some(option => option.value === 'monarch') || themes.some(option => option.value === 'terminal')) {
      throw new Error('Expected Monarch to replace Terminal');
    }
    for (const theme of themes) {
      theme.click();
      for (let i = 0; i < 80 && document.getElementById('app').dataset.theme !== theme.value; i++) await wait();
      const url = glassScene().backgroundImage.split('url("').at(-1).split('")')[0];
      const background = new Image();
      background.src = url;
      await background.decode();
      if (!new URL(url).pathname.split('/').at(-1).startsWith(theme.value + '-')) throw new Error('Incorrect background for ' + theme.value);
      const font = themeFonts[theme.value];
      if (font) {
        for (const weight of [400, 700]) {
          const faces = await document.fonts.load(weight + ' 16px "' + font + '"');
          if (!faces.some(face => face.status === 'loaded')) throw new Error('Missing bundled font for ' + theme.value);
        }
        for (const id of ['emptyCreate', 'closeAppSettings']) {
          if (!getComputedStyle(document.getElementById(id)).fontFamily.includes(font)) {
            throw new Error('Theme font did not apply to ' + id + ' in ' + theme.value);
          }
        }
      }
      if (getComputedStyle(document.querySelector('.library-card-icon')).backgroundColor !== 'rgba(0, 0, 0, 0)') {
        throw new Error('Server icon background should be transparent in ' + theme.value);
      }
      if (!isDiagonal(cardGradient())) throw new Error('Missing server card gradient in ' + theme.value);
    }
    dialog.querySelector('[value="normal"]').click();
    for (let i = 0; i < 80 && document.getElementById('app').dataset.theme !== 'normal'; i++) await wait();
    if (getComputedStyle(document.querySelector('.library-card-icon')).backgroundColor !== 'rgba(0, 0, 0, 0)') {
      throw new Error('Server icon background should be transparent in Normal');
    }
    if (!isDiagonal(cardGradient())) throw new Error('Missing server card gradient in Normal');
    const originalGradient = cardGradient();
    const preferences = dialog.querySelector('#appOptionsForm');
    preferences.closest('details').open = true;
    preferences.elements.serverType.value = 'fabric';
    preferences.elements.minecraftVersion.value = '1.20.1';
    preferences.elements.maxMemoryMb.value = '3072';
    preferences.elements.consoleFilter.value = 'warnings';
    preferences.elements.consoleFontSize.value = '17';
    preferences.elements.consoleTimestamps.checked = false;
    preferences.elements.consoleAutoScroll.checked = false;
    preferences.elements.gradientStrength.value = '135';
    preferences.requestSubmit();
    for (let i = 0; i < 80 && dialog.querySelector('#appOptionsFeedback').textContent !== 'Preferences saved.'; i++) await wait();
    if (originalGradient === cardGradient()) throw new Error('Saving gradient strength did not change the server card');
    const desktop = dialog.querySelector('#desktopOptionsForm');
    desktop.closest('details').open = true;
    if (!desktop.elements.notifyTray.checked || getComputedStyle(desktop.elements.notifyTray).borderRadius !== '50%') {
      throw new Error('Expected an enabled circular tray notification checkbox');
    }
    desktop.elements.notifyReady.checked = true;
    desktop.elements.reopenServer.checked = true;
    desktop.requestSubmit();
    for (let i = 0; i < 80 && dialog.querySelector('#desktopOptionsFeedback').textContent !== 'Desktop preferences saved.'; i++) await wait();
    const quick = dialog.querySelector('#quickDefaultsForm');
    quick.closest('details').open = true;
    quick.elements['max-players'].value = '24';
    quick.elements.difficulty.value = 'hard';
    quick.requestSubmit();
    for (let i = 0; i < 80 && dialog.querySelector('#quickDefaultsFeedback').textContent !== 'Quick Controls saved.'; i++) await wait();
    dialog.querySelector('#appStorageSettings').open = true;
    for (let i = 0; i < 80 && !dialog.querySelector('#appStorageInfo').textContent.includes('Backup fixture'); i++) await wait();
    if (!dialog.querySelector('#appStorageInfo').textContent.includes('8 KB')) throw new Error('Storage did not show cached download size');
    dialog.querySelector('#clearAppCache').click();
    for (let i = 0; i < 80 && dialog.querySelector('#appStorageFeedback').textContent !== 'Downloaded caches cleared.'; i++) await wait();
    if (!dialog.querySelector('#appStorageInfo').textContent.includes('0 B')) throw new Error('Storage did not refresh after clearing');
    document.getElementById('closeAppSettings').click();
    await wait();
    document.getElementById('emptyCreate').click();
    const create = () => document.querySelector('#createForm [type=submit]');
    for (let i = 0; i < 80 && create().disabled; i++) await wait();
    const advancedHidden = !document.getElementById('createAdvanced').open;
    document.getElementById('createAdvanced').open = true;
    document.querySelector('#createForm .server-icon-trigger').click();
    document.querySelector('#createForm [name="icon"][value="monarch"]').click();
    create().click();
    for (let i = 0; i < 80 && !document.getElementById('startServer'); i++) await wait();
    await wait();
    const noPromptAfterJava = !dialog.open;
    const bannerRemoved = !document.querySelector('.overview-status');
    document.getElementById('startServer').click();
    const view = document.querySelector('.workspace-nav [aria-current]').dataset.serverView;
    for (let i = 0; i < 80 && !document.getElementById('acceptEula'); i++) await wait();
    document.getElementById('acceptEula').click();
    for (let i = 0; i < 80 && !document.querySelector('#runtimeStatus.status-running'); i++) await wait();
    return { startsInLibrary, noTitlebarLogo, noEarlyPrompt, minecraftTheme, noPromptAfterJava, advancedHidden, bannerRemoved, view, addressRemoved: !document.querySelector('#joinAddress, #copyJoinAddress') };
  })()`);
  assert.deepEqual(beginner, { startsInLibrary: true, noTitlebarLogo: true, noEarlyPrompt: true, minecraftTheme: true,
    noPromptAfterJava: true, advancedHidden: true, bannerRemoved: true,
    view: 'console', addressRemoved: true });
  assert.equal(createdStandard.name, 'My Minecraft Server');
  assert.equal(createdStandard.type, 'fabric');
  assert.equal(createdStandard.version, '1.20.1');
  assert.equal(openAppPreferences(preferenceFile).snapshot().options.maxMemoryMb, 3072);
  assert.equal(settings.snapshot().desktop.notifyReady, true);
  assert.equal(settings.snapshot().desktop.reopenServer, true);
  assert.equal(settings.snapshot().lastServerId, 2);
  assert.deepEqual(settings.snapshot().quickDefaults, { "max-players": 24, difficulty: "hard" });
  assert.equal(createdStandard.icon, 'monarch');
  assert.deepEqual(startRequests, [{ id: 2, accepted: false }, { id: 2, accepted: true }]);

  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    document.getElementById('backToLibrary').click();
    const card = () => document.querySelector('.library-card[data-server-id="1"]');
    for (let i = 0; i < 80 && !card(); i++) await wait(25);
    card().click();
    for (let i = 0; i < 80 && document.getElementById('ramValue')?.textContent !== '1.00 GB'; i++) await wait(25);
    const ram = document.querySelector('#ramValue').textContent;
    document.querySelector('.workspace-nav [data-server-view="console"]').click();
    for (let i = 0; i < 80 && !document.querySelector('.console-line time'); i++) await wait(25);
    if (document.querySelector('[data-console-filter="warnings"]').getAttribute('aria-pressed') !== 'true'
      || document.getElementById('consoleAutoScroll').checked
      || getComputedStyle(document.querySelector('.console-line time')).display !== 'none'
      || getComputedStyle(document.getElementById('consoleOutput')).fontSize !== '17px') {
      throw new Error('Saved console preferences did not apply');
    }
    document.getElementById('openAppSettings').click();
    const preferences = document.getElementById('appOptionsForm');
    preferences.closest('details').open = true;
    preferences.elements.serverType.value = 'vanilla';
    preferences.elements.minecraftVersion.value = '';
    preferences.elements.maxMemoryMb.value = '';
    preferences.elements.consoleFilter.value = 'all';
    preferences.elements.consoleFontSize.value = '12';
    preferences.elements.consoleTimestamps.checked = true;
    preferences.elements.consoleAutoScroll.checked = true;
    preferences.elements.gradientStrength.value = '100';
    preferences.requestSubmit();
    for (let i = 0; i < 80 && document.getElementById('appOptionsFeedback').textContent !== 'Preferences saved.'; i++) await wait(25);
    document.getElementById('closeAppSettings').click();
    for (let i = 0; i < 100 && document.querySelectorAll('.console-line').length !== 2000; i++) await wait(50);
    const count = document.querySelectorAll('.console-line').length;
    const first = document.querySelector('.console-line');
    await wait(2300);
    const preserved = first === document.querySelector('.console-line');
    document.querySelector('[data-console-filter="warnings"]').click();
    const warnings = document.querySelectorAll('.console-line').length;
    document.querySelector('[data-console-filter="errors"]').click();
    const diagnosticsInErrors = !document.getElementById('copyConsoleDiagnostics').hidden
      && document.getElementById('copyVisibleConsole').textContent === 'Copy errors';
    document.querySelector('[data-console-filter="all"]').click();
    const input = document.getElementById('commandInput');
    const type = value => { input.focus(); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    const options = () => Array.from(document.querySelectorAll('#commandSuggestions code'), element => element.textContent);
    type('/');
    for (let i = 0; i < 100 && options().length !== 1; i++) await wait(20);
    const slashOptions = options();
    type('/give Al');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const completedPlayer = input.value;
    type('/give Alex minecraft:blu');
    const itemOptions = options();
    type('');
    return { count, preserved, warnings, restored: document.querySelectorAll('.console-line').length,
      ram, diagnosticsInErrors, diagnosticsHiddenInAll: document.getElementById('copyConsoleDiagnostics').hidden,
      slashOptions, completedPlayer, itemOptions, commandButtonRemoved: !document.getElementById('openCommandAssistant') };
  })()`);
  assert.deepEqual(result, { count: 2000, preserved: true, warnings: 1, restored: 2000, ram: '1.00 GB', diagnosticsInErrors: true, diagnosticsHiddenInAll: true,
    slashOptions: ['give'], completedPlayer: '/give Alex ', itemOptions: ['minecraft:blue_dye', 'minecraft:blue_wool'], commandButtonRemoved: true });

  const contents = window.webContents;
  const points = await contents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    document.getElementById('backToLibrary').click();
    for (let i = 0; i < 80 && !document.getElementById('emptyCreate'); i++) await wait(25);
    document.getElementById('emptyCreate').click();
    for (let i = 0; i < 50 && !document.querySelector('#createForm option[value="1.21.11"]'); i++) await wait(20);
    const title = document.getElementById('createTitle').getBoundingClientRect();
    return { inside: { x: title.left + 4, y: title.top + 4 }, outside: { x: 8, y: Math.round(innerHeight / 2) } };
  })()`);
  contents.debugger.attach('1.3');
  const mouse = (type, point, buttons) => contents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  const drag = async (start, end) => {
    await mouse('mousePressed', start, 1);
    await mouse('mouseMoved', end, 1);
    await mouse('mouseReleased', end, 0);
  };
  const popupIsOpen = () => contents.executeJavaScript("Boolean(document.getElementById('createTitle'))");
  await drag(points.inside, points.outside);
  assert.equal(await popupIsOpen(), true, 'releasing outside must keep the popup open');
  await drag(points.outside, points.inside);
  assert.equal(await popupIsOpen(), true, 'releasing inside must keep the popup open');
  await mouse('mousePressed', points.outside, 1);
  await mouse('mouseReleased', points.outside, 0);
  assert.equal(await contents.executeJavaScript(`(async () => {
    for (let i = 0; i < 25 && document.getElementById('createTitle'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    return Boolean(document.getElementById('createTitle'));
  })()`), false, 'a complete backdrop click closes the popup');
  const settingsTitle = await contents.executeJavaScript(`(() => {
    document.getElementById('openAppSettings').click();
    const title = document.getElementById('appSettingsTitle').getBoundingClientRect();
    return { x: title.left + 4, y: title.top + 4 };
  })()`);
  const settingsOpen = () => contents.executeJavaScript("document.getElementById('appSettingsDialog').open");
  await mouse('mousePressed', settingsTitle, 1);
  await mouse('mouseReleased', settingsTitle, 0);
  assert.equal(await settingsOpen(), true, 'clicking inside app settings keeps it open');
  await drag(settingsTitle, points.outside);
  assert.equal(await settingsOpen(), true, 'dragging outside app settings keeps it open');
  await mouse('mousePressed', points.outside, 1);
  await mouse('mouseReleased', points.outside, 0);
  assert.equal(await settingsOpen(), false, 'clicking the app settings backdrop closes it');
  contents.debugger.detach();

  const worldChoices = await contents.executeJavaScript(`(async () => {
    document.getElementById('emptyCreate').click();
    const wait = () => new Promise(resolve => setTimeout(resolve, 20));
    for (let i = 0; i < 50 && !document.querySelector('#createForm option[value="1.21.11"]'); i++) await wait();
    document.querySelector('#createAdvanced summary').click();
    await wait();
    const seedField = () => document.querySelector('#createForm [name="seed"]');
    const chooseWorld = () => document.getElementById('chooseWorldImport');
    seedField().focus();
    seedField().value = '0';
    seedField().dispatchEvent(new Event('input', { bubbles: true }));
    const seedBlocksImport = chooseWorld().disabled && document.activeElement === seedField();
    seedField().value = '';
    seedField().dispatchEvent(new Event('input', { bubbles: true }));
    const clearingEnablesImport = !chooseWorld().disabled;
    chooseWorld().click();
    for (let i = 0; i < 50 && !seedField().disabled; i++) await wait();
    const importBlocksSeed = seedField().disabled;
    document.getElementById('removeWorldImport').click();
    return { seedBlocksImport, clearingEnablesImport, importBlocksSeed, removingEnablesSeed: !seedField().disabled };
  })()`);
  assert.deepEqual(worldChoices, { seedBlocksImport: true, clearingEnablesImport: true, importBlocksSeed: true, removingEnablesSeed: true });

  const paletteGeometry = await contents.executeJavaScript(`(async () => {
    document.querySelector('#createForm .accent-trigger').click();
    await new Promise(resolve => setTimeout(resolve, 180));
    const panel = document.getElementById('create-accent');
    const rect = panel.getBoundingClientRect();
    return {
      open: panel.matches(':popover-open'),
      inView: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      interactive: panel.contains(document.elementFromPoint(rect.left + 16, rect.top + 16)),
      presets: panel.querySelectorAll('.accent-swatch').length,
    };
  })()`);
  assert.deepEqual(paletteGeometry, { open: true, inView: true, interactive: true, presets: 12 });
  const shadePoints = await contents.executeJavaScript(`(() => {
    const panel = document.getElementById('create-accent');
    panel.querySelector('[data-hex="#57dca4"]').click();
    document.querySelector('#createForm .accent-trigger').click();
    const hue = panel.querySelector('.accent-hue');
    hue.value = '120';
    hue.dispatchEvent(new Event('input', { bubbles: true }));
    panel.getAnimations().forEach(animation => animation.finish());
    const rect = panel.querySelector('.accent-shades').getBoundingClientRect();
    return {
      start: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      end: { x: rect.left + rect.width * .9, y: rect.top + rect.height * .1 },
    };
  })()`);
  contents.debugger.attach('1.3');
  await drag(shadePoints.start, shadePoints.end);
  contents.debugger.detach();
  const accents = await contents.executeJavaScript(`(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 20));
    const color = (form) => document.querySelector(form + ' [name="color"]').value;
    const panel = document.getElementById('create-accent');
    const preset = color('#createForm');
    const preview = () => panel.style.getPropertyValue('--custom-preview');
    const dragged = preview();
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    panel.querySelector('.accent-shades').dispatchEvent(down);
    const adjusted = preview();
    panel.querySelector('.accent-apply').click();
    const custom = color('#createForm');
    document.getElementById('closeCreate').click();
    document.querySelector('.library-card[data-server-id="1"]').click();
    for (let i = 0; i < 80 && !document.querySelector('[data-server-view=settings]'); i++) await wait();
    document.querySelector('[data-server-view=settings]').click();
    for (let i = 0; i < 50 && !document.getElementById('server-accent'); i++) await wait();
    const workspaceGradient = () => getComputedStyle(document.querySelector('.server-workspace')).backgroundImage;
    const before = workspaceGradient();
    if (!before.startsWith('linear-gradient(to right bottom,') && !before.startsWith('linear-gradient(to bottom right,')) {
      throw new Error('Missing diagonal workspace gradient');
    }
    document.querySelector('#serverIdentityForm .accent-trigger').click();
    document.querySelector('#server-accent [data-hex="#fb7185"]').click();
    document.querySelector('#serverIdentityForm .server-icon-trigger').click();
    document.querySelector('#serverIdentityForm [name="icon"][value="amethyst"]').click();
    document.querySelector('#serverIdentityForm').requestSubmit();
    for (let i = 0; i < 50 && workspaceGradient() === before; i++) await wait();
    if (workspaceGradient() === before) throw new Error('Workspace gradient did not update after changing the server color');
    return { preset, dragged, adjusted, keyboardHandled: down.defaultPrevented, custom, saved: color('#serverIdentityForm') };
  })()`);
  assert.equal(accents.preset, '#57dca4');
  assert.match(accents.dragged, /^#1[0-9a-f]e[0-9a-f]1[0-9a-f]$/);
  assert.equal(accents.keyboardHandled, true);
  assert.notEqual(accents.adjusted, accents.dragged);
  assert.equal(accents.custom, accents.adjusted);
  assert.equal(accents.saved, '#fb7185');
  assert.equal(savedAccent, '#fb7185');
  assert.equal(savedIcon, 'amethyst');

  const javaCard = await contents.executeJavaScript("document.querySelector('[aria-label=\"Java Runtime\"]').textContent");
  assert.match(javaCard, /Automatic/);
  assert.equal(await contents.executeJavaScript(`Boolean(document.querySelector('main .server-settings-page') && document.querySelector('[data-server-view=settings][aria-current=page]') && document.getElementById('stopServer') && !document.querySelector('[role=dialog]'))`), true);
  assert.match(javaCard, /Automatic uses Java 21/);
  const javaChoice = await contents.executeJavaScript(`(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 20));
    const select = () => document.getElementById('serverJavaVersion');
    const initial = select().value;
    select().value = '25';
    select().dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 50 && (select().disabled || select().value !== '25'); i++) await wait();
    return { initial, chosen: select().value };
  })()`);
  assert.deepEqual(javaChoice, { initial: 'automatic', chosen: '25' });

  runtime.status = 'recovering';
  const recoveryUi = await contents.executeJavaScript(`(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 50));
    document.querySelector('[data-server-view=overview]').click();
    const status = document.getElementById('runtimeStatus');
    const stop = document.getElementById('stopServer');
    for (let i = 0; i < 80 && status.textContent !== 'Recovering'; i++) await wait();
    const canCancel = status.textContent === 'Recovering' && !stop.hidden && stop.textContent === 'Cancel restart';
    stop.click();
    for (let i = 0; i < 40 && status.textContent !== 'Offline'; i++) await wait();
    return { canCancel, canceled: status.textContent === 'Offline' };
  })()`);
  assert.deepEqual(recoveryUi, { canCancel: true, canceled: true });
  const originalSize = window.getSize();
  window.setSize(1280, 850);
  const modUi = await contents.executeJavaScript(`(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 20));
    document.querySelector('[data-server-view=addons]').click();
    for (let i = 0; i < 50 && !document.getElementById('copyClientMods'); i++) await wait();
    const filesFirst = document.querySelector('.installed-title [role=status]')?.textContent.includes('Reading file details');
    for (let i = 0; i < 50 && !document.querySelector('[data-project-id=fixtureProject]'); i++) await wait();
    const icon = document.querySelector('.installed-addon-grid .addon-icon img');
    for (let i = 0; i < 50 && !icon?.naturalWidth; i++) await wait();
    const enriched = Boolean(icon?.naturalWidth && document.querySelector('[data-project-id=fixtureProject]'));
    const modsOnly = !document.querySelector('.pack-selected, .client-mod-list');
    const grid = document.querySelector('.installed-addon-grid');
    const columns = () => getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const wideColumns = columns();
    const installed = grid.closest('.installed-addons');
    installed.style.maxWidth = '650px';
    const compactColumns = columns();
    installed.style.removeProperty('max-width');
    document.querySelector('[data-installed-addon-tab="pack"]').click();
    const packOnly = document.querySelector('.pack-selected')?.textContent.includes('Installed fixture pack · 2.3')
      && document.querySelectorAll('.installed-addon-grid .addon-card').length === 1;
    const search = value => {
      const input = document.getElementById('installedAddonSearch');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelectorAll('.installed-addon-grid .addon-card:not([hidden])').length;
    };
    const packSearch = search('server') === 0 && search('both-1') === 1;
    document.querySelector('[data-installed-addon-tab="files"]').click();
    const modsSearch = search('server') === 1;
    search('');
    document.getElementById('copyClientMods').click();
    return { filesFirst, enriched, modsOnly, wideColumns, compactColumns, packOnly, packSearch, modsSearch, serverLabel: Array.from(document.querySelectorAll('.addon-compatibility')).some(label => label.textContent === 'Server only') };
  })()`);
  assert.deepEqual(modUi, { filesFirst: true, enriched: true, modsOnly: true, wideColumns: 3, compactColumns: 2, packOnly: true, packSearch: true, modsSearch: true, serverLabel: true });
  window.setSize(...originalSize);
  assert.equal(await contents.executeJavaScript(`Boolean(document.querySelector('main .addons-page') && document.querySelector('[data-server-view=addons][aria-current=page]') && document.getElementById('startServer') && !document.querySelector('[role=dialog]'))`), true);
  assert.match(copiedModList, /Required on clients[\s\S]+both-1\.0\.jar/);
  assert.doesNotMatch(copiedModList, /server-1\.0|disabled\.jar/);
  const dropUi = await contents.executeJavaScript(`(async () => {
    document.querySelector('[data-server-view=overview]').click();
    const transfer = new DataTransfer();
    transfer.items.add(new File(['fixture'], 'Dropped world.zip'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
    for (let i = 0; i < 50 && !document.getElementById('worldImportStatus'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { world: document.getElementById('worldImportStatus')?.textContent, seedDisabled: document.querySelector('#createForm [name="seed"]')?.disabled };
  })()`);
  assert.deepEqual(dropUi, { world: 'Dropped world.zip (zip)', seedDisabled: true });

  const packUi = await contents.executeJavaScript(`(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 20));
    document.getElementById('closeCreate').click();
    document.querySelector('[data-server-view=addons]').click();
    for (let i = 0; i < 80 && !document.querySelector('[data-addon-tab="modpacks"]'); i++) await wait();
    const installedVisible = !document.querySelector('.installed-title').closest('section').hidden;
    const discoverHidden = document.querySelector('.addon-search-section').hidden;
    document.querySelector('[data-addon-tab="modpacks"]').click();
    for (let i = 0; i < 80 && !document.querySelector('[data-pack-project]'); i++) await wait();
    const search = document.getElementById('packSearchForm');
    const packCard = document.querySelector('.pack-card');
    const app = document.getElementById('app');
    const originalTheme = app.dataset.theme;
    app.dataset.theme = 'minecraft';
    try {
      for (const element of packCard.querySelectorAll('h3, small, p, button')) {
        const style = getComputedStyle(element);
        if (!style.fontFamily.includes('Pixelify Sans') || parseFloat(style.fontSize) < 16 || style.fontWeight !== '500') {
          throw new Error('Minecraft pack cards should use readable pixel type');
        }
      }
    } finally {
      app.dataset.theme = originalTheme;
    }
    if (document.querySelector('#packSource')) throw new Error('Unexpected pack provider selector');
    search.query.value = 'adventure';
    search.requestSubmit();
    for (let i = 0; i < 80 && !document.querySelector('[data-pack-project]:not(:disabled)'); i++) await wait();
    document.querySelector('[data-pack-project]').click();
    for (let i = 0; i < 80 && document.getElementById('useOnlinePack')?.disabled; i++) await wait();
    document.getElementById('useOnlinePack').click();
    for (let i = 0; i < 80 && !document.getElementById('retryPacks'); i++) await wait();
    const cleanError = document.querySelector('.form-error')?.textContent === 'Modpack download failed (HTTP 503).';
    document.getElementById('retryPacks').click();
    for (let i = 0; i < 80 && !document.querySelector('.pack-selected'); i++) await wait();
    const form = document.getElementById('createForm');
    const locked = form.serverType.disabled && form.version.disabled;
    const correct = form.serverType.value === 'fabric' && form.version.value === '1.20.1';
    form.serverName.value = 'My pack server';
    form.serverName.dispatchEvent(new Event('input', { bubbles: true }));
    const requiresConsent = Boolean(form.elements.acceptPackEula?.required && !form.checkValidity());
    form.elements.acceptPackEula.click();
    form.requestSubmit();
    for (let i = 0; i < 80 && !document.querySelector('.pack-setup-error'); i++) await wait();
    const showsStartupError = document.querySelector('.pack-setup-error')?.textContent === 'The publisher archive uses an unsupported format.'
      && document.querySelector('.pack-error-details:not([open]) pre')?.textContent === 'Technical archive detail.';
    document.getElementById('closeCreate').click();
    document.getElementById('backToLibrary').click();
    for (let i = 0; i < 80 && !document.getElementById('localLibraryPack'); i++) await wait();
    document.querySelector('#localLibraryPack').closest('details').querySelector('summary').click();
    document.getElementById('localLibraryPack').click();
    for (let i = 0; i < 80 && !document.getElementById('packOptional'); i++) await wait();
    const localForm = document.getElementById('createForm');
    const localPackOpened = localForm.serverName.value === 'Test adventure pack' && !localForm.elements.acceptPackEula;
    localForm.serverName.value = 'My pack server';
    document.getElementById('packOptional').click();
    document.getElementById('createForm').requestSubmit();
    for (let i = 0; i < 80 && document.getElementById('createForm'); i++) await wait();
    return { installedVisible, discoverHidden, cleanError, locked, correct, requiresConsent, showsStartupError, localPackOpened, closed: !document.getElementById('createForm') };
  })()`);
  assert.deepEqual(packUi, { installedVisible: true, discoverHidden: true, cleanError: true, locked: true, correct: true, requiresConsent: true, showsStartupError: true, localPackOpened: true, closed: true });
  assert.deepEqual(packAttempts, ['release', 'release']);
  assert.ok(packQueries.includes('adventure'));
  assert.equal(testedPack.acceptPackEula, true);
  assert.equal(createdPack.modpackToken, 'pack-token');
  assert.equal(createdPack.loaderVersion, '0.16.10');
  assert.equal(createdPack.name, 'My pack server');
  assert.equal(createdPack.includeOptional, true);

  const repairUi = await contents.executeJavaScript(`(async () => {
    const waitFor = async (check) => {
      for (let i = 0; i < 120; i++) {
        const result = check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Timed out waiting for ' + check.toString() + ' during modpack repair. '
        + JSON.stringify({
          status: document.getElementById('runtimeStatus')?.textContent,
          tab: document.querySelector('[data-addon-tab][aria-pressed=true]')?.dataset.addonTab,
          query: document.querySelector('#addonSearchForm [name=query]')?.value,
          search: document.querySelector('.addon-search-status')?.textContent,
          error: document.querySelector('.form-error')?.textContent,
        }));
    };
    const panel = () => document.getElementById('modpackStatusPanel');
    const label = () => document.getElementById('runtimeStatus')?.textContent;
    const start = () => document.getElementById('startServer');
    const stop = () => document.getElementById('stopServer');
    document.getElementById('backToLibrary').click();
    (await waitFor(() => document.getElementById('browseLibraryPacks'))).closest('details').querySelector('summary').click();
    document.getElementById('browseLibraryPacks').click();
    if (document.getElementById('createForm')) throw new Error('Browse opened the regular server form');
    (await waitFor(() => document.querySelector('[data-pack-project]:not(:disabled)'))).click();
    (await waitFor(() => document.querySelector('#useOnlinePack:not(:disabled)'))).click();
    const form = await waitFor(() => document.querySelector('#createForm:has([name=acceptPackEula])'));
    form.elements.acceptPackEula.click();
    form.requestSubmit();
    await waitFor(() => !document.getElementById('createForm') && label() === 'Needs repair');
    const opensRepair = document.querySelector('[data-server-view=addons][aria-current=page]') !== null
      && panel().textContent.includes('Adventure Mod needs fixture-library (2.0)')
      && panel().textContent.includes('Minecraft 1.20.1 and Fabric')
      && panel().querySelector('details:not([open]) pre')?.textContent.includes('Fabric loader stack trace')
      && !document.querySelector('#startupCrashDialog');
    start().click();
    const failedRetry = await waitFor(() => label() === 'Needs repair' && document.querySelector('[data-server-view=addons][aria-current=page]')
      && start()?.textContent === 'Retry startup');
    (await waitFor(() => panel().querySelector('[data-modpack-action="find-dependency"]:not(:disabled)'))).click();
    const searchedDependency = await waitFor(() => !document.querySelector('.addon-search-section')?.hidden
      && document.getElementById('addonSearchForm')?.query.value === 'fixture-library'
      && document.querySelector('.addon-search-section .addon-list')?.textContent.includes('Fixture Library'));
    (await waitFor(() => panel().querySelector('[data-modpack-action="add-file"]:not(:disabled)'))).click();
    await waitFor(() => document.getElementById('notificationHost')?.textContent.includes('Dependency installation complete.'));
    const bundledAction = () => panel().querySelector('[data-modpack-action="try-bundled-dependency"]:not(:disabled)');
    const bundledButton = await waitFor(bundledAction);
    const offersBundledRepair = bundledButton.textContent === 'Enable Bundled Library and retry';
    bundledButton.click();
    await waitFor(() => stop()?.textContent === 'Cancel startup check' && !stop().disabled);
    stop().click();
    const cancelled = await waitFor(() => label() === 'Needs repair' && start()?.textContent === 'Retry startup');
    (await waitFor(bundledAction)).click();
    const waitsForReady = label() !== 'Ready to join' && !panel().querySelector('[data-modpack-action="copy-address"]');
    await waitFor(() => label() === 'Ready to join');
    const joins = panel().textContent.includes('localhost:25571');
    panel().querySelector('[data-modpack-action="copy-address"]').click();
    document.getElementById('backToLibrary').click();
    (await waitFor(() => document.querySelector('[data-server-id="1"]'))).click();
    await waitFor(() => document.getElementById('pageTitle')?.textContent === 'Smoke fixture');
    return { opensRepair, failedRetry, searchedDependency, offersBundledRepair, cancelled, waitsForReady, joins };
  })()`);
  assert.deepEqual(repairUi, { opensRepair: true, failedRetry: true, searchedDependency: true, offersBundledRepair: true, cancelled: true, waitsForReady: true, joins: true });
  assert.equal(retainedPack.modpackToken, 'pack-token');
  assert.deepEqual(dependencySearches.filter(entry => entry.id === 3), [{ id: 3, query: 'fixture-library' }]);
  assert.deepEqual(manualDependencyFiles, [3]);
  assert.deepEqual(bundledDependencyRetries, [3, 3]);
  assert.equal(packCheckCancellations, 1);
  assert.deepEqual(packAttempts, ['release', 'release', 'release']);
  assert.equal(copiedModList, 'localhost:25571');
  window.setSize(1280, 850);
  await contents.executeJavaScript(`(async () => {
    document.querySelector('[data-server-view=addons]').click();
    for (let i = 0; i < 80 && !document.querySelector('[data-addon-tab="modpacks"]'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    document.querySelector('[data-addon-tab="modpacks"]').click();
    for (let i = 0; i < 100 && !document.querySelector('.pack-grid [data-pack-project]:not(:disabled)'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    document.querySelector('.content').scrollTop = 0;
  })()`);
  if (paintedFrame && !paintedFrame.isEmpty()) {
    fs.writeFileSync(path.resolve(resources, '../../modpack-ui-smoke.png'), paintedFrame.toPNG());
  }
  Object.assign(runtime, {
    status: 'startup-failed', pid: 123, startupFailed: true, startedAt: new Date().toISOString(),
    startupDiagnosis: {
      problem: 'A mod tried to load client-only code.', cause: 'Client class unavailable.', fix: 'Remove the client-only mod from the server.',
      mod: 'citresewn', evidence: ['Attempted to load client classes'],
    },
  });
  const diagnosisUi = await contents.executeJavaScript(`(async () => {
    for (let i = 0; i < 120 && !document.getElementById('startupCrashDialog')?.open; i++) await new Promise(resolve => setTimeout(resolve, 25));
    const popup = document.getElementById('startupCrashDialog');
    const popupTitle = popup?.querySelector('h2').textContent;
    popup?.close();
    const panel = document.getElementById('startupDiagnosis');
    return {
      popupTitle, console: document.querySelector('[data-server-view="console"]').getAttribute('aria-current'),
      diagnosis: panel?.textContent.includes('citresewn') && panel.textContent.includes('Attempted to load client classes'),
      canStop: !document.getElementById('stopServer').hidden && document.getElementById('startServer').hidden,
    };
  })()`);
  assert.deepEqual(diagnosisUi, { popupTitle: 'Startup Failed', console: 'page', diagnosis: true, canStop: true });
  assert.deepEqual(errors, []);
  console.log('Packaged renderer smoke passed:', JSON.stringify({ ...result, modpackRepair: repairUi }));
  clearTimeout(deadline);
  window.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
