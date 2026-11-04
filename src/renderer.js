import "./index.css";
import appIconUrl from "../assets/app-icon.png";
import { buildCommand, commandDefinition, normalizeRawCommand, searchCommands } from "./lib/command-catalog.mjs";
import { attachErrorGroup, parseConsoleLine } from "./lib/console-log.mjs";

const root = document.getElementById("app");
const JAVA_URL = "https://adoptium.net/temurin/releases/?version=25&os=windows&arch=x64&package=jdk";
const NOTICE_DURATION_MS = 4500;
let noticeTimer = null;
let addonSearchRequestSequence = 0;
const legacyConsoleTimes = new Map();

const state = {
  servers: [],
  selectedId: null,
  runtime: null,
  usage: null,
  operations: [],
  createOpen: false,
  createPending: false,
  createType: "vanilla",
  createWorldImport: null,
  versions: [],
  versionsLoading: false,
  versionsError: "",
  pendingAction: "",
  pendingStart: null,
  javaSetup: null,
  deleteId: null,
  propertiesOpen: false,
  propertiesLoading: false,
  propertiesPending: false,
  propertiesModel: null,
  propertiesDraft: null,
  propertiesMode: "form",
  propertyPresetSummary: "",
  propertiesError: "",
  quickPropertiesModel: null,
  quickPropertiesLoading: false,
  quickPropertiesPending: false,
  quickPropertiesError: "",
  serverSettingsOpen: false,
  serverSettingsLoading: false,
  memoryModel: null,
  memoryDraft: null,
  memoryPending: false,
  memoryError: "",
  identityPending: false,
  identityError: "",
  addonsOpen: false,
  addonsLoading: false,
  addonsPending: "",
  addonsModel: null,
  addonQuery: "",
  addonCategory: "all",
  addonSort: "relevance",
  addonInstalledFilter: "all",
  addonResults: [],
  addonHasSearched: false,
  addonSearching: false,
  addonError: "",
  addonSearchStatus: "",
  addonRemoveId: null,
  addonRecommendations: [],
  addonRecommendationsLoading: false,
  addonRecommendationsError: "",
  transferPending: "",
  transferProgress: null,
  transferResult: null,
  dragActive: false,
  error: "",
  errorRetry: null,
  notice: "",
  consoleFilter: "all",
  consoleSearch: "",
  consoleClearedBeforeId: 0,
  consoleAutoScroll: true,
  commandAssistantOpen: false,
  commandSearch: "",
  selectedCommandId: "",
  commandValues: {},
  commandError: "",
  commandConfirming: false,
  commandHistory: [],
  commandHistoryIndex: -1,
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

function formatRunDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function runMetrics(runtime = {}) {
  const active = ["starting", "running", "stopping"].includes(runtime.status);
  const started = Date.parse(runtime.startedAt);
  const uptimeMs = active && Number.isFinite(started) ? Math.max(0, Date.now() - started) : null;
  const lastStarted = Date.parse(runtime.lastStartedAt);
  return {
    uptime: uptimeMs === null ? "—" : formatRunDuration(uptimeMs),
    uptimeDetail: uptimeMs === null ? "Server is offline" : `Started ${new Date(started).toLocaleString()}`,
    lastRun: Number.isFinite(lastStarted)
      ? new Date(lastStarted).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "—",
    lastRunDetail: Number.isFinite(lastStarted)
      ? new Date(lastStarted).toLocaleDateString()
      : "Never started",
    lastRunTitle: Number.isFinite(lastStarted) ? new Date(lastStarted).toLocaleString() : "",
  };
}

function normalizedConsoleEntry(value, index = 0, previousOccurrence = "") {
  const structured = value && typeof value === "object";
  const raw = String(structured ? value.raw ?? value.message ?? "" : value || "");
  const parsed = parseConsoleLine(raw, {
    id: structured ? value.id : index + 1,
    receivedAt: structured ? value.receivedAt : new Date().toISOString(),
    source: structured ? value.source : "server",
  });
  if (!structured) {
    const cacheKey = `${state.selectedId}:${index}:${raw}`;
    if (parsed.minecraftTime) {
      parsed.receivedAt = parsed.occurredAt;
      legacyConsoleTimes.set(cacheKey, parsed.occurredAt);
    } else {
      const stableTime = legacyConsoleTimes.get(cacheKey) || previousOccurrence || parsed.receivedAt;
      parsed.receivedAt = stableTime;
      parsed.occurredAt = stableTime;
      legacyConsoleTimes.set(cacheKey, stableTime);
    }
  }
  return structured
    ? { ...value, ...parsed, id: value.id, receivedAt: value.receivedAt || parsed.receivedAt }
    : parsed;
}

function consoleEntries() {
  const grouping = {};
  const normalized = [];
  for (const [index, value] of (state.runtime?.logs || []).entries()) {
    const entry = normalizedConsoleEntry(value, index, normalized.at(-1)?.occurredAt || "");
    normalized.push(attachErrorGroup({ ...entry, errorGroupId: "" }, grouping));
  }
  return normalized.filter((entry) => Number(entry.id || 0) > state.consoleClearedBeforeId);
}

function visibleConsoleEntries() {
  const query = state.consoleSearch.trim().toLowerCase();
  return consoleEntries().filter((entry) => {
    const filterMatches = state.consoleFilter === "all"
      || (state.consoleFilter === "players" && entry.category === "player")
      || (state.consoleFilter === "warnings" && entry.level === "warn")
      || (state.consoleFilter === "errors" && entry.level === "error");
    if (!filterMatches) return false;
    return !query || `${entry.raw} ${entry.message} ${entry.playerName}`.toLowerCase().includes(query);
  });
}

function formatConsoleTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const day = date.toLocaleDateString([], { day: "2-digit", month: "short" });
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${day} ${time}`;
}

function renderConsoleMessage(entry) {
  const message = String(entry.message ?? entry.raw ?? "");
  const player = String(entry.playerName || "");
  if (!player) return escapeHtml(message);
  const index = message.indexOf(player);
  if (index < 0) return escapeHtml(message);
  return `${escapeHtml(message.slice(0, index))}<strong class="console-player-name">${escapeHtml(player)}</strong>${escapeHtml(message.slice(index + player.length))}`;
}

function renderConsoleRow(entry) {
  const classes = ["console-line", `console-${escapeHtml(entry.level || "info")}`];
  if (entry.event) classes.push(`console-${escapeHtml(entry.event)}`);
  const label = entry.level === "command" ? "YOU" : entry.level === "app" ? "APP" : entry.level === "warn" ? "WARN" : "";
  return `<div class="${classes.join(" ")}" data-log-id="${Number(entry.id) || 0}">
    <time datetime="${escapeHtml(entry.occurredAt || entry.receivedAt || "")}" title="${escapeHtml(new Date(entry.occurredAt || entry.receivedAt || Date.now()).toLocaleString())}">${escapeHtml(formatConsoleTimestamp(entry.occurredAt || entry.receivedAt))}</time>
    ${label ? `<span class="console-source">${label}</span>` : "<span class=\"console-source\" aria-hidden=\"true\"></span>"}
    <code>${renderConsoleMessage(entry)}</code>
  </div>`;
}

function renderErrorGroup(entries) {
  const groupId = entries[0]?.errorGroupId || `single-${entries[0]?.id}`;
  return `<article class="console-error-group" data-error-group="${escapeHtml(groupId)}">
    <header><span>Error detected</span><div><button type="button" data-copy-error="${escapeHtml(groupId)}">Copy error</button><button type="button" data-copy-diagnostics="${escapeHtml(groupId)}">Copy diagnostics</button></div></header>
    ${entries.map(renderConsoleRow).join("")}
  </article>`;
}

function renderConsoleRows() {
  const entries = visibleConsoleEntries();
  if (!entries.length) {
    const filtered = state.consoleFilter !== "all" || state.consoleSearch;
    return `<div class="console-empty">${filtered ? "No console entries match this view." : "Server output will appear here."}</div>`;
  }
  const output = [];
  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (entry.errorGroupId) {
      const group = [];
      while (index < entries.length && entries[index].errorGroupId === entry.errorGroupId) group.push(entries[index++]);
      output.push(renderErrorGroup(group));
    } else {
      output.push(renderConsoleRow(entry));
      index += 1;
    }
  }
  return output.join("");
}

function consoleErrorCount() {
  return new Set(consoleEntries().filter((entry) => entry.level === "error").map((entry) => entry.errorGroupId || `entry-${entry.id}`)).size;
}

function syncConsoleOutput() {
  const output = document.getElementById("consoleOutput");
  if (!output) return;
  const wasAtBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 48;
  output.innerHTML = renderConsoleRows();
  const count = document.getElementById("consoleErrorCount");
  if (count) {
    const errors = consoleErrorCount();
    count.textContent = errors ? String(errors) : "";
    count.hidden = !errors;
  }
  if (state.consoleAutoScroll) output.scrollTop = output.scrollHeight;
  const latest = document.getElementById("jumpConsoleLatest");
  if (latest) latest.hidden = state.consoleAutoScroll || wasAtBottom;
}

function errorGroupEntries(groupId) {
  return consoleEntries().filter((entry) => (entry.errorGroupId || `single-${entry.id}`) === groupId);
}

async function writeClipboard(text, notice = "Copied to clipboard.") {
  try {
    try {
      await window.minecraftAPI.copyText(text);
    } catch (error) {
      if (!/No handler registered for ['"]?app:copyText/i.test(error?.message || "")) throw error;
      if (!navigator.clipboard?.writeText) throw new Error("Restart BlockHost once to activate clipboard support");
      await navigator.clipboard.writeText(text);
    }
    showNotice(notice);
  } catch (error) {
    showError(error);
  }
}

function consoleCopyLabel() {
  return {
    all: "Copy all",
    players: "Copy players",
    warnings: "Copy warnings",
    errors: "Copy errors",
  }[state.consoleFilter] || "Copy current view";
}

function diagnosticText(entries) {
  const server = selectedServer();
  const context = consoleEntries();
  const firstIndex = context.findIndex((entry) => entry.id === entries[0]?.id);
  const surrounding = context.slice(Math.max(0, firstIndex - 8), Math.min(context.length, firstIndex + entries.length + 8));
  return [
    "BlockHost console diagnostic",
    `Server: ${server?.name || "Unknown"}`,
    `Type: ${server?.typeLabel || server?.type || "Unknown"}`,
    `Minecraft: ${server?.version || "Unknown"}`,
    `Status: ${state.runtime?.status || "offline"}`,
    "",
    "Relevant console output:",
    ...surrounding.map((entry) => entry.raw),
  ].join("\n").replace(/C:\\Users\\[^\\\s]+/gi, "C:\\Users\\<user>");
}

function selectedCommand() {
  return commandDefinition(state.selectedCommandId);
}

function currentCommandPreview() {
  if (!state.selectedCommandId) return "";
  try { return buildCommand(state.selectedCommandId, state.commandValues); } catch { return selectedCommand()?.syntax || ""; }
}

function renderCommandField(field) {
  const value = state.commandValues[field.name] ?? field.default ?? "";
  const playerOptions = state.runtime?.onlinePlayers || [];
  if (field.type === "select") {
    return `<label><span>${escapeHtml(field.label)}</span><select data-command-field="${escapeHtml(field.name)}"><option value="">Choose…</option>${field.options.map((option) => `<option value="${escapeHtml(option)}" ${value === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select></label>`;
  }
  const listId = field.type === "player" ? `players-${escapeHtml(field.name)}` : "";
  return `<label><span>${escapeHtml(field.label)}${field.required ? "" : " (optional)"}</span><input data-command-field="${escapeHtml(field.name)}" type="${field.type === "number" ? "number" : "text"}" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder || "")}" ${field.min !== undefined ? `min="${field.min}"` : ""} ${field.max !== undefined ? `max="${field.max}"` : ""} ${listId ? `list="${listId}"` : ""} />${listId ? `<datalist id="${listId}">${playerOptions.map((player) => `<option value="${escapeHtml(player)}"></option>`).join("")}</datalist>` : ""}</label>`;
}

function renderCommandAssistant() {
  if (!state.commandAssistantOpen) return "";
  const definition = selectedCommand();
  if (definition) {
    return `<section class="command-builder" aria-label="Command builder">
      <header><div><small>${escapeHtml(definition.category)}</small><strong>${escapeHtml(definition.name)}</strong><p>${escapeHtml(definition.description)}</p></div><button id="closeCommandAssistant" type="button" aria-label="Close command builder">×</button></header>
      ${definition.fields.length ? `<div class="command-fields">${definition.fields.map(renderCommandField).join("")}</div>` : ""}
      ${state.commandError ? `<p class="command-error">${escapeHtml(state.commandError)}</p>` : ""}
      ${definition.danger && state.commandConfirming ? '<p class="command-warning">This command can remove access, affect players, or stop the server. Check the preview before confirming.</p>' : ""}
      <div class="command-preview"><span>Command preview</span><code>${escapeHtml(currentCommandPreview())}</code></div>
      <div class="command-builder-actions"><button class="secondary" id="backToCommands" type="button">Back</button><button class="${definition.danger ? "danger" : "primary"}" id="runGuidedCommand" type="button" ${state.runtime?.status !== "running" ? 'disabled title="Start the server to run commands"' : ""}>${state.runtime?.status !== "running" ? "Server offline" : definition.danger ? (state.commandConfirming ? "Confirm and run" : "Review command") : "Run command"}</button></div>
    </section>`;
  }
  const matches = searchCommands(state.commandSearch);
  return `<section class="command-palette" aria-label="Command library">
    <header><div><strong>Command library</strong><small>Choose a command and BlockHost will build it with you.</small></div><button id="closeCommandAssistant" type="button" aria-label="Close command library">×</button></header>
    <input id="commandSearch" value="${escapeHtml(state.commandSearch)}" placeholder="Search commands, e.g. player, weather, whitelist…" autocomplete="off" />
    <div class="command-results">${matches.length ? matches.map((command) => `<button type="button" data-command-id="${escapeHtml(command.id)}"><span><strong>${escapeHtml(command.name)}</strong><small>${escapeHtml(command.description)}</small></span><code>${escapeHtml(command.syntax)}</code></button>`).join("") : '<p class="command-no-results">No matching built-in commands. You can still type any command below.</p>'}</div>
  </section>`;
}

function showError(error, retry = null) {
  const message = error?.message || String(error || "Something went wrong");
  let outcome = "The operation stopped safely.";
  if (/rolled back|restored/i.test(message)) outcome = "The previous usable state was restored automatically.";
  else if (/no files were changed|was not added|unchanged/i.test(message)) outcome = "No server files were changed.";
  else if (/could not be restarted/i.test(message)) outcome = "Review the console or start the server again after resolving the reported problem.";
  const recommendation = /internet connection|required|network|download/i.test(message)
    ? "Check the internet connection, then retry."
    : /damaged|invalid|unsafe|unsupported/i.test(message)
      ? "Choose a known-good compatible file and try again."
      : "Review the message below and retry when ready.";
  state.error = { title: "Action failed", message, outcome, recommendation };
  state.errorRetry = typeof retry === "function" ? retry : null;
  render();
}

function showNotice(message) {
  if (noticeTimer) window.clearTimeout(noticeTimer);
  const notice = String(message || "");
  state.notice = notice;
  updateNoticeView();
  if (!notice) return;
  noticeTimer = window.setTimeout(() => {
    if (state.notice !== notice) return;
    state.notice = "";
    noticeTimer = null;
    updateNoticeView();
  }, NOTICE_DURATION_MS);
}

function clearNotice() {
  if (noticeTimer) window.clearTimeout(noticeTimer);
  noticeTimer = null;
  state.notice = "";
  updateNoticeView();
}

async function loadServers(preferredId = null) {
  state.servers = await window.minecraftAPI.getServers();
  if (preferredId && state.servers.some((server) => server.id === preferredId)) {
    state.selectedId = preferredId;
  } else if (!state.servers.some((server) => server.id === state.selectedId)) {
    state.selectedId = state.servers[0]?.id || null;
  }
  await Promise.all([refreshLive(), loadQuickProperties()]);
}

async function loadQuickProperties() {
  const serverId = state.selectedId;
  state.quickPropertiesModel = null;
  state.quickPropertiesError = "";
  if (!serverId) return;
  state.quickPropertiesLoading = true;
  try {
    state.quickPropertiesModel = await window.minecraftAPI.getServerProperties(serverId);
  } catch (error) {
    state.quickPropertiesError = error.message || "Could not load quick settings";
  } finally {
    state.quickPropertiesLoading = false;
  }
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
  const runs = runMetrics(runtime);
  const status = document.getElementById("runtimeStatus");
  if (status) {
    status.textContent = statusLabel(runtime.status);
    status.className = `status-badge status-${runtime.status || "offline"}`;
  }
  const cpu = document.getElementById("cpuValue");
  if (cpu) cpu.textContent = `${(Number(usage?.cpuPercent) || 0).toFixed(1)}%`;
  const ram = document.getElementById("ramValue");
  if (ram) ram.textContent = formatBytes(usage?.ramBytes || 0);
  const uptime = document.getElementById("uptimeValue");
  const uptimeDetail = document.getElementById("uptimeDetail");
  const lastRun = document.getElementById("lastRunValue");
  const lastRunDetail = document.getElementById("lastRunDetail");
  if (uptime) uptime.textContent = runs.uptime;
  if (uptimeDetail) uptimeDetail.textContent = runs.uptimeDetail;
  if (lastRun) lastRun.textContent = runs.lastRun;
  if (lastRunDetail) {
    lastRunDetail.textContent = runs.lastRunDetail;
    lastRunDetail.title = runs.lastRunTitle;
  }

  syncConsoleOutput();

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
      worldImportToken: state.createWorldImport?.token || "",
    });
    state.createOpen = false;
    state.createWorldImport = null;
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
    if (runtime.requiresPortConflict) {
      state.pendingStart = { kind: "port-conflict", portConflict: runtime.portConflict };
      render();
      return;
    }
    state.runtime = runtime;
  } catch (error) {
    const message = error.message || "";
    if (/Java|JDK|JRE/i.test(message)) {
      const requiredVersion = Number(message.match(/Java\s+(\d+)/i)?.[1]) >= 25 ? 25 : 21;
      state.javaSetup = { required: true, requiredVersion, installing: false, progress: null, error: "", reason: message };
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
  let command;
  try {
    command = normalizeRawCommand(input.value);
  } catch (error) {
    showError(error);
    return;
  }
  if (!command) return;
  input.value = "";
  await runConsoleCommand(command);
}

async function runConsoleCommand(command) {
  try {
    state.runtime = await window.minecraftAPI.sendCommand(state.selectedId, command);
    state.commandHistory = [command, ...state.commandHistory.filter((item) => item !== command)].slice(0, 30);
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

async function openProperties() {
  if (!state.selectedId || state.propertiesLoading) return;
  state.propertiesOpen = true;
  state.propertiesLoading = true;
  state.propertiesModel = null;
  state.propertiesDraft = null;
  state.propertiesError = "";
  render();
  try {
    const model = await window.minecraftAPI.getServerProperties(state.selectedId);
    state.propertiesModel = model;
    state.propertiesDraft = {
      values: { ...model.values },
      customProperties: model.customProperties || "",
      rawText: model.rawText || "",
    };
    state.propertiesMode = "form";
    state.propertyPresetSummary = "";
  } catch (error) {
    state.propertiesError = error.message || "Could not load server properties";
  } finally {
    state.propertiesLoading = false;
    render();
  }
}

function propertyDraftFromForm(form) {
  if (state.propertiesMode === "raw") {
    return {
      mode: "raw",
      rawText: form.elements.namedItem("rawText")?.value || "",
      values: { ...state.propertiesDraft?.values },
      customProperties: state.propertiesDraft?.customProperties || "",
    };
  }
  const values = {};
  for (const property of state.propertiesModel?.schema || []) {
    const input = form.elements.namedItem(property.key);
    if (!input) continue;
    if (property.type === "boolean") values[property.key] = input.checked;
    else if (property.type === "integer") values[property.key] = input.valueAsNumber;
    else values[property.key] = input.value;
  }
  return {
    mode: "form",
    values,
    customProperties: form.elements.namedItem("customProperties")?.value || "",
    rawText: state.propertiesDraft?.rawText || "",
  };
}

async function saveProperties(restart) {
  const form = document.getElementById("propertiesForm");
  if (!form || state.propertiesPending || !state.selectedId) return;

  const serverId = state.selectedId;
  state.propertiesDraft = propertyDraftFromForm(form);
  state.propertiesPending = true;
  state.propertiesError = "";
  clearNotice(false);
  render();
  try {
    const result = await window.minecraftAPI.updateServerProperties(
      serverId,
      state.propertiesDraft,
      { restart }
    );
    state.runtime = result.runtime;
    state.quickPropertiesModel = result.properties;
    state.propertiesOpen = false;
    state.propertiesModel = null;
    state.propertiesDraft = null;
    await loadServers(serverId);
    if (result.restarted) showNotice("Properties saved and the server restarted successfully.");
    else if (result.appliesOnNextStart) showNotice("Properties saved. They will apply on the next restart.");
    else showNotice("Server properties saved.");
  } catch (error) {
    state.propertiesError = error.message || "Could not save server properties";
    await refreshLive().catch(() => {});
  } finally {
    state.propertiesPending = false;
    render();
  }
}

async function saveQuickProperties(event) {
  event.preventDefault();
  if (!state.selectedId || state.quickPropertiesPending || !state.quickPropertiesModel) return;
  const form = event.currentTarget;
  const values = { ...state.quickPropertiesModel.values };
  for (const key of ["view-distance", "simulation-distance", "gamemode", "difficulty", "max-players"]) {
    const field = form.elements.namedItem(key);
    if (field) values[key] = field.value;
  }
  state.quickPropertiesPending = true;
  state.quickPropertiesError = "";
  render();
  try {
    const result = await window.minecraftAPI.updateServerProperties(state.selectedId, {
      mode: "form",
      values,
      customProperties: state.quickPropertiesModel.customProperties || "",
      rawText: state.quickPropertiesModel.rawText || "",
    }, { restart: false });
    state.quickPropertiesModel = result.properties;
    state.runtime = result.runtime;
    showNotice(result.appliesOnNextStart
      ? "Quick settings saved. They will apply on the next server restart."
      : "Quick server settings saved.");
  } catch (error) {
    state.quickPropertiesError = error.message || "Could not save quick settings";
  } finally {
    state.quickPropertiesPending = false;
    render();
  }
}

async function openServerSettings() {
  if (!state.selectedId || state.serverSettingsLoading) return;
  state.serverSettingsOpen = true;
  state.serverSettingsLoading = true;
  state.memoryModel = null;
  state.memoryDraft = null;
  state.memoryError = "";
  state.identityError = "";
  render();
  try {
    state.memoryModel = await window.minecraftAPI.getServerMemory(state.selectedId);
    state.memoryDraft = {
      minMemoryMb: state.memoryModel.minMemoryMb,
      maxMemoryMb: state.memoryModel.maxMemoryMb,
    };
  } catch (error) {
    state.memoryError = error.message || "Could not load memory settings";
  } finally {
    state.serverSettingsLoading = false;
    render();
  }
}

async function saveMemorySettings(event) {
  event.preventDefault();
  if (!state.selectedId || !state.memoryDraft || state.memoryPending) return;
  state.memoryPending = true;
  state.memoryError = "";
  render();
  try {
    const result = await window.minecraftAPI.updateServerMemory(
      state.selectedId,
      state.memoryDraft.minMemoryMb,
      state.memoryDraft.maxMemoryMb,
    );
    state.memoryModel = result;
    state.memoryDraft = { minMemoryMb: result.minMemoryMb, maxMemoryMb: result.maxMemoryMb };
    showNotice(result.appliesOnNextStart
      ? "RAM limits saved. They will apply on the next server restart."
      : "RAM limits saved.");
  } catch (error) {
    state.memoryError = error.message || "Could not save RAM limits";
  } finally {
    state.memoryPending = false;
    render();
  }
}

async function saveServerIdentity(event) {
  event.preventDefault();
  if (!state.selectedId || state.identityPending) return;
  const form = event.currentTarget;
  state.identityPending = true;
  state.identityError = "";
  render();
  try {
    const updated = await window.minecraftAPI.updateServerIdentity(
      state.selectedId,
      form.serverName.value.trim(),
      form.color.value,
    );
    state.servers = state.servers.map((server) => server.id === updated.id ? { ...server, ...updated } : server);
    showNotice("Server name and color saved.");
  } catch (error) {
    state.identityError = error.message || "Could not update server details";
  } finally {
    state.identityPending = false;
    render();
  }
}

async function chooseCreateWorld() {
  if (state.createPending) return;
  try {
    const result = await window.minecraftAPI.chooseWorldImportSource();
    if (result?.cancelled) return;
    state.createWorldImport = result;
    const status = document.getElementById("worldImportStatus");
    if (status) status.textContent = `${result.label} (${result.kind})`;
    document.getElementById("removeWorldImport")?.removeAttribute("hidden");
  } catch (error) {
    showError(error, chooseCreateWorld);
  }
}

async function exportSelectedWorld() {
  if (!state.selectedId || state.transferPending) return;
  state.serverSettingsOpen = false;
  state.transferPending = "world-export";
  state.transferProgress = { percent: 0, message: "Choose where to save the world…" };
  state.transferResult = null;
  state.error = "";
  render();
  try {
    const result = await window.minecraftAPI.exportWorld(state.selectedId);
    if (result?.cancelled) return;
    state.transferResult = { ...result, kind: "world-export" };
    await refreshLive();
  } catch (error) {
    state.transferResult = null;
    showError(error, exportSelectedWorld);
  } finally {
    state.transferPending = "";
    state.transferProgress = null;
    render();
  }
}

async function openAddons() {
  if (!state.selectedId || state.addonsLoading) return;
  addonSearchRequestSequence += 1;
  state.addonsOpen = true;
  state.addonsLoading = true;
  state.addonsModel = null;
  state.addonResults = [];
  state.addonHasSearched = false;
  state.addonError = "";
  state.addonSearchStatus = "";
  state.addonRemoveId = null;
  state.addonInstalledFilter = "all";
  state.addonRecommendations = [];
  state.addonRecommendationsLoading = true;
  state.addonRecommendationsError = "";
  render();
  try {
    state.addonsModel = await window.minecraftAPI.getAddons(state.selectedId);
  } catch (error) {
    state.addonError = error.message || "Could not load installed add-ons";
  } finally {
    state.addonsLoading = false;
    render();
  }
  if (!state.addonsModel?.supported) {
    state.addonRecommendationsLoading = false;
    render();
    return;
  }
  try {
    const recommendations = await window.minecraftAPI.getAddonRecommendations(state.selectedId);
    state.addonRecommendations = recommendations.results || [];
    state.addonSearchStatus = recommendations.offlineMessage || "";
  } catch (error) {
    state.addonRecommendationsError = error.message || "Recommendations are unavailable right now.";
  } finally {
    state.addonRecommendationsLoading = false;
    render();
  }
}

async function searchAddons(event) {
  event.preventDefault();
  const form = event.currentTarget;
  state.addonQuery = form.query.value.trim();
  await performAddonSearch();
}

async function performAddonSearch() {
  if (!state.selectedId || state.addonsPending) return;
  const requestId = ++addonSearchRequestSequence;
  const request = {
    serverId: state.selectedId,
    query: state.addonQuery,
    category: state.addonCategory,
    sort: state.addonSort,
  };
  state.addonHasSearched = true;
  state.addonSearching = true;
  state.addonResults = [];
  state.addonError = "";
  state.addonSearchStatus = "";
  render();
  try {
    const result = await window.minecraftAPI.searchAddons(request.serverId, request.query, {
      category: request.category,
      sort: request.sort,
    });
    if (requestId !== addonSearchRequestSequence) return;
    if (result?.searchContract !== 2) {
      throw new Error("BlockHost updated the add-on browser. Fully quit BlockHost from the tray, then open it again to activate category browsing.");
    }
    state.addonResults = result.results || [];
    state.addonSearchStatus = result.offlineMessage || "";
  } catch (error) {
    if (requestId !== addonSearchRequestSequence) return;
    state.addonError = error.message || "Could not search for add-ons";
  } finally {
    if (requestId !== addonSearchRequestSequence) return;
    state.addonSearching = false;
    render();
  }
}

async function runAddonAction(label, action) {
  if (state.addonsPending || !state.selectedId) return;
  state.addonsPending = label;
  state.addonError = "";
  clearNotice(false);
  render();
  let succeeded = false;
  try {
    const result = await action();
    if (result?.cancelled) return;
    if (result?.addons) state.addonsModel = result.addons;
    if (result?.runtime) state.runtime = result.runtime;
    state.addonRemoveId = null;
    const restartText = result?.restarted ? " The server restarted successfully." : "";
    const warningText = result?.warnings?.length ? ` ${result.warnings.join(" ")}` : "";
    showNotice(`${label} complete.${restartText}${warningText}`);
    succeeded = true;
  } catch (error) {
    state.addonError = error.message || `${label} failed`;
    await refreshLive().catch(() => {});
  } finally {
    state.addonsPending = "";
    render();
  }
  return succeeded;
}

async function checkAddonUpdatesNow() {
  if (state.addonsPending || !state.selectedId) return;
  state.addonsPending = "Checking updates";
  state.addonError = "";
  render();
  try {
    state.addonsModel = await window.minecraftAPI.checkAddonUpdates(state.selectedId);
    const count = state.addonsModel.items.filter((item) => item.update?.available).length;
    showNotice(count ? `${count} compatible update${count === 1 ? "" : "s"} available.` : "All managed add-ons are up to date.");
  } catch (error) {
    state.addonError = error.message || "Could not check for updates";
  } finally {
    state.addonsPending = "";
    render();
  }
}

function formatCompactNumber(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  return String(number);
}

async function exportSelectedServer(exportAs = false) {
  if (!state.selectedId || state.transferPending) return;
  state.transferPending = "export";
  state.transferProgress = { percent: 0, message: "Preparing the export…" };
  state.transferResult = null;
  state.error = "";
  render();
  try {
    const result = exportAs
      ? await window.minecraftAPI.exportServerAs(state.selectedId)
      : await window.minecraftAPI.exportServer(state.selectedId);
    if (result?.cancelled) return;
    state.transferResult = { kind: "export", ...result };
    await refreshLive();
  } catch (error) {
    state.transferResult = null;
    showError(error, () => exportSelectedServer(exportAs));
  } finally {
    state.transferPending = "";
    state.transferProgress = null;
    render();
  }
}

async function runImport(action, kind = "import") {
  if (state.transferPending) return;
  state.transferPending = kind;
  state.transferProgress = { percent: 0, message: kind === "external-import" ? "Choose a Minecraft server folder or ZIP…" : "Choose a BlockHost server archive…" };
  state.transferResult = null;
  state.error = "";
  render();
  try {
    const result = await action();
    if (result?.cancelled) return;
    await loadServers(result.server.id);
    state.transferResult = { kind: "import", ...result };
  } catch (error) {
    state.transferResult = null;
    showError(error, () => runImport(action, kind));
  } finally {
    state.transferPending = "";
    state.transferProgress = null;
    render();
  }
}

function importServerFromPicker() {
  return runImport(() => window.minecraftAPI.importServer());
}

function importExternalServerFromPicker() {
  return runImport(() => window.minecraftAPI.importExternalServer(), "external-import");
}

function importDroppedFile(file) {
  if (!file) return;
  if (file.name.toLowerCase().endsWith(".blockhost")) {
    return runImport(() => window.minecraftAPI.importDroppedServer(file));
  }
  return runImport(() => window.minecraftAPI.importDroppedExternalServer(file), "external-import");
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
      <button class="import-server" id="importServer" type="button" ${state.transferPending ? "disabled" : ""}>⇩ Import server</button>
      <button class="import-server subtle" id="importExternalServer" type="button" ${state.transferPending ? "disabled" : ""}>Import existing folder / ZIP</button>
      <div class="server-list" aria-label="Downloaded servers">
        ${buttons || '<p class="empty-sidebar">No servers downloaded yet.</p>'}
      </div>
      ${state.operations.length
        ? `<div class="operation-status"><span class="spinner"></span><div><strong>${escapeHtml(state.operations[0].feature || "Working")}</strong><small>${escapeHtml(state.operations[0].description || state.operations[0].label)}${state.operations[0].percent === null ? "" : ` · ${Math.round(state.operations[0].percent)}%`}</small></div></div>`
        : '<p class="sidebar-footnote">Local servers only</p>'}
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

function renderQuickProperties() {
  if (state.quickPropertiesLoading) {
    return `<section class="quick-settings"><div><p class="eyebrow">Common server settings</p><h2>Loading quick settings…</h2></div><span class="spinner"></span></section>`;
  }
  if (!state.quickPropertiesModel) {
    return `<section class="quick-settings"><div><p class="eyebrow">Common server settings</p><h2>Quick settings unavailable</h2><p>${escapeHtml(state.quickPropertiesError || "Open Properties from Server settings to edit the full file.")}</p></div></section>`;
  }
  const values = state.quickPropertiesModel.values || {};
  const hasSimulationDistance = state.quickPropertiesModel.schema?.some((item) => item.key === "simulation-distance");
  const numberControl = (key, label, min, max) => `
    <div class="quick-control quick-number-control">
      <span>${label}</span>
      <div class="quick-stepper">
        <button class="quick-step-zone quick-step-down" type="button" data-quick-adjust="${key}" data-delta="-1" aria-label="Decrease ${label}"><span aria-hidden="true">−</span></button>
        <input name="${key}" type="number" min="${min}" max="${max}" value="${escapeHtml(values[key])}" aria-label="${label}" readonly tabindex="-1" />
        <button class="quick-step-zone quick-step-up" type="button" data-quick-adjust="${key}" data-delta="1" aria-label="Increase ${label}"><span aria-hidden="true">+</span></button>
      </div>
    </div>`;
  const choiceControl = (key, label, options) => {
    const selected = String(values[key] || options[0]);
    const display = selected[0].toUpperCase() + selected.slice(1);
    return `
      <div class="quick-control quick-choice-control">
        <span>${label}</span>
        <input type="hidden" name="${key}" value="${escapeHtml(selected)}" />
        <details class="quick-choice">
          <summary><strong>${escapeHtml(display)}</strong><span>⌄</span></summary>
          <div>${options.map((item) => `<button type="button" class="${selected === item ? "selected" : ""}" data-quick-choice="${key}" data-value="${item}">${item[0].toUpperCase()}${item.slice(1)}${selected === item ? "<span>✓</span>" : ""}</button>`).join("")}</div>
        </details>
      </div>`;
  };
  return `
    <section class="quick-settings" aria-labelledby="quickSettingsTitle">
      <div class="quick-settings-heading">
        <div><p class="eyebrow">Server essentials</p><h2 id="quickSettingsTitle">Quick controls</h2><p>The settings players change most, without opening the full properties editor.</p></div>
        <button class="quick-save" type="submit" form="quickPropertiesForm" ${state.quickPropertiesPending ? "disabled" : ""}><span>✓</span>${state.quickPropertiesPending ? "Saving…" : "Save changes"}</button>
      </div>
      <form id="quickPropertiesForm">
        ${numberControl("view-distance", "Render distance", 2, 32)}
        ${hasSimulationDistance ? numberControl("simulation-distance", "Simulation distance", 2, 32) : ""}
        ${choiceControl("gamemode", "Game mode", ["survival", "creative", "adventure", "spectator"])}
        ${choiceControl("difficulty", "Difficulty", ["peaceful", "easy", "normal", "hard"])}
        ${numberControl("max-players", "Maximum players", 1, 1000)}
      </form>
      ${state.quickPropertiesError ? `<p class="form-error">${escapeHtml(state.quickPropertiesError)}</p>` : ""}
    </section>`;
}

function renderServer() {
  const server = selectedServer();
  const runtime = state.runtime || { status: "offline", logs: [] };
  const usage = runtimeUsage();
  const runs = runMetrics(runtime);
  return `
    <main class="content">
      <header class="server-header">
        <div>
          <p class="eyebrow">${escapeHtml(server.typeLabel)} · Minecraft ${escapeHtml(server.version)}</p>
          <h1>${escapeHtml(server.name)}</h1>
        </div>
        <div class="header-actions">
          <span id="runtimeStatus" class="status-badge status-${runtime.status || "offline"}">${statusLabel(runtime.status)}</span>
          <button class="addons-feature-button" id="openAddons" type="button"><span>◆</span> Add-ons</button>
          <button class="server-settings-button" id="openServerSettings" type="button" aria-label="Open server settings">•••</button>
          <button class="primary" id="startServer" type="button" ${runtime.status !== "offline" ? "hidden" : ""}>Start server</button>
          <button class="danger" id="stopServer" type="button" ${runtime.status === "offline" ? "hidden" : ""}>Stop server</button>
        </div>
      </header>

      <section class="metrics" aria-label="Server resource usage">
        <article><span>CPU usage</span><strong id="cpuValue">${(Number(usage?.cpuPercent) || 0).toFixed(1)}%</strong></article>
        <article><span>RAM usage</span><strong id="ramValue">${formatBytes(usage?.ramBytes || 0)}</strong></article>
        <article><span>Uptime</span><strong id="uptimeValue">${escapeHtml(runs.uptime)}</strong><small id="uptimeDetail">${escapeHtml(runs.uptimeDetail)}</small></article>
        <article><span>Last run</span><strong id="lastRunValue">${escapeHtml(runs.lastRun)}</strong><small id="lastRunDetail" title="${escapeHtml(runs.lastRunTitle)}">${escapeHtml(runs.lastRunDetail)}</small></article>
      </section>

      <section class="console-card">
        <div class="console-title"><div class="console-title-name"><span class="terminal-dot red"></span><span class="terminal-dot yellow"></span><span class="terminal-dot green"></span><strong>Server console</strong><span class="console-error-count" id="consoleErrorCount" ${consoleErrorCount() ? "" : "hidden"}>${consoleErrorCount() || ""}</span></div><div class="console-title-actions"><button id="copyVisibleConsole" type="button">${escapeHtml(consoleCopyLabel())}</button><button id="clearConsoleView" type="button">Clear view</button></div></div>
        <div class="console-toolbar">
          <div class="console-filters" role="group" aria-label="Console filters">${[["all", "All"], ["players", "Players"], ["warnings", "Warnings"], ["errors", "Errors"]].map(([value, label]) => `<button type="button" data-console-filter="${value}" class="${state.consoleFilter === value ? "active" : ""}">${label}</button>`).join("")}</div>
          <input id="consoleSearch" value="${escapeHtml(state.consoleSearch)}" placeholder="Search console…" aria-label="Search console output" />
          <label class="console-autoscroll"><input id="consoleAutoScroll" type="checkbox" ${state.consoleAutoScroll ? "checked" : ""} /> Auto-scroll</label>
        </div>
        <div class="console-output-wrap"><div id="consoleOutput" class="console-output" tabindex="0" role="log" aria-live="polite">${renderConsoleRows()}</div><button id="jumpConsoleLatest" type="button" hidden>Jump to latest ↓</button></div>
        ${renderCommandAssistant()}
        <form class="command-form" id="commandForm">
          <button class="command-library-button" id="openCommandAssistant" type="button">Commands</button>
          <span>&gt;</span>
          <input id="commandInput" name="command" autocomplete="off" placeholder="Enter any server command" ${runtime.status !== "running" ? "disabled" : ""} />
          <button id="sendCommand" type="submit" ${runtime.status !== "running" ? "disabled" : ""}>Send</button>
        </form>
      </section>
      ${renderQuickProperties()}
    </main>
  `;
}

function formatMemoryMb(value) {
  const amount = Number(value) || 0;
  return amount >= 1024 ? `${(amount / 1024).toFixed(amount % 1024 ? 1 : 0)} GB` : `${amount} MB`;
}

function renderServerSettingsModal() {
  if (!state.serverSettingsOpen) return "";
  const server = selectedServer();
  if (state.serverSettingsLoading) {
    return `<div class="overlay"><section class="modal server-settings-modal" role="dialog" aria-modal="true" aria-labelledby="serverSettingsTitle"><button class="modal-close" id="closeServerSettings" type="button" aria-label="Close">×</button><h2 id="serverSettingsTitle">Loading server settings…</h2><p>Preparing ${escapeHtml(server?.name || "server")} controls.</p></section></div>`;
  }
  const memory = state.memoryModel;
  const draft = state.memoryDraft || memory;
  const minimum = 512;
  const maximum = Math.max(1024, Number(memory?.limitMb) || 4096);
  const span = maximum - minimum;
  const minPercent = span ? ((Number(draft?.minMemoryMb) - minimum) / span) * 100 : 0;
  const maxPercent = span ? ((Number(draft?.maxMemoryMb) - minimum) / span) * 100 : 100;
  return `
    <div class="overlay">
      <section class="modal server-settings-modal" role="dialog" aria-modal="true" aria-labelledby="serverSettingsTitle">
        <button class="modal-close" id="closeServerSettings" type="button" aria-label="Close">×</button>
        <p class="eyebrow">${escapeHtml(server?.name || "Minecraft server")}</p>
        <h2 id="serverSettingsTitle">Server settings</h2>
        <p>Advanced controls, backups, and server-wide limits live here so the main dashboard stays focused.</p>

        <form id="serverIdentityForm" class="server-identity-settings">
          <div class="settings-section-heading"><div><strong>Server identity</strong><span>Change how this server appears in BlockHost.</span></div></div>
          <div class="identity-fields">
            <label>Server name<input name="serverName" maxlength="80" required value="${escapeHtml(server?.name || "")}" /></label>
            <label>Accent color<input name="color" type="color" value="${escapeHtml(server?.color || "#39c9ff")}" /></label>
            <button class="secondary" type="submit" ${state.identityPending ? "disabled" : ""}>${state.identityPending ? "Saving…" : "Save identity"}</button>
          </div>
          ${state.identityError ? `<p class="form-error">${escapeHtml(state.identityError)}</p>` : ""}
        </form>

        <div class="settings-action-grid">
          <article><div><strong>Full properties</strong><span>Edit every available server.properties option.</span></div><button class="secondary" id="openFullProperties" type="button">Properties</button></article>
          <article><div><strong>Export server</strong><span>Choose the folder and file name in the Windows save dialog.</span></div><div class="settings-inline-actions"><button class="primary" id="exportServer" type="button" ${state.transferPending ? "disabled" : ""}>Export</button><button class="secondary" id="exportServerAs" type="button" ${state.transferPending ? "disabled" : ""}>Export as…</button></div></article>
          <article><div><strong>Export world</strong><span>Save only the generated world as a portable ZIP archive.</span></div><button class="secondary" id="exportWorld" type="button" ${state.transferPending ? "disabled" : ""}>Export world</button></article>
        </div>

        <form id="memorySettingsForm" class="memory-settings">
          <div class="settings-section-heading"><div><strong>Java memory</strong><span>Set the minimum and maximum RAM available to this server.</span></div><span>${formatMemoryMb(memory?.systemMemoryMb)} installed</span></div>
          ${memory ? `
            <div class="memory-values"><output id="minMemoryOutput">Min ${formatMemoryMb(draft.minMemoryMb)}</output><output id="maxMemoryOutput">Max ${formatMemoryMb(draft.maxMemoryMb)}</output></div>
            <div class="dual-range" style="--range-start:${minPercent}%;--range-end:${maxPercent}%">
              <div class="range-track"></div><div class="range-selection"></div>
              <input id="minMemoryRange" name="minMemoryMb" aria-label="Minimum server RAM" type="range" min="${minimum}" max="${maximum}" step="256" value="${draft.minMemoryMb}" />
              <input id="maxMemoryRange" name="maxMemoryMb" aria-label="Maximum server RAM" type="range" min="${minimum}" max="${maximum}" step="256" value="${draft.maxMemoryMb}" />
            </div>
            <div class="memory-scale"><span>${formatMemoryMb(minimum)}</span><span>Safe limit ${formatMemoryMb(maximum)}</span></div>
            <p class="memory-note">Minimum RAM is reserved when Java starts. Maximum RAM is the ceiling. ${state.runtime?.status === "running" ? "Changes apply the next time the server starts." : "Changes apply on the next start."}</p>
            <button class="secondary" type="submit" ${state.memoryPending ? "disabled" : ""}>${state.memoryPending ? "Saving…" : "Save RAM limits"}</button>
          ` : `<p class="form-error">${escapeHtml(state.memoryError || "Memory settings are unavailable.")}</p>`}
          ${state.memoryError && memory ? `<p class="form-error">${escapeHtml(state.memoryError)}</p>` : ""}
        </form>

        <div class="danger-zone"><div><strong>Delete server</strong><span>Permanently remove this server and its world from this computer.</span></div><button class="danger-ghost" id="deleteServer" type="button">Delete server</button></div>
      </section>
    </div>`;
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
          <div class="world-import-picker">
            <div><strong>Existing world <span>Optional</span></strong><small id="worldImportStatus">${state.createWorldImport ? `${escapeHtml(state.createWorldImport.label)} (${escapeHtml(state.createWorldImport.kind)})` : "Start fresh, or choose a world folder or ZIP."}</small></div>
            <div><button class="secondary small" id="chooseWorldImport" type="button">Choose world</button><button class="subtle-action small" id="removeWorldImport" type="button" ${state.createWorldImport ? "" : "hidden"}>Remove</button></div>
          </div>
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

function renderPropertyField(property) {
  const draft = state.propertiesDraft?.values || {};
  const value = draft[property.key] ?? property.default ?? "";
  const description = property.description
    ? `<small class="field-help">${escapeHtml(property.description)}</small>`
    : "";

  if (property.type === "boolean") {
    return `
      <label class="property-toggle">
        <span><strong>${escapeHtml(property.label)}</strong>${description}</span>
        <input name="${escapeHtml(property.key)}" type="checkbox" ${value ? "checked" : ""} />
      </label>`;
  }

  if (property.type === "enum") {
    const options = property.options.map((option) =>
      `<option value="${escapeHtml(option)}" ${String(value) === option ? "selected" : ""}>${escapeHtml(option)}</option>`
    ).join("");
    return `
      <label>${escapeHtml(property.label)}
        <select name="${escapeHtml(property.key)}">${options}</select>
        ${description}
      </label>`;
  }

  const type = property.type === "integer" ? "number" : property.type === "password" ? "password" : "text";
  const limits = property.type === "integer"
    ? `min="${property.min}" max="${property.max}" step="1"`
    : property.maxLength ? `maxlength="${property.maxLength}"` : "";
  const autocomplete = property.type === "password" ? 'autocomplete="new-password"' : "";
  return `
    <label>${escapeHtml(property.label)}
      <input name="${escapeHtml(property.key)}" type="${type}" value="${escapeHtml(value)}" ${limits} ${autocomplete} />
      ${description}
    </label>`;
}

function renderPropertyGroups(properties) {
  const categories = [];
  for (const property of properties) {
    let category = categories.find((item) => item.name === property.category);
    if (!category) {
      category = { name: property.category, properties: [] };
      categories.push(category);
    }
    category.properties.push(property);
  }
  return categories.map((category) => `
    <section class="property-section">
      <h3>${escapeHtml(category.name)}</h3>
      <div class="property-grid">${category.properties.map(renderPropertyField).join("")}</div>
    </section>
  `).join("");
}

function renderPropertiesModal() {
  if (!state.propertiesOpen) return "";
  const server = selectedServer();
  if (state.propertiesLoading) {
    return `
      <div class="overlay"><section class="modal properties-modal" role="dialog" aria-modal="true" aria-labelledby="propertiesTitle">
        <button class="modal-close" id="closeProperties" type="button" aria-label="Close">×</button>
        <h2 id="propertiesTitle">Loading server properties…</h2>
        <p>Reading ${escapeHtml(server?.name || "server")} configuration.</p>
      </section></div>`;
  }

  if (!state.propertiesModel || !state.propertiesDraft) {
    return `
      <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="propertiesTitle">
        <h2 id="propertiesTitle">Properties unavailable</h2>
        <p class="form-error">${escapeHtml(state.propertiesError || "Could not load server properties")}</p>
        <div class="modal-actions">
          <button class="secondary" id="closeProperties" type="button">Close</button>
          <button class="primary" id="retryProperties" type="button">Retry</button>
        </div>
      </section></div>`;
  }

  const standard = state.propertiesModel.schema.filter((property) => !property.advanced);
  const advanced = state.propertiesModel.schema.filter((property) => property.advanced);
  const runtime = state.runtime || { status: "offline" };
  const running = runtime.status !== "offline";
  const pendingLabel = running ? "Saving and restarting…" : "Saving…";
  const rawMode = state.propertiesMode === "raw";
  const presetOptions = (state.propertiesModel.presets || []).map((preset) =>
    `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`
  ).join("");
  const editorContent = rawMode
    ? `<section class="property-section raw-properties-section">
        <div class="properties-warning"><strong>Expert editor</strong><span>Invalid known values are blocked, but unknown settings can still prevent the Minecraft server from starting. Restart recovery remains enabled.</span></div>
        <label>Complete server.properties file
          <textarea name="rawText" rows="24" spellcheck="false">${escapeHtml(state.propertiesDraft.rawText || "")}</textarea>
        </label>
      </section>`
    : `${renderPropertyGroups(standard)}
      <details class="advanced-properties">
        <summary>Advanced properties</summary>
        ${renderPropertyGroups(advanced)}
        <section class="property-section">
          <h3>Custom properties</h3>
          <label>Additional key/value settings
            <textarea name="customProperties" rows="7" spellcheck="false" placeholder="custom-setting=value">${escapeHtml(state.propertiesDraft.customProperties || "")}</textarea>
            <small class="field-help">Use one key=value setting per line. Unknown settings already in the file appear here.</small>
          </label>
        </section>
      </details>`;
  return `
    <div class="overlay">
      <section class="modal properties-modal" role="dialog" aria-modal="true" aria-labelledby="propertiesTitle">
        <button class="modal-close" id="closeProperties" type="button" aria-label="Close" ${state.propertiesPending ? "disabled" : ""}>×</button>
        <p class="eyebrow">${escapeHtml(server?.name || "Minecraft server")}</p>
        <h2 id="propertiesTitle">Server properties</h2>
        <p>Settings are matched to Minecraft ${escapeHtml(state.propertiesModel.minecraftVersion)} and validated before anything changes.</p>
        ${!state.propertiesModel.exists ? '<p class="properties-note">This server has not generated a properties file yet. BlockHost will create it safely when you save.</p>' : ""}
        <form id="propertiesForm">
          <div class="properties-tools">
            <label>Quick preset
              <select id="propertyPreset"><option value="">Choose a preset…</option>${presetOptions}</select>
            </label>
            <button class="secondary" id="toggleRawProperties" type="button">${rawMode ? "Use guided editor" : "Use raw editor"}</button>
          </div>
          ${state.propertyPresetSummary ? `<p class="properties-note">${escapeHtml(state.propertyPresetSummary)}</p>` : ""}
          ${editorContent}
          ${state.propertiesError ? `<p class="form-error">${escapeHtml(state.propertiesError)}</p>` : ""}
          ${running ? '<p class="properties-note">Most settings require a restart. “Save and restart” will stop the server safely and restore the old file automatically if startup fails.</p>' : ""}
          <div class="modal-actions sticky-actions">
            <button class="secondary" id="cancelProperties" type="button" ${state.propertiesPending ? "disabled" : ""}>Cancel</button>
            ${running ? `<button class="secondary" id="savePropertiesLater" type="button" ${state.propertiesPending ? "disabled" : ""}>Save for next restart</button>` : ""}
            <button class="primary" id="saveProperties" type="button" ${state.propertiesPending ? "disabled" : ""}>
              ${state.propertiesPending ? pendingLabel : running ? "Save and restart" : "Save properties"}
            </button>
          </div>
        </form>
      </section>
    </div>`;
}

function renderAddonIcon(item) {
  const fallback = escapeHtml((item.title || "?").slice(0, 1).toUpperCase());
  const iconUrl = String(item.iconUrl || "");
  return `<div class="addon-icon ${iconUrl ? "has-image" : ""}">${iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span>${fallback}</span>` : `<span>${fallback}</span>`}</div>`;
}

function renderInstalledAddon(item) {
  const pending = Boolean(state.addonsPending);
  const source = item.source === "modrinth" ? "Modrinth" : item.managed ? "Manual" : "Detected file";
  const update = item.update?.available
    ? `<button class="primary small" data-addon-action="update" data-addon-id="${escapeHtml(item.id)}" type="button" ${pending ? "disabled" : ""}>Update to ${escapeHtml(item.update.versionNumber || "latest")}</button>`
    : "";
  const cascadeCount = item.removalDependents?.length || 0;
  const confirmation = state.addonRemoveId === item.id
    ? `<div class="addon-remove-confirm"><span>${cascadeCount ? `Remove ${escapeHtml(item.title)} and ${cascadeCount} dependent add-on${cascadeCount === 1 ? "" : "s"}?` : `Remove ${escapeHtml(item.title)}?`}</span><button class="secondary small" data-addon-action="cancel-remove" type="button">Cancel</button><button class="danger small" data-addon-action="confirm-remove" data-addon-id="${escapeHtml(item.id)}" data-addon-cascade="${cascadeCount ? "true" : "false"}" type="button">${cascadeCount ? "Remove together" : "Remove"}</button></div>`
    : "";
  const dependencyStatus = item.missingDependencies?.length
    ? `<small class="addon-warning">Missing ${item.missingDependencies.length} required dependenc${item.missingDependencies.length === 1 ? "y" : "ies"}.</small>`
    : item.dependencies?.length ? `<small>${item.dependencies.length} required dependenc${item.dependencies.length === 1 ? "y" : "ies"} installed.</small>` : "";
  const warnings = (item.warnings || []).map((warning) => `<small class="addon-warning">${escapeHtml(warning)}</small>`).join("");
  const history = item.history?.length
    ? `<div class="addon-history"><select data-addon-history-for="${escapeHtml(item.id)}">${item.history.map((version) => `<option value="${escapeHtml(version.versionId || version.sha512)}">${escapeHtml(version.versionNumber || "Archived version")}</option>`).join("")}</select><button class="secondary small" data-addon-action="rollback" data-addon-id="${escapeHtml(item.id)}" type="button" ${pending ? "disabled" : ""}>Roll back</button></div>`
    : "";
  return `
    <article class="addon-card ${item.enabled ? "" : "disabled-addon"}">
      ${renderAddonIcon(item)}
      <div class="addon-copy">
        <div class="addon-heading"><strong>${escapeHtml(item.title)}</strong><span>${item.enabled ? "Enabled" : "Disabled"}</span></div>
        <p>${escapeHtml(item.versionNumber || "Unknown version")} · ${escapeHtml(item.loader || "unknown")} · Minecraft ${escapeHtml(item.minecraftVersion || "unverified")} · ${escapeHtml(source)}</p>
        <small>${escapeHtml(item.fileName)}</small>
        ${dependencyStatus}${warnings}${item.optionalDependencies?.length ? `<small>${item.optionalDependencies.length} optional dependenc${item.optionalDependencies.length === 1 ? "y suggestion" : "y suggestions"} available.</small>` : ""}
        ${history}
        ${item.update?.unavailable ? '<small>Update information is temporarily unavailable.</small>' : ""}
        ${confirmation}
      </div>
      <div class="addon-actions">
        ${update}
        <button class="secondary small" data-addon-action="toggle" data-addon-id="${escapeHtml(item.id)}" data-addon-enabled="${item.enabled ? "false" : "true"}" data-addon-cascade="${item.enabled && cascadeCount ? "true" : "false"}" type="button" ${pending ? "disabled" : ""}>${item.enabled && cascadeCount ? `Disable +${cascadeCount}` : item.enabled ? "Disable" : "Enable"}</button>
        <button class="danger-ghost small" data-addon-action="remove" data-addon-id="${escapeHtml(item.id)}" type="button" ${pending ? "disabled" : ""}>Remove</button>
      </div>
    </article>`;
}

function renderAddonSearchResult(result, recommendation = false) {
  const pending = Boolean(state.addonsPending);
  const installed = (state.addonsModel?.items || []).find((item) => item.projectId === result.projectId);
  const compatibility = recommendation && result.versionNumber
    ? `Verified ${result.versionNumber}`
    : `Minecraft ${selectedServer()?.version || "server"} · checked before install`;
  return `
    <article class="addon-card search-result ${recommendation ? "recommendation-card" : ""}">
      ${renderAddonIcon(result)}
      <div class="addon-copy">
        <div class="addon-heading"><strong>${escapeHtml(result.title)}</strong><span>${formatCompactNumber(result.downloads)} downloads</span></div>
        <p>${escapeHtml(result.description || "No description provided.")}</p>
        <small>By ${escapeHtml(result.author || "Unknown author")}</small>
        <small class="addon-compatibility">${escapeHtml(compatibility)}</small>
      </div>
      <div class="addon-actions">
        <button class="secondary small" data-addon-action="details" data-project-id="${escapeHtml(result.projectId)}" type="button">Details</button>
        ${installed
          ? `<button class="installed-addon small" type="button" disabled>${installed.enabled ? "Installed" : "Installed · disabled"}</button>`
          : `<button class="primary small" data-addon-action="install" data-project-id="${escapeHtml(result.projectId)}" data-version-id="${escapeHtml(result.versionId || "")}" data-project-title="${escapeHtml(result.title)}" data-icon-url="${escapeHtml(result.iconUrl || "")}" type="button" ${pending ? "disabled" : ""}>Install</button>`}
      </div>
    </article>`;
}

function renderAddonsModal() {
  if (!state.addonsOpen) return "";
  const server = selectedServer();
  if (state.addonsLoading) {
    return `<div class="overlay"><section class="modal addons-modal" role="dialog" aria-modal="true" aria-labelledby="addonsTitle"><button class="modal-close" id="closeAddons" type="button" aria-label="Close">×</button><h2 id="addonsTitle">Loading add-ons…</h2><p>Scanning ${escapeHtml(server?.name || "server")} files.</p></section></div>`;
  }
  if (!state.addonsModel) {
    return `
      <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="addonsTitle">
        <h2 id="addonsTitle">Add-ons unavailable</h2>
        <p class="form-error">${escapeHtml(state.addonError || "Could not load add-ons")}</p>
        <div class="modal-actions"><button class="secondary" id="closeAddons" type="button">Close</button><button class="primary" id="retryAddons" type="button">Retry</button></div>
      </section></div>`;
  }

  if (!state.addonsModel.supported) {
    return `
      <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="addonsTitle">
        <button class="modal-close" id="closeAddons" type="button" aria-label="Close">×</button>
        <p class="eyebrow">${escapeHtml(server?.name || "Vanilla server")}</p>
        <h2 id="addonsTitle">Add-ons are not available</h2>
        <p>Vanilla Minecraft does not load server mods or plugins. Create a Fabric, Forge, NeoForge, or Paper server to use managed add-ons.</p>
        <div class="modal-actions"><button class="primary" id="closeAddonsBottom" type="button">Close</button></div>
      </section></div>`;
  }

  const items = state.addonsModel.items || [];
  const kind = state.addonsModel.kind;
  const installedCounts = {
    all: items.length,
    enabled: items.filter((item) => item.enabled).length,
    disabled: items.filter((item) => !item.enabled).length,
    updates: items.filter((item) => item.update?.available).length,
  };
  const visibleItems = items.filter((item) => {
    if (state.addonInstalledFilter === "enabled") return item.enabled;
    if (state.addonInstalledFilter === "disabled") return !item.enabled;
    if (state.addonInstalledFilter === "updates") return item.update?.available;
    return true;
  });
  const categoryOptions = [
    ["all", "All"],
    ["performance", "Performance"],
    ["administration", "Administration"],
    ["world", "World"],
    ["social", "Social"],
    ["gameplay", "Gameplay"],
    ["libraries", "Libraries"],
  ];
  const resultText = state.addonSearching
    ? "Searching compatible releases…"
    : state.addonResults.length
      ? `${state.addonResults.length} compatible result${state.addonResults.length === 1 ? "" : "s"}`
      : state.addonHasSearched ? "No compatible results found for these filters." : `Browse ${kind} compatible with ${server.typeLabel} ${server.version}.`;
  return `
    <div class="overlay">
      <section class="modal addons-modal" role="dialog" aria-modal="true" aria-labelledby="addonsTitle">
        <button class="modal-close" id="closeAddons" type="button" aria-label="Close" ${state.addonsPending ? "disabled" : ""}>×</button>
        <p class="eyebrow">${escapeHtml(server?.name || "Minecraft server")} · ${escapeHtml(server?.typeLabel || "")}</p>
        <div class="addons-title-row">
          <div><h2 id="addonsTitle">Manage ${escapeHtml(kind)}</h2><p>Compatible releases and required dependencies are selected automatically.</p></div>
          <div class="addons-toolbar">
            <label class="release-channel">Updates
              <select id="addonReleaseChannel" ${state.addonsPending ? "disabled" : ""}>
                <option value="stable" ${state.addonsModel.releaseChannel === "stable" ? "selected" : ""}>Stable</option>
                <option value="beta" ${state.addonsModel.releaseChannel === "beta" ? "selected" : ""}>Stable + beta</option>
                <option value="alpha" ${state.addonsModel.releaseChannel === "alpha" ? "selected" : ""}>All channels</option>
              </select>
            </label>
            <button class="secondary" id="installManualAddon" type="button" ${state.addonsPending ? "disabled" : ""}>Install from file</button>
            <button class="secondary" id="checkAddonUpdates" type="button" ${state.addonsPending ? "disabled" : ""}>Check updates</button>
            <button class="primary" id="updateAllAddons" type="button" ${state.addonsPending || !items.some((item) => item.update?.available) ? "disabled" : ""}>Update all</button>
          </div>
        </div>

        <section class="addon-section">
          <div class="addon-section-title installed-title"><div><h3>Installed ${escapeHtml(kind)} <span>${items.length}</span></h3><p>Enable, disable, update, or roll back managed files.</p></div></div>
          <div class="addon-filter-row" role="group" aria-label="Filter installed add-ons">
            ${Object.entries(installedCounts).map(([filter, count]) => `<button class="addon-filter-chip ${state.addonInstalledFilter === filter ? "active" : ""}" data-installed-filter="${filter}" type="button">${filter === "all" ? "All" : filter[0].toUpperCase() + filter.slice(1)} <span>${count}</span></button>`).join("")}
          </div>
          <div class="addon-list">${visibleItems.length ? visibleItems.map(renderInstalledAddon).join("") : `<p class="addon-empty">${items.length ? `No ${escapeHtml(state.addonInstalledFilter)} ${escapeHtml(kind)} found.` : `No ${escapeHtml(kind)} are installed yet.`}</p>`}</div>
        </section>

        <section class="addon-section addon-recommendations-section">
          <div class="addon-section-title"><div><h3>Recommended ${escapeHtml(kind)}</h3><p>Popular, server-compatible choices for ${escapeHtml(server.typeLabel)} ${escapeHtml(server.version)}.</p></div><span>Scroll to explore →</span></div>
          ${state.addonRecommendationsLoading
            ? `<div class="recommendation-loading"><span class="spinner"></span><span>Finding compatible recommendations…</span></div>`
            : state.addonRecommendations.length
              ? `<div class="recommendation-scroller">${state.addonRecommendations.map((item) => renderAddonSearchResult(item, true)).join("")}</div>`
              : `<p class="addon-empty">${escapeHtml(state.addonRecommendationsError || "No recommendations are available for this exact server version yet.")}</p>`}
        </section>

        <section class="addon-section addon-search-section">
          <div class="addon-section-title"><div><h3>Explore compatible ${escapeHtml(kind)}</h3><p>Browse by purpose, or search for exactly what your server needs.</p></div></div>
          <div class="addon-category-chips" role="group" aria-label="Add-on category">
            ${categoryOptions.map(([value, label]) => `<button class="addon-filter-chip ${state.addonCategory === value ? "active" : ""}" data-addon-category="${value}" type="button" ${state.addonsPending ? "disabled" : ""}>${label}</button>`).join("")}
          </div>
          <form class="addon-search" id="addonSearchForm">
            <input name="query" value="${escapeHtml(state.addonQuery)}" maxlength="100" autocomplete="off" placeholder="Search by name or feature" />
            <select id="addonSort" aria-label="Sort add-ons" ${state.addonsPending ? "disabled" : ""}>
              <option value="relevance" ${state.addonSort === "relevance" ? "selected" : ""}>Most relevant</option>
              <option value="downloads" ${state.addonSort === "downloads" ? "selected" : ""}>Most downloaded</option>
              <option value="updated" ${state.addonSort === "updated" ? "selected" : ""}>Recently updated</option>
              <option value="newest" ${state.addonSort === "newest" ? "selected" : ""}>Newest</option>
            </select>
            <button class="primary" type="submit" ${state.addonsPending ? "disabled" : ""}>${state.addonSearching ? "Loading…" : state.addonQuery ? "Search" : "Browse"}</button>
          </form>
          <p class="addon-search-status">${escapeHtml(state.addonSearchStatus || resultText)}</p>
          <div class="addon-list">${state.addonResults.map((item) => renderAddonSearchResult(item)).join("")}</div>
        </section>

        ${state.addonError ? `<p class="form-error">${escapeHtml(state.addonError)}</p>` : ""}
        ${state.addonsPending ? `<div class="addon-progress"><span class="spinner"></span><strong>${escapeHtml(state.addonsPending)}…</strong><small>Files are staged and verified before the server is changed.</small></div>` : ""}
        <div class="modal-actions sticky-actions"><button class="primary" id="closeAddonsBottom" type="button" ${state.addonsPending ? "disabled" : ""}>Done</button></div>
      </section>
    </div>`;
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
  if (state.pendingStart.kind === "port-conflict") {
    const conflict = state.pendingStart.portConflict || {};
    return `
      <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="portConflictTitle">
        <h2 id="portConflictTitle">Server port is already in use</h2>
        <p>Port <strong>${escapeHtml(conflict.port || 25565)}</strong> on ${escapeHtml(conflict.host || "this computer")} is being used by another Minecraft server or application. Stop the other server, or choose a different port in Server properties.</p>
        <div class="modal-actions"><button class="secondary" id="cancelStart" type="button">Cancel</button><button class="secondary" id="openConflictProperties" type="button">Open properties</button><button class="primary" id="retryStart" type="button">Try again</button></div>
      </section></div>`;
  }
  return `
    <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="javaTitle">
      <h2 id="javaTitle">Java is required</h2>
      <p>Install 64-bit Java 25, then reopen BlockHost Manager.</p>
      <div class="modal-actions"><button class="secondary" id="cancelStart" type="button">Close</button><a class="primary link-button" href="${JAVA_URL}" target="_blank" rel="noreferrer">Get 64-bit Java 25</a></div>
    </section></div>`;
}

function renderJavaSetupModal() {
  const setup = state.javaSetup;
  if (!setup?.required) return "";
  const progress = setup.progress || {};
  const javaVersion = Number(setup.requiredVersion) >= 25 ? 25 : 21;
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  return `
    <div class="overlay"><section class="modal compact dependency-modal" role="dialog" aria-modal="true" aria-labelledby="javaSetupTitle">
      <p class="eyebrow">First-time setup</p>
      <h2 id="javaSetupTitle">Java ${javaVersion} is required</h2>
      ${setup.installing ? `
        <p>${escapeHtml(progress.message || "Preparing the Java runtime…")}</p>
        <div class="transfer-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>
        <p class="muted">Keep BlockHost open while setup finishes.</p>
      ` : `
        <p>BlockHost can download the official 64-bit Eclipse Temurin ${javaVersion} runtime automatically. It stays inside BlockHost, needs no administrator access, and does not change your system Java.</p>
        ${setup.error ? `<p class="inline-error">${escapeHtml(setup.error)}</p>` : ""}
        <div class="modal-actions"><button class="secondary" id="skipJavaSetup" type="button">Not now</button><button class="primary" id="installJava" type="button">Download and set up Java</button></div>
      `}
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

function renderTransferModal() {
  if (state.transferPending) {
    const progress = state.transferProgress || {};
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const title = state.transferPending === "world-export"
      ? "Exporting world"
      : state.transferPending === "export" ? "Exporting server" : "Importing server";
    return `
      <div class="overlay"><section class="modal compact transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transferTitle">
        <p class="eyebrow">Safe transfer</p>
        <h2 id="transferTitle">${title}</h2>
        <p>${escapeHtml(progress.message || "Working…")}</p>
        <div class="transfer-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>
        <small>${percent}% complete</small>
        <p class="transfer-note">Keep BlockHost open. The operation is staged and will clean itself up if anything fails.</p>
      </section></div>`;
  }
  if (!state.transferResult) return "";
  if (state.transferResult.kind === "export" || state.transferResult.kind === "world-export") {
    const worldOnly = state.transferResult.kind === "world-export";
    const warning = state.transferResult.restartError
      ? `<p class="form-error">The archive is safe, but the server could not restart automatically: ${escapeHtml(state.transferResult.restartError)}</p>`
      : "";
    return `
      <div class="overlay"><section class="modal compact transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transferTitle">
        <p class="eyebrow">Transfer complete</p>
        <h2 id="transferTitle">${worldOnly ? "World export complete" : "Export complete"}</h2>
        <p><strong>${escapeHtml(state.transferResult.fileName)}</strong> contains ${worldOnly ? "the server world" : "the complete server"} and was created successfully.</p>
        ${warning}
        <div class="modal-actions"><button class="secondary" id="closeTransfer" type="button">Done</button><button class="primary" id="openExportFolder" type="button">Open folder</button></div>
      </section></div>`;
  }
  return `
    <div class="overlay"><section class="modal compact transfer-modal" role="dialog" aria-modal="true" aria-labelledby="transferTitle">
      <p class="eyebrow">Transfer complete</p>
      <h2 id="transferTitle">Server imported</h2>
      <p><strong>${escapeHtml(state.transferResult.server?.name || "Imported server")}</strong> is ready and has been selected. Minecraft’s EULA will be confirmed on its first start.</p>
      <div class="modal-actions"><button class="primary" id="closeTransfer" type="button">Done</button></div>
    </section></div>`;
}

function renderDropOverlay() {
  if (!state.dragActive || state.transferPending) return "";
  if (state.addonsOpen && state.addonsModel?.supported) {
    return `<div class="drop-overlay" aria-hidden="true"><div><strong>Install this add-on</strong><span>Drop one compatible .jar file</span></div></div>`;
  }
  return `<div class="drop-overlay" aria-hidden="true"><div><strong>Import this server</strong><span>Drop a .blockhost archive, server ZIP, or folder</span></div></div>`;
}

function renderError() {
  if (!state.error) return "";
  const error = typeof state.error === "string"
    ? { title: "Action failed", message: state.error, outcome: "The operation stopped.", recommendation: "Review the message and try again." }
    : state.error;
  return `<div class="toast error-result" role="alert"><div><strong>${escapeHtml(error.title)}</strong><span>${escapeHtml(error.message)}</span><small>${escapeHtml(error.outcome)} ${escapeHtml(error.recommendation)}</small></div><div class="toast-actions">${state.errorRetry ? '<button class="secondary small" id="retryError" type="button">Retry</button>' : ""}<button id="dismissError" type="button" aria-label="Dismiss">×</button></div></div>`;
}

function renderNotice() {
  return state.notice
    ? `<div class="toast notice" role="status"><span>${escapeHtml(state.notice)}</span><button id="dismissNotice" type="button" aria-label="Dismiss">×</button></div>`
    : "";
}

function bindNoticeDismissal() {
  document.getElementById("dismissNotice")?.addEventListener("click", clearNotice);
}

function updateNoticeView() {
  const host = document.getElementById("notificationHost");
  if (!host) return;
  host.innerHTML = renderNotice();
  bindNoticeDismissal();
}

function captureScrollState() {
  const read = (selector) => {
    const element = document.querySelector(selector);
    return element ? { top: element.scrollTop, left: element.scrollLeft } : null;
  };
  return {
    content: read(".content"),
    sidebar: read(".server-list"),
    console: read("#consoleOutput"),
    modal: read(".modal"),
    recommendations: read(".recommendation-scroller"),
  };
}

function restoreScrollState(snapshot) {
  const restore = (selector, position) => {
    if (!position) return;
    const element = document.querySelector(selector);
    if (element) element.scrollTo(position.left, position.top);
  };
  restore(".content", snapshot.content);
  restore(".server-list", snapshot.sidebar);
  restore("#consoleOutput", snapshot.console);
  restore(".modal", snapshot.modal);
  restore(".recommendation-scroller", snapshot.recommendations);
}

function renderWindowTitlebar() {
  return `<header class="window-titlebar"><img src="${appIconUrl}" alt="" /><strong>BlockHost Manager</strong></header>`;
}

function render() {
  const scrollState = captureScrollState();
  root.innerHTML = `
    <div class="window-frame">${renderWindowTitlebar()}<div class="app-shell">${renderSidebar()}${selectedServer() ? renderServer() : renderEmpty()}</div></div>
    ${renderCreateModal()}${renderServerSettingsModal()}${renderPropertiesModal()}${renderAddonsModal()}${renderStartModal()}${renderJavaSetupModal()}${renderDeleteModal()}${renderTransferModal()}${renderDropOverlay()}${renderError()}<div id="notificationHost">${renderNotice()}</div>
  `;
  bindEvents();
  updateLiveElements();
  restoreScrollState(scrollState);
}

function bindEvents() {
  document.querySelectorAll("[data-server-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedId = Number(button.dataset.serverId);
      state.runtime = null;
      state.consoleClearedBeforeId = 0;
      state.commandAssistantOpen = false;
      state.selectedCommandId = "";
      state.quickPropertiesModel = null;
      render();
      await Promise.all([refreshLive(), loadQuickProperties()]);
      render();
    });
  });

  const openCreate = () => {
    state.createOpen = true;
    state.createWorldImport = null;
    state.versions = [];
    state.versionsError = "";
    render();
    loadVersions();
  };
  document.getElementById("openCreate")?.addEventListener("click", openCreate);
  document.getElementById("emptyCreate")?.addEventListener("click", openCreate);
  document.getElementById("importServer")?.addEventListener("click", importServerFromPicker);
  document.getElementById("importExternalServer")?.addEventListener("click", importExternalServerFromPicker);
  document.getElementById("closeCreate")?.addEventListener("click", () => {
    if (!state.createPending) {
      state.createOpen = false;
      state.createWorldImport = null;
      render();
    }
  });
  document.getElementById("serverType")?.addEventListener("change", (event) => {
    state.createType = event.target.value;
    loadVersions();
  });
  document.getElementById("createForm")?.addEventListener("submit", createServer);
  document.getElementById("chooseWorldImport")?.addEventListener("click", chooseCreateWorld);
  document.getElementById("removeWorldImport")?.addEventListener("click", () => {
    state.createWorldImport = null;
    const status = document.getElementById("worldImportStatus");
    if (status) status.textContent = "Start fresh, or choose a world folder or ZIP.";
    document.getElementById("removeWorldImport")?.setAttribute("hidden", "");
  });

  document.getElementById("startServer")?.addEventListener("click", () => startServer());
  document.getElementById("stopServer")?.addEventListener("click", stopServer);
  document.getElementById("commandForm")?.addEventListener("submit", submitCommand);
  document.querySelectorAll("[data-console-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.consoleFilter = button.dataset.consoleFilter;
      document.querySelectorAll("[data-console-filter]").forEach((item) => item.classList.toggle("active", item === button));
      const copyButton = document.getElementById("copyVisibleConsole");
      if (copyButton) copyButton.textContent = consoleCopyLabel();
      syncConsoleOutput();
    });
  });
  document.getElementById("consoleSearch")?.addEventListener("input", (event) => {
    state.consoleSearch = event.target.value;
    syncConsoleOutput();
  });
  document.getElementById("consoleAutoScroll")?.addEventListener("change", (event) => {
    state.consoleAutoScroll = event.target.checked;
    if (state.consoleAutoScroll) {
      const output = document.getElementById("consoleOutput");
      output?.scrollTo({ top: output.scrollHeight });
    }
  });
  document.getElementById("consoleOutput")?.addEventListener("scroll", (event) => {
    const output = event.currentTarget;
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 48;
    const latest = document.getElementById("jumpConsoleLatest");
    if (latest) latest.hidden = atBottom;
  });
  document.getElementById("consoleOutput")?.addEventListener("wheel", (event) => {
    if (event.deltaY >= 0 || !state.consoleAutoScroll) return;
    state.consoleAutoScroll = false;
    const toggle = document.getElementById("consoleAutoScroll");
    if (toggle) toggle.checked = false;
  }, { passive: true });
  document.getElementById("jumpConsoleLatest")?.addEventListener("click", () => {
    const output = document.getElementById("consoleOutput");
    if (output) output.scrollTop = output.scrollHeight;
    state.consoleAutoScroll = true;
    const toggle = document.getElementById("consoleAutoScroll");
    if (toggle) toggle.checked = true;
  });
  document.getElementById("copyVisibleConsole")?.addEventListener("click", () => {
    const text = visibleConsoleEntries().map((entry) => entry.raw).join("\n");
    if (!text) {
      showNotice("There is no output in the current console view.");
      return;
    }
    const viewName = state.consoleFilter === "all" ? "All console output" : `${consoleCopyLabel().replace("Copy ", "")} view`;
    writeClipboard(text, `${viewName} copied.`);
  });
  document.getElementById("clearConsoleView")?.addEventListener("click", () => {
    state.consoleClearedBeforeId = Math.max(0, ...consoleEntries().map((entry) => Number(entry.id) || 0));
    syncConsoleOutput();
    showNotice("Console view cleared. Minecraft log files were not deleted.");
  });
  document.getElementById("consoleOutput")?.addEventListener("click", (event) => {
    const copyError = event.target.closest("[data-copy-error]");
    const copyDiagnostics = event.target.closest("[data-copy-diagnostics]");
    const groupId = copyError?.dataset.copyError || copyDiagnostics?.dataset.copyDiagnostics;
    if (!groupId) return;
    const entries = errorGroupEntries(groupId);
    if (copyDiagnostics) writeClipboard(diagnosticText(entries), "Diagnostic details copied for support or AI help.");
    else writeClipboard(entries.map((entry) => entry.raw).join("\n"), "Complete error copied.");
  });
  document.getElementById("openCommandAssistant")?.addEventListener("click", () => {
    state.commandAssistantOpen = !state.commandAssistantOpen;
    state.selectedCommandId = "";
    state.commandError = "";
    state.commandConfirming = false;
    render();
    document.getElementById("commandSearch")?.focus();
  });
  document.getElementById("closeCommandAssistant")?.addEventListener("click", () => {
    state.commandAssistantOpen = false;
    state.selectedCommandId = "";
    state.commandConfirming = false;
    render();
  });
  document.getElementById("commandSearch")?.addEventListener("input", (event) => {
    state.commandSearch = event.target.value;
    const position = event.target.selectionStart;
    render();
    const search = document.getElementById("commandSearch");
    search?.focus();
    search?.setSelectionRange(position, position);
  });
  document.getElementById("commandSearch")?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      document.querySelector("[data-command-id]")?.focus();
    } else if (event.key === "Escape") {
      state.commandAssistantOpen = false;
      render();
      document.getElementById("commandInput")?.focus();
    }
  });
  document.querySelectorAll("[data-command-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const definition = commandDefinition(button.dataset.commandId);
      state.selectedCommandId = definition?.id || "";
      state.commandValues = Object.fromEntries((definition?.fields || []).map((field) => [field.name, field.default || ""]));
      state.commandError = "";
      state.commandConfirming = false;
      render();
      document.querySelector("[data-command-field]")?.focus();
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Escape") {
        document.getElementById("commandSearch")?.focus();
        return;
      }
      const buttons = [...document.querySelectorAll("[data-command-id]")];
      const index = buttons.indexOf(button);
      const next = event.key === "ArrowDown" ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
      buttons[next]?.focus();
    });
  });
  document.querySelectorAll("[data-command-field]").forEach((field) => {
    field.addEventListener("input", () => {
      state.commandValues[field.dataset.commandField] = field.value;
      state.commandError = "";
      state.commandConfirming = false;
      const preview = document.querySelector(".command-preview code");
      if (preview) preview.textContent = currentCommandPreview();
      document.querySelector(".command-warning")?.remove();
      const run = document.getElementById("runGuidedCommand");
      if (run && selectedCommand()?.danger) run.textContent = "Review command";
    });
  });
  document.getElementById("backToCommands")?.addEventListener("click", () => {
    state.selectedCommandId = "";
    state.commandValues = {};
    state.commandError = "";
    state.commandConfirming = false;
    render();
    document.getElementById("commandSearch")?.focus();
  });
  document.getElementById("runGuidedCommand")?.addEventListener("click", async () => {
    const definition = selectedCommand();
    if (!definition) return;
    let command;
    try {
      command = buildCommand(definition.id, state.commandValues);
    } catch (error) {
      state.commandError = error.message;
      render();
      return;
    }
    if (definition.danger && !state.commandConfirming) {
      state.commandConfirming = true;
      render();
      return;
    }
    state.commandAssistantOpen = false;
    state.selectedCommandId = "";
    state.commandConfirming = false;
    render();
    await runConsoleCommand(command);
  });
  document.getElementById("commandInput")?.addEventListener("keydown", (event) => {
    if (!state.commandHistory.length || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "ArrowUp") state.commandHistoryIndex = Math.min(state.commandHistory.length - 1, state.commandHistoryIndex + 1);
    else state.commandHistoryIndex = Math.max(-1, state.commandHistoryIndex - 1);
    event.currentTarget.value = state.commandHistoryIndex < 0 ? "" : state.commandHistory[state.commandHistoryIndex];
  });
  document.getElementById("quickPropertiesForm")?.addEventListener("submit", saveQuickProperties);
  document.querySelectorAll("[data-quick-adjust]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.querySelector(`#quickPropertiesForm [name="${CSS.escape(button.dataset.quickAdjust)}"]`);
      if (!input) return;
      const next = Number(input.value) + Number(button.dataset.delta || 0);
      input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), next)));
    });
  });
  document.querySelectorAll("[data-quick-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.dataset.quickChoice;
      const value = button.dataset.value;
      const input = document.querySelector(`#quickPropertiesForm [name="${CSS.escape(field)}"]`);
      const details = button.closest("details");
      if (input) input.value = value;
      details?.querySelectorAll("[data-quick-choice]").forEach((option) => option.classList.toggle("selected", option === button));
      const label = details?.querySelector("summary strong");
      if (label) label.textContent = `${value[0].toUpperCase()}${value.slice(1)}`;
      if (details) details.open = false;
    });
  });
  document.getElementById("openAddons")?.addEventListener("click", openAddons);
  document.getElementById("openServerSettings")?.addEventListener("click", openServerSettings);
  document.getElementById("closeServerSettings")?.addEventListener("click", () => {
    if (state.memoryPending) return;
    state.serverSettingsOpen = false;
    render();
  });
  document.getElementById("openFullProperties")?.addEventListener("click", () => {
    state.serverSettingsOpen = false;
    render();
    openProperties();
  });
  const exportFromSettings = () => {
    state.serverSettingsOpen = false;
    render();
    exportSelectedServer(true);
  };
  document.getElementById("exportServer")?.addEventListener("click", exportFromSettings);
  document.getElementById("exportServerAs")?.addEventListener("click", exportFromSettings);
  document.getElementById("exportWorld")?.addEventListener("click", exportSelectedWorld);
  document.getElementById("serverIdentityForm")?.addEventListener("submit", saveServerIdentity);
  document.getElementById("deleteServer")?.addEventListener("click", () => {
    state.serverSettingsOpen = false;
    state.deleteId = state.selectedId;
    render();
  });
  document.getElementById("memorySettingsForm")?.addEventListener("submit", saveMemorySettings);
  const minMemoryRange = document.getElementById("minMemoryRange");
  const maxMemoryRange = document.getElementById("maxMemoryRange");
  const syncMemoryRange = (changed) => {
    if (!minMemoryRange || !maxMemoryRange) return;
    const step = Number(minMemoryRange.step) || 256;
    let minValue = Number(minMemoryRange.value);
    let maxValue = Number(maxMemoryRange.value);
    if (minValue > maxValue) {
      if (changed === "min") maxValue = Math.min(Number(maxMemoryRange.max), minValue + step);
      else minValue = Math.max(Number(minMemoryRange.min), maxValue - step);
      minMemoryRange.value = String(minValue);
      maxMemoryRange.value = String(maxValue);
    }
    state.memoryDraft = { minMemoryMb: minValue, maxMemoryMb: maxValue };
    const range = document.querySelector(".dual-range");
    const span = Number(minMemoryRange.max) - Number(minMemoryRange.min);
    if (range && span) {
      range.style.setProperty("--range-start", `${((minValue - Number(minMemoryRange.min)) / span) * 100}%`);
      range.style.setProperty("--range-end", `${((maxValue - Number(minMemoryRange.min)) / span) * 100}%`);
    }
    const minOutput = document.getElementById("minMemoryOutput");
    const maxOutput = document.getElementById("maxMemoryOutput");
    if (minOutput) minOutput.textContent = `Min ${formatMemoryMb(minValue)}`;
    if (maxOutput) maxOutput.textContent = `Max ${formatMemoryMb(maxValue)}`;
  };
  minMemoryRange?.addEventListener("input", () => syncMemoryRange("min"));
  maxMemoryRange?.addEventListener("input", () => syncMemoryRange("max"));
  document.querySelectorAll(".overlay").forEach((overlay) => {
    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay || state.transferPending) return;
      const closeControl = overlay.querySelector(".modal-close:not(:disabled), #cancelProperties:not(:disabled), #closeProperties:not(:disabled), #closeAddons:not(:disabled), #closeAddonsBottom:not(:disabled), #cancelStart:not(:disabled), #skipJavaSetup:not(:disabled), #cancelDelete:not(:disabled), #closeTransfer:not(:disabled)");
      if (closeControl) {
        closeControl.click();
        return;
      }
      if (state.serverSettingsOpen && !state.memoryPending) state.serverSettingsOpen = false;
      else if (state.propertiesOpen && !state.propertiesPending) state.propertiesOpen = false;
      else if (state.addonsOpen && !state.addonsPending) state.addonsOpen = false;
      else return;
      render();
    });
  });
  document.querySelectorAll(".addon-icon img").forEach((image) => {
    image.addEventListener("error", () => image.parentElement?.classList.add("image-failed"), { once: true });
  });

  document.getElementById("cancelStart")?.addEventListener("click", () => {
    state.pendingStart = null;
    render();
  });
  document.getElementById("retryStart")?.addEventListener("click", () => {
    state.pendingStart = null;
    render();
    startServer();
  });
  document.getElementById("openConflictProperties")?.addEventListener("click", () => {
    state.pendingStart = null;
    render();
    openProperties();
  });
  document.getElementById("skipJavaSetup")?.addEventListener("click", () => {
    state.javaSetup = null;
    render();
  });
  document.getElementById("installJava")?.addEventListener("click", async () => {
    const requestedJavaVersion = state.javaSetup?.requiredVersion || 25;
    state.javaSetup = { ...state.javaSetup, installing: true, error: "" };
    render();
    try {
      const status = await window.minecraftAPI.installJava(requestedJavaVersion);
      if (!status?.ready) throw new Error(status?.reason || "Java setup did not complete");
      if (state.javaSetup) {
        state.javaSetup = null;
        showNotice(`Java ${status.requiredVersion || requestedJavaVersion} is ready. BlockHost can now run servers.`);
      }
    } catch (error) {
      if (!state.javaSetup) return;
      state.javaSetup = { required: true, requiredVersion: requestedJavaVersion, installing: false, progress: null, error: error.message || "Java setup failed" };
      render();
    }
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
  document.getElementById("closeTransfer")?.addEventListener("click", () => {
    state.transferResult = null;
    render();
  });
  document.getElementById("openExportFolder")?.addEventListener("click", async () => {
    try {
      await window.minecraftAPI.openExportFolder(state.transferResult?.path);
      state.transferResult = null;
      render();
    } catch (error) {
      showError(error);
    }
  });
  const closeProperties = () => {
    if (state.propertiesPending) return;
    state.propertiesOpen = false;
    state.propertiesModel = null;
    state.propertiesDraft = null;
    state.propertiesError = "";
    state.propertiesMode = "form";
    state.propertyPresetSummary = "";
    render();
  };
  document.getElementById("closeProperties")?.addEventListener("click", closeProperties);
  document.getElementById("cancelProperties")?.addEventListener("click", closeProperties);
  document.getElementById("retryProperties")?.addEventListener("click", openProperties);
  document.getElementById("toggleRawProperties")?.addEventListener("click", () => {
    const form = document.getElementById("propertiesForm");
    if (form) state.propertiesDraft = propertyDraftFromForm(form);
    state.propertiesMode = state.propertiesMode === "raw" ? "form" : "raw";
    state.propertyPresetSummary = "";
    render();
  });
  document.getElementById("propertyPreset")?.addEventListener("change", (event) => {
    const preset = state.propertiesModel?.presets?.find((item) => item.id === event.target.value);
    if (!preset) return;
    const form = document.getElementById("propertiesForm");
    if (form) state.propertiesDraft = propertyDraftFromForm(form);
    const changed = [];
    for (const [key, value] of Object.entries(preset.values || {})) {
      if (state.propertiesDraft.values[key] !== value) changed.push(key);
      state.propertiesDraft.values[key] = value;
    }
    state.propertiesMode = "form";
    state.propertyPresetSummary = changed.length
      ? `${preset.name} preview: ${changed.length} setting${changed.length === 1 ? "" : "s"} changed. Review them below, then save to apply.`
      : `${preset.name} already matches the current settings.`;
    render();
  });
  document.getElementById("propertiesForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveProperties((state.runtime?.status || "offline") !== "offline");
  });
  document.getElementById("saveProperties")?.addEventListener("click", () =>
    saveProperties((state.runtime?.status || "offline") !== "offline")
  );
  document.getElementById("savePropertiesLater")?.addEventListener("click", () => saveProperties(false));
  const closeAddons = () => {
    if (state.addonsPending) return;
    addonSearchRequestSequence += 1;
    state.addonsOpen = false;
    state.addonsModel = null;
    state.addonResults = [];
    state.addonHasSearched = false;
    state.addonSearching = false;
    state.addonError = "";
    state.addonSearchStatus = "";
    state.addonRemoveId = null;
    state.addonRecommendations = [];
    state.addonRecommendationsError = "";
    render();
  };
  document.getElementById("closeAddons")?.addEventListener("click", closeAddons);
  document.getElementById("closeAddonsBottom")?.addEventListener("click", closeAddons);
  document.getElementById("retryAddons")?.addEventListener("click", openAddons);
  document.getElementById("addonSearchForm")?.addEventListener("submit", searchAddons);
  document.getElementById("addonSort")?.addEventListener("change", async (event) => {
    state.addonSort = event.target.value;
    await performAddonSearch();
  });
  document.querySelectorAll("[data-addon-category]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.addonCategory = button.dataset.addonCategory;
      await performAddonSearch();
    });
  });
  document.querySelectorAll("[data-installed-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.addonInstalledFilter = button.dataset.installedFilter;
      render();
    });
  });
  document.getElementById("installManualAddon")?.addEventListener("click", () =>
    runAddonAction("Manual installation", () => window.minecraftAPI.installManualAddon(state.selectedId))
  );
  document.getElementById("checkAddonUpdates")?.addEventListener("click", checkAddonUpdatesNow);
  document.getElementById("updateAllAddons")?.addEventListener("click", () =>
    runAddonAction("Update all", () => window.minecraftAPI.updateAllAddons(state.selectedId))
  );
  document.getElementById("addonReleaseChannel")?.addEventListener("change", async (event) => {
    const succeeded = await runAddonAction("Release channel update", () =>
      window.minecraftAPI.setAddonReleaseChannel(state.selectedId, event.target.value)
    );
    if (succeeded && state.addonsOpen) await openAddons();
  });
  document.querySelectorAll("[data-addon-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.addonAction;
      const addonId = button.dataset.addonId;
      if (action === "details") {
        window.minecraftAPI.openAddonProject(button.dataset.projectId).catch((error) => {
          state.addonError = error.message || "Could not open the project page";
          render();
        });
      } else if (action === "install") {
        runAddonAction("Installation", () => window.minecraftAPI.installAddon(state.selectedId, {
          projectId: button.dataset.projectId,
          versionId: button.dataset.versionId,
          title: button.dataset.projectTitle,
          iconUrl: button.dataset.iconUrl,
        }));
      } else if (action === "toggle") {
        const enabled = button.dataset.addonEnabled === "true";
        runAddonAction(enabled ? "Enable" : "Disable", () =>
          window.minecraftAPI.setAddonEnabled(state.selectedId, addonId, enabled, button.dataset.addonCascade === "true")
        );
      } else if (action === "remove") {
        state.addonRemoveId = addonId;
        render();
      } else if (action === "cancel-remove") {
        state.addonRemoveId = null;
        render();
      } else if (action === "confirm-remove") {
        runAddonAction("Removal", () => window.minecraftAPI.removeAddon(state.selectedId, addonId, button.dataset.addonCascade === "true"));
      } else if (action === "update") {
        runAddonAction("Update", () => window.minecraftAPI.updateAddon(state.selectedId, addonId));
      } else if (action === "rollback") {
        const select = document.querySelector(`[data-addon-history-for="${CSS.escape(addonId)}"]`);
        runAddonAction("Rollback", () => window.minecraftAPI.rollbackAddon(state.selectedId, addonId, select?.value));
      }
    });
  });
  document.getElementById("dismissError")?.addEventListener("click", () => {
    state.error = "";
    state.errorRetry = null;
    render();
  });
  document.getElementById("retryError")?.addEventListener("click", () => {
    const retry = state.errorRetry;
    state.error = "";
    state.errorRetry = null;
    render();
    retry?.();
  });
  bindNoticeDismissal();
}

