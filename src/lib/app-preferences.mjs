import fs from "node:fs";
import { appThemes, normalizeAppTheme } from "./app-themes.mjs";
import { consoleFilterOptions, defaultAppOptions, desktopOptions, quickControlOptions, serverTypeOptions } from "./app-settings-options.mjs";
import { atomicWriteFile } from "./safe-filesystem.mjs";

const optionChecks = {
  serverType: value => typeof value === "string" && Object.hasOwn(serverTypeOptions, value),
  minecraftVersion: value => typeof value === "string" && (value === "" || /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(value)),
  maxMemoryMb: value => value === 0 || (Number.isSafeInteger(value) && value >= 512 && value % 256 === 0),
  consoleFilter: value => typeof value === "string" && Object.hasOwn(consoleFilterOptions, value),
  consoleFontSize: value => Number.isInteger(value) && value >= 10 && value <= 22,
  consoleTimestamps: value => typeof value === "boolean",
  consoleAutoScroll: value => typeof value === "boolean",
  gradientStrength: value => Number.isInteger(value) && value >= 0 && value <= 200,
  startupIdleMinutes: value => Number.isInteger(value) && value >= 1 && value <= 60,
  startupDeadlineMinutes: value => Number.isInteger(value) && value >= 2 && value <= 120,
};

function savedOptions(options) {
  return Object.fromEntries(Object.entries(optionChecks).map(([key, isValid]) => {
    const value = options?.[key];
    return [key, isValid(value) ? value : defaultAppOptions[key]];
  }));
}

function quickDefaults(input, strict = false) {
  const values = {};
  for (const [key, field] of Object.entries(quickControlOptions)) {
    const value = input?.[key];
    if (value === undefined || value === "") continue;
    const valid = field.choices ? field.choices.includes(value) : Number.isSafeInteger(value) && value >= field.min && value <= field.max;
    if (valid) values[key] = value;
    else if (strict) throw new Error(`Choose a valid value for ${field.label}.`);
  }
  return values;
}

export function openAppPreferences(file) {
  let values;
  try {
    values = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Invalid app preferences.");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("BlockHost’s app settings could not be read.", { cause: error });
    values = {};
  }

  function save(patch) {
    const next = { ...values, ...patch };
    atomicWriteFile(file, JSON.stringify(next, null, 2) + "\n");
    values = next;
  }

  function snapshot() {
    return {
      theme: normalizeAppTheme(values.theme),
      options: savedOptions(values.options),
      desktop: Object.fromEntries(Object.entries(desktopOptions).map(([key, [, fallback]]) =>
        [key, typeof values.desktop?.[key] === "boolean" ? values.desktop[key] : fallback])),
      quickDefaults: quickDefaults(values.quickDefaults),
      lastServerId: Number.isSafeInteger(values.lastServerId) && values.lastServerId > 0 ? values.lastServerId : null,
    };
  }

  return {
    snapshot,
    setTheme(theme) {
      if (typeof theme !== "string" || !Object.hasOwn(appThemes, theme)) throw new Error("Choose a supported BlockHost theme.");
      save({ theme });
      return snapshot();
    },
    setOptions(input, memoryLimitMb) {
      for (const [key, isValid] of Object.entries(optionChecks)) {
        if (!isValid(input?.[key])) throw new Error(`Invalid app setting: ${key}.`);
      }
      if (input.maxMemoryMb > memoryLimitMb) throw new Error(`Default RAM must be at most ${memoryLimitMb} MB on this computer.`);
      if (input.startupDeadlineMinutes < input.startupIdleMinutes) throw new Error("The total startup limit must be at least the idle timeout.");
      save({ options: savedOptions(input) });
      return snapshot();
    },
    setDesktopOptions(input) {
      const desktop = {};
      for (const key of Object.keys(desktopOptions)) {
        if (typeof input?.[key] !== "boolean") throw new Error("Choose valid desktop preferences.");
        desktop[key] = input[key];
      }
      save({ desktop });
      return snapshot();
    },
    setQuickDefaults(input) {
      save({ quickDefaults: quickDefaults(input, true) });
      return snapshot();
    },
    rememberServer(id) {
      if (values.lastServerId !== id) save({ lastServerId: id });
    },
    windowBounds: () => values.windowBounds,
    rememberWindow(bounds) {
      if (JSON.stringify(values.windowBounds) !== JSON.stringify(bounds)) save({ windowBounds: bounds });
    },
  };
}
