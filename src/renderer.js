import "./index.css";
import "./app-themes.css";
import { appThemes, normalizeAppTheme, normalizeServerIcon } from "./lib/app-themes.mjs";
import { consoleFilterOptions, defaultAppOptions, desktopOptions, quickControlOptions, serverTypeOptions } from "./lib/app-settings-options.mjs";
import { themeArtwork } from "./lib/theme-artwork.mjs";
import { normalizeRawCommand } from "./lib/command-catalog.mjs";
import { completeCommand } from "./lib/command-completion.mjs";
import { parseConsoleLine, updateOnlinePlayers } from "./lib/console-log.mjs";
import { createConsoleViewCache } from "./lib/console-view.mjs";
import { addonSide, clientModList } from "./lib/addon-sides.mjs";
import { diagnosticLinks } from "./lib/diagnostic-links.mjs";
import { createServerPageMotion } from "./lib/server-page-motion.mjs";

const root = document.getElementById("app");
const scene = document.getElementById("scene");
const serverPages = document.getElementById("serverPages");
const windowTitlebar = document.getElementById("windowTitlebar");
const appOverlays = document.getElementById("appOverlays");
const appSettingsDialog = document.getElementById("appSettingsDialog");
const WORLD_IMPORT_HINT = "Start fresh, or choose a world folder or ZIP.";
const WORLD_IMPORT_SEED_HINT = "Clear the world seed to choose an existing world.";
const ACCENT_PRESETS = [
  ["Ice", "#39c9ff"], ["Blue", "#5b82ff"], ["Indigo", "#7459f5"], ["Orchid", "#b172fa"],
  ["Pink", "#f275b5"], ["Coral", "#fb7185"], ["Tangerine", "#fb9555"], ["Gold", "#f4c95e"],
  ["Lime", "#a3da63"], ["Mint", "#57dca4"], ["Teal", "#31c6ba"], ["Silver", "#b6c6dd"],
];
const NOTICE_DURATION_MS = 4500;
let noticeTimer = null;
let memorySaveTimer = null;
let addonSearchRequestSequence = 0;
let addonLoadRequest = 0;
let liveRefreshSequence = 0;
let checkingDrop = false;
let versionRequest = 0;
let packRequest = 0;
let folderSize = null;
let libraryScrollTop = 0;
let serverPageMotion = null;
const pendingFolderSizes = new Set();
const legacyConsoleTimes = new Map();
const consoleView = createConsoleViewCache(normalizedConsoleEntry, buildConsoleRow);
const consoleOutputMarkup = new WeakMap();
let consoleFrame = null;
const consoleDayFormat = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" });
const consoleTimeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const consoleTitleFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