let liveRefreshPending = false;
let dragDepth = 0;

async function refreshLiveSafely() {
  if (liveRefreshPending || document.hidden) return;
  liveRefreshPending = true;
  try {
    await refreshLive();
  } finally {
    liveRefreshPending = false;
  }
}

window.minecraftAPI.onTransferProgress((progress) => {
  if (!state.transferPending || progress?.kind !== state.transferPending) return;
  state.transferProgress = {
    stage: String(progress.stage || ""),
    percent: Number(progress.percent) || 0,
    message: String(progress.message || "Working…"),
  };
  render();
});

window.minecraftAPI.onOperationsChanged((operations) => {
  state.operations = Array.isArray(operations) ? operations : [];
  render();
});

window.minecraftAPI.onConsoleEntry((payload) => {
  if (!payload?.entry || Number(payload.serverId) !== Number(state.selectedId) || !state.runtime) return;
  const logs = state.runtime.logs || (state.runtime.logs = []);
  if (!logs.some((entry) => Number(entry?.id) === Number(payload.entry.id))) logs.push(payload.entry);
  if (logs.length > 2000) logs.splice(0, logs.length - 2000);
  const players = new Set(state.runtime.onlinePlayers || []);
  if (payload.entry.event === "player-join" && payload.entry.playerName) players.add(payload.entry.playerName);
  if (payload.entry.event === "player-leave" && payload.entry.playerName) players.delete(payload.entry.playerName);
  state.runtime.onlinePlayers = [...players].sort((a, b) => a.localeCompare(b));
  syncConsoleOutput();
});

