import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("minecraftAPI", {
  getVersionOptions: (type) =>
    ipcRenderer.invoke("servers:getVersionOptions", { type }),
  createServer: (serverData) => ipcRenderer.invoke("servers:create", serverData),
  getServers: () => ipcRenderer.invoke("servers:getSaved"),
  getRuntime: (serverId) =>
    ipcRenderer.invoke("servers:getRuntimeState", serverId),
  getUsage: () => ipcRenderer.invoke("servers:getUsage"),
  getActiveOperations: () => ipcRenderer.invoke("operations:getActive"),
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
  updateServerIdentity: (serverId, name, color) =>
    ipcRenderer.invoke("servers:updateIdentity", { id: serverId, name, color }),
  chooseWorldImportSource: () => ipcRenderer.invoke("worlds:chooseImportSource"),
  exportWorld: (serverId) => ipcRenderer.invoke("worlds:export", serverId),
  getAddons: (serverId) => ipcRenderer.invoke("addons:list", serverId),
  getAddonRecommendations: (serverId) => ipcRenderer.invoke("addons:recommendations", serverId),
  searchAddons: (serverId, query) =>
    ipcRenderer.invoke("addons:search", { id: serverId, query }),
  installAddon: (serverId, project) =>
    ipcRenderer.invoke("addons:install", {
      id: serverId,
      projectId: project.projectId,
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
  exportServerAs: (serverId) => ipcRenderer.invoke("transfers:exportAs", serverId),
  importServer: () => ipcRenderer.invoke("transfers:importDialog"),
  importExternalServer: () => ipcRenderer.invoke("transfers:importExternalDialog"),
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