const state = {
  servers: [],
  selectedId: null,
  serverView: "overview",
  serversLoading: true,
  appSettings: null,
  runtime: null,
  startupDiagnostics: "",
  usage: null,
  operations: [],
  createPack: null,
  packBrowserOpen: false,
  packBusy: false,
  packQuery: "",
  packResults: [],
  packTotal: 0,
  packHasMore: false,
  packOffset: 0,
  packError: "",
  packProject: null,
  packVersions: [],
  packVersion: "",
  packIncludeOptional: false,
  packEulaAccepted: false,
  packProgress: "",
  addonTab: "installed",
  installedAddonTab: "files",
  installedAddonSearch: { files: "", pack: "" },
  createOpen: false,
  createAdvancedOpen: false,
  createPending: false,
  createPackError: "",
  createType: "vanilla",
  createDraft: { name: "", color: "#39c9ff", seed: "" },
  createWorldImport: null,
  versions: [],
  versionsLoading: false,
  versionsError: "",
  pendingAction: "",
  cancelPackCheckPending: false,
  pendingStart: null,
  serverJava: null,
  javaSettingsPending: false,
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
  quickPropertiesDirty: false,
  quickRestartNotice: false,
  settingsServerId: null,
  serverSettingsLoading: false,
  memoryModel: null,
  memoryDraft: null,
  memoryPending: false,
  memoryError: "",
  identityPending: false,
  identityError: "",
  identityIcon: "",
  backupModel: null,
  backupDraft: null,
  backupPending: false,
  backupError: "",
  addonsServerId: null,
  droppedAddon: null,
  addonsLoading: false,
  addonsInspecting: false,
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
  commandDraft: "",
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

function modpackSetup(server = selectedServer(), runtime = state.runtime) {
  if (runtime?.serverId === server?.id && runtime?.modpackSetup) return runtime.modpackSetup;
  return server?.modpackSetup;
}

function serverRuntimeBadge(runtime, server) {
  if (server?.modpack && runtime.status === "running") return { status: "running", label: "Ready to join" };
  if (server?.modpack && runtime.checkingModpack && runtime.status === "starting") return { status: "starting", label: "Checking pack" };
  if (modpackSetup(server, runtime)?.status === "repair" && !runtimeCanStop(runtime)) {
    return { status: "startup-failed", label: "Needs repair" };
  }
  return { status: runtime.status || "offline", label: statusLabel(runtime.status) };
}

function libraryServerLabel(server) {
  if (modpackSetup(server)?.status === "repair") return "Needs repair";
  return serverIsRunning(server.id) ? "Active" : "Offline";
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function folderSizeText() {
  if (folderSize?.id !== state.selectedId) return " · Calculating size…";
  return folderSize.bytes === null ? " · Size unavailable" : ` · ${formatBytes(folderSize.bytes)}`;
}

async function refreshFolderSize() {
  const id = state.selectedId;
  if (!id || document.hidden || pendingFolderSizes.has(id)) return;
  pendingFolderSizes.add(id);
  try {
    const bytes = await window.minecraftAPI.getServerFolderBytes(id).catch(() => null);
    if (state.selectedId !== id) return;
    folderSize = { id, bytes };
    const label = document.getElementById("serverFolderSize");
    if (label) label.textContent = folderSizeText();
  } finally {
    pendingFolderSizes.delete(id);
  }
}

function runtimeUsage() {
  return state.usage?.processes?.find((item) => item.serverId === state.selectedId) || null;
}

function serverIsRunning(serverId) {
  return Boolean(state.usage?.processes?.some((item) => Number(item.serverId) === Number(serverId)));
}

function playerCount() {
  const online = Array.isArray(state.runtime?.onlinePlayers) ? state.runtime.onlinePlayers.length : 0;
  const configured = Number(state.quickPropertiesModel?.values?.["max-players"]);
  return { online, maximum: Number.isSafeInteger(configured) && configured > 0 ? configured : 20 };
}

function statusLabel(status) {
  return {
    offline: "Offline",
    starting: "Starting",
    "startup-stalled": "Startup Stalled",
    "startup-failed": "Startup Failed",
    crashed: "Crashed",
    running: "Running",
    stopping: "Stopping",
    recovering: "Recovering",
  }[status] || "Offline";
}

function runtimeCanStop(runtime = {}) {
  return Boolean(runtime.pid) || ["starting", "running", "stopping", "recovering", "startup-stalled"].includes(runtime.status);
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
  const active = runtime.status !== "recovering" && runtimeCanStop(runtime);
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
  // The main process already parsed modern entries, including their timestamps.
  if (structured && value.occurredAt && value.level && typeof value.message === "string") return value;
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
  while (legacyConsoleTimes.size > 2000) legacyConsoleTimes.delete(legacyConsoleTimes.keys().next().value);
  return structured
    ? { ...value, ...parsed, id: value.id, receivedAt: value.receivedAt || parsed.receivedAt }
    : parsed;
}

function consoleEntries() {
  const normalized = consoleView.entries(state.runtime?.logs || [], [state.selectedId, state.runtime?.startedAt]);
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
  const day = consoleDayFormat.format(date);
  const time = consoleTimeFormat.format(date);
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
  return consoleView.row(entry);
}

function buildConsoleRow(entry) {
  const classes = ["console-line", `console-${escapeHtml(entry.level || "info")}`];
  if (entry.event) classes.push(`console-${escapeHtml(entry.event)}`);
  const label = entry.level === "command" ? "YOU" : entry.level === "app" ? "APP" : entry.level === "warn" ? "WARN" : "";
  return `<div class="${classes.join(" ")}" data-log-id="${Number(entry.id) || 0}">
    <time datetime="${escapeHtml(entry.occurredAt || entry.receivedAt || "")}" title="${escapeHtml(consoleTitleFormat.format(new Date(entry.occurredAt || entry.receivedAt || Date.now())))}">${escapeHtml(formatConsoleTimestamp(entry.occurredAt || entry.receivedAt))}</time>
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
  const markup = renderConsoleRows();
  if (consoleOutputMarkup.get(output) !== markup) {
    output.innerHTML = markup;
    consoleOutputMarkup.set(output, markup);
  }
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

function scheduleConsoleOutput() {
  if (consoleFrame !== null || document.hidden) return;
  consoleFrame = requestAnimationFrame(() => {
    consoleFrame = null;
    syncConsoleOutput();
  });
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
    return true;
  } catch (error) {
    showError(error);
    return false;
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
  const selectedIds = new Set(entries.map((entry) => entry.id));
  const included = new Set();
  context.forEach((entry, index) => {
    if (!selectedIds.has(entry.id)) return;
    for (let nearby = Math.max(0, index - 8); nearby < Math.min(context.length, index + 9); nearby++) {
      included.add(nearby);
    }
  });
  return [
    "BlockHost console diagnostic",
    `Server: ${server?.name || "Unknown"}`,
    `Type: ${server?.typeLabel || server?.type || "Unknown"}`,
    `Minecraft: ${server?.version || "Unknown"}`,
    `Status: ${state.runtime?.status || "offline"}`,
    "",
    "Relevant console output:",
    ...context.filter((_entry, index) => included.has(index)).map((entry) => entry.raw),
  ].join("\n").replace(/C:\\Users\\[^\\\s]+/gi, "C:\\Users\\<user>");
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

function selectServer(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  if (id) window.minecraftAPI.rememberServer(id).catch(() => {});
  state.serverView = "overview";
  state.settingsServerId = null;
  state.addonsServerId = null;
  state.droppedAddon = null;
  serverSettingsRequest += 1;
  addonLoadRequest += 1;
  addonSearchRequestSequence += 1;
  state.runtime = null;
  state.cancelPackCheckPending = false;
  state.startupDiagnostics = "";
  state.consoleFilter = state.appSettings?.options.consoleFilter ?? defaultAppOptions.consoleFilter;
  state.consoleAutoScroll = state.appSettings?.options.consoleAutoScroll ?? defaultAppOptions.consoleAutoScroll;
  state.consoleSearch = "";
  state.consoleClearedBeforeId = 0;
  state.commandDraft = "";
  state.identityIcon = "";
  state.commandHistoryIndex = -1;
  state.quickPropertiesModel = null;
}

function restoreLibraryCard(id) {
  const library = serverPages.querySelector(".library");
  library.scrollTop = libraryScrollTop;
  const card = library.querySelector(`.library-card[data-server-id="${id}"]`);
  card?.scrollIntoView({ block: "nearest", inline: "nearest" });
  (card || document.getElementById("emptyCreate"))?.focus({ preventScroll: true });
}

function finishServerPageMotion() {
  if (!serverPageMotion) return null;
  const motion = serverPageMotion;
  serverPageMotion = null;
  motion.dispose();
  if (motion.opening || state.selectedId !== motion.serverId) return null;
  selectServer(null);
  return motion.serverId;
}

function animateServerPage(id, opening) {
  const workspace = serverPages.querySelector(".server-workspace");
  const template = document.createElement("template");
  template.innerHTML = renderLibrary();
  const library = template.content.firstElementChild;
  const card = library.querySelector(`.library-card[data-server-id="${id}"]`);
  if (!card || !workspace) return null;

  library.classList.add("server-motion-library");
  library.inert = true;
  library.setAttribute("aria-hidden", "true");
  for (const element of library.querySelectorAll("[id], [data-server-id]")) {
    element.removeAttribute("id");
    element.removeAttribute("data-server-id");
  }
  serverPages.append(library);
  library.scrollTop = libraryScrollTop;
  card.scrollIntoView({ block: "nearest", inline: "nearest" });
  libraryScrollTop = library.scrollTop;

  const motion = createServerPageMotion(serverPages, workspace, library, card,
    () => {
      motion.play(true);
      document.getElementById("pageTitle")?.focus({ preventScroll: true });
    },
    () => {
      if (serverPageMotion !== motion) return;
      if (motion.opening) finishServerPageMotion();
      else render();
    });
  motion.serverId = id;
  serverPageMotion = motion;
  motion.start(opening);
  return motion;
}

async function navigateServer(id) {
  const opening = id !== null;
  const animate = !document.hidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    && typeof serverPages.animate === "function" && CSS.supports("clip-path", 'path("M 0 0 L 1 1 Z")');
  if (serverPageMotion?.serverId === state.selectedId && (!opening || id === state.selectedId)) {
    if (animate) {
      serverPageMotion.play(opening);
      return;
    }
    render();
  }
  if (id === state.selectedId) return;
  if (!opening) {
    const previousId = state.selectedId;
    if (animate && animateServerPage(previousId, false)) return;
    selectServer(null);
    render();
    restoreLibraryCard(previousId);
    return;
  }

  libraryScrollTop = serverPages.querySelector(".library")?.scrollTop ?? libraryScrollTop;
  selectServer(id);
  const properties = loadQuickProperties();
  // Allow local properties to populate the moving controls, while switching promptly on slow storage.
  if (animate) await Promise.race([properties, new Promise(resolve => setTimeout(resolve, 40))]);
  if (state.selectedId !== id) return;
  const waitingForProperties = state.quickPropertiesLoading;
  render();
  document.getElementById("pageTitle")?.focus({ preventScroll: true });
  const motion = animate ? animateServerPage(id, true) : null;
  await Promise.all([refreshLive(), properties, motion?.settled]);
  if (state.selectedId === id && modpackSetup()?.status === "repair") showServerView("addons");
  if (waitingForProperties && state.selectedId === id && state.serverView === "overview" && !serverPageMotion) render();
}

async function loadServers(preferredId = null) {
  try {
    state.servers = await window.minecraftAPI.getServers();
  } finally {
    state.serversLoading = false;
  }
  if (preferredId && state.servers.some((server) => server.id === preferredId)) {
    selectServer(preferredId);
  } else if (!selectedServer()) {
    selectServer(null);
  }
  await Promise.all([refreshLive(), loadQuickProperties()]);
}

async function loadQuickProperties() {
  const serverId = state.selectedId;
  state.quickPropertiesModel = null;
  state.quickPropertiesError = "";
  state.quickPropertiesDirty = false;
  state.quickPropertiesLoading = Boolean(serverId);
  if (!serverId) return;
  try {
    const properties = await window.minecraftAPI.getServerProperties(serverId);
    if (serverId === state.selectedId) state.quickPropertiesModel = properties;
  } catch (error) {
    if (serverId === state.selectedId) state.quickPropertiesError = error.message || "Could not load quick settings";
  } finally {
    if (serverId === state.selectedId) state.quickPropertiesLoading = false;
  }
}

async function loadVersions() {
  const request = ++versionRequest;
  const type = state.createType;
  state.versionsLoading = true;
  state.versionsError = "";
  state.versions = [];
  render();
  try {
    const versions = await window.minecraftAPI.getVersionOptions(type);
    if (request !== versionRequest || state.createPack) return;
    state.versions = versions;
    if (!versions.length) state.versionsError = "No versions were returned for this server type.";
    if (!versions.some(version => version.id === state.createDraft.version)) {
      const preferredVersion = state.appSettings?.options.minecraftVersion;
      state.createDraft.version = (versions.find(version => version.version === preferredVersion) || versions[0])?.id || "";
    }
  } catch (error) {
    if (request !== versionRequest || state.createPack) return;
    state.versionsError = error.message || "Could not load versions";
  } finally {
    if (request === versionRequest && !state.createPack) { state.versionsLoading = false; render(); }
  }
}

function applyRuntime(runtime) {
  const previous = state.runtime;
  state.runtime = runtime;
  if (runtime.modpackSetup) {
    const server = selectedServer();
    if (server?.id === runtime.serverId) server.modpackSetup = runtime.modpackSetup;
  }
  const enteredRepair = runtime.modpackSetup?.status === "repair" && previous?.modpackSetup?.status !== "repair";
  if (runtime.startupFailed && (previous || state.pendingAction === "start")
    && (enteredRepair || !previous?.startupFailed || previous.startedAt !== runtime.startedAt)) {
    if (runtime.modpackSetup?.status === "repair") {
      state.startupDiagnostics = "";
      state.serverView = "addons";
      void loadAddons(true);
      return;
    }
    state.serverView = "console";
    state.consoleFilter = "errors";
    state.consoleSearch = "";
    state.consoleClearedBeforeId = 0;
    state.startupDiagnostics = true;
    render();
  }
}

async function refreshLive() {
  const sequence = ++liveRefreshSequence;
  if (!state.selectedId) {
    state.runtime = null;
    const usage = await window.minecraftAPI.getUsage().catch(() => null);
    if (sequence !== liveRefreshSequence || state.selectedId) return;
    state.usage = usage;
    updateLiveElements();
    return;
  }

  const selectedId = state.selectedId;
  const [runtime, usage] = await Promise.all([
    window.minecraftAPI.getRuntime(selectedId).catch(() => null),
    window.minecraftAPI.getUsage().catch(() => null),
  ]);
  // A slow process sample must not replace a newly selected server's console.
  if (sequence !== liveRefreshSequence || state.selectedId !== selectedId) return;
  if (runtime && state.runtime?.startedAt === runtime.startedAt && state.runtime?.serverId === runtime.serverId) {
    const lastId = Number(runtime.logs?.at(-1)?.id) || 0;
    const streamed = (state.runtime.logs || []).filter((entry) => Number(entry.id) > lastId);
    runtime.logs = [...(runtime.logs || []), ...streamed].slice(-2000);
    let players = new Set(runtime.onlinePlayers || []);
    for (const entry of streamed) players = updateOnlinePlayers(players, entry);
    runtime.onlinePlayers = [...players].sort((a, b) => a.localeCompare(b));
  }
  state.usage = usage;
  if (runtime) applyRuntime(runtime);
  updateLiveElements();
}

function updateLiveElements() {
  const runtime = state.runtime || { status: "offline", logs: [] };
  const server = selectedServer();
  const repair = modpackSetup(server, runtime)?.status === "repair";
  const usage = runtimeUsage();
  const runs = runMetrics(runtime);
  const status = document.getElementById("runtimeStatus");
  if (status) {
    const badge = serverRuntimeBadge(runtime, server);
    if (status.textContent !== badge.label) status.textContent = badge.label;
    status.className = `status-badge status-${badge.status}`;
  }
  const startupDialog = document.getElementById("startupCrashDialog");
  if (startupDialog?.open) {
    if (!runtime.startupFailed) startupDialog.close();
    else startupDialog.querySelector("h2").textContent = statusLabel(runtime.status);
  }
  const diagnosisPanel = document.getElementById("startupDiagnosis");
  if (diagnosisPanel) {
    const content = repair ? "" : renderStartupDiagnosis(runtime);
    if (diagnosisPanel.startupMarkup !== content) {
      diagnosisPanel.startupMarkup = content;
      diagnosisPanel.innerHTML = content;
      diagnosisPanel.hidden = !content;
    }
  }
  const modpackPanel = document.getElementById("modpackStatusPanel");
  if (modpackPanel) {
    const content = renderModpackStatus(runtime, server);
    if (modpackPanel.startupMarkup !== content) {
      modpackPanel.startupMarkup = content;
      modpackPanel.innerHTML = content;
      modpackPanel.hidden = !content;
    }
  }
  const cpu = document.getElementById("cpuValue");
  if (cpu) cpu.textContent = `${(Number(usage?.cpuPercent) || 0).toFixed(1)}%`;
  const ram = document.getElementById("ramValue");
  if (ram) ram.textContent = formatBytes(usage?.ramBytes || 0);
  const uptime = document.getElementById("uptimeValue");
  const uptimeDetail = document.getElementById("uptimeDetail");
  const lastRun = document.getElementById("lastRunValue");
  const lastRunDetail = document.getElementById("lastRunDetail");
  const players = document.getElementById("playerCountValue");
  if (uptime) uptime.textContent = runs.uptime;
  if (uptimeDetail) uptimeDetail.textContent = runs.uptimeDetail;
  if (lastRun) lastRun.textContent = runs.lastRun;
  if (lastRunDetail) {
    lastRunDetail.textContent = runs.lastRunDetail;
    lastRunDetail.title = runs.lastRunTitle;
  }
  if (players) {
    const count = playerCount();
    players.textContent = `${count.online}/${count.maximum}`;
  }

  document.querySelectorAll("[data-server-id]").forEach((item) => {
    const itemServer = state.servers.find((server) => server.id === Number(item.dataset.serverId));
    if (!itemServer) return;
    item.classList.toggle("running", serverIsRunning(itemServer.id));
    const badge = item.querySelector(".library-card-status");
    if (badge) badge.textContent = libraryServerLabel(itemServer);
  });
  syncConsoleOutput();

  const start = document.getElementById("startServer");
  const stop = document.getElementById("stopServer");
  const running = runtimeCanStop(runtime);
  if (start) {
    start.hidden = running || runtime.status === "stopping";
    start.disabled = Boolean(state.pendingAction || (server?.modpack && (state.addonsPending || state.javaSettingsPending)));
    start.textContent = state.pendingAction === "start" ? "Getting ready…" : repair ? "Retry startup" : "Start server";
  }
  if (stop) {
    stop.hidden = !running && runtime.status !== "stopping";
    const canCancelCheck = runtime.checkingModpack && state.pendingAction === "start";
    stop.disabled = Boolean((state.pendingAction && !canCancelCheck) || state.cancelPackCheckPending) || runtime.status === "stopping";
    stop.textContent = runtime.status === "stopping" ? "Stopping…" : runtime.checkingModpack ? "Cancel startup check" : runtime.status === "recovering" ? "Cancel restart" : "Stop server";
  }
  const command = document.getElementById("commandInput");
  const send = document.getElementById("sendCommand");
  if (command) command.disabled = runtime.status !== "running";
  if (send) send.disabled = runtime.status !== "running";
  refreshCommandMenu?.();
}

async function createServer(event) {
  event.preventDefault();
  if (state.createPending || state.packBusy) return;
  const form = event.currentTarget;
  const selected = state.versions.find((version) => version.id === form.version.value);
  if (!selected) return;

  const request = {
    name: form.serverName.value.trim() || suggestedServerName(),
    color: form.color.value,
    icon: form.elements.icon.value,
    seed: form.seed.value.trim(),
    type: state.createType,
    version: selected.version,
    versionUrl: selected.versionUrl || "",
    loaderVersion: selected.loaderVersion || "",
    installerVersion: selected.installerVersion || "",
    worldImportToken: state.createWorldImport?.token || "",
    modpackToken: state.createPack?.token || "",
    includeOptional: state.packIncludeOptional,
    acceptPackEula: form.elements.acceptPackEula?.checked === true,
  };

  state.createDraft = { ...state.createDraft, name: request.name, color: request.color, icon: request.icon, seed: request.seed };
  state.packProgress = state.createPack ? "Preparing the modpack…" : "Downloading and setting up your server…";
  state.createPending = true;
  state.error = "";
  state.createPackError = "";
  render();
  try {
    const result = await window.minecraftAPI.createServer(request);
    const testedPack = state.createPack?.requiresStartupCheck;
    state.createOpen = false;
    state.createPack = null;
    state.createWorldImport = null;
    state.createDraft = { name: "", color: "#39c9ff", seed: "" };
    await loadServers(result.server.id);
    if (result.repairRequired || modpackSetup()?.status === "repair") showServerView("addons");
    else {
      state.serverView = "overview";
      if (testedPack) showNotice("Startup check passed. Select Start server when you’re ready to join.");
    }
  } catch (error) {
    if (/abort|cancelled/i.test(error.message || "")) showNotice("Modpack setup cancelled. You can retry or choose another pack.");
    else if (request.modpackToken) state.createPackError = modpackErrorMessage(error);
    else state.error = error.message || "Could not download the server";
  } finally {
    state.createPending = false;
    render();
  }
}

async function startServer(options = {}) {
  if (!state.selectedId || state.pendingAction || ((state.addonsPending || state.javaSettingsPending) && selectedServer()?.modpack)) return;
  const id = state.selectedId;
  state.pendingAction = "start";
  showServerView("console");
  updateLiveElements();
  try {
    const runtime = await window.minecraftAPI.startServer(id, options);
    if (id !== state.selectedId) return;
    if (runtime.requiresEula) {
      state.pendingStart = { kind: "eula", options };
      render();
      return;
    }
    if (runtime.requiresPortConflict) {
      state.pendingStart = { kind: "port-conflict", portConflict: runtime.portConflict, options };
      render();
      return;
    }
    applyRuntime(runtime);
    if (runtime.bundledDependencyUnavailable) {
      state.serverView = "addons";
      void loadAddons(true);
      showNotice("The bundled dependency has changed. Check the installed mods before retrying.");
    } else if (options.repairBundledDependency && runtime.modpackSetup?.status === "verified") {
      state.addonsServerId = null;
    }
  } catch (error) {
    showError(error);
  } finally {
    state.pendingAction = "";
    updateLiveElements();
  }
}

async function stopServer() {
  const id = state.selectedId;
  const cancelCheck = state.runtime?.checkingModpack && state.pendingAction === "start";
  if (!id || (state.pendingAction && !cancelCheck) || state.cancelPackCheckPending) return;
  if (cancelCheck) state.cancelPackCheckPending = true;
  else state.pendingAction = "stop";
  updateLiveElements();
  try {
    const runtime = await window.minecraftAPI.stopServer(id);
    if (id === state.selectedId && (!cancelCheck || state.pendingAction === "start")) state.runtime = runtime;
  } catch (error) {
    showError(error);
  } finally {
    if (cancelCheck) state.cancelPackCheckPending = false;
    else state.pendingAction = "";
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
  state.commandDraft = input.value = "";
  state.commandHistoryIndex = -1;
  refreshCommandMenu?.();
  await runConsoleCommand(command);
}

let commandData;
let refreshCommandMenu;

function bindCommandInput() {
  const input = document.getElementById("commandInput");
  refreshCommandMenu = null;
  if (!input) return;
  const menu = document.getElementById("commandMenu");
  const list = document.getElementById("commandSuggestions");
  const hint = document.getElementById("commandHint");
  const version = selectedServer()?.version;
  let dismissed = false;
  let result;
  let signature;
  let selected = -1;

  function setActive(index) {
    list.children[selected]?.setAttribute("aria-selected", "false");
    selected = index;
    const row = list.children[selected];
    if (row) {
      row.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function refresh() {
    if (input.disabled || !input.form.contains(document.activeElement) || dismissed || !input.value.trim()) {
      input.setAttribute("aria-expanded", "false");
      menu.hidden = true;
      return;
    }
    const players = state.runtime?.onlinePlayers || [];
    const data = commandData?.version === version ? commandData.data : null;
    const key = JSON.stringify([input.value, input.selectionStart, players, Boolean(data)]);
    if (key !== signature) {
      signature = key;
      result = completeCommand(input.value, input.selectionStart, data || {}, players);
      const markup = result.suggestions.map(({ text, detail }, index) =>
        `<div id="command-option-${index}" data-command-option="${index}" role="option" aria-selected="false"><code>${escapeHtml(text)}</code>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>`
      ).join("");
      list.innerHTML = markup;
      list.scrollTop = 0;
      setActive(-1);
      hint.textContent = result.hint ? `Next argument · ${result.hint}` : "";
    }
    menu.hidden = !result?.suggestions.length && !result?.hint;
    input.setAttribute("aria-expanded", String(!menu.hidden));
  }

  function loadData() {
    if (!version || commandData?.version === version || !window.minecraftAPI.getCommandData) return;
    const request = { version, data: null };
    commandData = request;
    window.minecraftAPI.getCommandData(state.selectedId).then((data) => {
      request.data = data;
      if (commandData === request) refreshCommandMenu?.();
    }).catch(() => {});
  }

  function choose(index) {
    const option = result?.suggestions[index];
    if (!option) return;
    const suffix = input.value.slice(result.to);
    const separator = /^\s/.test(suffix) ? "" : " ";
    const start = input.value.slice(0, result.from) + option.text;
    state.commandDraft = input.value = start + separator + suffix;
    input.focus();
    const caret = start.length + 1;
    input.setSelectionRange(caret, caret);
    refresh();
  }

  refreshCommandMenu = refresh;
  input.addEventListener("focus", () => { loadData(); refresh(); });
  input.addEventListener("input", () => {
    state.commandDraft = input.value;
    state.commandHistoryIndex = -1;
    dismissed = false;
    loadData();
    refresh();
  });
  input.addEventListener("click", () => { dismissed = false; refresh(); });
  input.addEventListener("keyup", refresh);
  input.form.addEventListener("focusout", (event) => {
    if (!input.form.contains(event.relatedTarget) || event.relatedTarget?.id === "sendCommand") {
      menu.hidden = true;
      input.setAttribute("aria-expanded", "false");
    }
  });
  list.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-command-option]")) event.preventDefault();
  });
  list.addEventListener("click", (event) => {
    const row = event.target.closest("[data-command-option]");
    if (row) choose(Number(row.dataset.commandOption));
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const count = menu.hidden ? 0 : result.suggestions.length;
    if (!menu.hidden && event.key === "Escape") {
      event.preventDefault();
      dismissed = true;
      setActive(-1);
      refresh();
    } else if (count && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(selected < 0 && step < 0 ? count - 1 : (selected + step + count) % count);
    } else if (count && ((event.key === "Tab" && !event.shiftKey) || (event.key === "Enter" && selected >= 0))) {
      event.preventDefault();
      choose(Math.max(0, selected));
    } else if (state.commandHistory.length && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "ArrowUp") state.commandHistoryIndex = Math.min(state.commandHistory.length - 1, state.commandHistoryIndex + 1);
      else state.commandHistoryIndex = Math.max(-1, state.commandHistoryIndex - 1);
      state.commandDraft = input.value = state.commandHistory[state.commandHistoryIndex] || "";
      dismissed = true;
      refresh();
    }
  });
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
  for (const key of Object.keys(quickControlOptions)) {
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
    state.quickPropertiesDirty = false;
    state.runtime = result.runtime;
    state.quickRestartNotice = true;
  } catch (error) {
    state.quickPropertiesError = error.message || "Could not save quick settings";
  } finally {
    state.quickPropertiesPending = false;
    render();
  }
}

let serverSettingsRequest = 0;

async function loadServerSettings() {
  const id = state.selectedId;
  if (!id || state.settingsServerId === id) return;
  state.settingsServerId = id;
  const request = ++serverSettingsRequest;
  const isCurrent = () => request === serverSettingsRequest && id === state.selectedId;
  state.serverSettingsLoading = true;
  state.serverJava = null;
  state.javaSettingsPending = false;
  state.memoryModel = null;
  state.memoryDraft = null;
  state.memoryError = "";
  state.identityError = "";
  state.backupModel = null;
  state.backupDraft = null;
  state.backupError = "";
  render();
  window.minecraftAPI.getServerJava(id).catch(error => ({ error: error.message })).then(java => {
    if (!isCurrent()) return;
    state.serverJava = java;
    refreshJavaRuntimeRow();
  });
  try {
    const [memory, backup] = await Promise.all([
      window.minecraftAPI.getServerMemory(id),
      window.minecraftAPI.getBackupSettings(id),
    ]);
    if (!isCurrent()) return;
    state.memoryModel = memory;
    state.backupModel = backup;
    state.backupDraft = { ...backup };
    state.memoryDraft = {
      minMemoryMb: state.memoryModel.minMemoryMb,
      maxMemoryMb: state.memoryModel.maxMemoryMb,
    };
  } catch (error) {
    if (isCurrent()) state.memoryError = error.message || "Could not load memory settings";
  } finally {
    if (isCurrent()) {
      state.serverSettingsLoading = false;
      if (state.serverView === "settings") render();
    }
  }
}

async function chooseBackupFolder() {
  if (!state.selectedId || state.backupPending) return;
  state.backupPending = true;
  state.backupError = "";
  render();
  try {
    const result = await window.minecraftAPI.chooseBackupDestination(state.selectedId);
    if (!result.cancelled) state.backupDraft = { ...state.backupDraft, destination: result.destination };
  } catch (error) {
    state.backupError = error.message || "Could not choose the backup folder";
  } finally {
    state.backupPending = false;
    render();
  }
}

function backupDraftFromForm(form) {
  return {
    ...state.backupDraft,
    enabled: form.enabled.checked,
    destination: state.backupDraft?.destination || "",
    intervalMinutes: Number(form.intervalMinutes.value),
    mode: form.mode.value,
  };
}

async function saveBackupSettings(event, runNow = false) {
  event?.preventDefault();
  if (!state.selectedId || state.backupPending) return;
  const form = event?.currentTarget?.matches?.("form")
    ? event.currentTarget
    : event?.currentTarget?.closest?.("form") || document.getElementById("backupSettingsForm");
  state.backupPending = true;
  state.backupError = "";
  render();
  try {
    const draft = backupDraftFromForm(form);
    state.backupModel = await window.minecraftAPI.updateBackupSettings(state.selectedId, draft);
    state.backupDraft = { ...state.backupModel };
    if (runNow) {
      const result = await window.minecraftAPI.runBackupNow(state.selectedId);
      state.backupModel = result.settings;
      state.backupDraft = { ...result.settings };
      showNotice(`World backup created: ${result.result.fileName}`);
    } else showNotice("Automatic backup settings saved.");
  } catch (error) {
    state.backupError = error.message || "Could not update automatic backups";
  } finally {
    state.backupPending = false;
    render();
  }
}

async function saveMemorySettings(event) {
  event?.preventDefault();
  if (!state.selectedId || !state.memoryDraft || state.memoryPending) return;
  clearTimeout(memorySaveTimer);
  memorySaveTimer = null;
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

function scheduleMemorySave() {
  clearTimeout(memorySaveTimer);
  memorySaveTimer = setTimeout(() => saveMemorySettings(), 650);
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
      form.elements.icon.value,
    );
    state.servers = state.servers.map((server) => server.id === updated.id ? { ...server, ...updated } : server);
    state.identityIcon = "";
    showNotice("Server identity saved.");
  } catch (error) {
    state.identityError = error.message || "Could not update server details";
  } finally {
    state.identityPending = false;
    render();
  }
}

async function chooseCreateWorld(kind = "zip") {
  if (state.createPack?.hasWorld) return;
  if (state.createPending || state.createDraft.seed.trim()) return;
  try {
    const result = await window.minecraftAPI.chooseWorldImportSource(kind);
    if (result?.cancelled || !state.createOpen || state.createPending || state.createDraft.seed.trim()) return;
    state.createWorldImport = result;
    render();
  } catch (error) {
    showError(error, () => chooseCreateWorld(kind));
  }
}

async function exportSelectedWorld() {
  if (!state.selectedId || state.transferPending) return;
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

async function loadAddons(force = false) {
  const id = state.selectedId;
  if (!id || (!force && state.addonsServerId === id)) return;
  state.addonsServerId = id;
  const request = ++addonLoadRequest;
  const isCurrent = () => request === addonLoadRequest && id === state.selectedId;
  addonSearchRequestSequence += 1;
  state.addonTab = "installed";
  state.addonsLoading = true;
  state.addonsInspecting = false;
  state.addonsModel = null;
  state.addonResults = [];
  state.addonHasSearched = false;
  state.addonSearching = false;
  state.addonError = "";
  state.addonSearchStatus = "";
  state.addonRemoveId = null;
  state.addonInstalledFilter = "all";
  state.installedAddonTab = "files";
  state.installedAddonSearch = { files: "", pack: "" };
  state.addonRecommendations = [];
  state.addonRecommendationsLoading = true;
  state.addonRecommendationsRequested = false;
  state.addonRecommendationsError = "";
  render();
  try {
    const model = await window.minecraftAPI.getAddons(id);
    if (!isCurrent()) return;
    state.addonsModel = model;
    state.addonsInspecting = Boolean(model.supported && model.items.length);
  } catch (error) {
    if (!isCurrent()) return;
    state.addonError = error.message || "Could not load installed add-ons";
  }
  state.addonsLoading = false;
  if (!state.addonsModel?.supported) state.addonRecommendationsLoading = false;
  if (state.serverView === "addons") render();
  if (!state.addonsModel?.supported) return;
  void fillInstalledAddonDetails(id, state.addonsModel, true);
}

async function loadAddonRecommendations() {
  if (state.addonRecommendationsRequested || !state.addonsModel?.supported) return;
  state.addonRecommendationsRequested = true;
  const id = state.selectedId;
  const request = addonLoadRequest;
  const isCurrent = () => request === addonLoadRequest && id === state.selectedId;
  try {
    const recommendations = await window.minecraftAPI.getAddonRecommendations(id);
    if (!isCurrent()) return;
    state.addonRecommendations = recommendations.results || [];
    state.addonSearchStatus = recommendations.offlineMessage || "";
  } catch (error) {
    if (!isCurrent()) return;
    state.addonRecommendationsError = error.message || "Recommendations are unavailable right now.";
  }
  state.addonRecommendationsLoading = false;
  if (state.serverView === "addons" && state.addonTab === "browse") render();
}

async function fillInstalledAddonDetails(id, model, inspect = false) {
  if (!model?.supported || !model.items.length) return;
  const isCurrent = () => id === state.selectedId && state.addonsModel === model;
  const renderInstalled = () => {
    if (state.serverView === "addons" && state.addonTab === "installed") render();
  };
  if (inspect) {
    const inspected = await window.minecraftAPI.inspectAddons(id).catch(() => null);
    if (!isCurrent()) return;
    state.addonsInspecting = false;
    if (inspected) {
      state.addonsModel = model = inspected;
    }
    renderInstalled();
  }
  const patches = await window.minecraftAPI.identifyAddons(id).catch(() => []);
  if (!isCurrent() || !patches.length) return;
  const fileKey = ({ id: addonId, fileName, enabled, sha512 }) => `${addonId}:${fileName}:${enabled}:${sha512}`;
  const byFile = new Map(patches.map((patch) => [fileKey(patch), patch]));
  for (const item of model.items) {
    const match = byFile.get(fileKey(item));
    if (!match) continue;
    item.catalogue = match.catalogue;
    item.title = match.title || item.title;
    if (item.versionNumber === "Unknown" && match.versionNumber) item.versionNumber = match.versionNumber;
    if (item.loader === "unknown" && match.loader) item.loader = match.loader;
    item.minecraftVersion ||= match.minecraftVersion;
    item.iconUrl ||= match.iconUrl;
    if (match.environment && (!item.environment || item.environment === "both_supported")) item.environment = match.environment;
  }
  model.items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  renderInstalled();
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
      source: request.source,
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
  const id = state.selectedId;
  state.addonsPending = label;
  state.addonError = "";
  clearNotice(false);
  render();
  let succeeded = false;
  try {
    const result = await action();
    if (result?.cancelled) return;
    if (result?.addons) {
      state.addonsInspecting = false;
      state.addonsModel = result.addons;
      void fillInstalledAddonDetails(id, result.addons);
    }
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
  const id = state.selectedId;
  state.addonsPending = "Checking updates";
  state.addonError = "";
  render();
  try {
    state.addonsModel = await window.minecraftAPI.checkAddonUpdates(id);
    state.addonsInspecting = false;
    void fillInstalledAddonDetails(id, state.addonsModel);
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

async function exportSelectedServer() {
  if (!state.selectedId || state.transferPending) return;
  state.transferPending = "export";
  state.transferProgress = { percent: 0, message: "Preparing the export…" };
  state.transferResult = null;
  state.error = "";
  render();
  try {
    const result = await window.minecraftAPI.exportServer(state.selectedId);
    if (result?.cancelled) return;
    state.transferResult = { kind: "export", ...result };
    await refreshLive();
  } catch (error) {
    state.transferResult = null;
    showError(error, exportSelectedServer);
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

function openCreate(world = null) {
  state.createPack = null;
  state.createPackError = "";
  state.createOpen = true;
  state.createType = state.appSettings?.options.serverType ?? defaultAppOptions.serverType;
  state.createAdvancedOpen = Boolean(world);
  state.createDraft = { name: "", color: "#39c9ff", seed: "" };
  state.createWorldImport = world;
  state.versions = [];
  state.versionsError = "";
  render();
  loadVersions();
}

async function importDroppedFile(file) {
  if (checkingDrop || state.packBusy || state.transferPending || state.createPending || state.addonsPending) return;
  checkingDrop = true;
  const selectedId = state.selectedId;
  try {
    const { kind, world, pack } = await window.minecraftAPI.detectDroppedFile(file);
    if (state.transferPending || state.createPending || state.addonsPending) return;
    if (kind === "modpack") {
      acceptModpack(pack);
    } else if (kind === "world") {
      if (state.createPack?.hasWorld && state.createOpen) throw new Error("This server pack already contains a world.");
      if (state.createOpen && state.createDraft.seed.trim()) throw new Error("Clear the world seed before dropping an existing world.");
      if (state.createOpen) {
        state.createWorldImport = world;
        state.createAdvancedOpen = true;
        render();
      } else {
        state.droppedAddon = null;
        openCreate(world);
      }
    } else if (kind === "blockhost" || kind === "server") {
      if (state.createOpen) throw new Error("This is a server archive. Close the download form to import the whole server.");
      if (kind === "blockhost") await runImport(() => window.minecraftAPI.importDroppedServer(file));
      else await runImport(() => window.minecraftAPI.importDroppedExternalServer(file), "external-import");
    } else if (kind === "addon" || kind === "addon-bundle") {
      if (state.createOpen) throw new Error("This contains add-ons. Finish creating the server, then drop the add-on JAR.");
      const server = selectedServer();
      if (!server || server.id !== selectedId || server.type === "vanilla") {
        throw new Error("Select a server that supports mods or plugins, then drop the add-on again.");
      }
      state.droppedAddon = { file, serverId: selectedId, bundle: kind === "addon-bundle" };
      state.addonTab = "installed";
      state.installedAddonTab = "files";
      if (state.serverView === "addons") render();
      else showServerView("addons");
    } else {
      throw new Error("BlockHost couldn't identify this file. Drop a world folder or ZIP, a server archive, or a mod or plugin JAR.");
    }
  } catch (error) {
    showError(error);
  } finally {
    checkingDrop = false;
  }
}

function serverBlock(size = 24) {
  return `<svg class="server-block" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2 29 9.5 16 17 3 9.5 16 2Z" fill="currentColor" fill-opacity=".76"/><path d="M3 9.5 16 17v13L3 22.5v-13Z" fill="currentColor" fill-opacity=".26"/><path d="M29 9.5 16 17v13l13-7.5v-13Z" fill="currentColor" fill-opacity=".51"/><path d="M16 2 29 9.5v13L16 30 3 22.5v-13L16 2Z" stroke="currentColor" stroke-opacity=".8" stroke-linejoin="round"/></svg>`;
}

function renderThemeIcon(id, size = 28) {
  id = normalizeServerIcon(id);
  if (id === "normal") return serverBlock(size);
  return `<svg width="${size}" height="${size}" viewBox="31 10 232 169" aria-hidden="true">${themeArtwork[id]}</svg>`;
}

function renderLibrary() {
  const packActionDisabled = state.packBusy || state.transferPending ? "disabled" : "";
  const cards = state.servers.map(server => `
    <button class="library-card ${serverIsRunning(server.id) ? "running" : ""}" type="button" data-server-id="${server.id}" style="--server-color:${escapeHtml(server.color || "#39c9ff")}">
      <span class="library-card-top"><span class="library-card-icon">${renderThemeIcon(server.icon, 40)}</span><span class="library-card-status">${libraryServerLabel(server)}</span></span>
      <span class="library-card-title">${escapeHtml(server.name)}</span>
      <span class="library-card-meta">${escapeHtml(server.typeLabel)} · Minecraft ${escapeHtml(server.version)}</span>
    </button>`).join("");
  return `
    <main class="content library" data-page="library" aria-label="Server library">
      <div class="library-actions" role="group" aria-label="Server actions">
        <button class="primary" id="emptyCreate" type="button">＋ New server</button>
        <details class="library-import" name="library-actions">
          <summary>Import server</summary>
          <div class="library-import-menu">
            <button id="importServer" type="button" ${state.transferPending ? "disabled" : ""}><strong>BlockHost backup</strong><small>Open a .blockhost file</small></button>
            <button id="importExternalServer" type="button" ${state.transferPending ? "disabled" : ""}><strong>Existing server</strong><small>Choose a server folder or ZIP</small></button>
          </div>
        </details>
        <details class="library-import" name="library-actions">
          <summary>Modpacks</summary>
          <div class="library-import-menu">
            <button id="browseLibraryPacks" type="button" ${packActionDisabled}>Browse packs</button>
            <button id="localLibraryPack" type="button" ${packActionDisabled}>From file</button>
          </div>
        </details>
      </div>
      ${state.packBusy && !state.packBrowserOpen && !state.createOpen ? '<p class="library-message" role="status">Reading and checking the selected pack…</p>' : ""}
      ${state.serversLoading ? '<p class="library-message" role="status">Finding your servers…</p>' : cards ? `<section class="library-section" aria-labelledby="savedServersTitle"><div class="library-section-heading"><h2 id="savedServersTitle">Saved servers</h2><span>${state.servers.length}</span></div><div class="library-grid">${cards}</div></section>` : '<div class="library-message">No saved servers yet.</div>'}
    </main>`;
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
        <button class="quick-save ${state.quickPropertiesDirty ? "has-changes" : ""}" type="submit" form="quickPropertiesForm" ${state.quickPropertiesPending || !state.quickPropertiesDirty ? "disabled" : ""}><span>✓</span>${state.quickPropertiesPending ? "Saving…" : state.quickPropertiesDirty ? "Save changes" : "Saved"}</button>
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
  const badge = serverRuntimeBadge(runtime, server);
  const repair = modpackSetup(server, runtime)?.status === "repair";
  const usage = runtimeUsage();
  const runs = runMetrics(runtime);
  const players = playerCount();
  const consoleOpen = state.serverView === "console";
  const overviewOpen = state.serverView === "overview";
  return `
    <main class="content server-workspace" data-page="${server.id}-${state.serverView}">
      <button class="server-breadcrumb" id="backToLibrary" type="button"><span aria-hidden="true">←</span> All servers</button>
      <header class="server-header">
        <div class="server-heading">
          <p class="eyebrow">${escapeHtml(server.typeLabel)} · Minecraft ${escapeHtml(server.version)}<span id="serverFolderSize" title="Total size of this server’s files">${folderSizeText()}</span></p>
          <div class="server-title-row">
            <h1 id="pageTitle" tabindex="-1">${escapeHtml(server.name)}</h1>
            <button class="server-folder-button" id="openServerFolder" type="button" title="Open server folder" aria-label="Open server folder">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 17.5v-11A1.5 1.5 0 0 1 4.5 5h4.2l2 2h7.8A1.5 1.5 0 0 1 20 8.5V10M3 17.5l2.4-6A2.4 2.4 0 0 1 7.6 10h12.7a1.5 1.5 0 0 1 1.4 2l-2.1 5.5a2.4 2.4 0 0 1-2.3 1.5H4.5A1.5 1.5 0 0 1 3 17.5Z"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="header-actions">
          <span id="runtimeStatus" class="status-badge status-${badge.status}"${server.modpack ? ' role="status"' : ""}>${badge.label}</span>
          <button class="primary" id="startServer" type="button" ${runtimeCanStop(runtime) ? "hidden" : ""}>${repair ? "Retry startup" : "Start server"}</button>
          <button class="danger" id="stopServer" type="button" ${runtimeCanStop(runtime) ? "" : "hidden"}>Stop server</button>
        </div>
      </header>

      <nav class="workspace-nav" aria-label="Server tools">
        ${[["overview", "Overview"], ["console", "Console"], ["addons", "Add-ons"], ["settings", "Settings"]].map(([view, label]) =>
          `<button type="button" data-server-view="${view}" ${state.serverView === view ? 'aria-current="page"' : ""} ${state.packBusy ? "disabled" : ""}>${label}</button>`
        ).join("")}
      </nav>

      ${server.modpack ? '<section id="modpackStatusPanel" class="startup-diagnosis modpack-status" aria-live="polite" hidden></section>' : ""}

      ${overviewOpen ? `
      <section class="metrics" aria-label="Server resource usage">
        <article><span>CPU usage</span><strong id="cpuValue">${(Number(usage?.cpuPercent) || 0).toFixed(1)}%</strong></article>
        <article><span>RAM usage</span><strong id="ramValue">${formatBytes(usage?.ramBytes || 0)}</strong></article>
        <article><span>Uptime</span><strong id="uptimeValue">${escapeHtml(runs.uptime)}</strong><small id="uptimeDetail">${escapeHtml(runs.uptimeDetail)}</small></article>
        <article><span>Last run</span><strong id="lastRunValue">${escapeHtml(runs.lastRun)}</strong><small id="lastRunDetail" title="${escapeHtml(runs.lastRunTitle)}">${escapeHtml(runs.lastRunDetail)}</small></article>
        <article><span>Players</span><strong id="playerCountValue">${players.online}/${players.maximum}</strong><small>Online / server limit</small></article>
      </section>
      ${renderQuickProperties()}` : ""}

      ${consoleOpen ? `<section id="startupDiagnosis" class="startup-diagnosis" aria-live="polite" ${!repair && runtime.startupDiagnosis ? "" : "hidden"}>${repair ? "" : renderStartupDiagnosis(runtime)}</section>
      <section class="console-card">
        <div class="console-toolbar">
          <div class="console-filters" role="group" aria-label="Console filters">
            ${Object.entries(consoleFilterOptions).map(([value, label]) => `
              <button type="button" data-console-filter="${value}" aria-pressed="${state.consoleFilter === value}">${label}${value === "errors" ? '<span class="console-error-count" id="consoleErrorCount" hidden></span>' : ""}</button>
            `).join("")}
          </div>
          <input id="consoleSearch" value="${escapeHtml(state.consoleSearch)}" placeholder="Search console…" aria-label="Search console output" />
          <label class="console-autoscroll"><input id="consoleAutoScroll" type="checkbox" ${state.consoleAutoScroll ? "checked" : ""} /> Auto-scroll</label>
          <div class="console-toolbar-actions" role="group" aria-label="Console actions">
            <button id="copyVisibleConsole" type="button">${escapeHtml(consoleCopyLabel())}</button>
            <button id="copyConsoleDiagnostics" type="button" ${state.consoleFilter === "errors" ? "" : "hidden"}>Copy diagnostics</button>
            <button id="clearConsoleView" type="button">Clear view</button>
          </div>
        </div>
        <div class="console-output-wrap"><div id="consoleOutput" class="console-output" tabindex="0" role="log" aria-live="polite">${renderConsoleRows()}</div><button id="jumpConsoleLatest" type="button" hidden>Jump to latest ↓</button></div>
        <form class="command-form" id="commandForm">
          <div id="commandMenu" class="command-menu" hidden>
            <div id="commandSuggestions" role="listbox" aria-label="Command suggestions" tabindex="-1"></div>
            <div id="commandHint"></div>
          </div>
          <span aria-hidden="true">&gt;</span>
          <input id="commandInput" name="command" role="combobox" aria-label="Server command" aria-autocomplete="list"
            aria-controls="commandSuggestions" aria-describedby="commandHint" aria-expanded="false" autocomplete="off" spellcheck="false"
            placeholder="Type / to browse commands" value="${escapeHtml(state.commandDraft)}" ${runtime.status !== "running" ? "disabled" : ""} />
          <button id="sendCommand" type="submit" ${runtime.status !== "running" ? "disabled" : ""}>Send</button>
        </form>
      </section>` : ""}
      ${state.serverView === "addons" ? renderAddonsPage() : ""}
      ${state.serverView === "settings" ? renderServerSettingsPage() : ""}
    </main>
  `;
}

function formatMemoryMb(value) {
  const amount = Number(value) || 0;
  return amount >= 1024 ? `${(amount / 1024).toFixed(amount % 1024 ? 1 : 0)} GB` : `${amount} MB`;
}

function accentColorName(color) {
  return ACCENT_PRESETS.find(([, hex]) => hex === color)?.[0] || "Custom";
}

function accentToHsv(color) {
  const [red, green, blue] = color.slice(1).match(/../g).map((pair) => Number.parseInt(pair, 16) / 255);
  const brightness = Math.max(red, green, blue);
  const chroma = brightness - Math.min(red, green, blue);
  let hue = 0;
  if (chroma) {
    if (brightness === red) hue = (green - blue) / chroma;
    else if (brightness === green) hue = 2 + (blue - red) / chroma;
    else hue = 4 + (red - green) / chroma;
  }
  return {
    hue: (hue * 60 + 360) % 360,
    saturation: brightness ? chroma / brightness : 0,
    brightness,
  };
}

function hsvToAccent({ hue, saturation, brightness }) {
  const chroma = brightness * saturation;
  const sector = (hue % 360) / 60;
  const middle = chroma * (1 - Math.abs(sector % 2 - 1));
  const channels = [
    [chroma, middle, 0], [middle, chroma, 0], [0, chroma, middle],
    [0, middle, chroma], [middle, 0, chroma], [chroma, 0, middle],
  ][Math.floor(sector)];
  return "#" + channels.map((channel) =>
    Math.round((channel + brightness - chroma) * 255).toString(16).padStart(2, "0")
  ).join("");
}

function serverIconName(id) {
  return id === "normal" ? "Cube" : appThemes[id].name;
}

function renderServerIconPicker(id, value) {
  const selected = normalizeServerIcon(value);
  return `<div class="server-icon-picker">
    <span class="accent-picker-label" id="${id}-label">Server icon</span>
    <button class="server-icon-trigger" type="button" popovertarget="${id}" aria-labelledby="${id}-label ${id}-value">
      <span class="server-icon-preview">${renderThemeIcon(selected, 22)}</span>
      <span class="server-icon-value" id="${id}-value">${serverIconName(selected)}</span>
      <span class="styled-select-arrow" aria-hidden="true"></span>
    </button>
    <div class="accent-popover server-icon-panel" id="${id}" popover="auto" role="group" aria-labelledby="${id}-label">
      <div class="server-icon-options">${Object.keys(appThemes).map((icon) => `
      <label class="server-icon-option">
        <input type="radio" name="icon" value="${icon}" ${icon === selected ? "checked" : ""}>
        ${renderThemeIcon(icon, 32)}
        <span>${serverIconName(icon)}</span>
      </label>`).join("")}
      </div>
    </div>
  </div>`;
}

function renderAccentPicker(id, value) {
  const color = /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : ACCENT_PRESETS[0][1];
  return `
    <div class="accent-picker" data-accent-picker style="--accent-preview: ${color}">
      <span class="accent-picker-label" id="${id}-label">Accent color</span>
      <input type="hidden" name="color" value="${color}" />
      <button class="accent-trigger" type="button" popovertarget="${id}" aria-labelledby="${id}-label ${id}-value">
        <span class="accent-chip" aria-hidden="true"></span>
        <span class="accent-value" id="${id}-value">${accentColorName(color)}</span>
        <span class="styled-select-arrow" aria-hidden="true"></span>
      </button>
      <div class="accent-popover" id="${id}" popover="auto" role="group" aria-labelledby="${id}-label">
        <div class="accent-popover-heading"><strong>Color palette</strong><span>12 presets</span></div>
        <div class="accent-swatches" role="group" aria-label="Color presets">
          ${ACCENT_PRESETS.map(([name, hex]) => `
            <button class="accent-swatch" type="button" data-hex="${hex}" style="--swatch: ${hex}" title="${name}" aria-label="${name}" aria-pressed="${hex === color}">
              <span aria-hidden="true">✓</span>
            </button>`).join("")}
        </div>
        <div class="accent-custom">
          <span class="accent-picker-label">Custom color</span>
          <div class="accent-shades" role="group" tabindex="0" aria-label="Color shade. Use left and right for saturation, up and down for brightness.">
            <span class="accent-shade-marker" aria-hidden="true"></span>
          </div>
          <label class="accent-hue-row" for="${id}-hue">Hue
            <input class="accent-hue" id="${id}-hue" type="range" min="0" max="360" step="1" value="0" />
          </label>
          <div class="accent-custom-row">
            <span class="accent-preview" aria-hidden="true"></span>
            <span class="accent-preview-label">Preview</span>
            <button class="accent-apply" type="button">Apply</button>
          </div>
        </div>
      </div>
    </div>`;
}

function bindAccentPickers() {
  document.querySelectorAll("[data-accent-picker]").forEach((picker) => {
    const colorField = picker.querySelector('[name="color"]');
    const trigger = picker.querySelector(".accent-trigger");
    const value = picker.querySelector(".accent-value");
    const panel = picker.querySelector(".accent-popover");
    const hueField = picker.querySelector(".accent-hue");
    const shades = picker.querySelector(".accent-shades");
    const swatches = picker.querySelectorAll(".accent-swatch");
    const clamp = (amount) => Math.min(1, Math.max(0, amount));
    let hsv = accentToHsv(colorField.value);
    let shadePointer = null;

    const previewColor = () => {
      panel.style.setProperty("--custom-preview", hsvToAccent(hsv));
      panel.style.setProperty("--picker-hue", hsv.hue);
      shades.style.setProperty("--shade-x", (hsv.saturation * 100) + "%");
      shades.style.setProperty("--shade-y", ((1 - hsv.brightness) * 100) + "%");
    };

    const applyColor = (color) => {
      colorField.value = color;
      value.textContent = accentColorName(color);
      picker.style.setProperty("--accent-preview", color);
      swatches.forEach((swatch) => swatch.setAttribute("aria-pressed", String(swatch.dataset.hex === color)));
      colorField.dispatchEvent(new Event("input", { bubbles: true }));
      panel.hidePopover();
      trigger.focus({ preventScroll: true });
    };

    panel.addEventListener("beforetoggle", (event) => {
      shadePointer = null;
      if (event.newState !== "open") return;
      hsv = accentToHsv(colorField.value);
      hueField.value = hsv.hue;
      previewColor();
    });
    hueField.addEventListener("input", () => {
      hsv.hue = hueField.valueAsNumber;
      previewColor();
    });

    const pointToShade = (event) => {
      const bounds = shades.getBoundingClientRect();
      hsv.saturation = clamp((event.clientX - bounds.left) / bounds.width);
      hsv.brightness = 1 - clamp((event.clientY - bounds.top) / bounds.height);
      previewColor();
    };
    shades.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      shadePointer = event.pointerId;
      shades.setPointerCapture(event.pointerId);
      pointToShade(event);
    });
    shades.addEventListener("pointermove", (event) => {
      if (shadePointer !== event.pointerId) return;
      if (event.buttons & 1) pointToShade(event);
      else shadePointer = null;
    });
    shades.addEventListener("pointerup", (event) => {
      if (shadePointer !== event.pointerId) return;
      pointToShade(event);
      shadePointer = null;
    });
    shades.addEventListener("pointercancel", (event) => {
      if (shadePointer === event.pointerId) shadePointer = null;
    });
    shades.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      if (event.key === "ArrowLeft") hsv.saturation = clamp(hsv.saturation - step);
      else if (event.key === "ArrowRight") hsv.saturation = clamp(hsv.saturation + step);
      else if (event.key === "ArrowUp") hsv.brightness = clamp(hsv.brightness + step);
      else if (event.key === "ArrowDown") hsv.brightness = clamp(hsv.brightness - step);
      else return;
      event.preventDefault();
      previewColor();
    });
    panel.querySelector(".accent-apply").addEventListener("click", () => applyColor(hsvToAccent(hsv)));
    swatches.forEach((swatch) => swatch.addEventListener("click", () => applyColor(swatch.dataset.hex)));
  });
}

