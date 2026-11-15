# BlockHost Manager

BlockHost manages local Minecraft Java servers in Electron. Use npm and the existing JavaScript modules. Keep local user data and existing working-tree changes intact.

## Read what the task needs

- [Architecture](docs/architecture.md) covers entry points, IPC, storage and module ownership.
- [Minecraft runtime](docs/minecraft-runtime.md) covers creation, loaders, Java, launch, packs and add-ons.
- [Development status](docs/development-status.md) covers constraints, known gaps and verification commands.

Use these references as a map. Verify the specific claims and interfaces your change depends on against the current source. Update relevant documentation when a durable contract changes.

## Process boundaries

- Keep filesystem access, downloads, validation and child processes in `src/main.js` and its Node helpers. Keep DOM and UI state in `src/renderer.js`.
- Preserve the sandboxed, context-isolated renderer with Node integration disabled. Extend the narrow `window.minecraftAPI` bridge in `src/preload.js` when needed. Keep raw IPC and Electron event objects out of the renderer.
- Follow existing main-process checks for IPC inputs, paths, downloads and archives. Reuse operation locks, staging, atomic writes and rollback where applicable.

## Task workflow

1. **Understand.** Identify expected behaviour, affected subsystem and acceptance criteria. Open only the relevant documentation.
2. **Locate.** Search filenames and symbols before reading. Inspect relevant sections, callers and dependencies as needed. Exclude `node_modules`, `.vite`, `out`, generated files, caches and large logs. Keep output bounded to the evidence you need.
3. **Plan.** For a straightforward fix, proceed once the cause is known. For a complex change, outline the affected contracts and verification in a short plan.
4. **Implement.** Make the smallest correct edit in the existing style. Reuse services and utilities, confirm paths and APIs in source, and preserve unrelated behaviour. Check callers and older saved data before changing an interface or format. Avoid unrelated refactors, unnecessary dependencies and whole-file rewrites.
5. **Verify.** Run the smallest relevant check after editing. Expand to broader tests, packaging or a manual runtime check when the affected behaviour warrants it. Diagnose a failure before making another edit.
6. **Report.** Use **Changed**, **Verified**, and **Unverified or remaining issues**. Name the files, important decisions, test results and relevant risks. Keep code and log excerpts short.

## Error diagnosis

1. **Identify the failure.** Describe the observable problem, name the affected feature and determine whether the issue is reproducible.
2. **Collect evidence.** Inspect the exact error and relevant stack frames. Start with the earliest actionable error and read only the relevant logs, files, dependencies and configuration.
3. **Determine the cause.** Trace the failure through the responsible components and distinguish symptoms from underlying causes. Check dependency versions and runtime compatibility where relevant. Label unverified hypotheses and collect evidence before editing.
4. **Assess the impact.** Identify affected modules and functionality. Check whether other Minecraft versions, loaders or configurations are affected, and consider main, preload and renderer boundaries where relevant.
5. **Propose a targeted fix.** Follow the task workflow and reuse existing utilities. Preserve validation and error reporting.
6. **Verify the fix.** Run focused regression checks and reproduce the original failure when feasible. Confirm the expected outcome and distinguish automated results from manual verification.
7. **Reassess unsuccessful attempts.** After two unsuccessful fixes without new evidence, stop speculative editing. Reassess the diagnosis, gather additional evidence before trying again and report any blocker.

For nontrivial errors, include a concise diagnosis in the task report. Cover **Error**, **Evidence**, **Root Cause** (confirmed or labelled as a hypothesis), **Affected Components**, **Proposed Fix**, **Regression Risks**, **Verification** and **Status** (fixed, partially fixed or unresolved). Keep the report proportional for simple errors.

## Debugging context

- Reuse prior findings. Repeat a read, search or command only when inputs changed or you need a distinct result. Keep investigation and progress updates focused on the current task.
- When context fills up, hand off the objective, relevant files, completed changes, tests and results, current blocker, and next action. Keep raw logs and conversation history out of persistent docs.
- Optimise total time and tokens per correct result. Keep verification proportionate to the change and distinguish observed results from assumptions.
