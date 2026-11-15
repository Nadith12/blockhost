# Java runtimes in BlockHost Manager

BlockHost selects a Java major version for each server and checks the executable before using it. The selection starts with the Minecraft version and loader policy. It uses Mojang's version metadata when downloading Vanilla, server pack recommendations when available, the server launcher's class-file version, and simple Java constraints declared by Fabric or Quilt mods. Installer bytecode can require a separate runtime from the installed server.

Automatic mode checks managed runtimes and existing 64-bit Java installations for the selected major. If none is usable, the Windows x64 build downloads the required release into the app's runtime directory. Temurin provides most releases. Java 16 uses Azul Zulu. BlockHost checks the archive's published SHA-256, extracts it into a temporary directory, tests the executable, and then activates it. Multiple operations requesting the same major share a download. BlockHost uses full executable paths and leaves system Java settings alone.

Server metadata records the selected major, mode, runtime identifier, and reported version. The Java Runtime dropdown defaults to Automatic. A selected version is stored per server on this device and is installed on the next start if needed. Exported server archives can be imported on another computer and resolve Java there. Existing servers gain an automatic assignment when opened or started.

## Manual checks

1. Fully quit BlockHost and start the development app from the project folder.
2. Use **Download a server → From file** to select the Cisco's V8E server pack ZIP. Create the server and check that setup uses Java 17 for Minecraft 1.19.2 and Forge 43.5.1. If Java 17 is missing, the app should install it.
3. Open **Server settings → Java Runtime**. Check that it shows **Automatic uses Java 17**. Start the server and check its Java version in the console.
4. Create a Minecraft 1.21.x Paper server. Give it a different **server-port** in **Full properties**, then start it while Cisco's is running. The Paper console should report Java 21.
5. Open **Java Runtime** and select another version offered by the dropdown. Check that the selection stays visible, then choose **Automatic** again.
6. On a profile that lacks the required runtime, disconnect the network and attempt creation or startup. Check that the error names the Java version. Reconnect and retry.

## Compatibility limits

The importer handles Java for supported server archives, including prepared custom servers. CurseForge client exports, provider-only installers, and scripts with no recognizable server launch files still need a prepared server pack. Automatic runtime downloads currently target Windows x64. Other platforms can use a compatible system or custom runtime.

Bytecode inspection checks the launch class. It does not prove compatibility of every class, nested dependency, native library, or mixin. Complex Java predicates produce a warning. An unknown Minecraft version uses a fallback recommendation unless the launcher requires a later major. The app has no in-place Minecraft or loader update workflow. Recreating a server with a different version or importing an updated server recalculates its Java requirement.

## Files changed

| Area | Files |
| --- | --- |
| Runtime requirements, discovery, validation, and downloads | src/lib/java-runtime.mjs, src/lib/java-requirements.mjs, src/lib/java-runtime-manager.mjs, src/lib/managed-java.mjs |
| Creation, import, launch, and settings | src/main.js, src/preload.js, src/renderer.js |
| Server types, portable settings, archive routing, and mod metadata | src/lib/server-metadata.mjs, src/lib/server-store.mjs, src/lib/drop-source.mjs, src/lib/external-importer.mjs, src/lib/transfer-manager.mjs, src/lib/modpack-manager.mjs, src/lib/addon-manager.mjs |
| Automated checks | test/java-runtime-manager.test.mjs, test/modpack-manager.test.mjs, test/server-recovery.test.mjs, test/smoke-renderer.cjs |
| Manual verification | docs/JAVA-RUNTIMES.md |