function renderJavaRuntimeRow() {
  const java = state.serverJava;
  const choice = String(java?.choice || "automatic");
  const versions = java?.versions || [];
  const previous = choice !== "automatic" && !versions.some(version => String(version) === choice);
  const detail = !java ? "Checking compatible versions…" : java.requiredMajor
    ? "Automatic uses Java " + java.requiredMajor + ". Changes apply on the next start." : "Compatibility check unavailable.";
  return `<section class="java-runtime-row" id="javaRuntimeRow" aria-label="Java Runtime">
    <div class="settings-section-heading"><div><strong><label for="serverJavaVersion">Java Runtime</label></strong><span>${escapeHtml(detail)}</span></div></div>
    <select id="serverJavaVersion" aria-label="Java Runtime" ${!java || state.javaSettingsPending ? "disabled" : ""}>
      <option value="automatic" ${choice === "automatic" ? "selected" : ""}>Automatic</option>
      ${previous ? `<option value="${escapeHtml(choice)}" selected disabled>${choice === "previous" ? "Previous selection" : "Java " + escapeHtml(choice) + " (unavailable)"}</option>` : ""}
      ${versions.map(version => `<option value="${version}" ${String(version) === choice ? "selected" : ""}>Java ${version}</option>`).join("")}
    </select>
    ${java?.error || java?.warning ? `<p class="form-note">${escapeHtml(java.error || java.warning)}</p>` : ""}
  </section>`;
}

