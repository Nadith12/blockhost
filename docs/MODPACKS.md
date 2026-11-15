# Modpack support

## User flow

In the server library, open **Modpacks** and choose **Browse packs** or **From file**. The Add-ons page also has a **Modpacks** tab for browsing. Modrinth cards show the server release and its Minecraft and loader versions. Projects with client-only and server editions must identify their separate server release. Selecting a release locks Minecraft and the loader to that release. Accept the Minecraft EULA and select **Test and create server**. BlockHost checks the installation and adds it to the library. Select **Start server** and wait for **Ready to join** and the join address.

Supported inputs:
- Modrinth `.mrpack` and ZIP files with a root `modrinth.index.json`.
- Complete local server-pack ZIPs whose launch files and Minecraft version the external importer can detect.
- Dropped `.mrpack`/manifest ZIP files use the same preview flow.

Modrinth packs support Fabric, Forge, NeoForge, and Quilt. CurseForge manifest-only exports point to the matching server pack ZIP. Standalone installer scripts are not executed.

Modrinth Browse requires a release explicitly marked server-only or dedicated-server-only and a verifiable .mrpack. Better MC BMC2 v40 uses a checksum-pinned publisher server ZIP linked to its Modrinth release.

## Installation

`src/lib/modpack-manager.mjs` validates manifests, checks download hashes, applies archive limits, and stages server files. Shared overrides replace manifest files with the same path, and server overrides take precedence over both. Client overrides and files marked unsupported on the server are excluded. If the manifest leaves the server side unspecified, BlockHost checks the exact release metadata and native mod descriptor for client-only files. Required server entries, selected optional server entries, and server overrides are preserved. Publisher server ZIPs keep their bundled mod set. Fabric can use the presence of a client-environment JAR to satisfy a dependency while keeping its client code disabled on the server.

The main process stores the selected release behind an opaque token. Downloads and extraction happen in app-owned staging. Online packs run the launcher with the selected Java runtime on a temporary loopback port and a disposable test world. If the pack has a world, BlockHost makes a copy for the check. BlockHost waits for Minecraft's readiness message and a listening port, asks the test server to save and stop, then restores the original properties. If the test JVM lingers after confirming that all dimensions are saved, BlockHost ends that test process.

An installed pack that fails its startup check appears under **Needs repair**. Open Add-ons to check the reported mod, find compatible releases, or add the publisher’s file. If the exact dependency is already bundled and disabled, **Enable and retry** checks it in place and restores its disabled state if the check fails or is cancelled. Java and port issues link to their settings. **Technical details** shows the diagnostic evidence. **Retry startup** checks the saved files and starts the server when the check passes. The retry reuses the installed pack. **Cancel startup check** keeps the saved setup and original world. Some packs require players to install the matching client pack before joining.

Cancellation interrupts file downloads, extraction and the startup test. The loader installation has a ten-minute timeout and completes its current step before cancellation removes the partial folder. Startup uses the deadline in App settings. Pack files download in parallel with a two-minute timeout per request and bounded retries. Each file must match its pinned hash and fit the size limits. The Modrinth limit is 512 MB per file or archive and 4 GB for expanded content.

Complete local server ZIPs use the isolated external importer and preserve existing player allowlist settings. Browse installs recreate the launcher from the identified versions and skip bundled root launch scripts, binaries and Java arguments. Fabric, Forge and NeoForge installers are checked against the official Maven checksum. Fabric’s installed libraries and vanilla server JAR are checked against Fabric and Mojang checksums before startup. Browse packs start with Minecraft account authentication enabled and remote administration and query services disabled. The preview detects existing worlds, which disables conflicting seed/world choices.

## Validation

- `npm run check`
- `node --test test/modpack-manager.test.mjs test/modpack-flow.test.mjs test/modpack-startup.test.mjs`
- `npm run package -- --platform=win32 --arch=x64`
- `node_modules/.bin/electron test/smoke-renderer.cjs`

The renderer smoke uses fixture data and a hidden window to check release selection, local selection, locked versions and the consent step. The startup tests use a simulated server process that opens a real loopback port.

Specification: https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
Catalogue API: https://docs.modrinth.com/api/operations/searchprojects/
