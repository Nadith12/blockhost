# BlockHost Manager architecture

BlockHost is an Electron desktop app that manages local Minecraft Java server processes. It uses npm with `package-lock.json`, Electron Forge for development and distribution, and the Forge Vite plugin to build main, preload and renderer. The renderer uses plain JavaScript and CSS. See [package.json](../package.json) and [forge.config.js](../forge.config.js) for the current dependency and packaging configuration.

## Entry points and IPC

| Layer | Location and ownership |
| --- | --- |
| Main | [src/main.js](../src/main.js) owns the single-instance app, window and tray, dialogs, filesystem, provider calls, Java processes and lifecycle. It loads the Vite dev URL or built renderer HTML. Closing the window hides it to the tray. Explicit quit coordinates active work and running servers. |
| Preload | [src/preload.js](../src/preload.js) exposes `window.minecraftAPI` via `contextBridge`. Named methods invoke fixed channels. Push subscriptions strip the Electron event and return an unsubscribe function. Dropped `File` paths are resolved here with `webUtils.getPathForFile`. |
| Renderer | [index.html](../index.html) mounts [src/renderer.js](../src/renderer.js), which owns UI state, events, forms and DOM rendering. It polls runtime and resource snapshots and consumes push events for live updates. [src/index.css](../src/index.css) owns styling. |

Trace a request from the renderer's `minecraftAPI` call to preload and the corresponding `ipcMain.handle` near the end of main. Request namespaces cover `servers:`, `operations:`, `app:`, `worlds:`, `backups:`, `addons:`, `modpacks:` and `transfers:`. Main pushes console entries, operation state, dependency and transfer progress, and backup results through `webContents.send`. The preload file is the inventory of renderer-accessible channels.

The BrowserWindow uses `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. The HTML sets a CSP, main blocks navigation away from the current URL, and new-window requests are denied, with selected links opened externally. Keep privileged decisions in main, including server ID lookup, path containment, approved pack and world selections, URL checks and archive validation.

## Where to look

Modules below live in `src/lib/`.

| Area | Entry points and helpers |
| --- | --- |
| Server state | Main's `createServer`, `startServer`, `stopServer` and `runtimeSnapshot`. `server-store.mjs` loads servers and writes metadata. `server-metadata.mjs` migrates it. `server-properties.mjs` parses, validates and updates properties. |
| Runtime and diagnostics | Java and loader flow is mapped in [Minecraft runtime](minecraft-runtime.md). `server-port.mjs` checks endpoints, `process-usage.mjs` aggregates process trees, and `console-log.mjs` parses output and player events. The renderer uses `console-view.mjs` for row caching and `command-catalog.mjs` for command assistance. |
| Packs and add-ons | `modpack-manager.mjs` handles pack catalogue and content. `modpack-startup.mjs` verifies online packs before publication. `addon-manager.mjs` handles per-server mods/plugins, dependencies and transactions. `addon-sides.mjs` handles client/server environment metadata. |
| App preferences | `app-preferences.mjs` validates and persists the app theme and preferences. `app-themes.mjs` shares theme names and title bar palettes between main and renderer. Minecraft is the default app theme. Saved Terminal themes and server icons resolve to Monarch. |
| Imports, exports and backups | `drop-source.mjs` classifies inputs. `transfer-manager.mjs` handles portable `.blockhost` archives and `external-importer.mjs` handles prepared folders and ZIPs. `world-manager.mjs` handles world import/export, and `world-backup.mjs` owns backup settings and results. |
| Shared safeguards | `safe-filesystem.mjs` provides containment checks and atomic/backup writes. `operation-manager.mjs` tracks mutations and coordinates per-server work. ZIP readers and writers use `yauzl` and `yazl`. |

## Data locations

| Location | Contents |
| --- | --- |
| Electron `userData/servers/` | One folder per server. `server-info.json` holds schema v3 metadata, including the server's color and icon, and portable launch details. Older records use the cube icon by default. Minecraft owns files such as `server.properties`, `eula.txt` and worlds. `addons-lock.json` tracks add-ons and `.blockhost-backup.json` stores local backup settings. |
| Electron `userData/` | `app-preferences.json` stores appearance, new-server and Quick Control defaults, console and desktop preferences, window bounds, and the last selected server. Default RAM and supported Quick Control overrides apply on server creation. Modpacks supply their own Minecraft version and loader. `server-cache/` holds cached server and installer downloads, `runtime/` holds managed Java, `java-choices/` holds device-specific Java choices by server ID, and `modpack-staging/` holds temporary pack inputs and content. Storage settings can clear cached downloads while server operations are idle. |
| Electron `documents/BlockHost Exports/` | Default export directory. `.blockhost` is a versioned archive (current format v2) with a separate import path from third-party ZIPs. |
| Main process memory | Active operations, Java child processes, runtime snapshots, and approved selections. Server folders and JSON files form the persistent store. |

Resolve profile paths through Electron rather than hardcoding OS-specific paths. For migration, staging and validation constraints, see [Development status](development-status.md).