function refreshJavaRuntimeRow() {
  const row = document.getElementById("javaRuntimeRow");
  if (!row) return;
  row.outerHTML = renderJavaRuntimeRow();
  enhanceSelects();
  bindJavaRuntimeSelect();
}

function bindJavaRuntimeSelect() {
  document.getElementById("serverJavaVersion")?.addEventListener("change", async event => {
    const version = event.currentTarget.value;
    const id = state.selectedId;
    const request = serverSettingsRequest;
    const isCurrent = () => id === state.selectedId && request === serverSettingsRequest;
    state.javaSettingsPending = true;
    refreshJavaRuntimeRow();
    try {
      const java = await window.minecraftAPI.setServerJavaVersion(id, version);
      if (isCurrent()) state.serverJava = java;
    } catch (error) {
      if (isCurrent()) state.serverJava = { ...state.serverJava, error: error.message };
    } finally {
      if (isCurrent()) {
        state.javaSettingsPending = false;
        refreshJavaRuntimeRow();
      }
    }
  });
}

function renderServerSettingsPage() {
  const server = selectedServer();
  if (state.serverSettingsLoading) {
    return `<section class="workspace-panel" aria-labelledby="serverSettingsTitle" aria-busy="true"><h2 id="serverSettingsTitle">Server settings</h2><p>Loading settings…</p></section>`;
  }
  const memory = state.memoryModel;
  const draft = state.memoryDraft || memory;
  const minimum = 512;
  const maximum = Math.max(1024, Number(memory?.limitMb) || 4096);
  const span = maximum - minimum;
  const minPercent = span ? ((Number(draft?.minMemoryMb) - minimum) / span) * 100 : 0;
  const maxPercent = span ? ((Number(draft?.maxMemoryMb) - minimum) / span) * 100 : 100;
  const backup = state.backupDraft || state.backupModel || {};
  const lastBackup = backup.lastBackupAt ? new Date(backup.lastBackupAt).toLocaleString() : "No backup created yet";
  const running = state.runtime?.status === "running";
  const firstInterval = Date.parse(state.runtime?.startedAt) + (Number(backup.intervalMinutes) || 60) * 60_000;
  const nextInterval = Math.max(firstInterval, Date.parse(backup.nextBackupAt) || 0);
  const nextBackup = !backup.enabled ? "Disabled" : running && Number.isFinite(nextInterval)
    ? new Date(nextInterval).toLocaleString() : "When the server is running";
  return `
    <section class="workspace-panel server-settings-page" aria-labelledby="serverSettingsTitle">
        <h2 id="serverSettingsTitle">Server settings</h2>
        <p>Change server details, RAM limits, and world backups.</p>
        <form id="serverIdentityForm" class="server-identity-settings">
          <div class="settings-section-heading"><div><strong>Server identity</strong><span>Change how this server appears in BlockHost.</span></div></div>
          <div class="identity-fields">
            <label>Server name<input name="serverName" maxlength="80" required value="${escapeHtml(server?.name || "")}" /></label>
            ${renderAccentPicker("server-accent", server?.color)}
            ${renderServerIconPicker("server-icon", state.identityIcon || server?.icon)}
          </div>
          <button class="secondary save-server-identity" type="submit" ${state.identityPending ? "disabled" : ""}>${state.identityPending ? "Saving…" : "Save identity"}</button>
          ${state.identityError ? `<p class="form-error">${escapeHtml(state.identityError)}</p>` : ""}
        </form>

        ${renderJavaRuntimeRow()}

        <div class="settings-action-grid">
          <article><div><strong>Full properties</strong><span>Edit every available server.properties option.</span></div><button class="secondary" id="openFullProperties" type="button">Properties</button></article>
          <article><div><strong>Export server</strong><span>Save your worlds, settings and add-ons. Import may need internet to restore exact downloads.</span></div><button class="primary" id="exportServer" type="button" ${state.transferPending ? "disabled" : ""}>Export</button></article>
          <article><div><strong>Export world</strong><span>Save only the generated world as a portable ZIP archive.</span></div><button class="secondary" id="exportWorld" type="button" ${state.transferPending ? "disabled" : ""}>Export world</button></article>
        </div>

        <form id="backupSettingsForm" class="backup-settings">
          <div class="settings-section-heading"><div><strong>Automatic world backups</strong><span>Back up at intervals while the server runs and whenever it shuts down cleanly.</span></div><label class="backup-switch"><input name="enabled" type="checkbox" ${backup.enabled ? "checked" : ""} /><span>Enabled</span></label></div>
          <div class="backup-destination">
            <div><strong>Backup folder</strong><span title="${escapeHtml(backup.destination || "")}">${escapeHtml(backup.destination || "Choose where backups should be saved")}</span></div>
            <button class="secondary" id="chooseBackupFolder" type="button" ${state.backupPending ? "disabled" : ""}>Choose folder</button>
          </div>
          <div class="backup-grid">
            <label>Backup interval
              <select name="intervalMinutes">
                ${[[15,"15 minutes"],[30,"30 minutes"],[60,"1 hour"],[180,"3 hours"],[360,"6 hours"],[720,"12 hours"],[1440,"24 hours"]].map(([value,label]) => `<option value="${value}" ${Number(backup.intervalMinutes) === value ? "selected" : ""}>${label}</option>`).join("")}
              </select>
            </label>
            <label>Backup history
              <select name="mode">
                <option value="replace" ${backup.mode === "replace" ? "selected" : ""}>Replace the latest backup</option>
                <option value="history" ${backup.mode === "history" ? "selected" : ""}>Keep every backup</option>
              </select>
            </label>
          </div>
          <p class="backup-warning">For local backups without cloud trash or version history, choose a folder outside OneDrive or other synced folders.</p>
          <div class="backup-status"><span><strong>Last backup</strong>${escapeHtml(lastBackup)}</span><span><strong>Next backup</strong>${escapeHtml(nextBackup)}</span></div>
          ${backup.lastError ? `<p class="backup-warning">Last attempt failed: ${escapeHtml(backup.lastError)}</p>` : ""}
          ${state.backupError ? `<p class="form-error">${escapeHtml(state.backupError)}</p>` : ""}
          <div class="backup-actions"><button class="secondary" type="submit" ${state.backupPending ? "disabled" : ""}>${state.backupPending ? "Working…" : "Save backup settings"}</button><button class="primary" id="runBackupNow" type="button" ${state.backupPending || !backup.destination ? "disabled" : ""}>Back up now</button></div>
        </form>

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
            <p class="memory-autosave"><span class="${state.memoryPending ? "spinner" : "autosave-check"}">${state.memoryPending ? "" : "✓"}</span>${state.memoryPending ? "Saving RAM limits…" : "Changes save automatically."}</p>
          ` : `<p class="form-error">${escapeHtml(state.memoryError || "Memory settings are unavailable.")}</p>`}
          ${state.memoryError && memory ? `<p class="form-error">${escapeHtml(state.memoryError)}</p>` : ""}
        </form>

        <div class="danger-zone"><div><strong>Delete server</strong><span>Permanently remove this server and its world from this computer.</span></div><button class="danger-ghost" id="deleteServer" type="button">Delete server</button></div>
    </section>`;
}

function suggestedServerName() {
  const base = "My Minecraft Server";
  const names = new Set(state.servers.map(server => server.name.toLowerCase()));
  let name = base;
  for (let number = 2; names.has(name.toLowerCase()); number++) name = base + " " + number;
  return name;
}

function renderCreateModal() {
  if (!state.createOpen) return "";
  const hasSeed = Boolean(state.createDraft.seed.trim());
  const options = state.versions.map((version) =>
    `<option value="${escapeHtml(version.id)}" ${state.createDraft.version === version.id ? "selected" : ""}>${escapeHtml(version.label)}</option>`
  ).join("");
  return `
    <div class="overlay" role="presentation">
      <section class="modal create-modal" role="dialog" aria-modal="true" aria-labelledby="createTitle">
        <button class="modal-close" id="closeCreate" type="button" aria-label="Close" ${state.createPending || state.packBusy ? "disabled" : ""}>×</button>
        <p class="eyebrow">Minecraft Java Edition</p>
        <h2 id="createTitle">Create a server</h2>
        ${state.createPack ? `<div class="pack-selected"><div><strong>${escapeHtml(state.createPack.name)}</strong><small>${state.createPack.source && state.createPack.source !== "local" ? `${catalogueSourceName(state.createPack.source)} · ` : ""}${escapeHtml(state.createPack.packVersion)} · ${escapeHtml(state.createPack.type)} ${escapeHtml(state.createPack.loaderVersion)} · ${state.createPack.fileCount} files · ${formatBytes(state.createPack.totalBytes)}</small><small>${state.createPack.format === "publisher-server" ? "Official dedicated-server pack. Versions are set by the publisher." : `Versions are set by the pack.${state.createPack.skipped ? " Client files and other unnecessary files are skipped." : ""}`}</small></div></div>` : ""}
        ${state.packBusy && !state.packBrowserOpen ? '<p class="form-note" role="status">Reading and checking the selected pack…</p>' : ""}
        <form id="createForm">
          <fieldset class="create-fields" ${state.createPending || state.packBusy ? "disabled" : ""}>
          <label>Server name<input name="serverName" maxlength="80" placeholder="${escapeHtml(suggestedServerName())}" value="${escapeHtml(state.createDraft.name)}" /></label>
          <details class="create-advanced" id="createAdvanced" ${state.createAdvancedOpen || state.createWorldImport ? "open" : ""}>
            <summary>Advanced options <small>Version, world, color and icon</small></summary>
            <div class="create-advanced-fields">
          <div class="form-row create-identity-options">
            <label>Server type
              <select name="serverType" id="serverType" ${state.createPack ? "disabled" : ""}>
                ${renderAppOptionList(serverTypeOptions, state.createType)}
              </select>
            </label>
            ${renderAccentPicker("create-accent", state.createDraft.color)}
            ${renderServerIconPicker("create-icon", state.createDraft.icon)}
          </div>
          <label>Minecraft version
            <select name="version" required ${state.createPack || state.versionsLoading || !state.versions.length ? "disabled" : ""}>
              ${state.versionsLoading ? '<option>Loading versions…</option>' : options || '<option>No versions available</option>'}
            </select>
          </label>
          <label><span class="field-label-row"><span>World seed</span><span class="field-optional">Optional</span></span>
            <input name="seed" maxlength="200" autocomplete="off" placeholder="Leave blank for a random world" value="${escapeHtml(state.createDraft.seed)}" ${state.createWorldImport || state.createPack?.hasWorld ? "disabled" : ""} />
            <small class="field-help">${state.createPack?.hasWorld ? "This server pack includes an existing world." : state.createWorldImport ? "Remove the imported world to enter a seed." : "Enter a number or text seed, or leave this empty for a random world."}</small>
          </label>
          <div class="world-import-picker">
            <div><strong>Existing world <span>Optional</span></strong><small id="worldImportStatus">${state.createWorldImport ? `${escapeHtml(state.createWorldImport.label)} (${escapeHtml(state.createWorldImport.kind)})` : state.createPack?.hasWorld ? "World included in this server pack." : hasSeed ? WORLD_IMPORT_SEED_HINT : WORLD_IMPORT_HINT}</small></div>
            <div><button class="secondary small" id="chooseWorldImport" type="button" aria-describedby="worldImportStatus" ${hasSeed || state.createPending || state.createPack?.hasWorld ? "disabled" : ""}>ZIP</button><button class="secondary small" id="chooseWorldFolder" type="button" aria-describedby="worldImportStatus" ${hasSeed || state.createPending || state.createPack?.hasWorld ? "disabled" : ""}>Folder</button><button class="subtle-action small" id="removeWorldImport" type="button" ${state.createWorldImport ? "" : "hidden"} ${state.createPending ? "disabled" : ""}>Remove</button></div>
          </div>
            </div>
          </details>
          ${state.versionsError ? `<div class="create-versions-error"><p class="form-error">Couldn’t load Minecraft versions. ${escapeHtml(state.versionsError)}</p><button type="button" class="secondary small" id="retryCreateVersions">Try again</button></div>` : ""}
          ${state.createPack?.optional ? `<label class="pack-optional"><input type="checkbox" id="packOptional" ${state.packIncludeOptional ? "checked" : ""}> Include ${state.createPack.optional} optional server files</label>` : ""}
          ${state.createPack?.requiresStartupCheck ? `<div class="field-help"><p>BlockHost checks that this pack starts and saves it for repair if it needs changes.</p><label class="pack-optional"><input type="checkbox" id="acceptPackEula" name="acceptPackEula" required ${state.packEulaAccepted ? "checked" : ""}> <span>I accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a> and agree to run the test.</span></label></div>` : ""}
          ${state.createPackError ? renderPackError(state.createPackError, true) : ""}
          <button class="primary full" type="submit" ${state.createPending || state.versionsLoading || !state.versions.length ? "disabled" : ""}>
            ${state.createPending ? "Setting up…" : state.createPack?.requiresStartupCheck ? "Test and create server" : state.createPack ? "Create modpack server" : "Create server"}
          </button>
          </fieldset>
        </form>
        ${state.createPending ? `<div class="pack-install-progress" role="status"><span class="spinner"></span><p id="packProgressMessage">${escapeHtml(state.packProgress)}</p>${state.createPack ? '<button type="button" class="secondary small" id="cancelPackInstall">Cancel setup</button>' : ""}</div>` : ""}
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
  const running = runtimeCanStop(runtime);
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

