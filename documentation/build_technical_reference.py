from pathlib import Path
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

OUTPUT = Path(r"C:\Users\nadit\my-app\documentation\BlockHost_Manager_Technical_Reference.docx")


def remove_document_body(document):
    body = document._element.body
    for child in list(body):
        if child.tag != qn("w:sectPr"):
            body.remove(child)


def set_cell_fill(cell, color):
    properties = cell._tc.get_or_add_tcPr()
    shading = properties.find(qn("w:shd"))
    if shading is None:
        shading = OxmlElement("w:shd")
        properties.append(shading)
    shading.set(qn("w:fill"), color)


def set_cell_margins(cell, top=90, start=100, bottom=90, end=100):
    properties = cell._tc.get_or_add_tcPr()
    margins = properties.first_child_found_in("w:tcMar")
    if margins is None:
        margins = OxmlElement("w:tcMar")
        properties.append(margins)
    for name, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn(f"w:{name}"))
        if node is None:
            node = OxmlElement(f"w:{name}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def keep_with_next(paragraph):
    paragraph.paragraph_format.keep_with_next = True


doc = Document(OUTPUT)
remove_document_body(doc)

section = doc.sections[0]
section.top_margin = Inches(0.68)
section.bottom_margin = Inches(0.65)
section.left_margin = Inches(0.72)
section.right_margin = Inches(0.72)
section.header_distance = Inches(0.27)
section.footer_distance = Inches(0.3)

styles = doc.styles
normal = styles["Normal"]
normal.font.name = "Aptos"
normal.font.size = Pt(9.0)
normal.font.color.rgb = RGBColor(36, 50, 68)
normal.paragraph_format.space_after = Pt(5.5)
normal.paragraph_format.line_spacing = 1.06

for name, size, color in (
    ("Title", 34, "10223A"),
    ("Heading 1", 20, "10223A"),
    ("Heading 2", 13.5, "177997"),
    ("Heading 3", 10.5, "10223A"),
):
    style = styles[name]
    style.font.name = "Aptos Display"
    style.font.size = Pt(size)
    style.font.bold = True
    style.font.color.rgb = RGBColor.from_string(color)
    style.paragraph_format.space_before = Pt(10 if name != "Title" else 0)
    style.paragraph_format.space_after = Pt(5)
    style.paragraph_format.keep_with_next = True

styles["Heading 1"].paragraph_format.page_break_before = False
styles["List Bullet"].font.name = "Aptos"
styles["List Bullet"].font.size = Pt(8.9)
styles["List Bullet"].paragraph_format.space_after = Pt(2.5)
styles["List Number"].font.name = "Aptos"
styles["List Number"].font.size = Pt(8.9)
styles["List Number"].paragraph_format.space_after = Pt(2.5)

if "Code" in styles:
    code_style = styles["Code"]
else:
    code_style = styles.add_style("Code", 1)
code_style.font.name = "Cascadia Mono"
code_style.font.size = Pt(8)
code_style.font.color.rgb = RGBColor(27, 67, 90)
code_style.paragraph_format.left_indent = Inches(0.18)
code_style.paragraph_format.space_after = Pt(1)

header = section.header
header.is_linked_to_previous = False
for child in list(header._element):
    header._element.remove(child)
hp = header.add_paragraph()
hp.text = "BLOCKHOST MANAGER    TECHNICAL REFERENCE"
hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
for run in hp.runs:
    run.font.name = "Aptos"
    run.font.size = Pt(7.5)
    run.font.bold = True
    run.font.color.rgb = RGBColor.from_string("6A7E92")

footer = section.footer
for child in list(footer._element):
    footer._element.remove(child)
fp = footer.add_paragraph()
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = fp.add_run("BlockHost Manager 1.0.0   •   2 November 2026   •   Page ")
run.font.size = Pt(7.5)
run.font.color.rgb = RGBColor.from_string("708399")
field = OxmlElement("w:fldSimple")
field.set(qn("w:instr"), "PAGE")
fp._p.append(field)


def paragraph(text="", bold_prefix=None, style=None):
    p = doc.add_paragraph(style=style)
    if bold_prefix and text.startswith(bold_prefix):
        first = p.add_run(bold_prefix)
        first.bold = True
        p.add_run(text[len(bold_prefix):])
    else:
        p.add_run(text)
    return p


def heading(text, level=1):
    p = doc.add_heading(text, level=level)
    if level == 1 and text not in {
        "Contents",
        "10 Export and import",
        "12 Reliability and recovery",
        "16 Operational runbook",
    }:
        p.paragraph_format.page_break_before = True
    return p


def bullet(text, level=0):
    p = doc.add_paragraph(text, style="List Bullet")
    if level:
        p.paragraph_format.left_indent = Inches(0.25 + 0.22 * level)
    return p


def numbered(text, number):
    p = doc.add_paragraph(style="Normal")
    p.paragraph_format.left_indent = Inches(0.25)
    p.paragraph_format.first_line_indent = Inches(-0.25)
    p.paragraph_format.space_after = Pt(2.5)
    p.add_run(f"{number}.\t{text}")
    return p


def add_table(headers, rows, widths=None):
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    properties = table._tbl.tblPr
    preferred_width = properties.first_child_found_in("w:tblW")
    if preferred_width is None:
        preferred_width = OxmlElement("w:tblW")
        properties.append(preferred_width)
    preferred_width.set(qn("w:type"), "dxa")
    preferred_width.set(qn("w:w"), str(int(sum(widths or [7.0]) * 1440)))
    layout = properties.first_child_found_in("w:tblLayout")
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        properties.append(layout)
    layout.set(qn("w:type"), "fixed")
    indent = properties.first_child_found_in("w:tblInd")
    if indent is None:
        indent = OxmlElement("w:tblInd")
        properties.append(indent)
    indent.set(qn("w:type"), "dxa")
    indent.set(qn("w:w"), "0")
    if widths:
        for index, width in enumerate(widths):
            table.columns[index].width = Inches(width)
    try:
        table.style = "Light Shading Accent 1"
    except KeyError:
        table.style = "Table Grid"
    for index, value in enumerate(headers):
        cell = table.rows[0].cells[index]
        if widths:
            cell.width = Inches(widths[index])
        cell.text = str(value)
        set_cell_fill(cell, "12314A")
        set_cell_margins(cell)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        for run in cell.paragraphs[0].runs:
            run.font.bold = True
            run.font.color.rgb = RGBColor(255, 255, 255)
            run.font.size = Pt(8.3)
    for row_index, values in enumerate(rows):
        cells = table.add_row().cells
        for index, value in enumerate(values):
            cells[index].text = str(value)
            set_cell_margins(cells[index])
            cells[index].vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP
            if row_index % 2:
                set_cell_fill(cells[index], "EEF4F7")
            for p in cells[index].paragraphs:
                p.paragraph_format.space_after = Pt(1.5)
                for run in p.runs:
                    run.font.size = Pt(7.9)
                    run.font.color.rgb = RGBColor.from_string("243244")
        if widths:
            for index, width in enumerate(widths):
                cells[index].width = Inches(width)
    table.rows[0]._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
    return table


def code(lines):
    box = doc.add_table(rows=1, cols=1)
    box.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = box.cell(0, 0)
    set_cell_fill(cell, "F2F6F8")
    set_cell_margins(cell, 110, 130, 110, 130)
    p = cell.paragraphs[0]
    p.style = code_style
    p.paragraph_format.space_after = Pt(0)
    p.add_run("\n".join(lines))
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


def callout(title, text, color="DFF6FD"):
    table = doc.add_table(rows=1, cols=1)
    cell = table.cell(0, 0)
    set_cell_fill(cell, color)
    set_cell_margins(cell, 120, 140, 120, 140)
    p = cell.paragraphs[0]
    r = p.add_run(title)
    r.bold = True
    r.font.color.rgb = RGBColor.from_string("10223A")
    p.add_run(f"  {text}")
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


# Cover
p = doc.add_paragraph()
p.paragraph_format.space_before = Pt(70)
p.alignment = WD_ALIGN_PARAGRAPH.LEFT
r = p.add_run("BLOCKHOST")
r.font.name = "Aptos Display"
r.font.size = Pt(14)
r.font.bold = True
r.font.color.rgb = RGBColor.from_string("39C9FF")

title = doc.add_paragraph(style="Title")
title.add_run("BlockHost Manager\nTechnical Reference")
subtitle = doc.add_paragraph()
subtitle.add_run("Architecture  •  Features  •  Reliability  •  Operations").bold = True
subtitle.runs[0].font.size = Pt(13)
subtitle.runs[0].font.color.rgb = RGBColor.from_string("4C677D")

doc.add_paragraph("Version 1.0.0", style="Subtitle")
doc.add_paragraph("Implementation reviewed 2 November 2026", style="Subtitle")

doc.add_paragraph().paragraph_format.space_before = Pt(95)
callout(
    "Purpose",
    "This document describes the current Electron application as implemented in the working tree. It covers every user feature, the privileged process boundary, server and add-on data formats, transfer safety, recovery behavior, testing evidence, packaging, and the remaining operational limits.",
)
paragraph("Audience  Maintainers, testers, release engineers, support staff, and contributors who need a single source of technical truth.")
paragraph("Scope  Local Minecraft Java Edition server management on Windows, with limited cross-platform runtime support where the operating system provides Java and process tools.")

doc.add_page_break()

heading("Contents", 1)
for item in (
    "1 Executive summary",
    "2 Product scope and feature catalog",
    "3 User workflows",
    "4 System architecture",
    "5 Electron security boundary",
    "6 Server provisioning",
    "7 Runtime management and monitoring",
    "8 Server properties",
    "9 Add-on management",
    "10 Export and import",
    "11 Persistence and data formats",
    "12 Reliability and recovery",
    "13 Network services",
    "14 Build packaging and distribution",
    "15 Testing and verification",
    "16 Operational runbook",
    "17 Maintenance guidance and known limits",
    "Appendix A IPC contract",
    "Appendix B Repository map",
    "Appendix C Compatibility matrix",
):
    bullet(item)

heading("Document conventions", 2)
add_table(
    ["Term", "Meaning"],
    [
        ["Managed server", "A server stored below Electron userData/servers with a valid portable server-info.json file."],
        ["Transaction", "A staged file operation that can restore the prior files and metadata if validation or restart fails."],
        ["Runtime", "The in-memory Java child-process record for the server controlled in the current app session."],
        ["Guaranteed import", "A validated .blockhost archive created by BlockHost Manager."],
        ["Best-effort import", "An external server folder or ZIP whose launch configuration is detected without modifying the source."],
    ],
    [1.35, 5.65],
)

heading("1 Executive summary", 1)
paragraph("BlockHost Manager is an Electron 42 desktop application for downloading, running, observing, configuring, extending, exporting, and importing local Minecraft Java Edition servers. It supports Vanilla, Paper, Fabric, Forge, and NeoForge. The common operating path requires only a selected server and one primary action: start or stop, save properties, install an add-on, export, or import.")
paragraph("The application uses a privileged Electron main process, a sandboxed renderer, and a narrow context bridge. The main process owns network requests, downloads, child processes, filesystem changes, archive validation, and recovery. The renderer owns presentation and short-lived UI state. Server data remains local except for provider requests used to retrieve Minecraft binaries or Modrinth add-on metadata and files.")
callout("Current implementation result", "The core server workflow, server identity editing, properties editor, memory controls, add-on lifecycle, world transfer, .blockhost transfer contract, external importer, atomic metadata migration, and startup recovery are implemented. The current automated suite contains 31 passing tests, the production dependency audit reports zero vulnerabilities, and Electron Forge packaging succeeds for win32 x64.")

heading("Primary capabilities", 2)
add_table(
    ["Capability", "What the user can do", "Safety behavior"],
    [
        ["Server download", "Choose a server type and exact provider version, then create a local server.", "HTTPS host allowlist, timeouts, hash or size verification, cached download, portable metadata."],
        ["Runtime control", "Start, stop, switch, and send console commands.", "One managed server at a time, EULA confirmation, graceful stop, readiness wait."],
        ["Resource view", "See Java process CPU, RAM, PID, status, and recent console output.", "Read-only sampling; monitoring failure does not stop the server."],
        ["Server identity", "Rename a saved server and change its accent color from Server settings.", "Portable metadata is validated and replaced atomically without moving the managed server folder."],
        ["Properties", "Change common values below the console or open the full guided, preset, custom-key, and raw editor from Server settings.", "Validation, atomic backup, optional restart, automatic rollback after failed startup."],
        ["Add-ons", "Browse server-focused recommendations with artwork; search, install, drop, update, disable, remove, and roll back mods or plugins.", "Exact compatibility filters, dependency resolution, hashes, staging, restart monitoring, crash journal."],
        ["Export", "Choose a name and destination for a complete verified .blockhost archive from Server settings.", "Running server is stopped and restarted; manifest sizes and SHA-256 hashes are verified."],
        ["Import", "Restore .blockhost archives or detect external server folders and ZIPs.", "Traversal, links, size, ratio, ambiguity, disk-space, EULA, staging, and atomic commit checks."],
        ["World transfer", "Export only a generated world, or attach a world folder or ZIP while downloading a new server.", "Running servers stop before export; imports use approved selection tokens, staging, containment, link, size, and compression checks."],
    ],
    [1.25, 2.5, 3.25],
)

heading("Deliberate boundaries", 2)
for text in (
    "BlockHost manages local Java Edition servers. It does not provide remote web administration, port forwarding, firewall configuration, or a public hosting service.",
    "The application permits one controlled server process at a time. It does not schedule multiple concurrent servers.",
    "CPU temperature, DDNS, tray-only operation, plugin bundles, player-list polling, server renaming, and sidebar reordering from the earlier application are intentionally absent.",
    "There is no automatic application updater, code-signing configuration, cloud sync, crash-report service, telemetry collector, or account system.",
    "External folder and ZIP import is best effort. Ambiguous launch candidates are rejected rather than guessed.",
):
    bullet(text)

heading("2 Product scope and feature catalog", 1)
heading("Server type matrix", 2)
add_table(
    ["Type", "Provisioning source", "Launch model", "Managed add-ons"],
    [
        ["Vanilla", "Mojang version manifest and server download metadata", "Local server.jar", "None"],
        ["Paper", "PaperMC Fill API", "Local server.jar", "Paper plugins"],
        ["Fabric", "Fabric Meta loader, installer, and server JAR endpoints", "Local server.jar", "Fabric mods"],
        ["Forge", "Forge Maven metadata and installer", "Generated win_args.txt or unix_args.txt", "Forge mods"],
        ["NeoForge", "NeoForge Maven metadata and installer", "Generated win_args.txt or unix_args.txt", "NeoForge mods"],
    ],
    [1.0, 2.4, 1.6, 2.0],
)

heading("Interface layout", 2)
paragraph("The renderer uses a two-column application shell beneath an integrated dark Windows title bar. The sidebar contains Download server, guaranteed import, best-effort import, saved servers, and the active operation label. The selected server header keeps Add-ons, Server settings, and Start or Stop visually distinct. CPU, RAM, PID, console output, and command entry follow. A compact Server essentials panel below the console provides render distance, simulation distance when supported, game mode, difficulty, and maximum-player controls.")
bullet("Server settings opens a full dialog containing rename and accent-color controls, Properties, Export, Export As, World export, Java minimum and maximum RAM controls, and Delete. Delete still requires a separate destructive confirmation dialog.")
bullet("All dialogs declare dialog semantics and an accessible label. Status and result messages use visible nonblocking notices.")
bullet("Pending property, add-on, and transfer actions disable conflicting controls and always unlock in a finally path.")
bullet("Dropped .jar files are routed to the open Add-ons dialog. Dropped .blockhost, ZIP, or directory items are routed to import.")

heading("Feature behavior by state", 2)
add_table(
    ["State", "Available behavior", "Prevented behavior"],
    [
        ["No server selected", "Download or import a server.", "Runtime, properties, add-ons, export, delete, and console actions."],
        ["Offline server", "Start, edit properties, manage add-ons, export, delete, inspect console history.", "Console command entry."],
        ["Starting server", "Observe logs and stop.", "A second start or conflicting modification."],
        ["Running server", "Stop, send commands, view usage, save properties with restart or later, manage add-ons with automatic restart, export with automatic restart.", "Concurrent modification."],
        ["Operation active", "Observe a feature, description, stage, and progress when measurable.", "A second modifying operation for the same server and application exit until cleanup completes."],
    ],
    [1.25, 3.45, 2.3],
)

heading("3 User workflows", 1)
heading("Download and first start", 2)
for number, text in enumerate((
    "Select Download server, choose Vanilla, Paper, Fabric, Forge, or NeoForge, then choose a version supplied by that provider.",
    "Enter a local display name. BlockHost creates a unique server directory and downloads or installs the launch files.",
    "Optionally choose an existing Minecraft world folder or ZIP. The selection is represented by a one-time main-process token and imported into the new server before it becomes visible.",
    "Select the new server and choose Start server.",
    "If the server has no accepted eula.txt, BlockHost shows the Minecraft EULA link. Accepting writes the local EULA file and starts the server.",
    "Status changes from Starting to Running when the console emits the Minecraft Done marker. Startup fails after four minutes if readiness never arrives.",
), start=1):
    numbered(text, number)

heading("Edit properties", 2)
for number, text in enumerate((
    "Use Server essentials below the console for common values, or open Server settings and choose Full properties. The editor loads server.properties or safe defaults when the file does not exist.",
    "Optionally choose a preset and review the changed guided fields, or open the raw expert editor.",
    "When offline, choose Save properties. When running, choose Save and restart or Save for next restart.",
    "BlockHost validates, writes through a backup transaction, and restarts when requested. If the server fails to reach ready, the previous file is restored and the prior configuration is restarted.",
), start=1):
    numbered(text, number)

heading("Manage add-ons", 2)
for number, text in enumerate((
    "Open Add-ons. Vanilla shows an explanation; loader servers show installed items plus a horizontally browsable recommendation shelf with project artwork.",
    "Browse recommendations filtered to server-only environments, or search Modrinth. Search results are restricted to the exact Minecraft version, loader, project type, and server-compatible environment.",
    "Choose Install. Required dependencies are resolved recursively and installed in the same transaction.",
    "Use Install from file or drop one JAR for a manual add-on. Loader metadata and duplicate hashes are checked before commit.",
    "Use Check updates, Update, or Update all. Stable is the default release channel; beta and alpha are explicit preferences.",
    "Use Disable, Remove, or Roll back. Dependency-aware actions include dependent add-ons when required to avoid a broken server.",
), start=1):
    numbered(text, number)

heading("Transfer a server", 2)
paragraph("Export and Export As are available from Server settings. Both open the operating-system save dialog so the user chooses the archive name and destination. Export stops a running server, creates and verifies a self-contained archive, then restarts the server. Import server is the guaranteed path for .blockhost archives. Import existing folder / ZIP is a separate compatibility path that detects an unambiguous launch configuration before adding the server.")
paragraph("Export world creates a conventional ZIP containing the configured Overworld and any matching Paper-style Nether or End folders. A running server is stopped before the snapshot and restarted afterward. Creation-time world import accepts a world directory or ZIP, rejects traversal, links, unsafe compression, excessive size, and ambiguous multi-world sources, then normalizes the imported destination to level-name=world.")

heading("4 System architecture", 1)
heading("Component model", 2)
add_table(
    ["Component", "Responsibilities", "Trust"],
    [
        ["Renderer", "Framework-free UI, modal state, polling, user events, progress and result presentation.", "Sandboxed and unprivileged."],
        ["Preload", "Expose named Promise-based operations and push-event subscriptions through contextBridge.", "Narrow Electron boundary."],
        ["Main process", "Application lifecycle, IPC registration, provider calls, Java processes, dialogs, usage sampling.", "Fully privileged."],
        ["Library modules", "Server store, metadata, properties, add-ons, world transfer, full transfers, external import, operation locks, safe filesystem.", "Privileged pure or filesystem services."],
        ["Minecraft Java", "Run the selected server and accept console commands over standard input.", "Third-party child process in one server directory."],
        ["PowerShell or ps", "Sample process CPU and working set.", "Read-only OS process tooling."],
    ],
    [1.25, 4.0, 1.75],
)

heading("Main process control flow", 2)
for number, text in enumerate((
    "A renderer event calls a method on window.minecraftAPI.",
    "The preload invokes one named IPC channel and passes a small serializable payload.",
    "The main process normalizes IDs, paths, names, types, URLs, and operation-specific fields.",
    "A per-server operation lock prevents overlap. The relevant service module stages, validates, and commits its change.",
    "The main process resolves with a snapshot or throws a user-readable error. Push events carry operation or transfer progress.",
    "The renderer updates state, renders the result, and re-enables controls in a finally path.",
), start=1):
    numbered(text, number)

heading("Library boundaries", 2)
add_table(
    ["Module", "Primary contract"],
    [
        ["safe-filesystem.mjs", "Containment checks, atomic replacement, file backup, restore, and commit."],
        ["operation-manager.mjs", "One active modification per numeric server ID, snapshots, progress fields, subscribers, and idle waiting."],
        ["server-metadata.mjs", "Schema 3 normalization and legacy metadata migration."],
        ["server-store.mjs", "Portable metadata persistence, server discovery, legacy cached-JAR migration, and runtime path reconstruction."],
        ["server-properties.mjs", "Java properties parsing, version schema, presets, guided and raw validation, save and rollback."],
        ["addon-manager.mjs", "Modrinth and manual lifecycle, dependency graph, lock schema 2, history, transactions, and recovery journals."],
        ["transfer-manager.mjs", "Self-contained .blockhost export, manifest inspection, verified extraction, name collision handling, and recovery cleanup."],
        ["external-importer.mjs", "Folder and ZIP preflight, safe copy or extraction, launch detection, EULA reset, and atomic import."],
        ["world-manager.mjs", "World discovery, world-only ZIP export, safe folder or ZIP import, dimension handling, and level-name normalization."],
    ],
    [2.05, 4.95],
)

heading("5 Electron security boundary", 1)
heading("Window configuration", 2)
code([
    "contextIsolation: true",
    "nodeIntegration: false",
    "sandbox: true",
    "preload: generated preload.js",
])
paragraph("The renderer cannot call Node.js, Electron IPC, the filesystem, or child-process APIs directly. The preload exposes only the minecraftAPI methods. The Content Security Policy permits local scripts and images, data images, and inline styles used by the current templates; it blocks remote renderer connections.")

heading("Navigation and external links", 2)
bullet("All new windows are denied. Only the Minecraft EULA and Adoptium Java links are handed to the operating system browser.")
bullet("Navigation away from the current application URL is prevented.")
bullet("Server and add-on downloads require HTTPS. Server binaries must come from the explicit Mojang, PaperMC, Fabric, Forge, or NeoForge allowlist. Modrinth files must come from cdn.modrinth.com.")
bullet("Network requests have a 30-second timeout. Downloads stream to partial files and validate size plus a supplied digest before replacement.")

heading("Filesystem security", 2)
bullet("All destructive server paths are resolved below the configured servers root before removal.")
bullet("Archive paths reject absolute forms, drive letters, NUL characters, backslashes in the .blockhost format, empty segments, dot segments, and parent traversal.")
bullet("ZIP links, device files, unsupported methods, encryption, excessive entry counts, uncompressed size, and compression ratios are rejected.")
bullet("Manual add-ons must be readable ZIP/JAR archives below 512 MB. Metadata entries are limited to 512 KB and archives to 100,000 entries.")

heading("Current security limits", 2)
bullet("IPC payload validation is explicit but hand-written. A shared schema library and sender-frame authorization would reduce drift as the API grows.")
bullet("The Forge configuration does not enable Electron fuses, code signing, or an authenticated application update channel.")
bullet("External server content is treated as untrusted data during import, but Minecraft and add-on JARs execute with the desktop user’s permissions when the server starts.")

heading("6 Server provisioning", 1)
heading("Provider discovery", 2)
add_table(
    ["Provider", "Catalog selection"],
    [
        ["Mojang", "Release entries from version_manifest_v2.json; the selected detail URL supplies server download metadata."],
        ["PaperMC", "Paper project versions and stable builds from the Fill v3 API."],
        ["Fabric", "Stable game versions plus current stable loader and installer values."],
        ["Forge", "Maven version elements containing a Minecraft and loader pair, newest first."],
        ["NeoForge", "Maven releases with beta values removed, newest first; Minecraft version is derived from the NeoForge line."],
    ],
    [1.25, 5.75],
)

heading("Jar-backed creation", 2)
paragraph("Vanilla, Paper, and Fabric downloads are cached below userData/server-cache. A verified copy is placed in the new server directory as server.jar, so an existing server no longer depends on an external cache path. Metadata records only jarFile, never an absolute jarPath.")

heading("Installer-backed creation", 2)
paragraph("Forge and NeoForge download a versioned installer and run java -jar installer --installServer in the new server directory. Creation succeeds only when the generated platform argument file exists. Metadata stores a relative launchArgsPath and launchType javaArgsFile.")

heading("Creation failure behavior", 2)
bullet("The server directory is created once and removed if provider validation, download, Java detection, installer execution, or metadata persistence fails.")
bullet("The renderer shows an indeterminate operation state while downloading or installing and unlocks after success or failure.")
bullet("A server is discoverable only when a valid server-info.json exists. Hidden staging directories are ignored.")

heading("7 Runtime management and monitoring", 1)
heading("Launch commands", 2)
code([
    "JAR server",
    "java -Dblockhost.serverId=<id> -Xms<minimum-memory>M -Xmx<maximum-memory>M -jar <server-folder>/<jarFile> nogui",
    "",
    "Forge or NeoForge",
    "java -Dblockhost.serverId=<id> -Xms<minimum-memory>M -Xmx<maximum-memory>M @<relative-args-file> nogui",
])
paragraph("The Server settings dialog exposes a dual-handle RAM control in 256 MB steps. Minimum defaults to 512 MB. Maximum defaults to half of physical memory rounded down to 512 MB increments and capped at 4 GB; the selectable safety ceiling is 80 percent of physical memory rounded down to 256 MB. The process working directory is the server folder. Standard input, output, and error are piped.")

heading("Lifecycle state", 2)
add_table(
    ["Status", "Transition"],
    [
        ["Offline", "No controlled child process. Start checks EULA, Java, launch files, and other active servers."],
        ["Starting", "Java spawned; console collected; waiting up to four minutes for the Minecraft Done message."],
        ["Running", "Done marker observed. Commands are accepted and usage is sampled."],
        ["Stopping", "The app writes stop and waits. After 15 seconds it requests process termination."],
    ],
    [1.2, 5.8],
)

heading("Console behavior", 2)
bullet("Recent stdout and stderr lines are retained in memory and rendered with HTML escaping.")
bullet("Commands are trimmed, followed by a newline, and written only when the selected runtime is running.")
bullet("No console history is persisted to BlockHost metadata. Minecraft may write its own logs inside the server folder.")

heading("CPU and RAM sampling", 2)
paragraph("On Windows, a hidden noninteractive PowerShell process queries Win32_Process and Win32_PerfFormattedData_PerfProc_Process for each controlled PID. CPU is normalized by logical processor count and capped at 100 percent per server process. RAM is the working set. On macOS and Linux, ps supplies PID, percent CPU, and RSS. A sampling failure returns zero values and does not affect the Java process.")

heading("Quit behavior", 2)
paragraph("Application quit waits for active transfers and per-server operations to finish. It then stops every controlled Java process before allowing Electron to exit. This protects staged files and reduces world corruption risk. The app does not adopt a Java process that survived a crash; runtime control is session-local.")

heading("8 Server properties", 1)
heading("Guided schema", 2)
add_table(
    ["Category", "Representative fields"],
    [
        ["General", "motd, game mode, difficulty, maximum players, hardcore, PvP, online mode, allowlist"],
        ["Gameplay", "force game mode, flight, command blocks, Nether, animals, monsters, NPCs, idle timeout"],
        ["World", "level name, seed, type, structures, spawn protection, view distance, simulation distance"],
        ["Network", "server port, bind address, query, RCON, RCON password and ports"],
        ["Advanced", "maximum tick time, synchronous chunk writes, unknown custom key/value settings"],
    ],
    [1.25, 5.75],
)
paragraph("Each known property defines a label, category, type, default, range or enum values, and optional Minecraft version floor. For example, simulation-distance is hidden before Minecraft 1.18. The bind address remains blank by default.")

heading("Parser and serialization", 2)
bullet("The parser handles comments, blank lines, empty values, escaped separators, Unicode escapes, continuations, duplicate keys, and Windows or Unix line endings.")
bullet("The last duplicate value is the effective value. Save emits one managed copy of an updated known key while preserving unrelated comments and unknown settings where possible.")
bullet("Guided values are normalized in the main process. Raw mode rejects files above 1 MB, NUL characters, and invalid values for known fields.")

heading("Presets", 2)
add_table(
    ["Preset", "Intent"],
    [
        ["Private friends server", "Verified accounts, allowlist, ten players, balanced distances."],
        ["Small survival server", "Normal survival for a modest group."],
        ["Creative building server", "Creative, peaceful, flight, command blocks, forced game mode."],
        ["Local testing server", "Five players, offline mode, short distances, no spawn protection."],
        ["Performance focused server", "Reduced view and simulation distances with lower player capacity."],
    ],
    [2.0, 5.0],
)
paragraph("A preset changes only the fields it declares. Advanced and unrelated values remain unchanged. The renderer reports how many values differ and keeps the form open for review before save.")

heading("Transactional save and restart", 2)
paragraph("saveServerProperties writes a sibling backup, flushes a temporary file, and atomically replaces server.properties. When restart is requested, the main process stops the server, saves, starts it, and waits for readiness. Startup failure triggers stop, file restore, and a second start using the previous properties. A successful operation deletes the backup. A missing properties file is created from safe defaults without requiring a preliminary server start.")

heading("9 Add-on management", 1)
heading("Profiles and locations", 2)
add_table(
    ["Server type", "Loader filter", "Directory", "Project type"],
    [
        ["Paper", "paper", "plugins", "plugin"],
        ["Fabric", "fabric", "mods", "mod"],
        ["Forge", "forge", "mods", "mod"],
        ["NeoForge", "neoforge", "mods", "mod"],
        ["Vanilla", "Unsupported", "None", "None"],
    ],
    [1.4, 1.4, 1.4, 2.8],
)

heading("Online search and install", 2)
paragraph("Search calls Modrinth v2 with the exact Minecraft version, exact loader, server-compatible environment facets, and the matching project type. The selected project resolves to the newest compatible version allowed by the saved release channel. Stable permits releases only; beta permits release and beta; alpha permits all three channels.")
paragraph("Required dependencies are resolved recursively. Incompatible installed projects fail before files change. Each JAR uses the provider SHA-512 digest when supplied, otherwise SHA-1, and must come from cdn.modrinth.com. The complete set downloads into a staging directory, then replaces affected projects in one transaction.")

heading("Manual JAR validation", 2)
bullet("A manual file must have a .jar name, a ZIP signature, readable central directory, nonzero content, and size at or below 512 MB.")
bullet("BlockHost reads fabric.mod.json, META-INF/mods.toml, META-INF/neoforge.mods.toml, paper-plugin.yml, or plugin.yml when present.")
bullet("Client-only Fabric mods and obvious loader mismatches are rejected. An exact installed SHA-512 or destination filename is rejected as a duplicate.")
bullet("Unknown loader or simple Minecraft-version mismatch produces a visible warning while retaining manual install capability.")

heading("Lock file and dependency graph", 2)
code([
    "addons-lock.json  schemaVersion 2",
    "preferences.releaseChannel",
    "entries[].projectId / versionId / versionNumber / title",
    "entries[].fileName / sha512 / sourceUrl / source",
    "entries[].loader / minecraftVersion / enabled / installedAt",
    "entries[].dependencies / optionalDependencies / history / warnings",
])
paragraph("Unrecognized JARs still appear as detected manual files. Enabling or disabling renames between file.jar and file.jar.disabled. Before disable or removal, BlockHost computes transitive dependents. The interface offers one explicit combined action when dependents must change together.")

heading("Updates and rollback", 2)
paragraph("Check updates compares saved Modrinth version IDs with the newest exact compatible version. Update all applies each compatible project in a composite transaction and rolls the children back in reverse order if any update fails. Before replacement, the current JAR is copied below .blockhost-addon-history and the lock file records up to ten local history entries. Rollback verifies the archived hash before restoring it.")

heading("Restart protection and offline behavior", 2)
paragraph("A running server is stopped before an add-on mutation. BlockHost restarts and waits for readiness. If startup fails, every changed file and the prior lock file are restored, then the previous configuration is started again. Installed files remain manageable without internet. Search uses up to 100 cached query results and labels them as cached when the live request fails; otherwise it reports that an internet connection is required.")

heading("10 Export and import", 1)
heading("BlockHost archive contract", 2)
paragraph("A .blockhost file is a ZIP archive with manifest.json and all managed server files below server/. The manifest identifies format blockhost-server, format version 1, creation metadata, portable server metadata, and every file’s path, size, and SHA-256 digest. Absolute machine paths are never stored.")
code([
    "manifest.json",
    "server/server-info.json",
    "server/server.jar or relative loader launch files",
    "server/world and dimensions",
    "server/server.properties",
    "server/mods or plugins and addons-lock.json",
    "server/config, datapacks, allowlist, bans, operators, icon, libraries",
])

heading("Export exclusions", 2)
bullet("session.lock and .blockhost backup or partial files")
bullet("BlockHost staging, backup, import, transfer, and add-on transaction directories")
bullet("Minecraft crash-reports and logs")
bullet("The reversible local metadata migration backup")
paragraph("Export calculates all digests before writing, checks free disk space, streams the ZIP, reopens it, validates the manifest, hashes every payload entry, and only then renames the partial file to the requested destination. Failure deletes the partial file. A previously running server is restarted even when archive creation fails.")

heading("Guaranteed BlockHost import", 2)
for number, text in enumerate((
    "Read and validate the manifest and central directory before extraction.",
    "Enforce entry count, size, compression ratio, file type, encryption, path, and free-space limits.",
    "Extract into a unique hidden staging directory while recalculating each SHA-256 digest.",
    "Verify required JAR or loader argument files, create a new ID, and resolve name collisions automatically.",
    "Write portable schema 3 metadata, remove eula.txt, and atomically rename the completed server into the servers root.",
    "Delete staging data on success or failure. No partial server appears in discovery.",
), start=1):
    numbered(text, number)

heading("External folder and ZIP import", 2)
paragraph("The compatibility importer never modifies the source. It preflights size and links, copies or extracts into staging, unwraps a single enclosing directory, and inspects top-level JARs plus Forge or NeoForge argument files. Paper and Fabric names receive specific detection. Plugins also identify a single generic JAR as Paper. Multiple possible launch JARs or loader configurations fail with the exact candidates listed.")
paragraph("The importer infers a Minecraft version from recognizable path or filename tokens. Some third-party layouts may import with version unknown; they can run, but exact-version Modrinth search cannot be reliable until metadata is corrected by a future repair flow.")

heading("11 Persistence and data formats", 1)
heading("User data layout", 2)
code([
    "Electron userData/",
    "  servers/<safe-name>-<id>/",
    "    server-info.json",
    "    server.jar or loader libraries and args",
    "    server.properties, world data, config, mods or plugins",
    "    addons-lock.json",
    "    .blockhost-addon-history/",
    "  server-cache/<provider>/<version>/",
    "  addon-search-cache.json",
    "Documents/BlockHost Exports/*.blockhost",
])

heading("Server metadata schema 3", 2)
add_table(
    ["Field", "Meaning"],
    [
        ["id", "Positive safe integer used by IPC, operations, runtime markers, and folder collision checks."],
        ["name", "Local display name, trimmed to 80 characters."],
        ["type and version", "Normalized server family and Minecraft version."],
        ["loaderVersion", "Fabric, Forge, or NeoForge loader or installer line when known."],
        ["color", "Six-digit UI accent color."],
        ["minMemoryMb and maxMemoryMb", "Portable Java heap limits in megabytes; validated in 256 MB steps before persistence."],
        ["launchType", "jar or javaArgsFile."],
        ["jarFile", "Basename inside the server folder for JAR launch. No absolute path."],
        ["launchArgsPath", "Contained relative loader argument-file path."],
        ["createdAt and lastModifiedAt", "ISO timestamps."],
        ["addonsManifestVersion", "Add-on manifest capability marker."],
    ],
    [2.0, 5.0],
)

heading("Migration behavior", 2)
paragraph("Loading older metadata reconstructs portable fields, removes folderPath, jarPath, and typeLabel, and copies a legacy external cached JAR into the server folder when necessary. Before the first schema 3 rewrite, BlockHost saves server-info.pre-blockhost-v3.json. Discovery ignores malformed or incomplete folders instead of breaking the sidebar.")

heading("Data retention", 2)
add_table(
    ["Data", "Retention and deletion"],
    [
        ["Server folder and world", "Persistent until Delete server removes the contained server directory."],
        ["Server cache", "Shared and persistent; not removed with a server."],
        ["Console state", "Memory only for the current app session."],
        ["Add-on history", "Persistent inside the server; current implementation retains up to ten recorded versions per entry, while files are included until manually removed or the server is deleted."],
        ["Search cache", "Up to 100 saved query entries in userData."],
        ["Exports", "Persistent in Documents or the chosen location until the user removes them."],
        ["Operation staging", "Removed at commit, rollback, or next startup recovery."],
    ],
    [2.0, 5.0],
)

heading("12 Reliability and recovery", 1)
heading("Atomic file pattern", 2)
for number, text in enumerate((
    "Resolve and validate the destination below the expected root.",
    "Write a unique sibling temporary file with exclusive creation and flush it to disk.",
    "Move an existing destination aside when a backup is required.",
    "Rename the completed temporary file into place.",
    "Restore the displaced file if replacement fails.",
    "Delete the backup only after the caller confirms the complete operation.",
), start=1):
    numbered(text, number)

heading("Operation locks", 2)
paragraph("operation-manager maintains one active operation per numeric server ID. Each snapshot includes a UUID, feature, label, stage, optional percentage, description, cancellable flag, server ID, and start time. Conflicts return a friendly ServerBusyError. Subscribers update the sidebar immediately. Application quit waits until the map is empty.")

heading("Startup recovery", 2)
add_table(
    ["Artifact", "Startup action"],
    [
        [".blockhost-import-staging", "Remove incomplete guaranteed imports."],
        [".blockhost-external-import-staging", "Remove incomplete compatibility imports."],
        ["Partial export names", "Remove incomplete .blockhost outputs from the default exports directory."],
        ["Add-on transaction journal", "Replay rollback using recorded new files, backups, renames, and the previous lock file."],
        ["Orphan add-on staging", "Remove staging after journal recovery. Backups without a safe journal are preserved."],
    ],
    [2.25, 4.75],
)

heading("Failure result principles", 2)
bullet("A failed properties restart states that the previous file was restored, or reports the recovery failure explicitly.")
bullet("A failed add-on download changes no installed files. A failed post-change restart restores files and lock metadata.")
bullet("A damaged import is not added to discovery. A failed export deletes its partial output and still attempts server restart.")
bullet("Renderer error results distinguish the failure message, observed outcome, recommended next action, and a Retry button when the action can be repeated safely.")

heading("13 Network services", 1)
add_table(
    ["Service", "Purpose", "Failure effect"],
    [
        ["Mojang piston-meta and piston-data", "Vanilla versions and server JAR.", "Vanilla catalog or creation fails without changing existing servers."],
        ["PaperMC Fill", "Paper versions, builds, and JAR.", "Paper catalog or creation fails."],
        ["Fabric Meta", "Minecraft, loader, installer, and Fabric server JAR.", "Fabric catalog or creation fails."],
        ["Forge Maven", "Forge versions and installer.", "Forge catalog or creation fails."],
        ["NeoForge Maven", "NeoForge versions and installer.", "NeoForge catalog or creation fails."],
        ["Modrinth API and CDN", "Add-on search, versions, dependencies, hashes, and JARs.", "Installed add-ons remain manageable; cached search may remain available."],
        ["Minecraft EULA and Adoptium", "External browser help links.", "The app remains open; the user must resolve EULA or Java prerequisites."],
    ],
    [2.1, 2.75, 2.15],
)
paragraph("BlockHost does not send analytics, console logs, world data, server names, or player data to a first-party service. Provider requests disclose the normal source IP, requested versions or project identifiers, and the BlockHostManager/1.0.0 user agent.")

heading("14 Build packaging and distribution", 1)
heading("Toolchain", 2)
add_table(
    ["Package", "Version or role"],
    [
        ["Electron", "42.4.0 desktop runtime"],
        ["Electron Forge", "7.11.2 packaging and makers"],
        ["Vite", "8.0.16 main, preload, and renderer bundles"],
        ["electron-squirrel-startup", "Windows install and uninstall event handling"],
        ["yauzl", "3.4.0 ZIP reading and validation"],
        ["yazl", "3.3.1 streaming ZIP creation"],
    ],
    [2.25, 4.75],
)

heading("Forge configuration", 2)
bullet("ASAR packaging and dependency pruning are enabled.")
bullet("Application PNG and ICO assets are packaged; the assets directory is also an extra resource.")
bullet("Configured makers are Squirrel, ZIP for Windows and macOS, DEB, and RPM.")
bullet("There is no publisher, signing identity, automatic updater, fuse plugin, or release provenance configuration.")

heading("Development and release commands", 2)
code([
    "npm start          # Electron Forge development session",
    "npm run check      # syntax checks plus all Node tests",
    "npm test           # Node test suite",
    "npm run package    # unpacked application package",
    "npm run make       # configured distributable makers",
    "npm audit --omit=dev",
])

heading("15 Testing and verification", 1)
heading("Automated coverage", 2)
add_table(
    ["Suite", "Covered behavior"],
    [
        ["safe-filesystem", "Atomic replacement, backup restore, containment rejection."],
        ["operation-manager", "Lock conflicts, release after success or failure, snapshots, progress updates, idle wait."],
        ["server metadata and store", "Normalization, portable persistence, schema migration, reversible backup, cached-JAR relocation."],
        ["server properties", "Java escaping, comments, duplicate keys, unknown values, ranges, versions, presets, raw validation, rollback."],
        ["add-on manager", "Profiles, exact search facets, dependency resolution, digest rejection, manual metadata, client-only rejection, duplicate hash, cascade removal, rollback."],
        ["transfer manager", "Self-contained export, payload verification, machine-path change, EULA reset, hashes, traversal, future format, cleanup."],
        ["external importer", "Paper folder detection, atomic commit, ambiguous JAR refusal, malicious traversal ZIP rejection."],
    ],
    [2.0, 5.0],
)

heading("Verification record", 2)
add_table(
    ["Check", "Result", "Evidence"],
    [
        ["JavaScript syntax and tests", "Pass", "npm run check; 31 tests passed on 2 November 2026."],
        ["Production dependency audit", "Pass", "npm audit --omit=dev; zero vulnerabilities on 2 November 2026."],
        ["Production Vite bundles", "Pass", "Main, preload, and renderer targets built successfully."],
        ["Windows package", "Pass", "electron-forge package completed for win32 x64 after runtime download access was allowed."],
        ["Native UI smoke test", "Required before release", "Open packaged or development build on the target display and exercise properties, add-ons, transfers, console, start, and stop."],
    ],
    [2.1, 1.0, 3.9],
)

heading("Manual compatibility matrix", 2)
add_table(
    ["Scenario", "Minimum smoke test"],
    [
        ["Vanilla", "Download, EULA, start, console command, properties, export, import, stop."],
        ["Paper", "Install and disable a plugin, restart recovery, update check."],
        ["Fabric", "Install a mod with a required dependency and verify cascade removal."],
        ["Forge and NeoForge", "Installer creation, argument-file launch, manual mod validation, export and import."],
        ["Running server", "Save and restart properties, add-on restart, export stop and restart, quit wait."],
        ["Offline network", "Installed add-on management, cached search label, manual JAR install, no stuck spinner."],
        ["Corrupted inputs", "Bad JAR, hash mismatch, traversal ZIP, compression bomb, unsupported archive version."],
        ["Packaged Windows build", "Cold launch, dialogs, external links, file pickers, PowerShell metrics, app quit."],
    ],
    [2.0, 5.0],
)

heading("16 Operational runbook", 1)
heading("Start development", 2)
numbered("Install the locked dependencies with npm install or npm ci.", 1)
numbered("Run npm run check and resolve any failure before launching.", 2)
numbered("Run npm start. Electron Forge starts Vite and opens BlockHost Manager.", 3)

heading("Recover a failed operation", 2)
add_table(
    ["Symptom", "Action"],
    [
        ["Properties failed and rolled back", "Read the console and error result. Correct the invalid setting or server prerequisite, then retry."],
        ["Add-on restart rolled back", "Open Add-ons, inspect warnings and dependency state, then retry a compatible release or remove the offending manual JAR."],
        ["Search says internet required", "Installed add-ons remain safe. Restore connectivity and use Retry; cached results may be shown."],
        ["Import rejected", "Do not extract into the managed servers directory. Use a known-good .blockhost archive or simplify an external folder to one launch candidate."],
        ["Export failed", "Confirm free space and file access. The app deletes incomplete output and reports whether the server restarted."],
        ["App closed during add-on change", "Restart BlockHost. Startup recovery replays the add-on journal before server discovery."],
        ["Server remains Starting", "Wait up to four minutes, inspect the console, then stop. Confirm Java, launch files, EULA, and add-on compatibility."],
    ],
    [2.3, 4.7],
)

heading("Data backup and deletion", 2)
paragraph("Use Export before destructive maintenance. The export is the supported portable backup because it includes the launch runtime, world, configuration, access lists, add-ons, lock file, and loader libraries. Delete server permanently removes the managed folder and world after confirmation. It does not remove provider caches or exports.")

heading("17 Maintenance guidance and known limits", 1)
heading("Change rules", 2)
bullet("Keep filesystem and network work in the main process. Never expose raw ipcRenderer, shell, fs, child_process, or arbitrary paths to the renderer.")
bullet("Add every privileged capability as one named preload method and one narrow IPC handler. Normalize IDs and enforce containment again in the service module.")
bullet("Any new modifying workflow must acquire the per-server operation lock, stage its files, verify the result, support rollback, clean up in finally, and define startup recovery.")
bullet("Metadata changes require a schema version, migration test, portable fields, and a reversible pre-migration copy when older data is rewritten.")
bullet("Archive format changes require a new format version. Never silently reinterpret a future version.")
bullet("Run syntax, unit, package, audit, and native UI checks before release. Visually test the exact packaged build users will receive.")

heading("Known limits", 2)
add_table(
    ["Limit", "Impact and next step"],
    [
        ["Runtime adoption", "A Java server that survives an app crash is not reattached for console or stop control. Add startup reconciliation before supporting unattended operation."],
        ["Startup readiness", "Readiness depends on the standard Done log message. Add loader-specific failure patterns and an alternate port or process readiness signal."],
        ["External version detection", "Nonstandard third-party layouts may import as version unknown. Add JAR manifest inspection and an explicit repair action."],
        ["Add-on metadata", "Optional dependencies are listed by identifier rather than enriched project name. Cache project metadata for clearer suggestions."],
        ["History pruning", "Lock entries retain ten records, but orphan history files are not yet garbage-collected. Add a verified cleanup command."],
        ["Cancellation", "Most file commits are intentionally non-cancellable once mutation begins. Add AbortController support for network and pre-commit transfer stages only."],
        ["Renderer size", "renderer.js still contains dashboard, properties, add-ons, transfer views, and bindings. Split view modules as the next maintainability task without changing the preload contract."],
        ["Release security", "Packages are not signed and no updater is configured. Add code signing, fuses, provenance, and authenticated updates before broad distribution."],
        ["Full E2E coverage", "Unit and integration-style filesystem tests exist; automated Electron E2E and interruption fault injection remain to be added."],
    ],
    [2.0, 5.0],
)

heading("Appendix A IPC contract", 1)
add_table(
    ["Channel group", "Channels and effects"],
    [
        ["Server catalog", "servers:getVersionOptions; remote provider reads."],
        ["Server creation and discovery", "servers:create, servers:getSaved; downloads, installer execution, metadata write, filesystem scan."],
        ["Runtime", "servers:getRuntimeState, servers:getUsage, servers:start, servers:stop, servers:sendCommand, servers:delete."],
        ["Operations", "operations:getActive plus operations:state push snapshots."],
        ["Properties", "servers:getProperties, servers:updateProperties."],
        ["Server identity", "servers:updateIdentity."],
        ["Add-on read and search", "addons:list, addons:search, addons:checkUpdates."],
        ["Add-on mutation", "addons:install, installManual, installManualPath, setEnabled, remove, update, updateAll, setReleaseChannel, rollback."],
        ["Transfers", "transfers:export, exportAs, importDialog, importExternalDialog, importPath, importExternalPath, openExportFolder plus transfers:progress."],
        ["Worlds", "worlds:chooseImportSource and worlds:export; progress uses the shared transfers:progress channel."],
    ],
    [2.1, 4.9],
)
paragraph("The preload converts dropped File objects to native paths through Electron webUtils before invoking the main process. The main process still treats those paths as untrusted and validates file type, existence, containment of destinations, and archive content.")

heading("Appendix B Repository map", 1)
add_table(
    ["Path", "Purpose"],
    [
        ["src/main.js", "Electron lifecycle, provider downloads, Java runtime, dialogs, usage sampling, IPC registration."],
        ["src/preload.js", "Renderer capability surface and progress subscriptions."],
        ["src/renderer.js", "Application state, views, workflows, event binding, polling, drag and drop."],
        ["src/index.css", "Dark application visual system, modal, form, add-on, transfer, toast, and responsive styles."],
        ["src/lib", "Reliability, store, properties, add-on, transfer, external import, and operation services."],
        ["test", "Node test runner suites for every service module."],
        ["index.html", "Renderer root and restrictive Content Security Policy."],
        ["forge.config.js", "ASAR packaging, assets, Vite targets, and maker definitions."],
        ["documentation", "This maintained technical and operational reference."],
    ],
    [2.1, 4.9],
)

heading("Appendix C Compatibility matrix", 1)
add_table(
    ["Capability", "Vanilla", "Paper", "Fabric", "Forge", "NeoForge"],
    [
        ["Download", "Yes", "Yes", "Yes", "Yes", "Yes"],
        ["Start stop console usage", "Yes", "Yes", "Yes", "Yes", "Yes"],
        ["Properties guided raw presets", "Yes", "Yes", "Yes", "Yes", "Yes"],
        ["Managed online add-ons", "No", "Plugins", "Mods", "Mods", "Mods"],
        ["Manual JAR add-ons", "No", "Yes", "Yes", "Yes", "Yes"],
        ["Update history rollback", "No", "Yes", "Yes", "Yes", "Yes"],
        ["BlockHost export import", "Yes", "Yes", "Yes", "Yes", "Yes"],
        ["External detection", "Single JAR", "Paper JAR or plugins", "Fabric launcher", "Forge args", "NeoForge args"],
    ],
    [2.1, 0.95, 0.95, 0.95, 0.95, 1.1],
)

heading("Document status", 2)
paragraph("This reference supersedes the earlier pre-cleanup application report. It intentionally excludes removed DDNS, CPU-temperature, tray, and legacy navigation behavior. It should be updated in the same change that modifies an IPC channel, metadata format, archive contract, recovery path, or user-visible capability.")

doc.core_properties.title = "BlockHost Manager Technical Reference"
doc.core_properties.subject = "Architecture, features, reliability, operations, and maintenance"
doc.core_properties.author = "BlockHost Manager project"
doc.core_properties.keywords = "Electron, Minecraft, server manager, properties, mods, plugins, export, import"
doc.core_properties.comments = "Updated from the current implementation on 2 November 2026."

doc.save(OUTPUT)
print(OUTPUT)
