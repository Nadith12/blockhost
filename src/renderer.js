import "./index.css";
import appIconUrl from "../assets/app-icon.png";

const root = document.getElementById("app");
const JAVA_URL = "https://adoptium.net/temurin/releases/?package=jdk";

const state = {
  servers: [],
  selectedId: null,
  runtime: null,
  usage: null,
  createOpen: false,
  createPending: false,
  createType: "vanilla",
  versions: [],
  versionsLoading: false,
  versionsError: "",
  pendingAction: "",
  pendingStart: null,
  deleteId: null,
  error: "",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function selectedServer() {
  return state.servers.find((server) => server.id === state.selectedId) || null;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function runtimeUsage() {
  return state.usage?.processes?.find((item) => item.serverId === state.selectedId) || null;
}

function statusLabel(status) {
  return {
    offline: "Offline",
    starting: "Starting",
    running: "Running",
    stopping: "Stopping",
  }[status] || "Offline";
}

function showError(error) {
  state.error = error?.message || String(error || "Something went wrong");
  render();
}

async function loadServers(preferredId = null) {
  state.servers = await window.minecraftAPI.getServers();
  if (preferredId && state.servers.some((server) => server.id === preferredId)) {
    state.selectedId = preferredId;
  } else if (!state.servers.some((server) => server.id === state.selectedId)) {
    state.selectedId = state.servers[0]?.id || null;
  }
  await refreshLive();
}

async function loadVersions() {
  state.versionsLoading = true;
  state.versionsError = "";
  state.versions = [];
  render();
  try {
    state.versions = await window.minecraftAPI.getVersionOptions(state.createType);
  } catch (error) {
    state.versionsError = error.message || "Could not load versions";
  } finally {
    state.versionsLoading = false;
    render();
  }
}

async function refreshLive() {
  if (!state.selectedId) {
    state.runtime = null;
    state.usage = await window.minecraftAPI.getUsage().catch(() => null);
    updateLiveElements();
    return;
  }

  const [runtime, usage] = await Promise.all([
    window.minecraftAPI.getRuntime(state.selectedId).catch(() => null),
    window.minecraftAPI.getUsage().catch(() => null),
  ]);
  state.runtime = runtime;
  state.usage = usage;
  updateLiveElements();
}

function updateLiveElements() {
  const runtime = state.runtime || { status: "offline", logs: [] };
  const usage = runtimeUsage();
  const status = document.getElementById("runtimeStatus");
  if (status) {
    status.textContent = statusLabel(runtime.status);
    status.className = `status-badge status-${runtime.status || "offline"}`;
  }
  const cpu = document.getElementById("cpuValue");
  if (cpu) cpu.textContent = `${(Number(usage?.cpuPercent) || 0).toFixed(1)}%`;
  const ram = document.getElementById("ramValue");
  if (ram) ram.textContent = formatBytes(usage?.ramBytes || 0);
  const pid = document.getElementById("pidValue");
  if (pid) pid.textContent = runtime.pid ? String(runtime.pid) : "—";

  const consoleOutput = document.getElementById("consoleOutput");
  if (consoleOutput) {
    const wasAtBottom =
      consoleOutput.scrollHeight - consoleOutput.scrollTop - consoleOutput.clientHeight < 40;
    consoleOutput.textContent = runtime.logs?.length
      ? runtime.logs.join("\n")
      : "Server output will appear here.";
    if (wasAtBottom) consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }

  const start = document.getElementById("startServer");
  const stop = document.getElementById("stopServer");
  const running = runtime.status === "running" || runtime.status === "starting";
  if (start) {
    start.hidden = running || runtime.status === "stopping";
    start.disabled = Boolean(state.pendingAction);
  }
  if (stop) {
    stop.hidden = !running && runtime.status !== "stopping";
    stop.disabled = Boolean(state.pendingAction) || runtime.status === "stopping";
    stop.textContent = runtime.status === "stopping" ? "Stopping…" : "Stop server";
  }
  const command = document.getElementById("commandInput");
  const send = document.getElementById("sendCommand");
  if (command) command.disabled = runtime.status !== "running";
  if (send) send.disabled = runtime.status !== "running";
}

async function createServer(event) {
  event.preventDefault();
  if (state.createPending) return;
  const form = event.currentTarget;
  const selected = state.versions.find((version) => version.id === form.version.value);
  if (!selected) return;

  state.createPending = true;
  state.error = "";
  render();
  try {
    const result = await window.minecraftAPI.createServer({
      name: form.serverName.value.trim(),
      color: form.color.value,
      type: state.createType,
      version: selected.version,
      versionUrl: selected.versionUrl || "",
      loaderVersion: selected.loaderVersion || "",
      installerVersion: selected.installerVersion || "",
    });
    state.createOpen = false;
    await loadServers(result.server.id);
  } catch (error) {
    state.error = error.message || "Could not download the server";
  } finally {
    state.createPending = false;
    render();
  }
}

async function startServer(options = {}) {
  if (!state.selectedId || state.pendingAction) return;
  state.pendingAction = "start";
  updateLiveElements();
  try {
    const runtime = await window.minecraftAPI.startServer(state.selectedId, options);
    if (runtime.requiresEula) {
      state.pendingStart = { kind: "eula" };
      render();
      return;
    }
    if (runtime.requiresServerSwitch) {
      state.pendingStart = { kind: "switch", activeServer: runtime.activeServer };
      render();
      return;
    }
    state.runtime = runtime;
  } catch (error) {
    if (/Java is not installed|available on PATH/i.test(error.message || "")) {
      state.pendingStart = { kind: "java" };
      render();
    } else {
      showError(error);
    }
  } finally {
    state.pendingAction = "";
    updateLiveElements();
  }
}

async function stopServer() {
  if (!state.selectedId || state.pendingAction) return;
  state.pendingAction = "stop";
  updateLiveElements();
  try {
    state.runtime = await window.minecraftAPI.stopServer(state.selectedId);
  } catch (error) {
    showError(error);
  } finally {
    state.pendingAction = "";
    updateLiveElements();
  }
}

async function submitCommand(event) {
  event.preventDefault();
  const input = event.currentTarget.command;
  const command = input.value.trim();
  if (!command) return;
  input.value = "";
  try {
    state.runtime = await window.minecraftAPI.sendCommand(state.selectedId, command);
    updateLiveElements();
  } catch (error) {
    showError(error);
  }
}

async function confirmDelete() {
  if (!state.deleteId) return;
  const id = state.deleteId;
  state.deleteId = null;
  try {
    await window.minecraftAPI.deleteServer(id);
    await loadServers();
    render();
  } catch (error) {
    showError(error);
  }
}

function renderSidebar() {
  const buttons = state.servers.map((server) => `
    <button class="server-item ${server.id === state.selectedId ? "active" : ""}"
      data-server-id="${server.id}" type="button">
      <span class="server-dot" style="--server-color:${escapeHtml(server.color)}"></span>
      <span>
        <strong>${escapeHtml(server.name)}</strong>
        <small>${escapeHtml(server.typeLabel)} ${escapeHtml(server.version)}</small>
      </span>
    </button>
  `).join("");

  return `
    <aside class="sidebar">
      <div class="brand">
        <img src="${appIconUrl}" alt="" />
        <div><strong>BlockHost</strong><span>Server Manager</span></div>
      </div>
      <button class="new-server" id="openCreate" type="button">＋ Download server</button>
      <div class="server-list" aria-label="Downloaded servers">
        ${buttons || '<p class="empty-sidebar">No servers downloaded yet.</p>'}
      </div>
      <p class="sidebar-footnote">Local servers only</p>
    </aside>
  `;
}

function renderEmpty() {
  return `
    <main class="empty-state">
      <div class="empty-icon">▦</div>
      <p class="eyebrow">Minecraft server manager</p>
      <h1>Everything needed to run a local server.</h1>
      <p>Download a server, start or stop it, watch CPU and RAM use, and manage it through the live console.</p>
      <button class="primary" id="emptyCreate" type="button">Download your first server</button>
    </main>
  `;
}

function renderServer() {
  const server = selectedServer();
  const runtime = state.runtime || { status: "offline", logs: [] };
  const usage = runtimeUsage();
  return `
    <main class="content">
      <header class="server-header">
        <div>
          <p class="eyebrow">${escapeHtml(server.typeLabel)} · Minecraft ${escapeHtml(server.version)}</p>
          <h1>${escapeHtml(server.name)}</h1>
        </div>
        <div class="header-actions">
          <span id="runtimeStatus" class="status-badge status-${runtime.status || "offline"}">${statusLabel(runtime.status)}</span>
          <button class="danger-ghost" id="deleteServer" type="button">Delete</button>
          <button class="primary" id="startServer" type="button" ${runtime.status !== "offline" ? "hidden" : ""}>Start server</button>
          <button class="danger" id="stopServer" type="button" ${runtime.status === "offline" ? "hidden" : ""}>Stop server</button>
        </div>
      </header>

      <section class="metrics" aria-label="Server resource usage">
        <article><span>CPU usage</span><strong id="cpuValue">${(Number(usage?.cpuPercent) || 0).toFixed(1)}%</strong></article>
        <article><span>RAM usage</span><strong id="ramValue">${formatBytes(usage?.ramBytes || 0)}</strong></article>
        <article><span>Process ID</span><strong id="pidValue">${runtime.pid || "—"}</strong></article>
      </section>

      <section class="console-card">
        <div class="console-title"><div><span class="terminal-dot red"></span><span class="terminal-dot yellow"></span><span class="terminal-dot green"></span></div><strong>Server console</strong></div>
        <pre id="consoleOutput" tabindex="0">${escapeHtml(runtime.logs?.length ? runtime.logs.join("\n") : "Server output will appear here.")}</pre>
        <form class="command-form" id="commandForm">
          <span>&gt;</span>
          <input id="commandInput" name="command" autocomplete="off" placeholder="Enter a server command" ${runtime.status !== "running" ? "disabled" : ""} />
          <button id="sendCommand" type="submit" ${runtime.status !== "running" ? "disabled" : ""}>Send</button>
        </form>
      </section>
    </main>
  `;
}

function renderCreateModal() {
  if (!state.createOpen) return "";
  const options = state.versions.map((version) =>
    `<option value="${escapeHtml(version.id)}">${escapeHtml(version.label)}</option>`
  ).join("");
  return `
    <div class="overlay" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="createTitle">
        <button class="modal-close" id="closeCreate" type="button" aria-label="Close">×</button>
        <p class="eyebrow">New local server</p>
        <h2 id="createTitle">Download a server</h2>
        <form id="createForm">
          <label>Server name<input name="serverName" maxlength="80" required placeholder="Survival world" /></label>
          <div class="form-row">
            <label>Server type
              <select name="serverType" id="serverType">
                <option value="vanilla" ${state.createType === "vanilla" ? "selected" : ""}>Vanilla</option>
                <option value="paper" ${state.createType === "paper" ? "selected" : ""}>Paper</option>
                <option value="fabric" ${state.createType === "fabric" ? "selected" : ""}>Fabric</option>
                <option value="forge" ${state.createType === "forge" ? "selected" : ""}>Forge</option>
                <option value="neoforge" ${state.createType === "neoforge" ? "selected" : ""}>NeoForge</option>
              </select>
            </label>
            <label>Accent color<input name="color" type="color" value="#39c9ff" /></label>
          </div>
          <label>Minecraft version
            <select name="version" required ${state.versionsLoading || !state.versions.length ? "disabled" : ""}>
              ${state.versionsLoading ? '<option>Loading versions…</option>' : options || '<option>No versions available</option>'}
            </select>
          </label>
          ${state.versionsError ? `<p class="form-error">${escapeHtml(state.versionsError)}</p>` : ""}
          <p class="form-note">The application downloads the selected server files and stores them in its local data folder.</p>
          <button class="primary full" type="submit" ${state.createPending || state.versionsLoading || !state.versions.length ? "disabled" : ""}>
            ${state.createPending ? "Downloading…" : "Download server"}
          </button>
        </form>
      </section>
    </div>
  `;
}

function renderStartModal() {
  if (!state.pendingStart) return "";
  if (state.pendingStart.kind === "eula") {
    return `
      <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="eulaTitle">
        <h2 id="eulaTitle">Accept the Minecraft EULA</h2>
        <p>Starting this server requires acceptance of the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>.</p>
        <div class="modal-actions"><button class="secondary" id="cancelStart" type="button">Cancel</button><button class="primary" id="acceptEula" type="button">Accept and start</button></div>
      </section></div>`;
  }
  if (state.pendingStart.kind === "switch") {
    return `
      <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="switchTitle">
        <h2 id="switchTitle">Switch running server?</h2>
        <p>${escapeHtml(state.pendingStart.activeServer?.serverName || "Another server")} is running. It will be stopped before this server starts.</p>
        <div class="modal-actions"><button class="secondary" id="cancelStart" type="button">Cancel</button><button class="primary" id="confirmSwitch" type="button">Stop and switch</button></div>
      </section></div>`;
  }
  return `
    <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="javaTitle">
      <h2 id="javaTitle">Java is required</h2>
      <p>Install a current JDK, then reopen BlockHost Manager.</p>
      <div class="modal-actions"><button class="secondary" id="cancelStart" type="button">Close</button><a class="primary link-button" href="${JAVA_URL}" target="_blank" rel="noreferrer">Get Java</a></div>
    </section></div>`;
}

function renderDeleteModal() {
  if (!state.deleteId) return "";
  const server = state.servers.find((item) => item.id === state.deleteId);
  return `
    <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="deleteTitle">
      <h2 id="deleteTitle">Delete ${escapeHtml(server?.name || "server")}?</h2>
      <p>This removes its local server folder and world data. This action cannot be undone.</p>
      <div class="modal-actions"><button class="secondary" id="cancelDelete" type="button">Cancel</button><button class="danger" id="confirmDelete" type="button">Delete server</button></div>
    </section></div>`;
}

function renderError() {
  return state.error
    ? `<div class="toast" role="alert"><span>${escapeHtml(state.error)}</span><button id="dismissError" type="button" aria-label="Dismiss">×</button></div>`
    : "";
}

function render() {
  root.innerHTML = `
    <div class="app-shell">${renderSidebar()}${selectedServer() ? renderServer() : renderEmpty()}</div>
    ${renderCreateModal()}${renderStartModal()}${renderDeleteModal()}${renderError()}
  `;
  bindEvents();
  updateLiveElements();
}

function bindEvents() {
  document.querySelectorAll("[data-server-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedId = Number(button.dataset.serverId);
      state.runtime = null;
      render();
      await refreshLive();
    });
  });

  const openCreate = () => {
    state.createOpen = true;
    state.versions = [];
    state.versionsError = "";
    render();
    loadVersions();
  };
  document.getElementById("openCreate")?.addEventListener("click", openCreate);
  document.getElementById("emptyCreate")?.addEventListener("click", openCreate);
  document.getElementById("closeCreate")?.addEventListener("click", () => {
    if (!state.createPending) {
      state.createOpen = false;
      render();
    }
  });
  document.getElementById("serverType")?.addEventListener("change", (event) => {
    state.createType = event.target.value;
    loadVersions();
  });
  document.getElementById("createForm")?.addEventListener("submit", createServer);

  document.getElementById("startServer")?.addEventListener("click", () => startServer());
  document.getElementById("stopServer")?.addEventListener("click", stopServer);
  document.getElementById("commandForm")?.addEventListener("submit", submitCommand);
  document.getElementById("deleteServer")?.addEventListener("click", () => {
    state.deleteId = state.selectedId;
    render();
  });

  document.getElementById("cancelStart")?.addEventListener("click", () => {
    state.pendingStart = null;
    render();
  });
  document.getElementById("acceptEula")?.addEventListener("click", () => {
    state.pendingStart = null;
    render();
    startServer({ acceptEula: true });
  });
  document.getElementById("confirmSwitch")?.addEventListener("click", () => {
    state.pendingStart = null;
    render();
    startServer({ forceSwitch: true });
  });
  document.getElementById("cancelDelete")?.addEventListener("click", () => {
    state.deleteId = null;
    render();
  });
  document.getElementById("confirmDelete")?.addEventListener("click", confirmDelete);
  document.getElementById("dismissError")?.addEventListener("click", () => {
    state.error = "";
    render();
  });
}

let liveRefreshPending = false;

async function refreshLiveSafely() {
  if (liveRefreshPending || document.hidden) return;
  liveRefreshPending = true;
  try {
    await refreshLive();
  } finally {
    liveRefreshPending = false;
  }
}

render();
loadServers().then(render).catch(showError);
setInterval(refreshLiveSafely, 2000);
