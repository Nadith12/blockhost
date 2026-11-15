export const serverTypeOptions = {
  vanilla: "Vanilla", purpur: "Purpur", quilt: "Quilt", paper: "Paper",
  fabric: "Fabric", forge: "Forge", neoforge: "NeoForge",
};

export const consoleFilterOptions = { all: "All", players: "Players", warnings: "Warnings", errors: "Errors" };

export const desktopOptions = {
  notifyReady: ["Server ready", false],
  notifyCrash: ["Server crashes or fails to start", false],
  notifyBackup: ["World backup finishes", false],
  notifyTray: ["BlockHost moves to the system tray", true],
  rememberWindow: ["Remember window size and position", false],
  reopenServer: ["Reopen the last server on launch", false],
  minimizeToTray: ["Minimize to tray while a server is running", false],
};

export const quickControlOptions = {
  "view-distance": { label: "Render distance", min: 2, max: 32 },
  "simulation-distance": { label: "Simulation distance", min: 2, max: 32 },
  gamemode: { label: "Game mode", choices: ["survival", "creative", "adventure", "spectator"] },
  difficulty: { label: "Difficulty", choices: ["peaceful", "easy", "normal", "hard"] },
  "max-players": { label: "Maximum players", min: 1, max: 1000 },
};

export const defaultAppOptions = Object.freeze({
  serverType: "vanilla",
  minecraftVersion: "",
  maxMemoryMb: 0,
  consoleFilter: "all",
  consoleFontSize: 12,
  consoleTimestamps: true,
  consoleAutoScroll: true,
  gradientStrength: 100,
  startupIdleMinutes: 5,
  startupDeadlineMinutes: 30,
});
