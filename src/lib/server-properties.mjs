import fs from "node:fs";
import path from "node:path";
import {
  assertPathInside,
  restoreFileBackup,
  writeFileWithBackup,
} from "./safe-filesystem.mjs";

export const PROPERTY_SCHEMA = [
  { key: "motd", category: "General", label: "Server description", type: "string", default: "A Minecraft Server", maxLength: 200, description: "The message shown in the multiplayer server list." },
  { key: "gamemode", category: "General", label: "Default game mode", type: "enum", default: "survival", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "difficulty", category: "General", label: "Difficulty", type: "enum", default: "easy", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "max-players", category: "General", label: "Maximum players", type: "integer", default: 20, min: 1, max: 1000 },
  { key: "hardcore", category: "General", label: "Hardcore mode", type: "boolean", default: false },
  { key: "pvp", category: "General", label: "Player versus player", type: "boolean", default: true },
  { key: "online-mode", category: "General", label: "Verify player accounts", type: "boolean", default: true, description: "Keep enabled for normal internet-connected servers." },
  { key: "white-list", category: "General", label: "Use allowlist", type: "boolean", default: false },
  { key: "force-gamemode", category: "Gameplay", label: "Force default game mode", type: "boolean", default: false },
  { key: "allow-flight", category: "Gameplay", label: "Allow flight", type: "boolean", default: false },
  { key: "enable-command-block", category: "Gameplay", label: "Enable command blocks", type: "boolean", default: false },
  { key: "allow-nether", category: "Gameplay", label: "Enable Nether", type: "boolean", default: true },
  { key: "spawn-animals", category: "Gameplay", label: "Spawn animals", type: "boolean", default: true },
  { key: "spawn-monsters", category: "Gameplay", label: "Spawn monsters", type: "boolean", default: true },
  { key: "spawn-npcs", category: "Gameplay", label: "Spawn villagers", type: "boolean", default: true },
  { key: "player-idle-timeout", category: "Gameplay", label: "Idle kick timeout (minutes)", type: "integer", default: 0, min: 0, max: 2147483647 },
  { key: "level-name", category: "World", label: "World folder name", type: "worldName", default: "world", maxLength: 80 },
  { key: "level-seed", category: "World", label: "World seed", type: "string", default: "", maxLength: 200 },
  { key: "level-type", category: "World", label: "World type", type: "string", default: "minecraft:normal", maxLength: 120 },
  { key: "generate-structures", category: "World", label: "Generate structures", type: "boolean", default: true },
  { key: "spawn-protection", category: "World", label: "Spawn protection radius", type: "integer", default: 16, min: 0, max: 65535 },
  { key: "view-distance", category: "World", label: "View distance", type: "integer", default: 10, min: 2, max: 32 },
  { key: "simulation-distance", category: "World", label: "Simulation distance", type: "integer", default: 10, min: 2, max: 32, minimumVersion: "1.18" },
  { key: "server-port", category: "Network", label: "Server port", type: "integer", default: 25565, min: 1, max: 65535 },
  { key: "server-ip", category: "Network", label: "Bind address", type: "string", default: "", maxLength: 255, description: "Leave empty unless a specific network interface is required." },
  { key: "enable-query", category: "Network", label: "Enable query", type: "boolean", default: false, advanced: true },
  { key: "query.port", category: "Network", label: "Query port", type: "integer", default: 25565, min: 1, max: 65535, advanced: true },
  { key: "enable-rcon", category: "Network", label: "Enable RCON", type: "boolean", default: false, advanced: true },
  { key: "rcon.port", category: "Network", label: "RCON port", type: "integer", default: 25575, min: 1, max: 65535, advanced: true },
  { key: "rcon.password", category: "Network", label: "RCON password", type: "password", default: "", maxLength: 255, advanced: true },
  { key: "broadcast-rcon-to-ops", category: "Network", label: "Broadcast RCON to operators", type: "boolean", default: true, advanced: true },
  { key: "max-tick-time", category: "Advanced", label: "Maximum tick time", type: "integer", default: 60000, min: -1, max: 9007199254740991, advanced: true },
  { key: "sync-chunk-writes", category: "Advanced", label: "Synchronous chunk writes", type: "boolean", default: true, advanced: true },
];

