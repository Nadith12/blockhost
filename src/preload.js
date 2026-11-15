import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("minecraftAPI", {
  getVersionOptions: (type) =>
    ipcRenderer.invoke("servers:getVersionOptions", { type }),
  createServer: (serverData) => ipcRenderer.invoke("servers:create", serverData),
  getServers: () => ipcRenderer.invoke("servers:getSaved"),
  getServerFolderBytes: (serverId) => ipcRenderer.invoke("servers:getFolderBytes", serverId),
  openServerFolder: (serverId) => ipcRenderer.invoke("servers:openFolder", serverId),
  getRuntime: (serverId) =>
    ipcRenderer.invoke("servers:getRuntimeState", serverId),
  getUsage: () => ipcRenderer.invoke("servers:getUsage"),
  getActiveOperations: () => ipcRenderer.invoke("operations:getActive"),
  getServerJava: (id) => ipcRenderer.invoke("servers:javaSettings", id),
  setServerJavaVersion: (id, version) => ipcRenderer.invoke("servers:setJavaVersion", { id, version }),
  onDependencyProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on("dependencies:progress", handler);
    return () => ipcRenderer.removeListener("dependencies:progress", handler);
  },
  onOperationsChanged: (listener) => {
    const handler = (_event, operations) => listener(operations);
    ipcRenderer.on("operations:state", handler);
    return () => ipcRenderer.removeListener("operations:state", handler);
  },
  startServer: (serverId, options = {}) =>
    ipcRenderer.invoke("servers:start", { id: serverId, ...options }),
  stopServer: (serverId) =>
    ipcRenderer.invoke("servers:stop", serverId),
  sendCommand: (serverId, command) =>
    ipcRenderer.invoke("servers:sendCommand", { id: serverId, command }),
  getCommandData: (serverId) => ipcRenderer.invoke("servers:commandData", serverId),
  copyText: (value) => ipcRenderer.invoke("app:copyText", value),
  getAppSettings: () => ipcRenderer.invoke("app:getSettings"),
  getUpdateStatus: () => ipcRenderer.invoke("app:getUpdateStatus"),
  checkUpdate: () => ipcRenderer.invoke("app:checkUpdate"),
  restartForUpdate: () => ipcRenderer.invoke("app:restartForUpdate"),
  onUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("app:update-state", handler);
    return () => ipcRenderer.removeListener("app:update-state", handler);
  },
  setAppTheme: (theme) => ipcRenderer.invoke("app:setTheme", theme),
  saveAppOptions: (options) => ipcRenderer.invoke("app:setOptions", options),
  saveDesktopOptions: (options) => ipcRenderer.invoke("app:setDesktopOptions", options),
  saveQuickDefaults: (options) => ipcRenderer.invoke("app:setQuickDefaults", options),
  rememberServer: (id) => ipcRenderer.invoke("app:rememberServer", id),
  getAppStorage: () => ipcRenderer.invoke("app:getStorage"),
  clearDownloadCache: () => ipcRenderer.invoke("app:clearDownloadCache"),
  onConsoleEntry: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("servers:consoleEntry", handler);
    return () => ipcRenderer.removeListener("servers:consoleEntry", handler);
  },
  deleteServer: (serverId) => ipcRenderer.invoke("servers:delete", serverId),
  getServerProperties: (serverId) =>
    ipcRenderer.invoke("servers:getProperties", serverId),
  updateServerProperties: (serverId, properties, options = {}) =>
    ipcRenderer.invoke("servers:updateProperties", {
      id: serverId,
      mode: properties.mode,
      values: properties.values,
      customProperties: properties.customProperties,
      rawText: properties.rawText,
      restart: Boolean(options.restart),
    }),
  getServerMemory: (serverId) => ipcRenderer.invoke("servers:getMemory", serverId),
  updateServerMemory: (serverId, minMemoryMb, maxMemoryMb) =>
    ipcRenderer.invoke("servers:updateMemory", { id: serverId, minMemoryMb, maxMemoryMb }),
  updateServerIdentity: (serverId, name, color, icon) =>
    ipcRenderer.invoke("servers:updateIdentity", { id: serverId, name, color, icon }),
  chooseWorldImportSource: (kind) => ipcRenderer.invoke("worlds:chooseImportSource", kind),
  exportWorld: (serverId) => ipcRenderer.invoke("worlds:export", serverId),
  getBackupSettings: (serverId) => ipcRenderer.invoke("backups:getSettings", serverId),
  chooseBackupDestination: (serverId) => ipcRenderer.invoke("backups:chooseDestination", serverId),
  updateBackupSettings: (serverId, settings) => ipcRenderer.invoke("backups:updateSettings", { id: serverId, settings }),
  runBackupNow: (serverId) => ipcRenderer.invoke("backups:runNow", serverId),
  onBackupCompleted: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("backups:completed", handler);
    return () => ipcRenderer.removeListener("backups:completed", handler);
  },
  onBackupFailed: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("backups:failed", handler);
    return () => ipcRenderer.removeListener("backups:failed", handler);
  },
  searchModpacks: (query, offset = 0) => ipcRenderer.invoke("modpacks:search", { query, offset }),
  getModpackVersions: (id) => ipcRenderer.invoke("modpacks:versions", id),
  prepareOnlineModpack: (id, projectId) => ipcRenderer.invoke("modpacks:prepareOnline", id, projectId),
  chooseLocalModpack: () => ipcRenderer.invoke("modpacks:chooseLocal"),
  cancelModpack: () => ipcRenderer.invoke("modpacks:cancel"),
  getAddons: (serverId) => ipcRenderer.invoke("addons:list", serverId),
  inspectAddons: (serverId) => ipcRenderer.invoke("addons:inspect", serverId),
  identifyAddons: (serverId) => ipcRenderer.invoke("addons:identify", serverId),
  getAddonRecommendations: (serverId) => ipcRenderer.invoke("addons:recommendations", serverId),
  searchAddons: (serverId, query, options = {}) =>
    ipcRenderer.invoke("addons:search", { id: serverId, query, category: options.category, sort: options.sort }),
  openAddonProject: (projectId) => ipcRenderer.invoke("addons:openProject", projectId),
  installAddon: (serverId, project) =>
    ipcRenderer.invoke("addons:install", {
      id: serverId,
      projectId: project.projectId,
      versionId: project.versionId,
      title: project.title,
      iconUrl: project.iconUrl,
    }),
  installManualAddon: (serverId) =>
    ipcRenderer.invoke("addons:installManual", serverId),
  installDroppedAddon: (serverId, file) =>
    ipcRenderer.invoke("addons:installManualPath", { id: serverId, filePath: webUtils.getPathForFile(file) }),
  setAddonEnabled: (serverId, addonId, enabled, cascade = false) =>
    ipcRenderer.invoke("addons:setEnabled", { id: serverId, addonId, enabled, cascade }),
  removeAddon: (serverId, addonId, cascade = false) =>
    ipcRenderer.invoke("addons:remove", { id: serverId, addonId, cascade }),
  checkAddonUpdates: (serverId) =>
    ipcRenderer.invoke("addons:checkUpdates", serverId),
  updateAddon: (serverId, addonId) =>
    ipcRenderer.invoke("addons:update", { id: serverId, addonId }),
  updateAllAddons: (serverId) => ipcRenderer.invoke("addons:updateAll", serverId),
  setAddonReleaseChannel: (serverId, releaseChannel) =>
    ipcRenderer.invoke("addons:setReleaseChannel", { id: serverId, releaseChannel }),
  rollbackAddon: (serverId, addonId, versionId) =>
    ipcRenderer.invoke("addons:rollback", { id: serverId, addonId, versionId }),
  exportServer: (serverId) => ipcRenderer.invoke("transfers:export", serverId),
  importServer: () => ipcRenderer.invoke("transfers:importDialog"),
  importExternalServer: () => ipcRenderer.invoke("transfers:importExternalDialog"),
  detectDroppedFile: (file) => ipcRenderer.invoke("transfers:detectDrop", webUtils.getPathForFile(file)),
  importDroppedServer: (file) =>
    ipcRenderer.invoke("transfers:importPath", webUtils.getPathForFile(file)),
  importDroppedExternalServer: (file) =>
    ipcRenderer.invoke("transfers:importExternalPath", webUtils.getPathForFile(file)),
  openExportFolder: (filePath) =>
    ipcRenderer.invoke("transfers:openExportFolder", filePath),
  onTransferProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on("transfers:progress", handler);
    return () => ipcRenderer.removeListener("transfers:progress", handler);
  },
});