function catalogueSourceName(source) {
  return source === "curseforge" ? "CurseForge" : "Modrinth";
}

function renderInstalledAddon(item) {
  const pending = Boolean(state.addonsPending);
  const source = ["modrinth", "curseforge"].includes(item.source) ? catalogueSourceName(item.source) : item.managed ? "Manual" : "Detected file";
  const project = item.catalogue || (item.projectId && item);
  const projectLink = project?.source === "modrinth"
    ? `<button class="secondary small" data-addon-action="details" data-project-id="${escapeHtml(project.projectId)}" type="button">${catalogueSourceName(project.source)}</button>` : "";
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
    <article class="addon-card ${item.enabled ? "" : "disabled-addon"}" data-addon-search="${escapeHtml([item.title, item.fileName, item.versionNumber].join(" ").toLowerCase())}">
      ${renderAddonIcon(item)}
      <div class="addon-copy">
        <div class="addon-heading"><strong>${escapeHtml(item.title)}</strong><span>${item.enabled ? "Enabled" : "Disabled"}</span></div>
        <p>${escapeHtml(item.versionNumber || "Unknown version")} · ${escapeHtml(item.loader || "unknown")} · Minecraft ${escapeHtml(item.minecraftVersion || "unverified")} · ${escapeHtml(source)}</p>
        <small>${escapeHtml(item.fileName)}</small>
        <small class="addon-compatibility">${addonSide(item.environment).label}</small>
        ${dependencyStatus}${warnings}${item.optionalDependencies?.length ? `<small>${item.optionalDependencies.length} optional dependenc${item.optionalDependencies.length === 1 ? "y suggestion" : "y suggestions"} available.</small>` : ""}
        ${history}
        ${item.update?.unavailable ? '<small>Update information is temporarily unavailable.</small>' : ""}
        ${confirmation}
      </div>
      <div class="addon-actions">
        ${projectLink}
        ${update}
        <button class="secondary small" data-addon-action="toggle" data-addon-id="${escapeHtml(item.id)}" data-addon-enabled="${item.enabled ? "false" : "true"}" data-addon-cascade="${item.enabled && cascadeCount ? "true" : "false"}" type="button" ${pending ? "disabled" : ""}>${item.enabled && cascadeCount ? `Disable +${cascadeCount}` : item.enabled ? "Disable" : "Enable"}</button>
        <button class="danger-ghost small" data-addon-action="remove" data-addon-id="${escapeHtml(item.id)}" type="button" ${pending ? "disabled" : ""}>Remove</button>
      </div>
    </article>`;
}

function renderAddonSearchResult(result, recommendation = false) {
  const pending = Boolean(state.addonsPending);
  const source = result.source || "modrinth";
  const installed = (state.addonsModel?.items || []).find((item) => (item.source || "modrinth") === source && item.projectId === result.projectId);
  const server = selectedServer();
  const compatibility = recommendation && result.versionNumber ? `Verified ${result.versionNumber}`
      : `Minecraft ${server?.version || "server"} · checked before install`;
  return `
    <article class="addon-card search-result ${recommendation ? "recommendation-card" : ""}">
      ${renderAddonIcon(result)}
      <div class="addon-copy">
        <div class="addon-heading"><strong>${escapeHtml(result.title)}</strong><span>${formatCompactNumber(result.downloads)} downloads</span></div>
        <p>${escapeHtml(result.description || "No description provided.")}</p>
        <small>${catalogueSourceName(source)} · By ${escapeHtml(result.author || "Unknown author")}</small>
        <small class="addon-compatibility">${escapeHtml(compatibility)}</small>
        <small>${addonSide(state.addonsModel?.kind === "plugins" ? "server_only" : result.environment).label}</small>
      </div>
      <div class="addon-actions">
        <button class="secondary small" data-addon-action="details" data-project-id="${escapeHtml(result.projectId)}" type="button">Details</button>
        ${installed
          ? `<button class="installed-addon small" type="button" disabled>${installed.enabled ? "Installed" : "Installed · disabled"}</button>`
          : `<button class="primary small" data-addon-action="install" data-project-id="${escapeHtml(result.projectId)}" data-version-id="${escapeHtml(result.versionId || "")}" data-project-title="${escapeHtml(result.title)}" data-icon-url="${escapeHtml(result.iconUrl || "")}" type="button" ${pending ? "disabled" : ""}>Install</button>`}
      </div>
    </article>`;
}

function renderCopyClientMods(items) {
  const groups = clientModList(items);
  const count = groups.reduce((sum, [, mods]) => sum + mods.length, 0);
  return `<button class="secondary" id="copyClientMods" type="button" ${count ? "" : "disabled"}>Copy client-side mods</button>`;
}

async function copyClientMods() {
  const server = selectedServer();
  const groups = clientModList(state.addonsModel?.items || []);
  if (!server || !groups.length) return;
  const sections = groups.map(([heading, items]) => [
    heading,
    ...items.map((item) => {
      const project = item.projectId && item.source !== "curseforge" ? ` · https://modrinth.com/mod/${encodeURIComponent(item.projectId)}` : "";
      return `- ${item.title} (${item.fileName})${project}`;
    }),
  ].join("\n"));
  await writeClipboard([`${server.name} · Minecraft ${server.version} · ${server.typeLabel}`, ...sections].join("\n\n"), "Client mod list copied.");
}

function renderAddonsPage() {
  const server = selectedServer();
  const heading = '<h2 id="addonsTitle">Add-ons</h2>';
  if (state.addonTab === "modpacks") return `<section class="workspace-panel addons-page" aria-labelledby="addonsTitle">${heading}${renderAddonTabs()}${renderPackContents()}</section>`;
  if (state.addonTab === "installed" && state.installedAddonTab === "pack") {
    const pack = server.modpack;
    const known = state.addonsModel?.packInventoryKnown;
    const items = (state.addonsModel?.items || []).filter(item => !known || item.fromModpack);
    return `<section class="workspace-panel addons-page" aria-labelledby="addonsTitle">${heading}${renderAddonTabs()}${renderInstalledAddonTabs()}
      ${pack ? `<div class="pack-selected"><div><strong>${escapeHtml(pack.name)} · ${escapeHtml(pack.version)}</strong><small>Keep players on the same release; changing individual mods may affect compatibility.</small></div></div>` : '<p class="addon-empty">This server has no installed modpack.</p>'}
      ${pack ? `<section class="addon-section installed-addons">
        ${!known ? '<p>Pack membership was not recorded for this install. The list shows files currently installed on the server.</p>' : ""}
        ${renderInstalledAddonSearch(items, "Search modpack mods", "No modpack mods are currently installed.")}
      </section>` : ""}
    </section>`;
  }
  if (state.addonsLoading) return `<section class="workspace-panel" aria-labelledby="addonsTitle" aria-busy="true">${heading}<p>Scanning ${escapeHtml(server.name)} files…</p></section>`;
  if (!state.addonsModel) {
    return `<section class="workspace-panel" aria-labelledby="addonsTitle">${heading}<p class="form-error">${escapeHtml(state.addonError || "Could not load add-ons")}</p><button class="secondary" id="retryAddons" type="button">Try again</button></section>`;
  }
  if (!state.addonsModel.supported) {
    return `<section class="workspace-panel addons-page" aria-labelledby="addonsTitle">${heading}${renderAddonTabs()}${state.addonTab === "installed" ? renderInstalledAddonTabs() : ""}<p>Vanilla Minecraft does not load server mods or plugins. Create a modded or plugin-compatible server to use add-ons.</p></section>`;
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
    <section class="workspace-panel addons-page" aria-labelledby="addonsTitle">
        <div class="addons-title-row">
          <div><h2 id="addonsTitle">Add-ons</h2><p>${escapeHtml(kind[0].toUpperCase() + kind.slice(1))} for ${escapeHtml(server.typeLabel)} ${escapeHtml(server.version)}</p></div>
          <div class="addons-toolbar" ${state.addonTab !== "installed" ? "hidden" : ""}>
            <label class="release-channel">Updates
              <select id="addonReleaseChannel" ${state.addonsPending ? "disabled" : ""}>
                <option value="stable" ${state.addonsModel.releaseChannel === "stable" ? "selected" : ""}>Stable</option>
                <option value="beta" ${state.addonsModel.releaseChannel === "beta" ? "selected" : ""}>Stable + beta</option>
                <option value="alpha" ${state.addonsModel.releaseChannel === "alpha" ? "selected" : ""}>All channels</option>
              </select>
            </label>
            <button class="secondary" id="installManualAddon" type="button" ${state.addonsPending ? "disabled" : ""}>Install from file</button>
            <button class="secondary" id="checkAddonUpdates" type="button" ${state.addonsPending ? "disabled" : ""}>Check updates</button>
            ${kind === "mods" ? renderCopyClientMods(items) : ""}
            <button class="primary" id="updateAllAddons" type="button" ${state.addonsPending || !items.some((item) => item.update?.available) ? "disabled" : ""}>Update all</button>
          </div>
        </div>

        ${renderAddonTabs()}
        ${state.addonTab === "installed" ? renderInstalledAddonTabs() : ""}
        ${state.droppedAddon?.serverId === server.id ? `
          <div class="properties-note">
            <strong>${escapeHtml(state.droppedAddon.file.name)}</strong>
            ${state.droppedAddon.bundle ? "<p>Extract the add-on files, then drop the individual JAR you want to install.</p>" : '<button class="primary small" id="confirmDroppedAddon" type="button">Install on this server</button>'}
          </div>` : ""}
        <section class="addon-section installed-addons" ${state.addonTab !== "installed" ? "hidden" : ""}>
          <div class="addon-section-title installed-title"><h3>Installed ${escapeHtml(kind)} <span>${items.length}</span></h3>${state.addonsInspecting ? '<small role="status">Reading file details…</small>' : ""}</div>
          <div class="addon-filter-row" role="group" aria-label="Filter installed add-ons">
            ${Object.entries(installedCounts).map(([filter, count]) => `<button class="addon-filter-chip ${state.addonInstalledFilter === filter ? "active" : ""}" data-installed-filter="${filter}" type="button">${filter === "all" ? "All" : filter[0].toUpperCase() + filter.slice(1)} <span>${count}</span></button>`).join("")}
          </div>
          ${renderInstalledAddonSearch(visibleItems, `Search installed ${kind}`, items.length ? `No ${state.addonInstalledFilter} ${kind} found.` : `No ${kind} are installed yet.`)}
        </section>

        <section class="addon-section addon-recommendations-section" ${state.addonTab !== "browse" || state.addonHasSearched ? "hidden" : ""}>
          <div class="addon-section-title"><div><h3>Recommended ${escapeHtml(kind)}</h3><p>Popular, server-compatible choices for ${escapeHtml(server.typeLabel)} ${escapeHtml(server.version)}.</p></div><span>Scroll to explore →</span></div>
          ${state.addonRecommendationsLoading
            ? `<div class="recommendation-loading"><span class="spinner"></span><span>Finding compatible recommendations…</span></div>`
            : state.addonRecommendations.length
              ? `<div class="recommendation-scroller">${state.addonRecommendations.map((item) => renderAddonSearchResult(item, true)).join("")}</div>`
              : `<p class="addon-empty">${escapeHtml(state.addonRecommendationsError || "No recommendations are available for this exact server version yet.")}</p>`}
        </section>

        <section class="addon-section addon-search-section" ${state.addonTab !== "browse" ? "hidden" : ""}>
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

        ${state.addonError && !(state.addonTab === "installed" && modpackSetup(server)?.status === "repair")
          ? `<p class="form-error">${escapeHtml(state.addonError)}</p>` : ""}
        ${state.addonsPending ? `<div class="addon-progress"><span class="spinner"></span><strong>${escapeHtml(state.addonsPending)}…</strong><small>Files are staged and verified before the server is changed.</small></div>` : ""}
    </section>`;
}

function renderInstalledAddonSearch(items, label, emptyMessage) {
  return `<input class="installed-addon-search" type="search" id="installedAddonSearch" aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(label)}…" value="${escapeHtml(state.installedAddonSearch[state.installedAddonTab])}">
    <div class="addon-list installed-addon-grid">
      ${items.map(renderInstalledAddon).join("")}
      <p class="addon-empty" ${items.length ? "hidden" : ""}>${escapeHtml(emptyMessage)}</p>
      <p class="addon-empty" id="installedAddonNoMatches" hidden>No matches found.</p>
    </div>`;
}

function renderStartModal() {
  if (!state.pendingStart) return "";
  if (state.pendingStart.kind === "eula") {
    return `
      <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="eulaTitle">
        <h2 id="eulaTitle">Minecraft’s server rules</h2>
        <p>Minecraft asks you to agree to its rules before starting a server. Read the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>, then choose Accept and start if you agree.</p>
        <div class="modal-actions"><button class="secondary" id="cancelStart" type="button">Cancel</button><button class="primary" id="acceptEula" type="button">Accept and start</button></div>
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
  return "";
}

function renderStartupDiagnosis(runtime) {
  const diagnosis = runtime.startupDiagnosis;
  if (!diagnosis) return "";
  return `<h2>${escapeHtml(statusLabel(runtime.status))}</h2>
    <p><strong>${escapeHtml(diagnosis.problem)}</strong></p>
    ${diagnosis.mod ? `<p><strong>Suspected mod</strong> ${escapeHtml(diagnosis.mod)}</p>` : ""}
    <p>${escapeHtml(diagnosis.cause)}</p>
    <p><strong>Recommended fix</strong> ${escapeHtml(diagnosis.fix)}</p>
    ${diagnosis.evidence?.length ? `<details><summary>Relevant log lines</summary><pre>${escapeHtml(diagnosis.evidence.join("\n"))}</pre></details>` : ""}`;
}

function renderModpackStatus(runtime, server) {
  if (runtime.status === "running" && runtime.joinAddress) {
    return `<h2>Join in Minecraft Java Edition</h2>
      <p>In Multiplayer, open Direct Connection and enter <strong>${escapeHtml(runtime.joinAddress)}</strong>.</p>
      <button class="secondary small" type="button" data-modpack-action="copy-address">Copy address</button>`;
  }
  const setup = modpackSetup(server, runtime);
  if (setup?.status !== "repair" || ["starting", "stopping", "startup-stalled", "recovering"].includes(runtime.status)) return "";
  const diagnosis = setup.diagnosis || {};
  const requirement = diagnosis.requirements?.find(item => (item.kind === "missing" || item.kind === "incompatible") &&
    !["minecraft", "forge", "neoforge", "fabricloader", "quilt_loader", "java"].includes(item.modId));
  const currentMods = state.serverView === "addons" && state.addonTab === "installed" && state.installedAddonTab === "files";
  const busy = state.addonsPending || state.pendingAction || state.javaSettingsPending || runtimeCanStop(runtime);
  let nextStep = "Review the installed mods, then retry startup.";
  let actions = currentMods ? [] : [["mods", "Manage mods"]];
  if (diagnosis.kind === "dependency" && requirement) {
    const version = requirement.version && requirement.version !== "*" ? ` (${requirement.version})` : "";
    const subject = requirement.requiredByName || requirement.requiredBy || "This pack";
    nextStep = `${subject} needs ${requirement.dependencyName || requirement.modId}${version}. Install a publisher release for Minecraft ${server.version} and ${server.typeLabel}, then retry startup.`;
    actions = [["find-dependency", "Find compatible releases", requirement.modId], ["add-file", "Add dependency file"]];
    const bundled = state.addonsServerId === server.id && state.addonsModel?.bundledDependency;
    if (requirement.kind === "missing" && bundled?.modId === requirement.modId) {
      nextStep = `${bundled.name} is included in this pack and disabled. BlockHost can try it in a private startup check.`;
      actions.unshift(["try-bundled-dependency", `Enable ${bundled.name} and retry`]);
    }
  } else if (diagnosis.kind === "client-mod") {
    nextStep = diagnosis.mod
      ? `Find ${diagnosis.mod} in the installed mods and check for a server-compatible release before retrying startup.`
      : "Check the installed mods for client-only files before retrying startup.";
  } else if (diagnosis.kind === "java") {
    nextStep = diagnosis.javaMajor
      ? `Select Java ${diagnosis.javaMajor} in Java settings, then retry startup.`
      : "Check the Java version and RAM settings, then retry startup.";
    actions = [["java", "Open Java settings"]];
  } else if (diagnosis.kind === "port") {
    nextStep = "Stop the app using the server port or choose another port in Properties, then retry startup.";
    actions = [["properties", "Open properties"]];
  } else if (diagnosis.kind === "stall") {
    nextStep = "Check the Console for recent progress. For a slow pack, you can increase the startup time limits in App settings.";
    actions = [["console", "Open Console"]];
  } else if (diagnosis.kind === "runtime") {
    nextStep = "Check which Minecraft or loader version the mod requires in Technical details. Add a matching release of that mod, or choose another pack release.";
    actions.push(["browse-packs", "Browse packs"]);
  } else if (diagnosis.kind === "setup") {
    nextStep = "Check available disk space and the world folder, then retry startup.";
    actions = [["folder", "Open server folder"]];
  }
  const details = [diagnosis.cause, diagnosis.fix, ...(diagnosis.evidence || [])].filter(Boolean);
  const addonError = currentMods && state.addonsServerId === server.id && state.addonsModel?.supported && state.addonError;
  return `<h2>This modpack needs repair</h2>
    <p><strong>${escapeHtml(diagnosis.problem || "The server could not start.")}</strong></p>
    <p>${escapeHtml(nextStep)}</p>
    <div class="modpack-repair-actions">${actions.map(([action, label, query]) =>
      `<button class="secondary small" type="button" data-modpack-action="${action}" ${query ? `data-modpack-query="${escapeHtml(query)}"` : ""} ${busy ? "disabled" : ""}>${label}</button>`
    ).join("")}</div>
    ${addonError ? renderPackError(modpackErrorMessage({ message: addonError })) : ""}
    ${details.length ? `<details><summary>Technical details</summary><pre>${escapeHtml(details.join("\n"))}</pre></details>` : ""}`;
}

