// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("minecraftAPI", {
  getVanillaVersions: () => ipcRenderer.invoke("vanilla:getVersions"),

  getVanillaServerDownload: (versionUrl) =>
    ipcRenderer.invoke("vanilla:getServerDownload", versionUrl),

  downloadVanillaServerJar: (serverData) =>
    ipcRenderer.invoke("vanilla:downloadServerJar", serverData),

  getServerVersionOptions: (options) =>
    ipcRenderer.invoke("servers:getVersionOptions", options),

  createServer: (serverData) =>
    ipcRenderer.invoke("servers:create", serverData),

  getSavedServers: () => ipcRenderer.invoke("servers:getSaved"),

  getServerRuntimeStats: () =>
    ipcRenderer.invoke("system:getServerRuntimeStats"),

  getAppSettings: () => ipcRenderer.invoke("settings:getApp"),

  saveAppSettings: (settings) =>
    ipcRenderer.invoke("settings:saveApp", settings),

  getDdnsSettings: () => ipcRenderer.invoke("ddns:getSettings"),

  saveDdnsSettings: (settings) =>
    ipcRenderer.invoke("ddns:saveSettings", settings),

  runDdnsUpdateNow: () => ipcRenderer.invoke("ddns:runNow"),

  getServerRuntimeState: (serverId) =>
    ipcRenderer.invoke("servers:getRuntimeState", serverId),

  startServer: (serverData) =>
    ipcRenderer.invoke("servers:start", serverData),

  stopServer: (serverId) =>
    ipcRenderer.invoke("servers:stop", serverId),

  restartServer: (serverData) =>
    ipcRenderer.invoke("servers:restart", serverData),

  sendServerCommand: (serverData) =>
    ipcRenderer.invoke("servers:sendCommand", serverData),

  updateSavedServer: (serverData) =>
    ipcRenderer.invoke("servers:updateSaved", serverData),

  reorderServers: (serverIds) =>
    ipcRenderer.invoke("servers:reorder", serverIds),

  deleteSavedServer: (serverId) =>
    ipcRenderer.invoke("servers:deleteSaved", serverId),
});

contextBridge.exposeInMainWorld("hardware", {
  getCpuTemp: () => ipcRenderer.invoke("hardware:getCpuTemp"),
});
