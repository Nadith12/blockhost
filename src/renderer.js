import "./index.css";

const app = document.getElementById("app");

const APP_DISPLAY_NAME = "BlockHost Manager";
const DEFAULT_SERVER_COLOR = "#39c9ff";
const JAVA_INSTALL_URL = "https://adoptium.net/temurin/releases/?package=jdk";
const APP_ICON_MARK = `
  <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="7" fill="#05080f"/>
    <path fill="#39c9ff" d="M7 9h4v3h2v3h2v3h2v-3h2v-3h2V9h4v16h-4v-8h-2v3h-2v3h-2v-3h-2v-3h-2v8H7z"/>
    <path fill="#746dff" d="M13 12h2v3h2v3h-2v-2h-2zM21 9h4v16h-3v-5h-2v-3h1z"/>
  </svg>
`;
const ICON_HOME = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z"/>
  </svg>
`;
const ICON_SYSTEM = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 19V9h3v10zm5 0V5h3v14zm5 0v-7h3v7z"/>
  </svg>
`;
const ICON_SETTINGS = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm8.5 3.8-.1 1.2-2.1.5a7.5 7.5 0 0 1-.8 1.8l1.1 1.9-.8.9-.9.8-1.9-1.1c-.6.3-1.2.6-1.9.8l-.5 2.1-1.2.1-1.2-.1-.5-2.1a7.5 7.5 0 0 1-1.8-.8l-1.9 1.1-.9-.8-.8-.9 1.1-1.9c-.3-.6-.6-1.2-.8-1.8l-2.1-.5L3.5 12l.1-1.2 2.1-.5c.2-.7.4-1.3.8-1.9L5.4 6.6l.8-.9.9-.8L9 6c.6-.3 1.2-.6 1.9-.8l.5-2.1 1.2-.1 1.2.1.5 2.1c.7.2 1.3.4 1.9.8l1.9-1.1.9.8.8.9-1.1 1.9c.3.6.6 1.2.8 1.9l2.1.5z"/>
  </svg>