function renderPackError(message, setup = false) {
  const [summary, ...details] = message.trim().split(/\r?\n/);
  const nextStep = /unsupported|archive|manifest|server distribution|server zip|checksum/i.test(summary)
    ? "Choose another release or import a dedicated server ZIP from the publisher."
    : setup ? "Retry setup, or choose another pack." : "";
  return `<p class="form-error${setup ? " pack-setup-error" : ""}" role="alert">${escapeHtml(summary)}</p>
    ${nextStep ? `<p class="form-note">${escapeHtml(nextStep)}</p>` : ""}
    ${details.length ? `<details class="pack-error-details"><summary>Technical details</summary><pre>${escapeHtml(details.join("\n"))}</pre></details>` : ""}`;
}

function renderStartupCrashModal() {
  if (!state.startupDiagnostics) return "";
  return `<dialog class="modal" id="startupCrashDialog" aria-labelledby="startupCrashTitle" aria-describedby="startupCrashHelp">
    <h2 id="startupCrashTitle">${escapeHtml(statusLabel(state.runtime?.status))}</h2>
    <p id="startupCrashHelp">Review the errors in the Console, or copy the diagnostics and paste them into an AI chat for help.</p>
    <div class="startup-crash-links" aria-label="AI chat sites">
      ${diagnosticLinks.map(({ label, url }) => `<a class="secondary link-button" href="${url}" target="_blank" rel="noreferrer">${label}</a>`).join("")}
    </div>
    <div class="modal-actions">
      <button class="secondary" id="closeStartupCrash" type="button" autofocus>Back to Errors</button>
      <button class="primary" id="copyStartupDiagnostics" type="button">Copy diagnostics</button>
    </div>
    <div id="startupCopyStatus" role="status"></div>
  </dialog>`;
}

function renderQuickRestartModal() {
  if (!state.quickRestartNotice) return "";
  const running = runtimeCanStop(state.runtime || {});
  return `
    <div class="overlay"><section class="modal compact" role="dialog" aria-modal="true" aria-labelledby="quickRestartTitle">
      <p class="eyebrow">Settings saved</p>
      <h2 id="quickRestartTitle">${running ? "Restart the server to apply changes" : "Changes apply on the next start"}</h2>
      <p>${running ? "Minecraft reads these settings when the server starts. Stop and start the server when you are ready to use the new values." : "The new quick settings are saved and will be used the next time this server starts."}</p>
      <div class="modal-actions"><button class="primary" id="closeQuickRestartNotice" type="button">Got it</button></div>
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
        <p><strong>${escapeHtml(state.transferResult.fileName)}</strong> was saved${state.transferResult.archiveBytes ? ` (${formatBytes(state.transferResult.archiveBytes)})` : ""}.</p>
        ${state.transferResult.downloadCount ? `<p>Import requires internet to restore ${state.transferResult.downloadCount} exact downloads.</p>` : ""}
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
  return `<div class="drop-overlay" aria-hidden="true"><div><strong>Drop to open in BlockHost</strong><span>World folder or ZIP, modpack, server archive, or add-on JAR</span></div></div>`;
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
    page: document.querySelector(".content")?.dataset.page,
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
  if (snapshot.page === document.querySelector(".content")?.dataset.page) restore(".content", snapshot.content);
  restore("#consoleOutput", snapshot.console);
  restore(".modal", snapshot.modal);
  restore(".recommendation-scroller", snapshot.recommendations);
}

function closeStyledSelects(except = null) {
  document.querySelectorAll(".styled-select.open").forEach((wrapper) => {
    if (wrapper === except) return;
    wrapper.classList.remove("open");
    wrapper.querySelector(".styled-select-trigger")?.setAttribute("aria-expanded", "false");
  });
}

function enhanceSelects() {
  document.querySelectorAll("select:not([data-blockhost-select])").forEach((select) => {
    select.dataset.blockhostSelect = "true";
    select.classList.add("native-select-hidden");

    const wrapper = document.createElement("div");
    wrapper.className = `styled-select${select.disabled ? " disabled" : ""}`;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "styled-select-trigger";
    trigger.disabled = select.disabled;
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "styled-select-value";
    label.textContent = select.selectedOptions[0]?.textContent || "Choose…";
    const arrow = document.createElement("span");
    arrow.className = "styled-select-arrow";
    arrow.setAttribute("aria-hidden", "true");
    trigger.append(label, arrow);

    const menu = document.createElement("div");
    menu.className = "styled-select-menu";
    menu.setAttribute("role", "listbox");
    [...select.options].forEach((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `styled-select-option${option.selected ? " selected" : ""}`;
      item.textContent = option.textContent;
      item.disabled = option.disabled;
      item.hidden = option.hidden;
      item.dataset.value = option.value;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", option.selected ? "true" : "false");
      item.addEventListener("click", () => {
        if (item.disabled) return;
        select.value = option.value;
        label.textContent = option.textContent;
        menu.querySelectorAll(".styled-select-option").forEach((candidate) => {
          const selected = candidate === item;
          candidate.classList.toggle("selected", selected);
          candidate.setAttribute("aria-selected", selected ? "true" : "false");
        });
        closeStyledSelects();
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      menu.append(item);
    });

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = !wrapper.classList.contains("open");
      closeStyledSelects(opening ? wrapper : null);
      wrapper.classList.toggle("open", opening);
      trigger.setAttribute("aria-expanded", opening ? "true" : "false");
      if (opening) menu.querySelector(".styled-select-option.selected")?.scrollIntoView({ block: "nearest" });
    });
    menu.addEventListener("click", (event) => event.stopPropagation());
    wrapper.append(trigger, menu);
    select.insertAdjacentElement("afterend", wrapper);
  });
}

document.addEventListener("click", () => closeStyledSelects());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeStyledSelects();
});

function applyAppSettings(settings) {
  const previousOptions = state.appSettings?.options ?? defaultAppOptions;
  state.appSettings = { ...state.appSettings, ...settings };
  const options = state.appSettings.options;
  const filterChanged = previousOptions.consoleFilter !== options.consoleFilter;
  const scrollChanged = previousOptions.consoleAutoScroll !== options.consoleAutoScroll;
  if (filterChanged) state.consoleFilter = options.consoleFilter;
  if (scrollChanged) state.consoleAutoScroll = options.consoleAutoScroll;
  root.style.setProperty("--console-font-size", `${options.consoleFontSize}px`);
  root.style.setProperty("--server-gradient-strength", options.gradientStrength / 100);
  root.classList.toggle("console-hide-timestamps", !options.consoleTimestamps);
  const theme = normalizeAppTheme(state.appSettings.theme);
  root.dataset.theme = theme;
  root.style.setProperty("--theme-titlebar", appThemes[theme].titlebar);
  if (state.serverView === "console" && (filterChanged || scrollChanged)) render();
}

async function loadAppSettings() {
  applyAppSettings(await window.minecraftAPI.getAppSettings());
}

async function changeAppSettings(action, message, { feedbackId = "appSettingsFeedback" } = {}) {
  if (appSettingsDialog.getAttribute("aria-busy") === "true") return;
  const controls = appSettingsDialog.querySelectorAll("button, input, select");
  const activeControl = document.activeElement;
  const feedback = document.getElementById(feedbackId);
  appSettingsDialog.setAttribute("aria-busy", "true");
  controls.forEach((control) => { control.disabled = true; });
  feedback.textContent = "Working…";
  feedback.classList.remove("form-error");
  try {
    applyAppSettings(await action());
    feedback.textContent = message;
  } catch (error) {
    feedback.classList.add("form-error");
    feedback.textContent = error.message?.replace(/^Error invoking remote method '[^']+': Error:\s*/, "") || "Could not save app settings.";
  } finally {
    appSettingsDialog.removeAttribute("aria-busy");
    controls.forEach((control) => { control.disabled = false; });
    const selectedTheme = appSettingsDialog.querySelector(`[name="appTheme"][value="${state.appSettings.theme}"]`);
    if (selectedTheme) selectedTheme.checked = true;
    if (appSettingsDialog.open && appSettingsDialog.contains(activeControl) && !activeControl.hidden) activeControl.focus();
  }
}

function renderAppOptionList(choices, selected) {
  return Object.entries(choices).map(([value, label]) =>
    `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
  ).join("");
}

function renderDesktopSettings(settings) {
  const toggles = keys => keys.map(key => `<label><input type="checkbox" name="${key}" ${settings.desktop[key] ? "checked" : ""}> ${desktopOptions[key][0]}</label>`).join("");
  const quickFields = Object.entries(quickControlOptions).map(([key, field]) => {
    const value = settings.quickDefaults[key] ?? "";
    return `<label>${field.label}${field.choices
      ? `<select name="${key}"><option value="">Use server default</option>${renderAppOptionList(Object.fromEntries(field.choices.map(choice => [choice, choice[0].toUpperCase() + choice.slice(1)])), value)}</select>`
      : `<input name="${key}" type="number" min="${field.min}" max="${field.max}" placeholder="Use server default" value="${value}">`}</label>`;
  }).join("");
  return `
    <details class="app-option-settings">
      <summary>Notifications and window behavior</summary>
      <form id="desktopOptionsForm">
        <fieldset><legend>Notifications</legend><div class="app-option-toggles desktop-toggles">${toggles(["notifyReady", "notifyCrash", "notifyBackup", "notifyTray"])}</div></fieldset>
        <fieldset><legend>Window behavior</legend><div class="app-option-toggles desktop-toggles">${toggles(["rememberWindow", "reopenServer", "minimizeToTray"])}</div></fieldset>
        <div class="settings-actions"><button type="submit" class="primary">Save desktop preferences</button></div>
        <p class="app-section-feedback" id="desktopOptionsFeedback" role="status"></p>
      </form>
    </details>
    <details class="app-option-settings">
      <summary>Quick Controls for new servers</summary>
      <form id="quickDefaultsForm">
        <div class="app-option-grid">${quickFields}</div>
        <div class="settings-actions"><button type="submit" class="primary">Save Quick Controls</button></div>
        <p class="app-section-feedback" id="quickDefaultsFeedback" role="status"></p>
      </form>
    </details>
    <details class="app-option-settings" id="appStorageSettings">
      <summary>Storage</summary>
      <div id="appStorageInfo"></div>
      <div class="settings-actions">
        <button class="secondary" id="refreshAppStorage" type="button">Refresh sizes</button>
        <button class="secondary" id="clearAppCache" type="button">Clear downloaded caches</button>
      </div>
      <p class="app-section-feedback" id="appStorageFeedback" role="status"></p>
    </details>`;
}

function bindDesktopSettings() {
  appSettingsDialog.querySelector("#desktopOptionsForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const fields = event.currentTarget.elements;
    const options = Object.fromEntries(Object.keys(desktopOptions).map(key => [key, fields[key].checked]));
    changeAppSettings(() => window.minecraftAPI.saveDesktopOptions(options), "Desktop preferences saved.", { feedbackId: "desktopOptionsFeedback" });
  });
  appSettingsDialog.querySelector("#quickDefaultsForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const fields = event.currentTarget.elements;
    const options = Object.fromEntries(Object.entries(quickControlOptions).map(([key, field]) =>
      [key, fields[key].value === "" || field.choices ? fields[key].value : fields[key].valueAsNumber]));
    changeAppSettings(() => window.minecraftAPI.saveQuickDefaults(options), "Quick Controls saved.", { feedbackId: "quickDefaultsFeedback" });
  });
  const storage = appSettingsDialog.querySelector("#appStorageSettings");
  if (!storage) return;
  const info = storage.querySelector("#appStorageInfo");
  const feedback = storage.querySelector("#appStorageFeedback");
  const buttons = storage.querySelectorAll("button");
  async function updateStorage(clear = false) {
    if (buttons[0].disabled) return;
    buttons.forEach(button => { button.disabled = true; });
    feedback.classList.remove("form-error");
    feedback.textContent = clear ? "Clearing cached downloads…" : "Calculating storage…";
    try {
      const summary = await (clear ? window.minecraftAPI.clearDownloadCache() : window.minecraftAPI.getAppStorage());
      const row = (label, entry) => `<div><dt>${label}</dt><dd>${escapeHtml(entry.path)}<small>${entry.bytes === null ? "Size unavailable" : entry.bytes < 1024 ? `${entry.bytes} B` : formatBytes(entry.bytes)}</small></dd></div>`;
      info.innerHTML = `<dl class="app-storage-list">${row("Servers", summary.servers)}${row("Managed Java", summary.java)}
        ${summary.backups.length ? summary.backups.map(entry => row("World backups", entry)).join("") : "<div><dt>World backups</dt><dd>No folders configured</dd></div>"}
        ${row("Downloaded server files", summary.cache)}</dl>`;
      feedback.textContent = clear ? "Downloaded caches cleared." : "";
    } catch (error) {
      feedback.classList.add("form-error");
      feedback.textContent = error.message?.replace(/^Error invoking remote method '[^']+': Error:\s*/, "") || "Storage is unavailable.";
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }
  storage.addEventListener("toggle", () => { if (storage.open && !info.childElementCount) updateStorage(); });
  buttons[0].addEventListener("click", () => updateStorage());
  buttons[1].addEventListener("click", () => updateStorage(true));
}

let appUpdate;

function showAppUpdate(status) {
  const previous = appUpdate?.status;
  appUpdate = status;
  const panel = appSettingsDialog.querySelector("#appUpdates");
  if (panel) {
    const messages = {
      unavailable: "Updates are managed outside this build.",
      idle: "BlockHost checks for updates in the background.",
      checking: "Checking for updates…",
      current: "BlockHost is up to date.",
      downloading: `Downloading version ${status.availableVersion} · ${status.percent}%`,
      ready: `Version ${status.availableVersion} is ready to install.`,
      verifying: "Verifying the update…",
      installing: "Restarting to install the update…",
      error: "BlockHost could not download or verify the update. Try again from a trusted network.",
    };
    panel.querySelector("#appInstalledVersion").textContent = status.version;
    panel.querySelector("#appUpdateStatus").textContent = status.message || messages[status.status] || "";
    const check = panel.querySelector("#checkAppUpdate");
    const restart = panel.querySelector("#restartAppUpdate");
    check.hidden = status.status === "unavailable" || status.status === "ready";
    check.disabled = !["idle", "current", "error"].includes(status.status);
    restart.hidden = status.status !== "ready";
    restart.disabled = status.status !== "ready";
  }
  if (status.status === "ready" && previous === "downloading" && !appSettingsDialog.open) {
    showNotice("A BlockHost update is ready. Open Settings → About and updates when you can restart.");
  }
}