export const PROPERTY_PRESETS = [
  {
    id: "private-friends",
    name: "Private friends server",
    description: "A small verified server with an allowlist and balanced distances.",
    values: { "max-players": 10, difficulty: "normal", "online-mode": true, "white-list": true, "view-distance": 10, "simulation-distance": 8 },
  },
  {
    id: "small-survival",
    name: "Small survival server",
    description: "Normal survival settings for a modest player group.",
    values: { gamemode: "survival", difficulty: "normal", "max-players": 20, hardcore: false, pvp: true, "view-distance": 10, "simulation-distance": 10 },
  },
  {
    id: "creative-building",
    name: "Creative building server",
    description: "Creative mode with flight, commands and peaceful spawning.",
    values: { gamemode: "creative", difficulty: "peaceful", "allow-flight": true, "enable-command-block": true, "spawn-monsters": false, "force-gamemode": true },
  },
  {
    id: "local-testing",
    name: "Local testing server",
    description: "A lightweight local-only configuration for development and experiments.",
    values: { "max-players": 5, "online-mode": false, "view-distance": 6, "simulation-distance": 4, "spawn-protection": 0, "player-idle-timeout": 0 },
  },
  {
    id: "performance",
    name: "Performance focused server",
    description: "Reduced simulation and view distances for lower resource use.",
    values: { "view-distance": 6, "simulation-distance": 4, "max-players": 12, "sync-chunk-writes": false, "spawn-protection": 8 },
  },
];

const SCHEMA_BY_KEY = new Map(PROPERTY_SCHEMA.map((property) => [property.key, property]));

function versionParts(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1).map((part) => Number(part || 0)) : null;
}

function versionAtLeast(value, minimum) {
  const current = versionParts(value);
  const required = versionParts(minimum);
  if (!current || !required) return true;
  for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
    if ((current[index] || 0) > (required[index] || 0)) return true;
    if ((current[index] || 0) < (required[index] || 0)) return false;
  }
  return true;
}

export function propertySchemaForVersion(version) {
  return PROPERTY_SCHEMA.filter((property) => !property.minimumVersion || versionAtLeast(version, property.minimumVersion));
}

function hasOddTrailingBackslashes(value) {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === "\\"; index -= 1) count += 1;
  return count % 2 === 1;
}

function decodeProperty(value) {
  return String(value).replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_match, unicode, escaped) => {
    if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
    return { t: "\t", r: "\r", n: "\n", f: "\f" }[escaped] ?? escaped;
  });
}

function encodeProperty(value, isKey = false) {
  const string = String(value ?? "");
  let output = "";
  for (let index = 0; index < string.length; index += 1) {
    const character = string[index];
    if (character === "\\") output += "\\\\";
    else if (character === "\t") output += "\\t";
    else if (character === "\r") output += "\\r";
    else if (character === "\n") output += "\\n";
    else if (character === "\f") output += "\\f";
    else if ((character === " " && (isKey || index === 0)) || (isKey && "=:#!".includes(character))) output += `\\${character}`;
    else output += character;
  }
  return output;
}

function parseLogicalProperty(logical, raw) {
  const trimmed = logical.trimStart();
  if (!trimmed) return { type: "blank", raw };
  if (trimmed.startsWith("#") || trimmed.startsWith("!")) return { type: "comment", raw };

  const offset = logical.length - trimmed.length;
  let escaped = false;
  let separator = -1;
  let whitespaceSeparator = false;
  for (let index = offset; index < logical.length; index += 1) {
    const character = logical[index];
    if (!escaped && (character === "=" || character === ":" || /\s/.test(character))) {
      separator = index;
      whitespaceSeparator = /\s/.test(character);
      break;
    }
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  }

  let rawKey;
  let rawValue;
  if (separator === -1) {
    rawKey = logical.slice(offset);
    rawValue = "";
  } else {
    rawKey = logical.slice(offset, separator);
    let valueStart = separator;
    if (whitespaceSeparator) {
      while (valueStart < logical.length && /\s/.test(logical[valueStart])) valueStart += 1;
      if (logical[valueStart] === "=" || logical[valueStart] === ":") valueStart += 1;
    } else {
      valueStart += 1;
    }
    while (valueStart < logical.length && /\s/.test(logical[valueStart])) valueStart += 1;
    rawValue = logical.slice(valueStart);
  }

  const key = decodeProperty(rawKey);
  if (!key) return { type: "unknown", raw };
  return { type: "property", key, value: decodeProperty(rawValue), raw };
}