window.minecraftAPI.onDependencyProgress((progress) => {
  if (!state.javaSetup?.installing) return;
  if (progress?.stage === "complete" && Number(progress.percent) >= 100) {
    const completedVersion = state.javaSetup.requiredVersion || 25;
    state.javaSetup = null;
    showNotice(`Java ${completedVersion} is ready. BlockHost can now run servers.`);
    return;
  }
  state.javaSetup.progress = progress;
  render();
});

window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files") || state.transferPending) return;
  event.preventDefault();
  dragDepth += 1;
  if (!state.dragActive) {
    state.dragActive = true;
    render();
  }
});
window.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
});
window.addEventListener("dragleave", (event) => {
  if (!state.dragActive) return;
  dragDepth = event.relatedTarget ? Math.max(0, dragDepth - 1) : 0;
  if (!dragDepth && state.dragActive) {
    state.dragActive = false;
    render();
  }
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  state.dragActive = false;
  render();
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length !== 1) {
    showError(new Error(state.addonsOpen ? "Drop one JAR add-on at a time." : "Drop one .blockhost archive at a time."));
    return;
  }
  if (state.addonsOpen && state.addonsModel?.supported) {
    if (!files[0].name.toLowerCase().endsWith(".jar")) {
      showError(new Error("Drop a .jar add-on file here."));
      return;
    }
    runAddonAction("Manual installation", () => window.minecraftAPI.installDroppedAddon(state.selectedId, files[0]));
    return;
  }
  importDroppedFile(files[0]);
});

window.addEventListener("wheel", (event) => {
  const eventElement = event.target instanceof Element ? event.target : null;
  const pointedElement = eventElement || document.elementFromPoint(event.clientX, event.clientY);
  const section = pointedElement?.closest?.(".addon-recommendations-section");
  const scroller = section?.querySelector(".recommendation-scroller");
  if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;

  const rawDelta = event.deltaY || event.deltaX;
  if (!rawDelta) return;
  const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 18
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientWidth : 1;
  event.preventDefault();
  event.stopPropagation();
  scroller.scrollBy({ left: rawDelta * modeScale, behavior: "auto" });
}, { capture: true, passive: false });

render();
Promise.all([
  loadServers(),
  window.minecraftAPI.getActiveOperations().then((operations) => { state.operations = operations; }),
  window.minecraftAPI.getJavaStatus().then((status) => {
    if (!status?.ready) state.javaSetup = { required: true, requiredVersion: status?.requiredVersion || 25, installing: false, progress: null, error: "", reason: status?.reason || "Java 25 is required" };
  }),
]).then(render).catch(showError);
setInterval(refreshLiveSafely, 2000);