`;

let servers = [];
let currentPage = "home";

let isCreateModalOpen = false;
let isCreateServerPending = false;
let serverContextMenu = null;
let draggingServerId = null;
let dragOverServerId = null;
let editServerModal = null;
let pendingDeleteServerId = null;
let deletingServerId = null;
let createServerFormState = {
  name: "",
  type: "vanilla",
  selectedVersionId: "",
  color: DEFAULT_SERVER_COLOR,
};
let serverVersionOptions = [];
let versionOptionsType = "";
let versionOptionsProject = "";
let versionsLoading = false;
let versionsError = "";
let systemMonitorStats = {
  isLoading: false,
  error: "",
  data: null,
};
let cpuTemperatureState = {
  isLoading: false,
  error: "",
  data: null,
};
let appSettings = {
  isLoading: false,
  isSaving: false,
  error: "",
  data: null,
  form: {
    serverMaxRamMb: 4096,
    minServerMaxRamMb: 512,
    maxServerMaxRamMb: 32768,
  },
};
let ddnsSettings = {
  isLoading: false,
  isSaving: false,
  isRunningNow: false,
  error: "",
  data: null,
  form: {
    enabled: false,
    hostname: "digi-project.freeddns.org",
    intervalMinutes: 10,
    password: "",
  },
};
let systemMonitorInterval = null;
let systemMonitorRequestInFlight = false;
let selectedServerRuntime = null;
let selectedServerRuntimeInterval = null;
let selectedServerRuntimeRequestInFlight = false;
let serverActionPending = "";
let pendingEulaAction = null;
let pendingJavaInstallError = null;
let pendingStopServerId = null;
let pendingServerSwitchAction = null;
let consoleCommand = "";

function escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function normalizeServerColor(value) {
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return value;
  }

  return DEFAULT_SERVER_COLOR;
}

function formatBytes(bytes) {
  const numericBytes = Number(bytes) || 0;

  if (numericBytes >= 1024 * 1024 * 1024) {
    return `${(numericBytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  return `${(numericBytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatPercent(value) {
  return `${(Number(value) || 0).toFixed(1)}%`;
}

function formatTemperature(value) {
  return typeof value === "number" ? `${value.toFixed(1)} C` : "-- C";
}

function getRuntimeStatusClass(status) {
  if (status === "running") return "status-running";
  if (status === "starting") return "status-starting";
  if (status === "stopping") return "status-stopping";
  if (status === "unknown") return "status-unknown";

  return "status-offline";
}

function hasBlockingOverlayOpen() {
  return Boolean(
    isCreateModalOpen ||
      editServerModal ||
      pendingDeleteServerId !== null ||
      pendingEulaAction ||
      pendingJavaInstallError ||
      pendingStopServerId !== null ||
      pendingServerSwitchAction ||
      serverContextMenu
  );
}

function updateConsolePanel() {
  const consoleOutput = document.querySelector(".console-output");

  if (consoleOutput) {
    consoleOutput.innerHTML = renderConsoleOutput();

    if (!consoleOutput.matches(":hover")) {
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }
  }

  const consoleForm = document.getElementById("consoleCommandForm");
  const serverId = getCurrentServerId();
  const runtime =
    selectedServerRuntime?.serverId === serverId ? selectedServerRuntime : null;
  const canSendCommand = runtime?.status === "running";
  const statusDot = document.querySelector(".status-dot");

  if (statusDot) {
    statusDot.className = `status-dot ${getRuntimeStatusClass(runtime?.status || "offline")}`;
  }

  if (consoleForm) {
    consoleForm.consoleCommand.disabled = !canSendCommand;
    consoleForm.consoleCommand.placeholder = canSendCommand
      ? "Type a server command"
      : "Start a server to send commands";
    consoleForm.querySelector("button").disabled = !canSendCommand;
  }
}

function getRuntimePlayerDetails(runtime) {
  const isRunning = runtime?.status === "running";
  const playerCount = runtime?.playerCount || 0;
  const maxPlayers = runtime?.maxPlayers || 20;
  const playerNames = runtime?.players || [];
  const playerInfo = playerNames.length
    ? playerNames.join(", ")
    : isRunning
      ? "No players online"
      : "Start the server to update players";

  return {
    playerCount,
    maxPlayers,
    playerInfo,
  };
}

function updatePlayerCountCard() {
  const serverId = getCurrentServerId();
  const runtime =
    selectedServerRuntime?.serverId === serverId ? selectedServerRuntime : null;

  if (!runtime) return;

  const playerValue = document.getElementById("playerCountValue");
  const playerInfo = document.getElementById("playerCountInfo");

  if (!playerValue || !playerInfo) return;

  const playerDetails = getRuntimePlayerDetails(runtime);

  playerValue.textContent = `${playerDetails.playerCount}/${playerDetails.maxPlayers}`;
  playerInfo.textContent = playerDetails.playerInfo;
}

function getFriendlySystemMonitorError(error) {
  const message = error.message || "";

  if (message.includes("No handler registered for 'system:getServerRuntimeStats'")) {
    return "Restart the app to enable server monitoring.";
  }

  if (message.includes("Access denied")) {
    return "Windows blocked access to server process stats.";
  }

  return "Could not load server monitoring stats.";
}

function getJavaInstallPrompt(error) {
  const message = error?.message || "";

  if (
    error?.code === "MISSING_JAVA" ||
    message.includes("MISSING_JAVA") ||
    message.includes("Java for developers is not installed") ||
    message.includes("spawn java ENOENT")
  ) {
    return {
      message:
        "Java for developers is not installed or the java command is not available on this PC.",
      installUrl: error?.installUrl || JAVA_INSTALL_URL,
    };
  }

  return null;
}

function showJavaInstallPrompt(error) {
  const prompt = getJavaInstallPrompt(error);

  if (!prompt) return false;

  pendingJavaInstallError = prompt;
  renderApp();

  return true;
}

function showHome() {
  currentPage = "home";
  renderApp();
}

function showSystemMonitor() {
  currentPage = "system";
  renderApp();
}

function showSettings() {
  currentPage = "settings";
  renderApp();
  refreshAppSettings();
  refreshDdnsSettings();
}

function selectServer(serverId) {
  serverContextMenu = null;
  currentPage = `server:${serverId}`;
  renderApp();
}

function getDdnsFormFromSettings(settings) {
  return {
    enabled: Boolean(settings?.enabled),
    hostname: settings?.hostname || "digi-project.freeddns.org",
    intervalMinutes: settings?.intervalMinutes || 10,
    password: "",
  };
}

function getAppSettingsForm(settings) {
  return {
    serverMaxRamMb: Number(settings?.serverMaxRamMb) || 4096,
    minServerMaxRamMb: Number(settings?.minServerMaxRamMb) || 512,
    maxServerMaxRamMb: Number(settings?.maxServerMaxRamMb) || 32768,
  };
}

function formatRamMb(value) {
  const numericValue = Number(value) || 0;

  if (numericValue >= 1024) {
    return `${(numericValue / 1024).toFixed(numericValue % 1024 === 0 ? 0 : 1)} GB`;
  }

  return `${numericValue} MB`;
}

async function refreshAppSettings() {
  if (currentPage !== "settings" || appSettings.isLoading) return;

  appSettings = {
    ...appSettings,
    isLoading: true,
    error: "",
  };
  renderApp();

  try {
    const data = await window.minecraftAPI.getAppSettings();

    appSettings = {
      ...appSettings,
      isLoading: false,
      data,
      form: getAppSettingsForm(data),
    };
  } catch (error) {
    appSettings = {
      ...appSettings,
      isLoading: false,
      error: error.message || "Could not load app settings.",
    };
  }

  renderApp();
}

async function saveAppSettings(nextForm = appSettings.form) {
  if (appSettings.isSaving) return;

  appSettings = {
    ...appSettings,
    isSaving: true,
    error: "",
    form: getAppSettingsForm(nextForm),
  };
  renderApp();

  try {
    const data = await window.minecraftAPI.saveAppSettings({
      serverMaxRamMb: appSettings.form.serverMaxRamMb,
    });

    appSettings = {
      ...appSettings,
      isSaving: false,
      data,
      form: getAppSettingsForm(data),
    };
  } catch (error) {
    appSettings = {
      ...appSettings,
      isSaving: false,
      error: error.message || "Could not save app settings.",
    };
  }

  renderApp();
}

async function refreshDdnsSettings() {
  if (currentPage !== "settings" || ddnsSettings.isLoading) return;

  ddnsSettings = {
    ...ddnsSettings,
    isLoading: true,
    error: "",
  };
  renderApp();

  try {
    const data = await window.minecraftAPI.getDdnsSettings();

    ddnsSettings = {
      ...ddnsSettings,
      isLoading: false,
      data,
      form: getDdnsFormFromSettings(data),
    };
  } catch (error) {
    ddnsSettings = {
      ...ddnsSettings,
      isLoading: false,
      error: error.message || "Could not load DDNS settings.",
    };
  }

  renderApp();
}

async function saveDdnsSettings(event) {
  event.preventDefault();

  if (ddnsSettings.isSaving) return;

  const form = event.target;

  ddnsSettings = {
    ...ddnsSettings,
    isSaving: true,
    error: "",
    form: {
      enabled: form.ddnsEnabled.checked,
      hostname: form.ddnsHostname.value.trim(),
      intervalMinutes: Number(form.ddnsInterval.value),
      password: form.ddnsPassword.value,
    },
  };
  renderApp();

  try {
    const data = await window.minecraftAPI.saveDdnsSettings(ddnsSettings.form);

    ddnsSettings = {
      ...ddnsSettings,
      isSaving: false,
      data,
      form: getDdnsFormFromSettings(data),
    };
  } catch (error) {
    ddnsSettings = {
      ...ddnsSettings,
      isSaving: false,
      error: error.message || "Could not save DDNS settings.",
    };
  }

  renderApp();
}

async function runDdnsUpdateNow() {
  if (ddnsSettings.isRunningNow) return;

  ddnsSettings = {
    ...ddnsSettings,
    isRunningNow: true,
    error: "",
  };
  renderApp();

  try {
    const data = await window.minecraftAPI.runDdnsUpdateNow();

    ddnsSettings = {
      ...ddnsSettings,
      isRunningNow: false,
      data,
      form: getDdnsFormFromSettings(data),
    };
  } catch (error) {
    ddnsSettings = {
      ...ddnsSettings,
      isRunningNow: false,
      error: error.message || "Could not run DDNS update.",
    };
  }

  renderApp();
}

async function openCreateServerModal() {
  serverContextMenu = null;
  editServerModal = null;
  pendingDeleteServerId = null;
  isCreateModalOpen = true;
  renderApp();

  await loadServerVersionOptions();
}

async function loadServerVersionOptions(force = false) {
  const serverType = createServerFormState.type || "vanilla";

  if (
    !force &&
    versionsLoading === false &&
    serverVersionOptions.length > 0 &&
    versionOptionsType === serverType
  ) {
    return;
  }

  if (versionsLoading) return;

  versionsLoading = true;
  versionsError = "";
  serverVersionOptions = [];
  renderApp();

  try {
    serverVersionOptions = await window.minecraftAPI.getServerVersionOptions({
      type: serverType,
    });
    versionOptionsType = serverType;
    versionOptionsProject = "";
  } catch (error) {
    versionsError = error.message || "Failed to load server versions";
  } finally {
    versionsLoading = false;
    renderApp();
  }
}

function closeCreateServerModal() {
  if (isCreateServerPending) return;

  isCreateModalOpen = false;
  renderApp();
}

async function createServer(event) {
  event.preventDefault();

  if (isCreateServerPending) return;

  const form = event.target;

  const serverName = form.serverName.value.trim();
  const serverColor = normalizeServerColor(form.serverColor.value);
  const serverType = form.serverType.value;
  const serverVersion = form.serverVersion.value;

  if (!serverName || !serverVersion) return;

  const selectedVersion = serverVersionOptions.find(
    (version) => version.id === serverVersion
  );

  if (!selectedVersion) {
    alert("Could not find selected version.");
    return;
  }

  createServerFormState = {
    name: serverName,
    type: serverType,
    selectedVersionId: serverVersion,
    color: serverColor,
  };

  isCreateServerPending = true;
  renderApp();

  try {
    const downloadedServer = await window.minecraftAPI.createServer({
      name: serverName,
      type: serverType,
      color: serverColor,
      version: selectedVersion.version || serverVersion,
      versionUrl: selectedVersion.versionUrl || selectedVersion.url || "",
      loaderVersion: selectedVersion.loaderVersion || "",
      installerVersion: selectedVersion.installerVersion || "",
      minecraftVersion: selectedVersion.version || "",
    });

    console.log("Used cache:", downloadedServer.usedCache);

    const newServer = downloadedServer.server;

    isCreateServerPending = false;
    isCreateModalOpen = false;
    createServerFormState = {
      name: "",
      type: "vanilla",
      selectedVersionId: "",
      color: DEFAULT_SERVER_COLOR,
    };
    serverVersionOptions = [];
    versionOptionsType = "";
    versionOptionsProject = "";
    currentPage = `server:${newServer.id}`;

    // Reload servers from saved server-info.json files
    servers = await window.minecraftAPI.getSavedServers();
  } catch (error) {
    isCreateServerPending = false;
    renderApp();
    if (showJavaInstallPrompt(error)) return;

    alert(error.message || "Failed to create server");
    return;
  }

  renderApp();
}

async function refreshSystemMonitorStats() {
  if (currentPage !== "system" || systemMonitorRequestInFlight) return;

  systemMonitorRequestInFlight = true;

  if (!systemMonitorStats.data) {
    systemMonitorStats = {
      ...systemMonitorStats,
      isLoading: true,
      error: "",
    };
    cpuTemperatureState = {
      ...cpuTemperatureState,
      isLoading: true,
      error: "",
    };

    if (!hasBlockingOverlayOpen()) {
      renderApp();
    }
  }

  const [serverStatsResult, cpuTemperatureResult] = await Promise.allSettled([
    window.minecraftAPI.getServerRuntimeStats(),
    window.hardware.getCpuTemp(),
  ]);

  if (serverStatsResult.status === "fulfilled") {
    systemMonitorStats = {
      isLoading: false,
      error: "",
      data: serverStatsResult.value,
    };
  } else {
    systemMonitorStats = {
      ...systemMonitorStats,
      isLoading: false,
      error: getFriendlySystemMonitorError(serverStatsResult.reason),
    };
  }

  if (cpuTemperatureResult.status === "fulfilled") {
    cpuTemperatureState = {
      isLoading: false,
      error: "",
      data: cpuTemperatureResult.value,
    };
  } else {
    cpuTemperatureState = {
      ...cpuTemperatureState,
      isLoading: false,
      error: cpuTemperatureResult.reason?.message || "Temperature unavailable on this PC",
    };
  }

  systemMonitorRequestInFlight = false;

  if (currentPage === "system" && !hasBlockingOverlayOpen()) {
    renderApp();
  }
}

function syncSystemMonitorPolling() {
  if (currentPage === "system") {
    if (!systemMonitorInterval) {
      systemMonitorInterval = setInterval(refreshSystemMonitorStats, 2500);
      refreshSystemMonitorStats();
    }

    return;
  }

  if (systemMonitorInterval) {
    clearInterval(systemMonitorInterval);
    systemMonitorInterval = null;
  }
}

function getCurrentServerId() {
  if (!currentPage.startsWith("server:")) return null;

  return Number(currentPage.replace("server:", ""));
}

async function refreshSelectedServerRuntime() {
  const serverId = getCurrentServerId();

  if (!serverId || selectedServerRuntimeRequestInFlight) return;

  selectedServerRuntimeRequestInFlight = true;
  const previousStatus = selectedServerRuntime?.status || "";

  try {
    selectedServerRuntime = await window.minecraftAPI.getServerRuntimeState(serverId);
  } catch (error) {
    selectedServerRuntime = {
      serverId,
      status: "unknown",
      logs: [error.message || "Failed to load server state"],
      eulaAccepted: false,
      eulaUrl: "https://aka.ms/MinecraftEULA",
    };
  } finally {
    selectedServerRuntimeRequestInFlight = false;

    if (getCurrentServerId() === serverId) {
      if (hasBlockingOverlayOpen()) {
        updateConsolePanel();
        updatePlayerCountCard();
      } else if (previousStatus !== selectedServerRuntime?.status) {
        renderApp();
      } else {
        updateConsolePanel();
        updatePlayerCountCard();
      }
    }
  }
}

function syncSelectedServerRuntimePolling() {
  const serverId = getCurrentServerId();

  if (serverId) {
    if (!selectedServerRuntime || selectedServerRuntime.serverId !== serverId) {
      selectedServerRuntime = null;
    }

    if (!selectedServerRuntimeInterval) {
      selectedServerRuntimeInterval = setInterval(refreshSelectedServerRuntime, 1500);
      refreshSelectedServerRuntime();
    }

    return;
  }

  if (selectedServerRuntimeInterval) {
    clearInterval(selectedServerRuntimeInterval);
    selectedServerRuntimeInterval = null;
  }

  selectedServerRuntime = null;
}

async function runServerAction(serverId, action, options = {}) {
  if (serverActionPending) return;

  serverActionPending = action;
  renderApp();

  try {
    let runtime;

    if (action === "start") {
      runtime = await window.minecraftAPI.startServer({
        id: serverId,
        acceptEula: Boolean(options.acceptEula),
        forceSwitch: Boolean(options.forceSwitch),
      });
    }

    if (action === "stop") {
      runtime = await window.minecraftAPI.stopServer(serverId);
    }

    if (action === "restart") {
      runtime = await window.minecraftAPI.restartServer({
        id: serverId,
        acceptEula: Boolean(options.acceptEula),
      });
    }

    if (runtime?.requiresEula) {
      pendingEulaAction = {
        serverId,
        action,
        forceSwitch: Boolean(options.forceSwitch),
        eulaUrl: runtime.eulaUrl || "https://aka.ms/MinecraftEULA",
      };
    }

    if (runtime?.requiresServerSwitch) {
      pendingServerSwitchAction = {
        serverId,
        action,
        activeServer: runtime.activeServer,
      };
    }

    selectedServerRuntime = runtime || selectedServerRuntime;
  } catch (error) {
    if (showJavaInstallPrompt(error)) return;

    alert(error.message || `Failed to ${action} server`);
  } finally {
    serverActionPending = "";
    renderApp();
  }
}

function requestStopServer(serverId) {
  pendingStopServerId = Number(serverId);
  renderApp();
}

function closeStopServerModal() {
  pendingStopServerId = null;
  renderApp();
}

async function confirmStopServer() {
  const serverId = pendingStopServerId;

  pendingStopServerId = null;
  await runServerAction(serverId, "stop");
}

function closeEulaModal() {
  pendingEulaAction = null;
  renderApp();
}

function closeJavaInstallModal() {
  pendingJavaInstallError = null;
  renderApp();
}

async function acceptEulaAndRunServer() {
  if (!pendingEulaAction) return;

  const action = pendingEulaAction.action;
  const serverId = pendingEulaAction.serverId;
  const forceSwitch = Boolean(pendingEulaAction.forceSwitch);

  pendingEulaAction = null;
  await runServerAction(serverId, action, { acceptEula: true, forceSwitch });
}

function closeServerSwitchModal() {
  pendingServerSwitchAction = null;
  renderApp();
}

async function confirmServerSwitch() {
  if (!pendingServerSwitchAction) return;

  const switchAction = pendingServerSwitchAction;

  pendingServerSwitchAction = null;
  await runServerAction(switchAction.serverId, switchAction.action, {
    forceSwitch: true,
  });
}

async function submitConsoleCommand(event) {
  event.preventDefault();

  const serverId = getCurrentServerId();
  const command = consoleCommand.trim();

  if (!serverId || !command) return;

  try {
    selectedServerRuntime = await window.minecraftAPI.sendServerCommand({
      id: serverId,
      command,
    });
    consoleCommand = "";
  } catch (error) {
    alert(error.message || "Failed to send server command");
  }

  renderApp();
}

function openServerContextMenu(serverId, x, y) {
  const numericServerId = Number(serverId);
  const server = servers.find((item) => item.id === numericServerId);

  if (!server || deletingServerId !== null) return;

  serverContextMenu = {
    serverId: numericServerId,
    x,
    y,
  };
  renderApp();
}

function closeServerContextMenu() {
  if (!serverContextMenu) return;

  serverContextMenu = null;
  renderApp();
}

async function reorderServerSidebar(draggedServerId, targetServerId) {
  const draggedId = Number(draggedServerId);
  const targetId = Number(targetServerId);

  if (!draggedId || !targetId || draggedId === targetId) return;

  const fromIndex = servers.findIndex((server) => server.id === draggedId);
  const toIndex = servers.findIndex((server) => server.id === targetId);

  if (fromIndex === -1 || toIndex === -1) return;

  const nextServers = [...servers];
  const [movedServer] = nextServers.splice(fromIndex, 1);
  nextServers.splice(toIndex, 0, movedServer);

  servers = nextServers;
  renderApp();

  try {
    servers = await window.minecraftAPI.reorderServers(
      nextServers.map((server) => server.id)
    );
  } catch (error) {
    alert(error.message || "Failed to save server order");
    servers = await window.minecraftAPI.getSavedServers();
  } finally {
    draggingServerId = null;
    dragOverServerId = null;
    renderApp();
  }
}

function openEditServerModal(serverId, mode) {
  const numericServerId = Number(serverId);
  const server = servers.find((item) => item.id === numericServerId);

  if (!server || deletingServerId !== null) return;

  serverContextMenu = null;
  editServerModal = {
    serverId: numericServerId,
    mode,
    name: server.name,
    color: normalizeServerColor(server.color),
    isSaving: false,
  };
  renderApp();
}

function closeEditServerModal() {
  if (editServerModal?.isSaving) return;

  editServerModal = null;
  renderApp();
}

async function saveServerEdit(event) {
  event.preventDefault();

  if (!editServerModal || editServerModal.isSaving) return;

  const form = event.target;
  const serverData = {
    id: editServerModal.serverId,
  };

  if (editServerModal.mode === "rename") {
    const name = form.serverName.value.trim();

    if (!name) return;

    serverData.name = name;
    editServerModal = {
      ...editServerModal,
      name,
      isSaving: true,
    };
  }

  if (editServerModal.mode === "recolor") {
    const color = normalizeServerColor(form.serverColor.value);

    serverData.color = color;
    editServerModal = {
      ...editServerModal,
      color,
      isSaving: true,
    };
  }

  renderApp();

  try {
    await window.minecraftAPI.updateSavedServer(serverData);
    servers = await window.minecraftAPI.getSavedServers();
    editServerModal = null;
  } catch (error) {
    editServerModal = {
      ...editServerModal,
      isSaving: false,
    };
    alert(error.message || "Failed to update server");
  }

  renderApp();
}

function requestDeleteServer(serverId) {
  const numericServerId = Number(serverId);
  const server = servers.find((item) => item.id === numericServerId);

  if (!server || deletingServerId !== null) return;

  serverContextMenu = null;
  editServerModal = null;
  pendingDeleteServerId = numericServerId;
  renderApp();
}

function closeDeleteServerModal() {
  if (deletingServerId !== null) return;

  pendingDeleteServerId = null;
  renderApp();
}

async function confirmDeleteServer() {
  const numericServerId = Number(pendingDeleteServerId);
  const server = servers.find((item) => item.id === numericServerId);

  if (!server || deletingServerId !== null) return;

  pendingDeleteServerId = null;
  deletingServerId = numericServerId;
  renderApp();

  try {
    await window.minecraftAPI.deleteSavedServer(numericServerId);
    servers = await window.minecraftAPI.getSavedServers();

    if (currentPage === `server:${numericServerId}`) {
      currentPage = "home";
    }
  } catch (error) {
    alert(error.message || "Failed to delete server");
  } finally {
    deletingServerId = null;
    renderApp();
  }
}

function renderServerButtons() {
  return servers
    .map((server) => {
      const isActive = currentPage === `server:${server.id}`;
      const serverColor = normalizeServerColor(server.color);
      const isDeleting = deletingServerId === server.id;
      const isDragging = draggingServerId === server.id;
      const isDragTarget = dragOverServerId === server.id && draggingServerId !== server.id;

      return `
        <button 
          class="server-icon server-button ${isActive ? "active" : ""} ${isDeleting ? "deleting" : ""} ${isDragging ? "dragging" : ""} ${isDragTarget ? "drag-target" : ""}" 
          data-server-id="${server.id}"
          style="--server-color: ${escapeHTML(serverColor)}"
          title="${escapeHTML(server.name)}"
          aria-label="${escapeHTML(server.name)}"
          draggable="${isDeleting ? "false" : "true"}"
          ${isDeleting ? "disabled" : ""}
        ></button>
      `;
    })
    .join("");
}

function renderServerContextMenu() {
  if (!serverContextMenu) return "";

  const server = servers.find((item) => item.id === serverContextMenu.serverId);

  if (!server) return "";

  const left = Math.max(8, Math.min(serverContextMenu.x, window.innerWidth - 168));
  const top = Math.max(8, Math.min(serverContextMenu.y, window.innerHeight - 136));

  return `
    <div class="context-menu-backdrop" id="closeServerContextMenu"></div>
    <div
      class="server-context-menu"
      style="left: ${left}px; top: ${top}px"
      role="menu"
      aria-label="${escapeHTML(server.name)} actions"
    >
      <button type="button" data-context-action="rename" data-server-id="${server.id}">
        Rename
      </button>
      <button type="button" data-context-action="recolor" data-server-id="${server.id}">
        Recolor
      </button>
      <button type="button" class="danger-menu-item" data-context-action="delete" data-server-id="${server.id}">
        Delete
      </button>
    </div>
  `;
}

function renderEditServerModal() {
  if (!editServerModal) return "";

  const server = servers.find((item) => item.id === editServerModal.serverId);

  if (!server) return "";

  const isRename = editServerModal.mode === "rename";
  const title = isRename ? "Rename Server" : "Recolor Server";
  const saveLabel = editServerModal.isSaving ? "Saving..." : "Save";
  const controlsDisabled = editServerModal.isSaving ? "disabled" : "";

  return `
    <div class="modal-overlay">
      <div class="edit-server-modal">
        <div class="modal-header">
          <h2>${title}</h2>
          <button
            type="button"
            class="modal-close-button"
            id="closeEditModal"
            aria-label="Close ${title.toLowerCase()} popup"
            ${controlsDisabled}
          >
            &times;
          </button>
        </div>

        <form id="editServerForm">
          ${
            isRename
              ? `<label>
                  Server Name
                  <input
                    type="text"
                    name="serverName"
                    value="${escapeHTML(editServerModal.name)}"
                    required
                    ${controlsDisabled}
                  />
                </label>`
              : `<label class="server-color-field">
                  Color
                  <input
                    type="color"
                    name="serverColor"
                    value="${escapeHTML(normalizeServerColor(editServerModal.color))}"
                    ${controlsDisabled}
                  />
                </label>`
          }

          <div class="modal-actions">
            <button
              type="button"
              class="secondary-button"
              id="cancelEditServer"
              ${controlsDisabled}
            >
              Cancel
            </button>

            <button type="submit" class="primary-button" ${controlsDisabled}>
              ${saveLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderDeleteServerModal() {
  if (pendingDeleteServerId === null) return "";

  const server = servers.find((item) => item.id === pendingDeleteServerId);

  if (!server) return "";

  return `
    <div class="modal-overlay">
      <div class="delete-server-modal">
        <div class="modal-header">
          <h2>Delete Server</h2>
          <button
            type="button"
            class="modal-close-button"
            id="closeDeleteModal"
            aria-label="Close delete server popup"
          >
            &times;
          </button>
        </div>

        <p>
          Delete <b>${escapeHTML(server.name)}</b>? This will remove its saved server folder.
        </p>

        <div class="modal-actions">
          <button type="button" class="secondary-button" id="cancelDeleteServer">
            Cancel
          </button>

          <button
            type="button"
            class="danger-button"
            id="confirmDeleteServer"
          >
            Delete Server
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderEulaModal() {
  if (!pendingEulaAction) return "";

  const server = servers.find((item) => item.id === pendingEulaAction.serverId);
  const serverName = server?.name || "this server";

  return `
    <div class="modal-overlay">
      <div class="eula-modal">
        <div class="modal-header">
          <h2>Minecraft EULA</h2>
          <button
            type="button"
            class="modal-close-button"
            id="closeEulaModal"
            aria-label="Close Minecraft EULA popup"
            ${serverActionPending ? "disabled" : ""}
          >
            &times;
          </button>
        </div>

        <p>
          Before starting <b>${escapeHTML(serverName)}</b>, you need to agree to the Minecraft End User License Agreement.
        </p>

        <a class="eula-link" href="${escapeHTML(pendingEulaAction.eulaUrl)}" target="_blank" rel="noreferrer">
          Read the Minecraft EULA
        </a>

        <div class="modal-actions">
          <button
            type="button"
            class="secondary-button"
            id="cancelEula"
            ${serverActionPending ? "disabled" : ""}
          >
            Cancel
          </button>

          <button
            type="button"
            class="primary-button"
            id="acceptEula"
            ${serverActionPending ? "disabled" : ""}
          >
            I Agree
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderJavaInstallModal() {
  if (!pendingJavaInstallError) return "";

  const installUrl = pendingJavaInstallError.installUrl || JAVA_INSTALL_URL;

  return `
    <div class="modal-overlay">
      <div class="java-install-modal">
        <div class="modal-header">
          <h2>Java Required</h2>
          <button
            type="button"
            class="modal-close-button"
            id="closeJavaInstallModal"
            aria-label="Close Java install popup"
          >
            &times;
          </button>
        </div>

        <p>
          ${escapeHTML(pendingJavaInstallError.message)}
          Install a JDK, then reopen ${escapeHTML(APP_DISPLAY_NAME)} before starting the server again.
        </p>

        <a class="eula-link" href="${escapeHTML(installUrl)}" target="_blank" rel="noreferrer">
          Install Java for developers
        </a>

        <div class="modal-actions">
          <button
            type="button"
            class="primary-button"
            id="dismissJavaInstallModal"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderStopServerModal() {
  if (pendingStopServerId === null) return "";

  const server = servers.find((item) => item.id === pendingStopServerId);
  const serverName = server?.name || "this server";

  return `
    <div class="modal-overlay">
      <div class="delete-server-modal">
        <div class="modal-header">
          <h2>Stop Server</h2>
          <button
            type="button"
            class="modal-close-button"
            id="closeStopModal"
            aria-label="Close stop server popup"
            ${serverActionPending ? "disabled" : ""}
          >
            &times;
          </button>
        </div>

        <p>
          Stop <b>${escapeHTML(serverName)}</b>? Connected players will be disconnected.
        </p>

        <div class="modal-actions">
          <button
            type="button"
            class="secondary-button"
            id="cancelStopServer"
            ${serverActionPending ? "disabled" : ""}
          >
            Cancel
          </button>

          <button
            type="button"
            class="danger-button"
            id="confirmStopServer"
            ${serverActionPending ? "disabled" : ""}
          >
            Stop Server
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderServerSwitchModal() {
  if (!pendingServerSwitchAction) return "";

  const nextServer = servers.find((item) => {
    return item.id === pendingServerSwitchAction.serverId;
  });
  const nextServerName = nextServer?.name || "this server";
  const activeServerName =
    pendingServerSwitchAction.activeServer?.serverName || "the running server";

  return `
    <div class="modal-overlay">
      <div class="switch-server-modal">
        <div class="modal-header">
          <h2>Switch Server</h2>
          <button
            type="button"
            class="modal-close-button"
            id="closeSwitchServerModal"
            aria-label="Close switch server popup"
            ${serverActionPending ? "disabled" : ""}
          >
            &times;
          </button>
        </div>

        <p>
          Only one server can run at a time. Starting <b>${escapeHTML(nextServerName)}</b> will stop <b>${escapeHTML(activeServerName)}</b> first.
        </p>

        <div class="modal-actions">
          <button
            type="button"
            class="secondary-button"
            id="cancelSwitchServer"
            ${serverActionPending ? "disabled" : ""}
          >
            Cancel
          </button>

          <button
            type="button"
            class="primary-button"
            id="confirmSwitchServer"
            ${serverActionPending ? "disabled" : ""}
          >
            Stop and Start
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderSystemMonitorPage() {
  const stats = systemMonitorStats.data;
  const totalCpuPercent = stats?.totalCpuPercent || 0;
  const totalRamBytes = stats?.totalRamBytes || 0;
  const cpuTemperatureResult = cpuTemperatureState.data;
  const hasCpuTemperature =
    cpuTemperatureResult?.ok && typeof cpuTemperatureResult.cpuTemp === "number";
  const cpuTemperatureSensors = Array.isArray(cpuTemperatureResult?.sensors)
    ? cpuTemperatureResult.sensors
    : [];
  const sampledAt = stats?.sampledAt
    ? new Date(stats.sampledAt).toLocaleTimeString()
    : "Waiting for sample";

  return `
    <section class="system-page">
      <div class="system-page-header">
        <div>
          <h1>System Monitor</h1>
          <p>Live usage from the active Minecraft server.jar process.</p>
        </div>

        <span class="monitor-refresh-status">
          ${systemMonitorStats.isLoading ? "Checking..." : `Updated ${sampledAt}`}
        </span>
      </div>

      ${
        systemMonitorStats.error
          ? `<p class="monitor-error">${escapeHTML(systemMonitorStats.error)}</p>`
          : ""
      }

      <div class="stats-grid monitor-stats-grid">
        <div class="stat-card">
          <h2>Server CPU</h2>
          <p class="stat-value">${formatPercent(totalCpuPercent)}</p>
          <p class="stat-info">CPU used by server.jar</p>
        </div>

        <div class="stat-card">
          <h2>Server RAM</h2>
          <p class="stat-value">${formatBytes(totalRamBytes)}</p>
          <p class="stat-info">Memory used by server.jar</p>
        </div>

        <div class="stat-card">
          <h2>CPU Temperature</h2>
          <p class="stat-value">${formatTemperature(
            hasCpuTemperature ? cpuTemperatureResult.cpuTemp : null
          )}</p>
          <p class="stat-info">
            ${
              hasCpuTemperature
                ? escapeHTML(`${cpuTemperatureSensors.length} CPU sensor${cpuTemperatureSensors.length === 1 ? "" : "s"}`)
                : "Temperature unavailable on this PC"
            }
          </p>
          ${
            !hasCpuTemperature && cpuTemperatureState.isLoading
              ? `<p class="stat-info">Checking...</p>`
              : ""
          }
          ${
            !hasCpuTemperature && cpuTemperatureState.error
              ? `<p class="stat-info">${escapeHTML(cpuTemperatureState.error)}</p>`
              : ""
          }
        </div>
      </div>
    </section>
  `;
}

function renderDdnsStatus() {
  const status = ddnsSettings.data?.lastStatus;

  if (!status) {
    return `
      <div class="ddns-status-box">
        <h2>Last Check</h2>
        <p class="stat-info">No DDNS check has run yet.</p>
      </div>
    `;
  }

  const checkedAt = status.checkedAt
    ? new Date(status.checkedAt).toLocaleString()
    : "Unknown";
  const statusClass = status.ok ? "ddns-ok" : "ddns-error";

  return `
    <div class="ddns-status-box">
      <div class="ddns-status-header">
        <h2>Last Check</h2>
        <span class="ddns-pill ${statusClass}">
          ${status.ok ? "OK" : "Error"}
        </span>
      </div>

      <dl class="ddns-status-list">
        <div>
          <dt>Time</dt>
          <dd>${escapeHTML(checkedAt)}</dd>
        </div>
        <div>
          <dt>Public IP</dt>
          <dd>${escapeHTML(status.publicIp || "--")}</dd>
        </div>
        <div>
          <dt>Domain IP</dt>
          <dd>${escapeHTML(status.domainIp || "--")}</dd>
        </div>
        <div>
          <dt>Response</dt>
          <dd>${escapeHTML(status.response || "--")}</dd>
        </div>
      </dl>
    </div>
  `;
}

function renderSettingsPage() {
  const form = ddnsSettings.form;
  const ramForm = appSettings.form;
  const hasPassword = ddnsSettings.data?.hasPassword;
  const controlsDisabled =
    ddnsSettings.isLoading || ddnsSettings.isSaving || ddnsSettings.isRunningNow;
  const ramControlsDisabled = appSettings.isLoading || appSettings.isSaving;

  return `
    <section class="settings-page">
      <div class="settings-page-header">
        <div>
          <h1>Settings</h1>
          <p>Dynu Dynamic DNS updater</p>
        </div>
      </div>

      ${
        ddnsSettings.error
          ? `<p class="monitor-error">${escapeHTML(ddnsSettings.error)}</p>`
          : ""
      }
      ${
        appSettings.error
          ? `<p class="monitor-error">${escapeHTML(appSettings.error)}</p>`
          : ""
      }

      <div class="settings-grid">
        <form class="settings-panel ram-settings-panel" id="appSettingsForm">
          <div class="settings-panel-header">
            <h2>Server Runtime</h2>
            <span class="settings-value-pill">
              ${escapeHTML(formatRamMb(ramForm.serverMaxRamMb))}
            </span>
          </div>

          <label class="range-field">
            Maximum server.jar RAM
            <input
              type="range"
              name="serverMaxRamMb"
              min="${ramForm.minServerMaxRamMb}"
              max="${ramForm.maxServerMaxRamMb}"
              step="512"
              value="${ramForm.serverMaxRamMb}"
              ${ramControlsDisabled ? "disabled" : ""}
            />
          </label>

          <div class="ram-scale">
            <span>${escapeHTML(formatRamMb(ramForm.minServerMaxRamMb))}</span>
            <span>${escapeHTML(formatRamMb(ramForm.maxServerMaxRamMb))}</span>
          </div>

          <p class="settings-note">
            Applied as the Java maximum heap for server.jar launches.
          </p>

          <div class="modal-actions">
            <button type="submit" class="primary-button" ${ramControlsDisabled ? "disabled" : ""}>
              ${appSettings.isSaving ? "Saving..." : "Save RAM Limit"}
            </button>
          </div>
        </form>

        <form class="settings-panel" id="ddnsSettingsForm">
          <div class="settings-panel-header">
            <h2>DDNS</h2>
            <label class="toggle-field">
              <input
                type="checkbox"
                name="ddnsEnabled"
                ${form.enabled ? "checked" : ""}
                ${controlsDisabled ? "disabled" : ""}
              />
              <span>Enabled</span>
            </label>
          </div>

          <label>
            Hostname
            <input
              type="text"
              name="ddnsHostname"
              value="${escapeHTML(form.hostname)}"
              placeholder="digi-project.freeddns.org"
              required
              ${controlsDisabled ? "disabled" : ""}
            />
          </label>

          <label>
            Update Password
            <input
              type="password"
              name="ddnsPassword"
              value="${escapeHTML(form.password)}"
              placeholder="${hasPassword ? "Saved - leave blank to keep" : "Enter IP update password"}"
              ${hasPassword ? "" : "required"}
              ${controlsDisabled ? "disabled" : ""}
            />
          </label>

          <label>
            Check Every
            <input
              type="number"
              name="ddnsInterval"
              min="5"
              max="1440"
              step="1"
              value="${escapeHTML(String(form.intervalMinutes))}"
              required
              ${controlsDisabled ? "disabled" : ""}
            />
          </label>

          <div class="modal-actions">
            <button
              type="button"
              class="secondary-button"
              id="runDdnsUpdateNow"
              ${controlsDisabled || !hasPassword ? "disabled" : ""}
            >
              ${ddnsSettings.isRunningNow ? "Checking..." : "Update Now"}
            </button>

            <button type="submit" class="primary-button" ${controlsDisabled ? "disabled" : ""}>
              ${ddnsSettings.isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>

        ${renderDdnsStatus()}
      </div>
    </section>
  `;
}

function renderMainContent() {
  if (currentPage === "system") {
    return renderSystemMonitorPage();
  }

  if (currentPage === "settings") {
    return renderSettingsPage();
  }

  if (currentPage.startsWith("server:")) {
    const serverId = Number(currentPage.replace("server:", ""));
    const server = servers.find((item) => item.id === serverId);

    if (!server) {
      return `<h1>Server not found</h1>`;
    }

    const serverColor = normalizeServerColor(server.color);
    const isDeleting = deletingServerId === server.id;
    const runtime =
      selectedServerRuntime?.serverId === server.id ? selectedServerRuntime : null;
    const serverStatus = runtime?.status || "offline";
    const isStarting = serverStatus === "starting";
    const isRunning = serverStatus === "running";
    const isStopping = serverStatus === "stopping";
    const controlsDisabled = Boolean(serverActionPending || isDeleting);
    const playerDetails = getRuntimePlayerDetails(runtime);
    const statusClass = getRuntimeStatusClass(serverStatus);
    const serverTypeLabel = server.typeLabel || server.type.toUpperCase();

    return `
      <section class="server-dashboard">
        <div class="server-dashboard-header">
          <div>
            <h1>${escapeHTML(server.name)}</h1>
            <p>${escapeHTML(serverTypeLabel)} server running Minecraft ${escapeHTML(server.version)}</p>
          </div>

          <button
            type="button"
            class="danger-button"
            id="deleteCurrentServer"
            data-server-id="${server.id}"
            ${controlsDisabled ? "disabled" : ""}
          >
            ${isDeleting ? "Deleting..." : "Delete"}
          </button>
        </div>

        <div class="server-color-summary">
          <span
            class="server-color-preview"
            style="--server-color: ${escapeHTML(serverColor)}"
            aria-hidden="true"
          ></span>
          <span>${escapeHTML(serverColor)}</span>
        </div>

        <div class="server-power-control">
          ${
            isRunning || isStopping
              ? `<div class="stop-control-wrap">
                  <button
                    type="button"
                    class="server-power-button stop-server-button"
                    id="stopServer"
                    data-server-id="${server.id}"
                    ${controlsDisabled || isStopping ? "disabled" : ""}
                  >
                    ${serverActionPending === "stop" || isStopping ? "Ending..." : "Stop"}
                  </button>

                  <button
                    type="button"
                    class="restart-mini-button"
                    id="restartServer"
                    data-server-id="${server.id}"
                    ${controlsDisabled || isStopping ? "disabled" : ""}
                  >
                    ${serverActionPending === "restart" ? "..." : "Restart"}
                  </button>
                </div>`
              : `<button
                  type="button"
                  class="server-power-button start-server-button ${serverActionPending === "start" || isStarting ? "is-loading" : ""}"
                  id="startServer"
                  data-server-id="${server.id}"
                  ${controlsDisabled || isStarting ? "disabled" : ""}
                >
                  ${serverActionPending === "start" || isStarting ? "Starting..." : "Start Server"}
                </button>`
          }
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <h2>Status</h2>
            <p class="stat-value server-status-value ${statusClass}">
              ${escapeHTML(serverStatus)}
            </p>
            <p class="stat-info">
              ${
                runtime?.pid
                  ? `PID ${runtime.pid}`
                  : runtime?.eulaAccepted
                    ? "Ready to start"
                    : "EULA agreement required before first start"
              }
            </p>
          </div>

          <div class="stat-card">
            <h2>Players</h2>
            <p class="stat-value" id="playerCountValue">
              ${playerDetails.playerCount}/${playerDetails.maxPlayers}
            </p>
            <p class="stat-info" id="playerCountInfo">
              ${escapeHTML(playerDetails.playerInfo)}
            </p>
          </div>

          <div class="stat-card">
            <h2>Version</h2>
            <p class="stat-value">${escapeHTML(server.version)}</p>
            <p class="stat-info">
              ${escapeHTML(server.loaderVersion ? `${serverTypeLabel} ${server.loaderVersion}` : serverTypeLabel)}
            </p>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="welcome-card">
      <div class="welcome-brand">
        <div class="welcome-brand-icon">${APP_ICON_MARK}</div>
        <div>
          <h1>${escapeHTML(APP_DISPLAY_NAME)}</h1>
          <p>Create, launch, monitor, and tune local Minecraft servers.</p>
        </div>
      </div>

      <div class="launcher-summary-grid">
        <div class="guide-box">
          <h2>Quick Start</h2>

          <div class="guide-step">
            <span>1</span>
            <p>Create a Vanilla, Paper, Fabric, Forge, or NeoForge server.</p>
          </div>

          <div class="guide-step">
            <span>2</span>
            <p>Start it from the dashboard and accept the EULA when prompted.</p>
          </div>

          <div class="guide-step">
            <span>3</span>
            <p>Use the console and monitor panels while the server is running.</p>
          </div>
        </div>

        <div class="guide-box accent-guide-box">
          <h2>Runtime Control</h2>
          <p>Set a global RAM limit in Settings before starting a server.</p>
          <button type="button" class="secondary-button" id="homeSettingsButton">
            Open Settings
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderVersionOptions() {
  if (versionsLoading) {
    return `<option value="">Loading versions...</option>`;
  }

  if (versionsError) {
    return `<option value="">Failed to load versions</option>`;
  }

  if (serverVersionOptions.length === 0) {
    return `<option value="">No versions loaded</option>`;
  }

  if (
    !createServerFormState.selectedVersionId ||
    !serverVersionOptions.some((version) => {
      return version.id === createServerFormState.selectedVersionId;
    })
  ) {
    createServerFormState = {
      ...createServerFormState,
      selectedVersionId: serverVersionOptions[0].id,
    };
  }

  return serverVersionOptions
    .map((version) => {
      const selected =
        version.id === createServerFormState.selectedVersionId ? "selected" : "";

      return `<option value="${escapeHTML(version.id)}" ${selected}>${escapeHTML(version.label || version.id)}</option>`;
    })
    .join("");
}

function renderCreateServerModal() {
  if (!isCreateModalOpen) return "";

  const createDisabled =
    versionsLoading ||
    serverVersionOptions.length === 0;
  const controlsDisabled = isCreateServerPending ? "disabled" : "";
  const selectedColor = normalizeServerColor(createServerFormState.color);

  return `
    <div class="modal-overlay">
      <div class="create-server-modal">
        <div class="modal-header">
          <h2>Create New Server</h2>
          <button
            type="button"
            class="modal-close-button"
            id="closeCreateModal"
            aria-label="Close create server popup"
            ${controlsDisabled}
          >
            &times;
          </button>
        </div>

        <form id="createServerForm">
          <div class="server-name-row">
            <label class="server-name-field">
              Server Name
              <input 
                type="text" 
                name="serverName" 
                placeholder="Example: Survival 1.21"
                value="${escapeHTML(createServerFormState.name)}"
                required
                ${controlsDisabled}
              />
            </label>

            <label class="server-color-field">
              Color
              <input 
                type="color" 
                name="serverColor" 
                value="${escapeHTML(selectedColor)}"
                ${controlsDisabled}
              />
            </label>
          </div>

          <label>
            Server Type
            <select name="serverType" ${controlsDisabled}>
              <option value="vanilla" ${createServerFormState.type === "vanilla" ? "selected" : ""}>Vanilla</option>
              <option value="paper" ${createServerFormState.type === "paper" ? "selected" : ""}>Paper</option>
              <option value="fabric" ${createServerFormState.type === "fabric" ? "selected" : ""}>Fabric</option>
              <option value="forge" ${createServerFormState.type === "forge" ? "selected" : ""}>Forge</option>
              <option value="neoforge" ${createServerFormState.type === "neoforge" ? "selected" : ""}>NeoForge</option>
            </select>
          </label>

          <label>
            Minecraft Version
            <select name="serverVersion" required ${controlsDisabled}>
              ${renderVersionOptions()}
            </select>
          </label>

          ${
            versionsError
              ? `<p class="modal-error">${versionsError}</p>`
              : ""
          }

          <div class="modal-actions">
            <button
              type="button"
              class="secondary-button"
              id="cancelCreateServer"
              ${controlsDisabled}
            >
              Cancel
            </button>

            ${
              isCreateServerPending
                ? `<p class="download-status" aria-live="polite">
                    Downloading<span class="download-dots"><span>.</span><span>.</span><span>.</span></span>
                  </p>`
                : `<button type="submit" class="primary-button" ${createDisabled ? "disabled" : ""}>
                    Create Server
                  </button>`
            }
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderConsoleOutput() {
  const serverId = getCurrentServerId();

  if (!serverId) {
    return `
      <p>[INFO] Console ready.</p>
      <p>[INFO] Select a server to view its output.</p>
    `;
  }

  const runtime =
    selectedServerRuntime?.serverId === serverId ? selectedServerRuntime : null;
  const logs = runtime?.logs || [];

  if (logs.length === 0) {
    return `
      <p>[INFO] Console ready.</p>
      <p>[INFO] Server has not produced output yet.</p>
    `;
  }

  return logs
    .slice(-120)
    .map((line) => `<p>${escapeHTML(line)}</p>`)
    .join("");
}

function renderConsoleInput() {
  const serverId = getCurrentServerId();
  const runtime =
    selectedServerRuntime?.serverId === serverId ? selectedServerRuntime : null;
  const canSendCommand = runtime?.status === "running";

  return `
    <form class="console-command-form" id="consoleCommandForm">
      <input
        type="text"
        name="consoleCommand"
        value="${escapeHTML(consoleCommand)}"
        placeholder="${canSendCommand ? "Type a server command" : "Start a server to send commands"}"
        ${canSendCommand ? "" : "disabled"}
        autocomplete="off"
      />
      <button type="submit" ${canSendCommand ? "" : "disabled"}>
        Send
      </button>
    </form>
  `;
}

function renderApp() {
  const activeElement = document.activeElement;
  const shouldRestoreConsoleFocus =
    activeElement?.name === "consoleCommand" && !activeElement.disabled;
  const consoleSelectionStart = shouldRestoreConsoleFocus
    ? activeElement.selectionStart
    : null;
  const consoleSelectionEnd = shouldRestoreConsoleFocus
    ? activeElement.selectionEnd
    : null;
  const currentServerId = getCurrentServerId();
  const consoleRuntime =
    selectedServerRuntime?.serverId === currentServerId ? selectedServerRuntime : null;
  const consoleStatusClass = getRuntimeStatusClass(consoleRuntime?.status || "offline");

  app.innerHTML = `
    <div class="app-layout">

      <aside class="sidebar">
        <div class="sidebar-top">
          <div class="app-logo" title="${escapeHTML(APP_DISPLAY_NAME)}">
            ${APP_ICON_MARK}
          </div>

          <button class="server-icon ${currentPage === "home" ? "active" : ""}" id="homeButton" title="Home">
            ${ICON_HOME}
          </button>

          <button class="server-icon ${currentPage === "system" ? "active" : ""}" id="systemButton" title="System Monitor">
            ${ICON_SYSTEM}
          </button>

          ${renderServerButtons()}

          <button class="add-server-button" id="addServerButton" title="Create new server">
            +
          </button>
        </div>

        <div class="sidebar-bottom">
          <button class="settings-button ${currentPage === "settings" ? "active" : ""}" id="settingsButton" title="Settings">
            ${ICON_SETTINGS}
          </button>
        </div>
      </aside>

      <main class="main-content">
        ${renderMainContent()}
      </main>

      <aside class="console-panel">
        <div class="console-header">
          <h2>Console</h2>
          <span class="status-dot ${consoleStatusClass}"></span>
        </div>

        <div class="console-output">
          ${renderConsoleOutput()}
        </div>

        ${renderConsoleInput()}
      </aside>

    </div>

    ${renderCreateServerModal()}
    ${renderEditServerModal()}
    ${renderDeleteServerModal()}
    ${renderEulaModal()}
    ${renderJavaInstallModal()}
    ${renderStopServerModal()}
    ${renderServerSwitchModal()}
    ${renderServerContextMenu()}
  `;

  document.getElementById("homeButton").addEventListener("click", showHome);
  document.getElementById("systemButton").addEventListener("click", showSystemMonitor);
  document.getElementById("addServerButton").addEventListener("click", openCreateServerModal);
  document.getElementById("settingsButton").addEventListener("click", showSettings);

  const homeSettingsButton = document.getElementById("homeSettingsButton");
  if (homeSettingsButton) {
    homeSettingsButton.addEventListener("click", showSettings);
  }

  document.querySelectorAll(".server-button").forEach((button) => {
    button.addEventListener("click", () => {
      selectServer(button.dataset.serverId);
    });

    button.addEventListener("dragstart", (event) => {
      draggingServerId = Number(button.dataset.serverId);
      dragOverServerId = null;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", button.dataset.serverId);
      button.classList.add("dragging");
    });

    button.addEventListener("dragover", (event) => {
      if (!draggingServerId) return;

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      dragOverServerId = Number(button.dataset.serverId);
      document.querySelectorAll(".server-button.drag-target").forEach((item) => {
        item.classList.remove("drag-target");
      });

      if (dragOverServerId !== draggingServerId) {
        button.classList.add("drag-target");
      }
    });

    button.addEventListener("dragleave", () => {
      if (dragOverServerId === Number(button.dataset.serverId)) {
        dragOverServerId = null;
        button.classList.remove("drag-target");
      }
    });

    button.addEventListener("drop", (event) => {
      event.preventDefault();
      const draggedId =
        Number(event.dataTransfer.getData("text/plain")) || draggingServerId;

      reorderServerSidebar(draggedId, button.dataset.serverId);
    });

    button.addEventListener("dragend", () => {
      draggingServerId = null;
      dragOverServerId = null;
      document.querySelectorAll(".server-button.dragging, .server-button.drag-target").forEach((item) => {
        item.classList.remove("dragging", "drag-target");
      });
    });

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openServerContextMenu(
        button.dataset.serverId,
        event.clientX,
        event.clientY
      );
    });
  });

  const contextBackdrop = document.getElementById("closeServerContextMenu");
  if (contextBackdrop) {
    contextBackdrop.addEventListener("click", closeServerContextMenu);
    contextBackdrop.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      closeServerContextMenu();
    });
  }

  document.querySelectorAll("[data-context-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const serverId = button.dataset.serverId;

      if (button.dataset.contextAction === "rename") {
        openEditServerModal(serverId, "rename");
      }

      if (button.dataset.contextAction === "recolor") {
        openEditServerModal(serverId, "recolor");
      }

      if (button.dataset.contextAction === "delete") {
        requestDeleteServer(serverId);
      }
    });
  });

  const deleteButton = document.getElementById("deleteCurrentServer");
  if (deleteButton) {
    deleteButton.addEventListener("click", () => {
      requestDeleteServer(deleteButton.dataset.serverId);
    });
  }

  const startButton = document.getElementById("startServer");
  if (startButton) {
    startButton.addEventListener("click", () => {
      runServerAction(Number(startButton.dataset.serverId), "start");
    });
  }

  const stopButton = document.getElementById("stopServer");
  if (stopButton) {
    stopButton.addEventListener("click", () => {
      requestStopServer(Number(stopButton.dataset.serverId));
    });
  }

  const restartButton = document.getElementById("restartServer");
  if (restartButton) {
    restartButton.addEventListener("click", () => {
      runServerAction(Number(restartButton.dataset.serverId), "restart");
    });
  }

  const closeEditButton = document.getElementById("closeEditModal");
  if (closeEditButton) {
    closeEditButton.addEventListener("click", closeEditServerModal);
  }

  const cancelEditButton = document.getElementById("cancelEditServer");
  if (cancelEditButton) {
    cancelEditButton.addEventListener("click", closeEditServerModal);
  }

  const editForm = document.getElementById("editServerForm");
  if (editForm) {
    editForm.addEventListener("submit", saveServerEdit);

    if (editForm.serverName) {
      editForm.serverName.addEventListener("input", () => {
        editServerModal = {
          ...editServerModal,
          name: editForm.serverName.value,
        };
      });
    }

    if (editForm.serverColor) {
      editForm.serverColor.addEventListener("input", () => {
        editServerModal = {
          ...editServerModal,
          color: normalizeServerColor(editForm.serverColor.value),
        };
      });
    }
  }

  const closeDeleteButton = document.getElementById("closeDeleteModal");
  if (closeDeleteButton) {
    closeDeleteButton.addEventListener("click", closeDeleteServerModal);
  }

  const cancelDeleteButton = document.getElementById("cancelDeleteServer");
  if (cancelDeleteButton) {
    cancelDeleteButton.addEventListener("click", closeDeleteServerModal);
  }

  const confirmDeleteButton = document.getElementById("confirmDeleteServer");
  if (confirmDeleteButton) {
    confirmDeleteButton.addEventListener("click", confirmDeleteServer);
  }

  const closeEulaButton = document.getElementById("closeEulaModal");
  if (closeEulaButton) {
    closeEulaButton.addEventListener("click", closeEulaModal);
  }

  const cancelEulaButton = document.getElementById("cancelEula");
  if (cancelEulaButton) {
    cancelEulaButton.addEventListener("click", closeEulaModal);
  }

  const acceptEulaButton = document.getElementById("acceptEula");
  if (acceptEulaButton) {
    acceptEulaButton.addEventListener("click", acceptEulaAndRunServer);
  }

  const closeJavaInstallButton = document.getElementById("closeJavaInstallModal");
  if (closeJavaInstallButton) {
    closeJavaInstallButton.addEventListener("click", closeJavaInstallModal);
  }

  const dismissJavaInstallButton = document.getElementById("dismissJavaInstallModal");
  if (dismissJavaInstallButton) {
    dismissJavaInstallButton.addEventListener("click", closeJavaInstallModal);
  }

  const closeStopButton = document.getElementById("closeStopModal");
  if (closeStopButton) {
    closeStopButton.addEventListener("click", closeStopServerModal);
  }

  const cancelStopButton = document.getElementById("cancelStopServer");
  if (cancelStopButton) {
    cancelStopButton.addEventListener("click", closeStopServerModal);
  }

  const confirmStopButton = document.getElementById("confirmStopServer");
  if (confirmStopButton) {
    confirmStopButton.addEventListener("click", confirmStopServer);
  }

  const closeSwitchServerButton = document.getElementById("closeSwitchServerModal");
  if (closeSwitchServerButton) {
    closeSwitchServerButton.addEventListener("click", closeServerSwitchModal);
  }

  const cancelSwitchServerButton = document.getElementById("cancelSwitchServer");
  if (cancelSwitchServerButton) {
    cancelSwitchServerButton.addEventListener("click", closeServerSwitchModal);
  }

  const confirmSwitchServerButton = document.getElementById("confirmSwitchServer");
  if (confirmSwitchServerButton) {
    confirmSwitchServerButton.addEventListener("click", confirmServerSwitch);
  }

  const closeButton = document.getElementById("closeCreateModal");
  if (closeButton) {
    closeButton.addEventListener("click", closeCreateServerModal);
  }

  const cancelButton = document.getElementById("cancelCreateServer");
  if (cancelButton) {
    cancelButton.addEventListener("click", closeCreateServerModal);
  }

  const form = document.getElementById("createServerForm");
  if (form) {
    form.addEventListener("submit", createServer);

    form.serverName.addEventListener("input", () => {
      createServerFormState = {
        ...createServerFormState,
        name: form.serverName.value,
      };
    });

    form.serverType.addEventListener("change", () => {
      createServerFormState = {
        ...createServerFormState,
        type: form.serverType.value,
        selectedVersionId: "",
      };
      serverVersionOptions = [];
      versionOptionsType = "";
      versionOptionsProject = "";
      renderApp();
      loadServerVersionOptions(true);
    });

    form.serverColor.addEventListener("input", () => {
      createServerFormState = {
        ...createServerFormState,
        color: normalizeServerColor(form.serverColor.value),
      };
    });

    form.serverVersion.addEventListener("change", () => {
      createServerFormState = {
        ...createServerFormState,
        selectedVersionId: form.serverVersion.value,
      };
    });
  }

  const consoleForm = document.getElementById("consoleCommandForm");
  if (consoleForm) {
    consoleForm.addEventListener("submit", submitConsoleCommand);
    consoleForm.consoleCommand.addEventListener("input", () => {
      consoleCommand = consoleForm.consoleCommand.value;
    });

    if (shouldRestoreConsoleFocus && !consoleForm.consoleCommand.disabled) {
      consoleForm.consoleCommand.focus();
      consoleForm.consoleCommand.setSelectionRange(
        consoleSelectionStart,
        consoleSelectionEnd
      );
    }
  }

  const ddnsForm = document.getElementById("ddnsSettingsForm");
  if (ddnsForm) {
    ddnsForm.addEventListener("submit", saveDdnsSettings);
    ddnsForm.ddnsEnabled.addEventListener("change", () => {
      ddnsSettings.form = {
        ...ddnsSettings.form,
        enabled: ddnsForm.ddnsEnabled.checked,
      };
    });
    ddnsForm.ddnsHostname.addEventListener("input", () => {
      ddnsSettings.form = {
        ...ddnsSettings.form,
        hostname: ddnsForm.ddnsHostname.value,
      };
    });
    ddnsForm.ddnsPassword.addEventListener("input", () => {
      ddnsSettings.form = {
        ...ddnsSettings.form,
        password: ddnsForm.ddnsPassword.value,
      };
    });
    ddnsForm.ddnsInterval.addEventListener("input", () => {
      ddnsSettings.form = {
        ...ddnsSettings.form,
        intervalMinutes: ddnsForm.ddnsInterval.value,
      };
    });
  }

  const appSettingsForm = document.getElementById("appSettingsForm");
  if (appSettingsForm) {
    appSettingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveAppSettings({
        ...appSettings.form,
        serverMaxRamMb: Number(appSettingsForm.serverMaxRamMb.value),
      });
    });

    appSettingsForm.serverMaxRamMb.addEventListener("input", () => {
      const nextServerMaxRamMb = Number(appSettingsForm.serverMaxRamMb.value);

      appSettings = {
        ...appSettings,
        form: {
          ...appSettings.form,
          serverMaxRamMb: nextServerMaxRamMb,
        },
      };

      const valuePill = appSettingsForm.querySelector(".settings-value-pill");
      if (valuePill) {
        valuePill.textContent = formatRamMb(nextServerMaxRamMb);
      }
    });
  }

  const runDdnsButton = document.getElementById("runDdnsUpdateNow");
  if (runDdnsButton) {
    runDdnsButton.addEventListener("click", runDdnsUpdateNow);
  }

  const consoleOutput = document.querySelector(".console-output");
  if (consoleOutput && !consoleOutput.matches(":hover")) {
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }

  syncSystemMonitorPolling();
  syncSelectedServerRuntimePolling();
}

async function loadSavedServers() {
  try {
    servers = await window.minecraftAPI.getSavedServers();
    renderApp();
  } catch (error) {
    console.error("Failed to load saved servers:", error);
  }
}

renderApp();
loadSavedServers();