function showAppSettings() {
  if (appSettingsDialog.open) return;
  const { theme, options, memoryLimitMb } = state.appSettings;
  appSettingsDialog.setAttribute("closedby", "any");
  appSettingsDialog.innerHTML = `
    <p class="eyebrow">BlockHost preferences</p>
    <h2 id="appSettingsTitle">App settings</h2>
      <details class="app-option-settings" id="appUpdates" ${appUpdate?.status === "ready" ? "open" : ""}>
        <summary>About and updates</summary>
        <p>BlockHost Manager <span id="appInstalledVersion"></span></p>
        <p id="appUpdateStatus" role="status">Reading update status…</p>
        <div class="settings-actions">
          <button class="secondary" type="button" id="checkAppUpdate" hidden>Check for updates</button>
          <button class="primary" type="button" id="restartAppUpdate" hidden>Restart to update</button>
        </div>
      </details>
      <details class="app-option-settings">
        <summary>Server defaults, console and gradient</summary>
        <form id="appOptionsForm">
          <fieldset>
            <legend>New servers</legend>
            <div class="app-option-grid">
              <label>Server type<select name="serverType">${renderAppOptionList(serverTypeOptions, options.serverType)}</select></label>
              <label>Minecraft version<input name="minecraftVersion" value="${escapeHtml(options.minecraftVersion)}" maxlength="81" placeholder="Latest available" autocomplete="off" spellcheck="false"></label>
              <label>Maximum RAM (MB)<input name="maxMemoryMb" type="number" min="512" max="${memoryLimitMb}" step="256" placeholder="Automatic" value="${options.maxMemoryMb || ""}"></label>
            </div>
            <small class="field-help">If the version is unavailable for the server type, BlockHost selects the latest available. Modpacks use the version and loader set by the pack.</small>
          </fieldset>
          <fieldset>
            <legend>Console</legend>
            <div class="app-option-grid">
              <label>Default filter<select name="consoleFilter">${renderAppOptionList(consoleFilterOptions, options.consoleFilter)}</select></label>
              <label>Log font size (px)<input name="consoleFontSize" type="number" min="10" max="22" required value="${options.consoleFontSize}"></label>
            </div>
            <div class="app-option-toggles">
              <label><input name="consoleTimestamps" type="checkbox" ${options.consoleTimestamps ? "checked" : ""}> Show timestamps</label>
              <label><input name="consoleAutoScroll" type="checkbox" ${options.consoleAutoScroll ? "checked" : ""}> Auto-scroll by default</label>
            </div>
          </fieldset>
          <label><span class="field-label-row"><span>Server color gradient</span><output for="gradientStrength" id="gradientStrengthValue">${options.gradientStrength}%</output></span>
            <input id="gradientStrength" name="gradientStrength" type="range" min="0" max="200" value="${options.gradientStrength}">
          </label>
          <fieldset>
            <legend>Startup detection</legend>
            <div class="app-option-grid">
              <label>Idle timeout (minutes)<input name="startupIdleMinutes" type="number" min="1" max="60" required value="${options.startupIdleMinutes}"></label>
              <label>Total limit (minutes)<input name="startupDeadlineMinutes" type="number" min="2" max="120" required value="${options.startupDeadlineMinutes}"></label>
            </div>
            <small class="field-help">Used on the next server start. A stalled server can still become ready.</small>
          </fieldset>
          <div class="settings-actions"><button class="primary" type="submit">Save preferences</button></div>
          <p id="appOptionsFeedback" role="status"></p>
        </form>
      </details>
      ${renderDesktopSettings(state.appSettings)}
      <fieldset class="theme-options">
        <legend>Appearance</legend>
        ${Object.entries(appThemes).map(([id, preset]) => `
          <label class="theme-option">
            <input type="radio" name="appTheme" value="${id}" ${id === theme ? "checked" : ""}>
            <span class="theme-preview" data-preview="${id}" aria-hidden="true">${renderThemeIcon(id, 36)}</span>
            <span><strong>${preset.name}</strong><small>${preset.description}</small></span>
          </label>
        `).join("")}
      </fieldset>
    <p id="appSettingsFeedback" role="status"></p>
    <div class="modal-actions">
      <button class="secondary" type="button" id="closeAppSettings">Done</button>
    </div>`;
  bindDesktopSettings();
  if (appUpdate) showAppUpdate(appUpdate);
  const updateRequest = action => async event => {
    event.currentTarget.disabled = true;
    try {
      showAppUpdate(await action());
    } catch {
      appSettingsDialog.querySelector("#appUpdateStatus")?.replaceChildren("Update status is unavailable. Try again.");
      if (event.target.isConnected) event.target.disabled = false;
    }
  };
  appSettingsDialog.querySelector("#checkAppUpdate").addEventListener("click", updateRequest(window.minecraftAPI.checkUpdate));
  appSettingsDialog.querySelector("#restartAppUpdate").addEventListener("click", updateRequest(window.minecraftAPI.restartForUpdate));
  window.minecraftAPI.getUpdateStatus().then(showAppUpdate).catch(() => {
    appSettingsDialog.querySelector("#appUpdateStatus")?.replaceChildren("Update status is unavailable.");
  });
  appSettingsDialog.querySelectorAll('[name="appTheme"]').forEach((radio) => {
    radio.addEventListener("change", () => changeAppSettings(() => window.minecraftAPI.setAppTheme(radio.value), "Theme saved."));
  });
  appSettingsDialog.querySelector("#gradientStrength")?.addEventListener("input", (event) => {
    appSettingsDialog.querySelector("#gradientStrengthValue").value = `${event.target.value}%`;
  });
  appSettingsDialog.querySelector("#appOptionsForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = event.currentTarget.elements;
    const input = {
      serverType: fields.serverType.value,
      minecraftVersion: fields.minecraftVersion.value.trim(),
      maxMemoryMb: Number(fields.maxMemoryMb.value),
      consoleFilter: fields.consoleFilter.value,
      consoleFontSize: fields.consoleFontSize.valueAsNumber,
      consoleTimestamps: fields.consoleTimestamps.checked,
      consoleAutoScroll: fields.consoleAutoScroll.checked,
      gradientStrength: fields.gradientStrength.valueAsNumber,
      startupIdleMinutes: fields.startupIdleMinutes.valueAsNumber,
      startupDeadlineMinutes: fields.startupDeadlineMinutes.valueAsNumber,
    };
    changeAppSettings(() => window.minecraftAPI.saveAppOptions(input), "Preferences saved.", { feedbackId: "appOptionsFeedback" });
  });
  appSettingsDialog.querySelector("#closeAppSettings").addEventListener("click", () => appSettingsDialog.close());
  appSettingsDialog.showModal();
}

function renderWindowTitlebar() {
  const operation = state.operations[0];
  const progress = operation && Number.isFinite(operation.percent) ? ` · ${Math.round(operation.percent)}%` : "";
  return `<strong>BlockHost Manager</strong>
    ${operation ? `<span class="titlebar-operation" role="status"><span class="spinner"></span><span>${escapeHtml(operation.description || operation.label || "Working…")}${progress}</span></span>` : ""}
    <button class="titlebar-settings" id="openAppSettings" type="button" aria-haspopup="dialog">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--theme-titlebar, #07111d)"/><circle cx="15" cy="17" r="2.5" fill="var(--theme-titlebar, #07111d)"/></svg>
      Settings
    </button>`;
}

function render() {
  const returnToCard = finishServerPageMotion();
  const scrollState = captureScrollState();
  const server = selectedServer();
  if (server) {
    const color = /^#[0-9a-f]{6}$/i.test(server.color) ? server.color : ACCENT_PRESETS[0][1];
    root.style.setProperty("--workspace-color", color);
  } else {
    root.style.removeProperty("--workspace-color");
  }
  const input = document.activeElement;
  const commandSelection = input?.id === "commandInput" ? [input.selectionStart, input.selectionEnd] : null;
  const addonSearchSelection = input?.id === "installedAddonSearch" ? [input.selectionStart, input.selectionEnd] : null;
  const activeServerTab = input?.closest(".workspace-nav [data-server-view]")?.dataset.serverView;
  const focusedCard = input?.matches(".library-card") ? input.dataset.serverId : null;
  const focusedTitle = input?.id === "pageTitle";
  const createInput = input?.matches('#createForm [name="serverName"], #createForm [name="seed"]')
    ? { name: input.name, start: input.selectionStart, end: input.selectionEnd }
    : null;
  windowTitlebar.innerHTML = renderWindowTitlebar();
  serverPages.innerHTML = server ? renderServer() : renderLibrary();
  appOverlays.innerHTML = `
    ${renderCreateModal()}${renderPropertiesModal()}${renderPackBrowser()}${renderStartModal()}${renderQuickRestartModal()}${renderDeleteModal()}${renderTransferModal()}${renderDropOverlay()}${renderError()}${renderStartupCrashModal()}<div id="notificationHost">${renderNotice()}</div>
  `;
  bindEvents();
  enhanceSelects();
  bindAccentPickers();
  updateLiveElements();
  restoreScrollState(scrollState);
  if (commandSelection) {
    const command = document.getElementById("commandInput");
    command?.focus({ preventScroll: true });
    command?.setSelectionRange(...commandSelection);
    refreshCommandMenu?.();
  }
  if (addonSearchSelection) {
    const search = document.getElementById("installedAddonSearch");
    search?.focus({ preventScroll: true });
    search?.setSelectionRange(...addonSearchSelection);
  }
  if (activeServerTab === state.serverView) document.querySelector(".workspace-nav [aria-current]")?.focus({ preventScroll: true });
  if (focusedCard && !server) serverPages.querySelector(`.library-card[data-server-id="${focusedCard}"]`)?.focus({ preventScroll: true });
  if (focusedTitle && server) document.getElementById("pageTitle")?.focus({ preventScroll: true });
  if (returnToCard !== null) restoreLibraryCard(returnToCard);
  if (createInput) {
    const field = document.getElementById("createForm")?.elements.namedItem(createInput.name);
    if (field && !field.matches(":disabled") && field.getClientRects().length) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(createInput.start, createInput.end);
    }
  }
  if (folderSize?.id !== state.selectedId) refreshFolderSize();
  document.getElementById("startupCrashDialog")?.showModal();
}

function showServerView(view) {
  if (!state.selectedId || state.packBusy || state.serverView === view) return;
  state.serverView = view;
  if (view === "addons" && state.addonsServerId !== state.selectedId) loadAddons();
  else if (view === "settings" && state.settingsServerId !== state.selectedId) loadServerSettings();
  else render();
}

async function showRepairMods() {
  const id = state.selectedId;
  state.serverView = "addons";
  state.addonTab = "installed";
  state.installedAddonTab = "files";
  if (state.addonsServerId !== id) await loadAddons();
  else render();
  return state.selectedId === id && state.serverView === "addons";
}

function bindEvents() {
  bindPackEvents();
  document.getElementById("modpackStatusPanel")?.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-modpack-action]");
    const action = target?.dataset.modpackAction;
    if (action === "copy-address") void writeClipboard(state.runtime?.joinAddress, "Server address copied.");
    if (action === "try-bundled-dependency") void startServer({ repairBundledDependency: true });
    if (action === "add-file" && await showRepairMods()) {
      void runAddonAction("Dependency installation", () => window.minecraftAPI.installManualAddon(state.selectedId));
    }
    if (action === "find-dependency" && await showRepairMods()) {
      state.addonTab = "browse";
      state.addonCategory = "all";
      state.addonSort = "relevance";
      state.addonQuery = target.dataset.modpackQuery;
      void performAddonSearch();
    }
    if (action === "properties") void openProperties();
    if (action === "console") showServerView("console");
    if (action === "folder") document.getElementById("openServerFolder")?.click();
    if (action === "browse-packs") {
      openCreate();
      state.packBrowserOpen = true;
      void browsePacks();
    }
    if (action === "java") {
      showServerView("settings");
      document.getElementById("javaRuntimeRow")?.scrollIntoView({ block: "center" });
    }
    if (action === "mods") void showRepairMods();
  });
  document.getElementById("openAppSettings").addEventListener("click", async () => {
    try {
      if (!state.appSettings) await loadAppSettings();
      showAppSettings();
    } catch (error) {
      showError(error);
    }
  });
  const startupCrashDialog = document.getElementById("startupCrashDialog");
  if (startupCrashDialog) {
    startupCrashDialog.addEventListener("close", () => {
      if (!startupCrashDialog.isConnected) return;
      state.startupDiagnostics = "";
      startupCrashDialog.remove();
      document.querySelector('[data-console-filter="errors"]')?.focus();
    });
    document.getElementById("closeStartupCrash").addEventListener("click", () => startupCrashDialog.close());
    document.getElementById("copyStartupDiagnostics").addEventListener("click", async () => {
      const diagnosis = state.runtime?.startupDiagnosis;
      const summary = diagnosis ? [diagnosis.problem, diagnosis.mod && `Suspected mod: ${diagnosis.mod}`, diagnosis.cause, diagnosis.fix, ...diagnosis.evidence].filter(Boolean).join("\n") : "";
      const consoleDetails = diagnosticText(consoleEntries().filter((entry) => entry.level === "error"));
      const report = [summary, consoleDetails].filter(Boolean).join("\n\n").replace(/C:\\Users\\[^\\\s]+/gi, "C:\\Users\\<user>");
      const copied = await writeClipboard(report, "Startup diagnostics copied.");
      const status = document.getElementById("startupCopyStatus");
      if (status) status.textContent = copied ? "Diagnostics copied. Paste them into your chat." : "Could not copy the diagnostics. Try again.";
    });
  }
  document.querySelectorAll("[data-server-id]").forEach((button) => {
    button.addEventListener("click", () => navigateServer(Number(button.dataset.serverId)).catch(showError));
  });
  document.getElementById("backToLibrary")?.addEventListener("click", async () => {
    if (state.packBusy || state.addonsPending || state.memoryPending || state.backupPending || state.identityPending || state.javaSettingsPending || state.pendingAction) return;
    if (memorySaveTimer) await saveMemorySettings();
    await navigateServer(null).catch(showError);
  });
  document.querySelectorAll("[data-server-view]").forEach(button => button.addEventListener("click", () => {
    showServerView(button.dataset.serverView);
    document.querySelector(".workspace-nav [aria-current]")?.focus({ preventScroll: true });
  }));

  document.getElementById("emptyCreate")?.addEventListener("click", () => openCreate());
  document.getElementById("importServer")?.addEventListener("click", importServerFromPicker);
  document.getElementById("importExternalServer")?.addEventListener("click", importExternalServerFromPicker);
  document.getElementById("closeCreate")?.addEventListener("click", () => {
    if (!state.createPending && !state.packBusy) {
      state.createPack = null;
      state.createOpen = false;
      state.createWorldImport = null;
      state.createDraft = { name: "", color: "#39c9ff", seed: "" };
      render();
    }
  });
  document.getElementById("serverType")?.addEventListener("change", (event) => {
    state.createDraft = { ...state.createDraft, version: "" };
    state.createType = event.target.value;
    loadVersions();
  });
  document.querySelector('#createForm [name="serverName"]')?.addEventListener("input", (event) => {
    state.createDraft = { ...state.createDraft, name: event.target.value };
  });
  document.querySelector('#createForm [name="color"]')?.addEventListener("input", (event) => {
    state.createDraft = { ...state.createDraft, color: event.target.value };
  });
  document.querySelectorAll(".server-icon-picker").forEach((picker) => {
    picker.addEventListener("change", (event) => {
      const icon = normalizeServerIcon(event.target.value);
      if (picker.closest("#createForm")) state.createDraft.icon = icon;
      else state.identityIcon = icon;
      picker.querySelector(".server-icon-preview").innerHTML = renderThemeIcon(icon, 22);
      picker.querySelector(".server-icon-value").textContent = serverIconName(icon);
      const panel = picker.querySelector(".server-icon-panel");
      if (panel.matches(":popover-open")) {
        panel.hidePopover();
        picker.querySelector(".server-icon-trigger").focus();
      }
    });
  });
  document.querySelector('#createForm [name="version"]')?.addEventListener("change", (event) => {
    state.createDraft.version = event.target.value;
  });
  document.querySelector('#createForm [name="seed"]')?.addEventListener("input", (event) => {
    state.createDraft = { ...state.createDraft, seed: event.target.value };
    const hasSeed = Boolean(event.target.value.trim());
    document.getElementById("chooseWorldImport").disabled = hasSeed || state.createPending;
    document.getElementById("chooseWorldFolder").disabled = hasSeed || state.createPending;
    document.getElementById("worldImportStatus").textContent = hasSeed ? WORLD_IMPORT_SEED_HINT : WORLD_IMPORT_HINT;
  });
  document.getElementById("createAdvanced")?.addEventListener("toggle", (event) => {
    if (event.currentTarget.isConnected) state.createAdvancedOpen = event.currentTarget.open;
  });
  document.getElementById("retryCreateVersions")?.addEventListener("click", () => loadVersions());
  document.getElementById("createForm")?.addEventListener("submit", createServer);
  document.getElementById("chooseWorldImport")?.addEventListener("click", () => chooseCreateWorld("zip"));
  document.getElementById("chooseWorldFolder")?.addEventListener("click", () => chooseCreateWorld("folder"));
  document.getElementById("removeWorldImport")?.addEventListener("click", () => {
    state.createWorldImport = null;
    render();
  });

  document.getElementById("startServer")?.addEventListener("click", () => startServer());
  document.getElementById("stopServer")?.addEventListener("click", stopServer);
  document.getElementById("commandForm")?.addEventListener("submit", submitCommand);
  bindCommandInput();
  document.querySelectorAll("[data-console-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.consoleFilter = button.dataset.consoleFilter;
      document.querySelectorAll("[data-console-filter]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      document.getElementById("copyVisibleConsole").textContent = consoleCopyLabel();
      document.getElementById("copyConsoleDiagnostics").hidden = state.consoleFilter !== "errors";
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
  document.getElementById("copyConsoleDiagnostics")?.addEventListener("click", () => {
    const entries = visibleConsoleEntries();
    if (!entries.length) {
      showNotice("There are no errors in the current console view.");
      return;
    }
    writeClipboard(diagnosticText(entries), "Diagnostic details copied for support or AI help.");
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
  document.getElementById("quickPropertiesForm")?.addEventListener("submit", saveQuickProperties);
  document.querySelectorAll("[data-quick-adjust]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.querySelector(`#quickPropertiesForm [name="${CSS.escape(button.dataset.quickAdjust)}"]`);
      if (!input) return;
      const next = Number(input.value) + Number(button.dataset.delta || 0);
      const value = String(Math.max(Number(input.min), Math.min(Number(input.max), next)));
      state.quickPropertiesModel.values[button.dataset.quickAdjust] = value;
      state.quickPropertiesDirty = true;
      render();
    });
  });
  document.querySelectorAll("[data-quick-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.dataset.quickChoice;
      const value = button.dataset.value;
      const input = document.querySelector(`#quickPropertiesForm [name="${CSS.escape(field)}"]`);
      if (input) input.value = value;
      state.quickPropertiesModel.values[field] = value;
      state.quickPropertiesDirty = true;
      render();
    });
  });
  document.getElementById("closeQuickRestartNotice")?.addEventListener("click", () => {
    state.quickRestartNotice = false;
    render();
  });
  document.getElementById("openServerFolder")?.addEventListener("click", async () => {
    try {
      await window.minecraftAPI.openServerFolder(state.selectedId);
    } catch (error) {
      showError(error);
    }
  });
  document.getElementById("openFullProperties")?.addEventListener("click", openProperties);
  document.getElementById("exportServer")?.addEventListener("click", exportSelectedServer);
  document.getElementById("exportWorld")?.addEventListener("click", exportSelectedWorld);
  document.getElementById("serverIdentityForm")?.addEventListener("submit", saveServerIdentity);
  document.getElementById("backupSettingsForm")?.addEventListener("submit", saveBackupSettings);
  document.getElementById("chooseBackupFolder")?.addEventListener("click", chooseBackupFolder);
  document.getElementById("runBackupNow")?.addEventListener("click", (event) => saveBackupSettings(event, true));
  document.querySelector('#backupSettingsForm [name="enabled"]')?.addEventListener("change", (event) => {
    state.backupDraft = { ...state.backupDraft, enabled: event.target.checked };
  });
  document.querySelector('#backupSettingsForm [name="intervalMinutes"]')?.addEventListener("change", (event) => {
    state.backupDraft = { ...state.backupDraft, intervalMinutes: Number(event.target.value) };
  });
  document.querySelector('#backupSettingsForm [name="mode"]')?.addEventListener("change", (event) => {
    state.backupDraft = { ...state.backupDraft, mode: event.target.value };
  });
  document.getElementById("deleteServer")?.addEventListener("click", () => {
    state.deleteId = state.selectedId;
    render();
  });
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
  minMemoryRange?.addEventListener("input", () => {
    syncMemoryRange("min");
    scheduleMemorySave();
  });
  maxMemoryRange?.addEventListener("input", () => {
    syncMemoryRange("max");
    scheduleMemorySave();
  });
  document.querySelectorAll(".overlay").forEach((overlay) => {
    let backdropPointer = null;
    let backdropClick = false;
    overlay.addEventListener("pointerdown", (event) => {
      backdropClick = false;
      backdropPointer = event.isPrimary && event.button === 0 && event.target === overlay ? event.pointerId : null;
    });
    overlay.addEventListener("pointerup", (event) => {
      // Touch can capture the pointer, so check where it was actually released.
      backdropClick = backdropPointer === event.pointerId
        && document.elementFromPoint(event.clientX, event.clientY) === overlay;
      backdropPointer = null;
    });
    overlay.addEventListener("pointercancel", () => {
      backdropPointer = null;
      backdropClick = false;
    });
    overlay.addEventListener("click", (event) => {
      const shouldClose = backdropClick && event.target === overlay && !state.transferPending;
      backdropClick = false;
      if (!shouldClose) return;
      overlay.querySelector(".modal-close:not(:disabled), #cancelProperties:not(:disabled), #closeProperties:not(:disabled), #cancelStart:not(:disabled), #cancelDelete:not(:disabled), #closeTransfer:not(:disabled), #closeQuickRestartNotice:not(:disabled)")?.click();
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
    const options = state.pendingStart?.options;
    state.pendingStart = null;
    render();
    startServer(options);
  });
  document.getElementById("openConflictProperties")?.addEventListener("click", () => {
    state.pendingStart = null;
    render();
    openProperties();
  });
  bindJavaRuntimeSelect();
  document.getElementById("acceptEula")?.addEventListener("click", () => {
    const options = state.pendingStart?.options;
    state.pendingStart = null;
    render();
    startServer({ ...options, acceptEula: true });
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
    saveProperties(runtimeCanStop(state.runtime || {}));
  });
  document.getElementById("saveProperties")?.addEventListener("click", () =>
    saveProperties(runtimeCanStop(state.runtime || {}))
  );
  document.getElementById("savePropertiesLater")?.addEventListener("click", () => saveProperties(false));
  document.getElementById("confirmDroppedAddon")?.addEventListener("click", () => {
    const drop = state.droppedAddon;
    if (!drop || drop.serverId !== state.selectedId) return;
    state.droppedAddon = null;
    runAddonAction("Manual installation", () => window.minecraftAPI.installDroppedAddon(drop.serverId, drop.file));
  });
  document.getElementById("retryAddons")?.addEventListener("click", () => loadAddons(true));
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
  document.getElementById("copyClientMods")?.addEventListener("click", copyClientMods);
  const installedSearch = document.getElementById("installedAddonSearch");
  if (installedSearch) {
    const cards = document.querySelectorAll(".installed-addon-grid [data-addon-search]");
    const filterCards = () => {
      state.installedAddonSearch[state.installedAddonTab] = installedSearch.value;
      const terms = installedSearch.value.toLowerCase().trim().split(/\s+/);
      let matched = 0;
      for (const card of cards) {
        card.hidden = !terms.every(term => card.dataset.addonSearch.includes(term));
        if (!card.hidden) matched++;
      }
      document.getElementById("installedAddonNoMatches").hidden = !cards.length || matched > 0;
    };
    installedSearch.addEventListener("input", filterCards);
    filterCards();
  }
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
    if (succeeded && state.serverView === "addons") await loadAddons(true);
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
  if (progress?.kind === "modpack" && state.createPending) {
    state.packProgress = progress.message || "Preparing modpack…";
    const label = document.getElementById("packProgressMessage");
    if (label) label.textContent = state.packProgress;
    return;
  }
  if (!state.transferPending || progress?.kind !== state.transferPending) return;
  state.transferProgress = {
    stage: String(progress.stage || ""),
    percent: Number(progress.percent) || 0,
    message: String(progress.message || "Working…"),
  };
  render();
});