export function parseProperties(text = "") {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const entries = [];
  const values = {};

  for (let index = 0; index < lines.length; index += 1) {
    const rawLines = [lines[index]];
    let logical = lines[index];
    while (hasOddTrailingBackslashes(logical) && index + 1 < lines.length) {
      logical = `${logical.slice(0, -1)}${lines[index + 1].trimStart()}`;
      index += 1;
      rawLines.push(lines[index]);
    }
    const entry = parseLogicalProperty(logical, rawLines.join("\n"));
    entries.push(entry);
    if (entry.type === "property") values[entry.key] = entry.value;
  }

  return { entries, values };
}

export function serializeProperties(parsed, updates, removeKeys = new Set()) {
  const updateMap = new Map(Object.entries(updates || {}).map(([key, value]) => [key, String(value)]));
  const lastIndexes = new Map();
  parsed.entries.forEach((entry, index) => {
    if (entry.type === "property") lastIndexes.set(entry.key, index);
  });

  const output = [];
  const written = new Set();
  parsed.entries.forEach((entry, index) => {
    if (entry.type !== "property") {
      output.push(entry.raw);
      return;
    }
    if (removeKeys.has(entry.key)) return;
    if (!updateMap.has(entry.key)) {
      output.push(entry.raw);
      return;
    }
    if (lastIndexes.get(entry.key) !== index) return;
    output.push(`${encodeProperty(entry.key, true)}=${encodeProperty(updateMap.get(entry.key))}`);
    written.add(entry.key);
  });

  const missing = Array.from(updateMap.entries()).filter(([key]) => !written.has(key));
  if (missing.length) {
    while (output.length && output.at(-1) === "") output.pop();
    if (output.length) output.push("");
    output.push("# Managed by BlockHost Manager");
    missing.forEach(([key, value]) => output.push(`${encodeProperty(key, true)}=${encodeProperty(value)}`));
  }
  return `${output.join("\n").replace(/\n+$/g, "")}\n`;
}

function normalizeValue(property, rawValue) {
  if (property.type === "boolean") {
    if (rawValue === true || rawValue === "true") return true;
    if (rawValue === false || rawValue === "false") return false;
    throw new Error(`${property.label} must be enabled or disabled`);
  }
  if (property.type === "integer") {
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value < property.min || value > property.max) {
      throw new Error(`${property.label} must be between ${property.min} and ${property.max}`);
    }
    return value;
  }

  const value = String(rawValue ?? "");
  if (/\r|\n/.test(value)) throw new Error(`${property.label} cannot contain a line break`);
  if (property.maxLength && value.length > property.maxLength) {
    throw new Error(`${property.label} cannot exceed ${property.maxLength} characters`);
  }
  if (property.type === "enum" && !property.options.includes(value)) {
    throw new Error(`${property.label} has an unsupported value`);
  }
  if (property.type === "worldName") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "." || trimmed === ".." || /[<>:"/\\|?*]/.test(trimmed)) {
      throw new Error("World folder name contains characters Windows cannot safely use");
    }
    return trimmed;
  }
  return value;
}

export function validatePropertyValues(input = {}, schema = PROPERTY_SCHEMA) {
  const values = {};
  schema.forEach((property) => {
    const raw = Object.hasOwn(input, property.key) ? input[property.key] : property.default;
    const normalized = normalizeValue(property, raw);
    values[property.key] = property.type === "boolean" ? String(normalized) : String(normalized);
  });
  return values;
}

