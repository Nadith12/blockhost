# Minecraft server runtime

This page describes the implemented paths in the current source. [Development status](development-status.md) lists limits and verification.

## Creation and loader selection

Start with `getVersionOptions` and `createServer` in [src/main.js](../src/main.js). Version lists come from upstream metadata. Ordinary Vanilla creation lists Mojang releases, Fabric pairs stable game versions with a loader and installer (stable preferred), and Forge and NeoForge derive game/loader choices from Maven releases. Packs supply their pinned versions through the preview flow.

| Type | Setup | Launch target |
| --- | --- | --- |
| Vanilla, Paper, Purpur | Download a server JAR from the respective provider. Vanilla also saves Mojang's Java major when supplied. | JAR |
| Fabric | Use a Fabric Meta launcher for standard creation. For modpacks, run the checksum-verified Fabric installer and verify its installed library and Minecraft JARs. | JAR with `-Dfabric.noGui=true` |
| Forge, NeoForge | Run the provider installer with `--installServer`. | Platform argument file under `libraries/`, with a legacy Forge JAR fallback when found |
| Quilt | Run the Quilt installer with the chosen game and loader versions. | `quilt-server-launch.jar` |

Creation uses app-owned server folders and cached downloads. It sets initial properties, can import a world, and writes server metadata after setup. Imports resolve launch files through the archive or external importer and prepare Java for the destination machine. Changing Minecraft or loader version currently means creating or importing a different server.

## Java discovery and selection

- [java-runtime.mjs](../src/lib/java-runtime.mjs) provides the Minecraft and server-type baseline. For example, the default policy uses Java 16 for Minecraft 1.17, Java 17 for 1.18 through 1.20.4, Java 21 from 1.20.5 through 1.21.x, and Java 25 for the 26.x version family. Paper and Purpur use their own rules for older releases. For Vanilla, available Mojang metadata takes precedence. A compatible pack recommendation can raise the baseline.
- [java-requirements.mjs](../src/lib/java-requirements.mjs) can raise it from launcher bytecode and evaluate simple Fabric/Quilt mod constraints. Unknown versions or complex predicates can produce warnings, and conflicting pinned requirements can fail setup. Loader installers can resolve a separate Java major based on installer bytecode.
- [java-runtime-manager.mjs](../src/lib/java-runtime-manager.mjs) probes candidates for the exact requested major and confirmed 64-bit architecture. Automatic mode checks managed Java, then installed Java discovered via `JAVA_HOME`, `PATH` and common install roots. A saved compatible major uses the same resolver. The resolver also accepts an existing saved custom executable path.
- [managed-java.mjs](../src/lib/managed-java.mjs) downloads a runtime on Windows x64 when needed. It uses Temurin for most majors and Azul Zulu for Java 16, verifies the published SHA-256 and probes staged Java before activation. Requests for the same major can share an in-flight install. System Java settings stay untouched.

Server settings offer Automatic and compatible majors. Device-specific choices are separate from portable server metadata. See [Java runtimes](JAVA-RUNTIMES.md) for the manual checks.

## Start, stop and recovery

1. `startServer` checks server state, the configured host/port and EULA consent. It resolves Java, rechecks the port before spawning and returns structured prompts for port conflicts or required EULA acceptance.
2. `launchCommand` passes an absolute Java executable and separate arguments to `spawn`, using the server folder as the working directory. It supplies the server ID property, `-Xms` and `-Xmx`, then `-jar <jar> nogui` or `@<args-file> nogui`. Commands go to stdin.
3. Main buffers stdout/stderr by line and marks the server running when Minecraft prints its readiness line. Clicking Start opens the Console immediately. The startup monitor tracks recognized loading milestones and applies configurable idle and total time limits (five and thirty minutes by default). A live process can report **Startup Stalled** and still become ready. A fatal startup error reports **Startup Failed**, and an unexpected process exit reports **Crashed**.
4. Startup diagnoses use console evidence and recent server crash reports. The Console shows the suspected cause, a suggested fix, and relevant lines. A fatal startup issue opens the Errors filter with the existing diagnostics dialog. The monitor reads evidence and does not modify server files or stop stalled processes.
4. Stop sends `stop`, terminates after 15 seconds if needed, and waits for any shutdown backup. Unexpected exits after readiness or during recovery can trigger up to three delayed restart attempts. A requested stop cancels recovery, and recovery can stop early if startup is blocked.

