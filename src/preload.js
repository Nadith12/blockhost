import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("minecraftAPI", {
  getVersionOptions: (type) =>
    ipcRenderer.invoke("servers:getVersionOptions", { type }),
  createServer: (serverData) => ipcRenderer.invoke("servers:create", serverData),
  getServers: () => ipcRenderer.invoke("servers:getSaved"),
  getRuntime: (serverId) =>
    ipcRenderer.invoke("servers:getRuntimeState", serverId),
  getUsage: () => ipcRenderer.invoke("servers:getUsage"),
  startServer: (serverId, options = {}) =>
    ipcRenderer.invoke("servers:start", { id: serverId, ...options }),
  stopServer: (serverId) =>
    ipcRenderer.invoke("servers:stop", serverId),
  sendCommand: (serverId, command) =>
    ipcRenderer.invoke("servers:sendCommand", { id: serverId, command }),
  deleteServer: (serverId) => ipcRenderer.invoke("servers:delete", serverId),
});
