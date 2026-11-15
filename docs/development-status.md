# Development status

## Decisions and constraints

- Keep process and filesystem work behind the preload API. When changing IPC, check payloads, error handling and event subscriptions across main, preload and renderer. See [Architecture](architecture.md).
- Treat existing server folders and archives as compatibility contracts. Check metadata migration and relative launch paths on schema changes. Resolve Java locally on import. Preserve unknown Minecraft properties when editing known settings.
- Keep server mutations within the existing operation and recovery paths. For writes and imports, preserve staging, rollback and startup cleanup. Validate paths before writing or deleting data. Test with disposable folders and an isolated Electron profile.
- Keep pack installations pinned to the inspected selection. Verify downloads with the integrity data required by their flow and preserve archive size and path limits.

## Known limits and open validation

- Managed Java downloads target Windows x64. Other platforms need a compatible local runtime. Bytecode and mod metadata checks are partial compatibility checks. Unknown versions and complex constraints can still require a real launch.
- The app supports local Minecraft Java servers. Public relay hosting is design work described in [the hosting research](public-hosting-research-2026-11.md). Minecraft and loader versions have no in-place update workflow. See [Minecraft runtime](minecraft-runtime.md) for supported inputs.
- Node fixtures cover helpers and selected main/renderer flows. The Electron smoke uses mocked IPC and a temporary profile. Live provider downloads, installer execution and real Java process compatibility still need manual coverage. The repository has no automated live Minecraft integration command.

## Reusable verification

Run commands from the repository root using existing dependencies. Select the smallest check that exercises the changed behaviour.

| Scope | Command or procedure |
| --- | --- |
| Syntax of a changed entry point | `node --check src/main.js` (substitute the changed JavaScript path). The project has no dedicated lint or type-check script. |
| Java and recovery fixtures | `node --test test/java-runtime-manager.test.mjs test/server-recovery.test.mjs` |
| Modpack fixtures | `node --test test/modpack-manager.test.mjs test/modpack-flow.test.mjs` |
| Full Node suite | `npm test` runs `test/*.test.mjs`. `npm run check` adds syntax checks for the entry points and selected helpers before the suite. |
| Windows Electron package | `npm run package -- --platform=win32 --arch=x64` builds the app into `out/`. Use `npm run make:store` when the MSIX maker or manifest is in scope. |
| Packaged renderer smoke (Windows PowerShell) | `& .\node_modules\.bin\electron.cmd test/smoke-renderer.cjs` after the Windows x64 package build. The script defaults to that package's resources directory and accepts a resources path as its first argument. |
| Real Minecraft runtime | Use `npm start` with a disposable profile and follow the [Java runtime manual checks](JAVA-RUNTIMES.md#manual-checks). Use a prepared modded pack and a recent Paper server on distinct ports to exercise different Java versions, readiness and graceful stop. |

For changes to import or launch, verify both the success path and relevant failures, such as an unavailable port, an incompatible Java major or invalid archive contents. Report fixture and real-server results separately.