function typedValue(property, rawValue) {
  const value = rawValue ?? String(property.default);
  if (property.type === "boolean") return String(value).toLowerCase() === "true";
  if (property.type === "integer") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : property.default;
  }
  if (property.type === "enum" && !property.options.includes(String(value))) return property.default;
  return String(value);
}

export function parseCustomProperties(text = "") {
  const parsed = parseProperties(text);
  const custom = {};
  for (const entry of parsed.entries) {
    if (entry.type !== "property") continue;
    if (SCHEMA_BY_KEY.has(entry.key)) {
      throw new Error(`${entry.key} is already available in the standard property editor`);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(entry.key)) {
      throw new Error(`Custom property name "${entry.key}" is not valid`);
    }
    custom[entry.key] = entry.value;
  }
  return custom;
}

function customPropertiesText(parsed) {
  const ordered = [];
  const seen = new Set();
  for (let index = parsed.entries.length - 1; index >= 0; index -= 1) {
    const entry = parsed.entries[index];
    if (entry.type !== "property" || SCHEMA_BY_KEY.has(entry.key) || seen.has(entry.key)) continue;
    seen.add(entry.key);
    ordered.unshift(`${encodeProperty(entry.key, true)}=${encodeProperty(entry.value)}`);
  }
  return ordered.join("\n");
}

export function buildPropertiesModel(text = "", exists = true, version = "unknown") {
  const parsed = parseProperties(text);
  const schema = propertySchemaForVersion(version);
  const values = {};
  schema.forEach((property) => {
    values[property.key] = typedValue(property, parsed.values[property.key]);
  });
  return {
    exists,
    schema,
    values,
    customProperties: customPropertiesText(parsed),
    rawText: String(text),
    presets: PROPERTY_PRESETS.map((preset) => ({
      ...preset,
      values: Object.fromEntries(Object.entries(preset.values).filter(([key]) => schema.some((property) => property.key === key))),
    })),
    minecraftVersion: String(version || "unknown"),
  };
}

export function validateRawPropertiesText(text, version = "unknown") {
  const raw = String(text ?? "");
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("Raw server properties cannot exceed 1 MB");
  if (raw.includes("\0")) throw new Error("Raw server properties contain an invalid null character");
  const parsed = parseProperties(raw);
  for (const property of propertySchemaForVersion(version)) {
    if (Object.hasOwn(parsed.values, property.key)) normalizeValue(property, parsed.values[property.key]);
  }
  return `${raw.replace(/\r\n?/g, "\n").replace(/\n*$/g, "")}\n`;
}

export function buildPropertiesText(existingText, input = {}, version = "unknown") {
  if (input.mode === "raw") return validateRawPropertiesText(input.rawText, version);
  const parsed = parseProperties(existingText);
  const schema = propertySchemaForVersion(version);
  const standard = validatePropertyValues(input.values || {}, schema);
  const custom = parseCustomProperties(input.customProperties || "");
  const existingCustomKeys = Object.keys(parsed.values).filter((key) => !SCHEMA_BY_KEY.has(key));
  const removeKeys = new Set(existingCustomKeys.filter((key) => !Object.hasOwn(custom, key)));
  return serializeProperties(parsed, { ...standard, ...custom }, removeKeys);
}

export function getPropertiesPath(serverFolder) {
  const filePath = path.join(serverFolder, "server.properties");
  return assertPathInside(serverFolder, filePath);
}

export function loadServerProperties(serverFolder, version = "unknown") {
  const filePath = getPropertiesPath(serverFolder);
  const exists = fs.existsSync(filePath);
  const text = exists ? fs.readFileSync(filePath, "utf8") : "# Minecraft server properties\n";
  return buildPropertiesModel(text, exists, version);
}

export function saveServerProperties(serverFolder, input = {}, version = "unknown") {
  const filePath = getPropertiesPath(serverFolder);
  const existingText = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : "# Minecraft server properties\n";
  const nextText = buildPropertiesText(existingText, input, version);
  const transaction = writeFileWithBackup(filePath, nextText);
  return { model: buildPropertiesModel(nextText, true, version), transaction };
}

export function rollbackServerProperties(transaction) {
  restoreFileBackup(transaction);
}