window.minecraftAPI.onBackupCompleted((payload) => {
  if (Number(payload?.serverId) === Number(state.selectedId)) {
    state.backupModel = payload.settings;
    state.backupDraft = { ...payload.settings };
  }
  showNotice(`World backup created${payload?.result?.fileName ? `: ${payload.result.fileName}` : "."}`);
});

window.minecraftAPI.onBackupFailed((payload) => {
  if (Number(payload?.serverId) === Number(state.selectedId)) state.backupError = payload.message || "Automatic backup failed";
  showError(new Error(payload?.message || "Automatic world backup failed"));
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
  if (["player-join", "player-leave"].includes(payload.entry.event)) refreshCommandMenu?.();
  scheduleConsoleOutput();
});

window.minecraftAPI.onDependencyProgress((progress) => {
  if (progress?.message && !state.transferPending) showNotice(progress.message);
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
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  dragDepth = 0;
  state.dragActive = false;
  render();
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length !== 1) {
    showError(new Error("Drop one world, server archive, or add-on at a time."));
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

appSettingsDialog.addEventListener("cancel", (event) => {
  if (appSettingsDialog.getAttribute("aria-busy") === "true") event.preventDefault();
});
appSettingsDialog.addEventListener("close", () => {
  if (appSettingsDialog.open) return;
  appSettingsDialog.replaceChildren();
  document.getElementById("openAppSettings")?.focus();
});

scene.addEventListener("pointermove", event => {
  if (event.pointerType !== "mouse" || serverPageMotion) return;
  const { left, top, width, height } = scene.getBoundingClientRect();
  scene.style.setProperty("--library-view-x", `${(0.5 - (event.clientX - left) / width) * 20}px`);
  scene.style.setProperty("--library-view-y", `${(0.5 - (event.clientY - top) / height) * 14}px`);
});
scene.addEventListener("pointerleave", () => {
  if (serverPageMotion) return;
  scene.style.removeProperty("--library-view-x");
  scene.style.removeProperty("--library-view-y");
});
window.minecraftAPI.onUpdateStatus(showAppUpdate);
window.addEventListener("resize", () => {
  if (serverPageMotion) render();
});

render();
Promise.all([
  loadAppSettings().catch(showError).then(() => loadServers(state.appSettings?.desktop.reopenServer ? state.appSettings.lastServerId : null)),
  window.minecraftAPI.getActiveOperations().then((operations) => { state.operations = operations; }),
]).then(render).catch(showError);
setInterval(refreshLiveSafely, 2000);
setInterval(refreshFolderSize, 10_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    scheduleConsoleOutput();
    refreshLiveSafely();
    refreshFolderSize();
  }
});


function renderAddonTabs() {
  return `<nav class="addon-tabs" aria-label="Add-on sections">${[["installed", "Installed"], ["browse", "Discover"], ["modpacks", "Modpacks"]].map(([id, title]) => `<button type="button" data-addon-tab="${id}" class="${state.addonTab === id ? "active" : ""}" aria-pressed="${state.addonTab === id}" ${state.addonsPending || state.packBusy ? "disabled" : ""}>${title}</button>`).join("")}</nav>`;
}

function renderInstalledAddonTabs() {
  const label = state.addonsModel?.kind === "plugins" ? "Plugins" : "Mods";
  return `<nav class="addon-filter-row installed-addon-tabs" aria-label="Installed add-ons">
    ${[["files", label], ["pack", "Modpack"]].map(([id, title]) => `<button class="addon-filter-chip ${state.installedAddonTab === id ? "active" : ""}" type="button" data-installed-addon-tab="${id}" aria-pressed="${state.installedAddonTab === id}" ${state.addonsPending ? "disabled" : ""}>${title}</button>`).join("")}
  </nav>`;
}

function acceptModpack(pack) {
  if (!pack) return;
  ++versionRequest;
  if (!state.createOpen) {
    state.createAdvancedOpen = false;
    state.createDraft = { name: "", color: "#39c9ff", seed: "" };
    state.createWorldImport = null;
  }
  state.createDraft.name ||= pack.name;
  if (pack.hasWorld) {
    state.createWorldImport = null;
    state.createDraft.seed = "";
  }
  state.createPack = pack;
  state.packIncludeOptional = false;
  state.packEulaAccepted = false;
  state.createPackError = "";
  state.createType = pack.type;
  state.versions = [{ id: pack.version, label: `${pack.version} · ${pack.type} ${pack.loaderVersion}`, version: pack.version, loaderVersion: pack.loaderVersion }];
  state.createDraft.version = pack.version;
  state.versionsLoading = false;
  state.versionsError = "";
  state.packBrowserOpen = false;
  state.createOpen = true;
  render();
}

function modpackErrorMessage(error) {
  return error?.message?.replace(/^Error invoking remote method '(?:modpacks:[^']+|addons:[^']+|servers:create)': Error:\s*/, "")
    || "Could not load modpacks. Check your connection and retry.";
}

async function browsePacks(offset = 0) {
  const request = ++packRequest;
  state.packBusy = true;
  state.packError = "";
  state.packProject = null;
  state.packOffset = offset;
  render();
  try {
    const result = await window.minecraftAPI.searchModpacks(state.packQuery, offset);
    if (request !== packRequest) return;
    state.packResults = result.results;
    state.packTotal = result.total;
    state.packHasMore = result.hasMore ?? (offset + 18 < result.total);
  } catch (error) {
    if (request === packRequest) { state.packResults = []; state.packTotal = 0; state.packHasMore = false; state.packError = modpackErrorMessage(error); }
  } finally {
    if (request === packRequest) { state.packBusy = false; render(); }
  }
}

async function chooseLocalPack() {
  if (state.packBusy || state.createPending) return;
  state.packBusy = true;
  state.packError = "";
  render();
  try { acceptModpack(await window.minecraftAPI.chooseLocalModpack()); }
  catch (error) {
    state.packError = modpackErrorMessage(error);
    if (state.createOpen && !state.packBrowserOpen) state.createPackError = state.packError;
    else if (!state.packBrowserOpen && !state.selectedId) showError(new Error(state.packError));
  }
  finally { state.packBusy = false; render(); }
}

function packServerReleaseSummary(pack) {
  const release = pack.serverRelease;
  if (!release) return pack.description || "";
  return `Server edition · ${release.name} · Minecraft ${release.games.join(", ")} · ${release.loaders.join(", ")}`;
}

function renderPackContents() {
  const selected = state.packProject;
  return `
    <div class="pack-intro"><div><h3>${selected ? escapeHtml(selected.title) : "Dedicated server packs"}</h3><p>Browse publisher server distributions. BlockHost tests the selected release during setup. Players may need the matching client pack.</p></div></div>
    ${selected ? `<div class="pack-release"><button class="subtle-action" id="backToPacks" type="button" ${state.packBusy ? "disabled" : ""}>← Back to packs</button><p>${catalogueSourceName(selected.source)} · ${escapeHtml(packServerReleaseSummary(selected))}</p><label>Dedicated server release<select id="packRelease" ${state.packBusy ? "disabled" : ""}>${state.packVersions.map(version => `<option value="${escapeHtml(version.id)}" ${state.packVersion === version.id ? "selected" : ""}>${escapeHtml(version.name)} · ${escapeHtml(version.games.join(", "))} · ${escapeHtml(version.loaders.join(", "))}${version.compatibility ? ` · ${escapeHtml(version.compatibility)}` : ""}${version.channel === "release" ? "" : ` · ${escapeHtml(version.channel)}`}</option>`).join("")}</select></label><button class="primary" id="useOnlinePack" type="button" ${state.packBusy || !state.packVersion ? "disabled" : ""}>Use this pack</button></div>` : `
    <form class="addon-search pack-search" id="packSearchForm"><input name="query" placeholder="Search modpacks…" aria-label="Search modpacks" maxlength="100" value="${escapeHtml(state.packQuery)}" ${state.packBusy ? "disabled" : ""}><button class="primary" type="submit" ${state.packBusy ? "disabled" : ""}>Search</button></form>
    <div class="pack-grid">${state.packResults.map(pack => `<article class="pack-card">${pack.iconUrl ? `<img src="${escapeHtml(pack.iconUrl)}" alt="" loading="lazy">` : '<span class="pack-placeholder" aria-hidden="true">▦</span>'}<div><h3>${escapeHtml(pack.title)}</h3><small>${catalogueSourceName(pack.source)} · By ${escapeHtml(pack.author || "Unknown author")} · ${Number(pack.downloads || 0).toLocaleString()} downloads</small></div><p>${escapeHtml(packServerReleaseSummary(pack))}</p><button class="secondary" type="button" data-pack-project="${escapeHtml(pack.id)}" ${state.packBusy ? "disabled" : ""}>Choose release</button></article>`).join("")}</div>
    ${!state.packBusy && !state.packResults.length && !state.packError ? '<p class="addon-empty">No supported server distributions on this page. Try another search or import a server pack.</p>' : ""}
    <div class="pack-pagination"><button class="secondary small" id="previousPacks" type="button" ${state.packBusy || state.packOffset === 0 ? "disabled" : ""}>Previous</button><span>${state.packTotal ? `Page ${Math.floor(state.packOffset / 18) + 1}` : ""}</span><button class="secondary small" id="nextPacks" type="button" ${state.packBusy || !state.packHasMore ? "disabled" : ""}>Next</button></div>`}
    ${state.packBusy ? '<div class="addon-progress" role="status"><span class="spinner"></span><span>Loading and checking pack details…</span></div>' : ""}
    ${state.packError ? `${renderPackError(state.packError)}<button class="secondary small" id="retryPacks" type="button">Try again</button>` : ""}`;
}

function renderPackBrowser() {
  if (!state.packBrowserOpen) return "";
  return `<div class="overlay"><section class="modal addons-modal" role="dialog" aria-modal="true" aria-labelledby="packTitle"><button class="modal-close" id="closePackBrowser" type="button" aria-label="Close" ${state.packBusy ? "disabled" : ""}>×</button><p class="eyebrow">Build your next server</p><h2 id="packTitle">Modpacks</h2>${renderPackContents()}</section></div>`;
}

async function loadPackReleases(project) {
  if (!project || state.packBusy) return;
  state.packProject = project;
  state.packVersions = []; state.packVersion = ""; state.packError = ""; state.packBusy = true; render();
  try {
    state.packVersions = await window.minecraftAPI.getModpackVersions(project.id);
    state.packVersion = (state.packVersions.find(version => version.id === project.serverRelease?.id)
      || state.packVersions.find(version => version.channel === "release") || state.packVersions[0])?.id || "";
    if (!state.packVersion) state.packError = "This project has no supported publisher server distributions.";
  } catch (error) { state.packError = modpackErrorMessage(error); }
  finally { state.packBusy = false; render(); }
}

async function useOnlinePack() {
  if (state.packBusy || !state.packVersion) return;
  state.packBusy = true; state.packError = ""; render();
  try { acceptModpack(await window.minecraftAPI.prepareOnlineModpack(state.packVersion, state.packProject?.id)); }
  catch (error) { state.packError = modpackErrorMessage(error); }
  finally { state.packBusy = false; render(); }
}

function bindPackEvents() {
  document.querySelectorAll("[data-installed-addon-tab]").forEach(button => button.addEventListener("click", () => {
    state.installedAddonTab = button.dataset.installedAddonTab;
    render();
    document.querySelector("[data-installed-addon-tab][aria-pressed='true']")?.focus({ preventScroll: true });
  }));
  document.querySelectorAll("[data-addon-tab]").forEach(button => button.addEventListener("click", () => {
    if (state.addonsPending || state.packBusy) return;
    state.addonTab = button.dataset.addonTab;
    if (state.addonTab === "browse") void loadAddonRecommendations();
    if (state.addonTab === "modpacks") browsePacks(); else render();
  }));
  document.getElementById("browseLibraryPacks")?.addEventListener("click", () => { state.packBrowserOpen = true; browsePacks(); });
  document.getElementById("localLibraryPack")?.addEventListener("click", chooseLocalPack);
  document.getElementById("closePackBrowser")?.addEventListener("click", () => { if (!state.packBusy) { state.packBrowserOpen = false; render(); } });
  document.getElementById("packOptional")?.addEventListener("change", event => { state.packIncludeOptional = event.target.checked; });
  document.getElementById("acceptPackEula")?.addEventListener("change", event => { state.packEulaAccepted = event.target.checked; });
  document.getElementById("cancelPackInstall")?.addEventListener("click", async event => { event.currentTarget.disabled = true; state.packProgress = "Stopping setup…"; document.getElementById("packProgressMessage").textContent = state.packProgress; await window.minecraftAPI.cancelModpack(); });
  document.getElementById("packSearchForm")?.addEventListener("submit", event => { event.preventDefault(); state.packQuery = event.currentTarget.query.value.trim(); browsePacks(); });
  document.getElementById("previousPacks")?.addEventListener("click", () => browsePacks(Math.max(0, state.packOffset - 18)));
  document.getElementById("nextPacks")?.addEventListener("click", () => browsePacks(state.packOffset + 18));
  document.getElementById("retryPacks")?.addEventListener("click", () => {
    if (!state.packProject) return browsePacks(state.packOffset);
    return state.packVersion ? useOnlinePack() : loadPackReleases(state.packProject);
  });
  document.getElementById("backToPacks")?.addEventListener("click", () => { state.packProject = null; state.packError = ""; render(); });
  document.getElementById("packRelease")?.addEventListener("change", event => { state.packVersion = event.target.value; });
  document.querySelectorAll("[data-pack-project]").forEach(button => button.addEventListener("click", () => {
    loadPackReleases(state.packResults.find(pack => pack.id === button.dataset.packProject));
  }));
  document.getElementById("useOnlinePack")?.addEventListener("click", useOnlinePack);
}