Typing `/` in the Console shows a scrollable list of commands. BlockHost loads the saved Minecraft version's vanilla command and registry reports from [mcmeta](https://github.com/misode/mcmeta) through the main process. Argument suggestions use the cursor position, vanilla registry IDs and the server's connected players. A small built-in catalogue is available when the reports cannot be loaded. Mod, plugin and datapack commands still run as raw input. The stdin connection does not expose those live command trees or world-specific values.

## Modpacks and add-ons

- **Modrinth packs.** Browse requires a server-only or dedicated-server-only release, or a checksum-pinned publisher server ZIP for that release. Projects that also publish client-only releases must identify the server release or artifact separately. [modpack-manager.mjs](../src/lib/modpack-manager.mjs) pins Minecraft and the loader, validates paths and hashes, and applies server overrides after shared overrides and manifest files. Files explicitly included in the server plan stay available to the loader, including client-environment JARs needed during dependency resolution. Users can opt into optional server files.
- **Server ZIPs.** [drop-source.mjs](../src/lib/drop-source.mjs) and [external-importer.mjs](../src/lib/external-importer.mjs) distinguish prepared ZIPs from recognised starter packs. Prepared ZIPs can supply detected launch files. BlockHost reconstructs the launch setup for online publisher starter archives from the pinned versions and preserves the publisher’s mod files for the loader to evaluate. Version detection reads supported config, script assignments or archive markers as data.
- **Creation boundary.** Main's `preparePack` stores the inspected selection behind an opaque token. `createModpackServer` uses the saved versions and creates a separate server. Cancellation aborts staging or waits for the loader step to finish. Failures clean partial output while retaining the selection for retry. See [Modpack support](MODPACKS.md) for more on overrides and the renderer smoke test.
- **Per-server add-ons.** Browse Mods uses Modrinth to match the server's exact Minecraft version and loader, resolve required dependencies, and record optional dependencies without installing them automatically. Provider project IDs and dependency links are kept separate in the add-on lock. [addon-manager.mjs](../src/lib/addon-manager.mjs) stages and verifies downloads, and main's `applyAddonChange` checks restart readiness and attempts rollback if a change prevents startup. Automatic update checks currently cover Modrinth.

Installed add-ons appear as soon as the file list is ready. BlockHost reads names, versions, loaders, Minecraft ranges and declared PNG logos from JARs in the background, including disabled files. It uses the server's loader descriptor when several are present and caches file hashes and thumbnails for unchanged files during the app session.

BlockHost looks up detected files by SHA-512 on Modrinth. Catalogue lookups can add a project link, missing artwork and any available compatibility details. The add-on lock records installation and update ownership. File matching sends only hashes, and the local list remains usable while requests are pending or unavailable.

CurseForge client manifests, packwiz sources, FTB installer archives and unrecognised scripted setups require a supported export or a prepared server. Server ZIP support depends on detectable launch files or supported pinned metadata.

The online pack setup form collects EULA acceptance. [modpack-startup.mjs](../src/lib/modpack-startup.mjs) runs a dedicated-server check with the staged files, selected Java runtime, a private test world and a temporary loopback port. A failed check leaves the installed setup in the library under **Needs repair**. Users can review the diagnosis, edit mods and retry startup. The normal server shows **Ready to join** when Minecraft reports readiness and the configured port is listening. See [Modpack support](MODPACKS.md) for the full flow.

New modpack installs record the included add-on filenames in `blockhost-modpack.json`. The installed Modpack tab uses that inventory to show the pack's files that are still installed. For older installs without an inventory, it labels the current add-on list as unverified.
