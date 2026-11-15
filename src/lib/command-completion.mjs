import { COMMAND_CATALOG } from "./command-catalog.mjs";

const REGISTRIES = {
  item_stack: "item", item_predicate: "item", block_state: "block", block_predicate: "block",
  particle: "particle_type", mob_effect: "mob_effect", item_enchantment: "enchantment", entity_summon: "entity_type",
  dimension: "dimension", biome: "worldgen/biome", function: "function", dialog: "dialog",
  loot_table: "loot_table", loot_predicate: "predicate", loot_modifier: "item_modifier",
};
const CHOICES = {
  gamemode: ["survival", "creative", "adventure", "spectator"],
  difficulty: ["peaceful", "easy", "normal", "hard"],
  color: ["black", "dark_blue", "dark_green", "dark_aqua", "dark_red", "dark_purple", "gold", "gray", "dark_gray", "blue", "green", "aqua", "red", "light_purple", "yellow", "white", "reset"],
  template_mirror: ["none", "left_right", "front_back"],
  template_rotation: ["none", "clockwise_90", "clockwise_180", "counterclockwise_90"],
  scoreboard_slot: ["list", "sidebar", "below_name"],
  entity_anchor: ["eyes", "feet"],
  swizzle: ["x", "y", "z", "xy", "xz", "yz", "xyz"],
  heightmap: ["world_surface", "motion_blocking", "motion_blocking_no_leaves", "ocean_floor"],
  operation: ["=", "+=", "-=", "*=", "/=", "%=", "<", ">", "><"],
  objective_criteria: ["dummy", "trigger", "deathCount", "playerKillCount", "totalKillCount", "health", "xp", "level", "food", "air", "armor"],
  time: ["1t", "1s", "1d"],
  bool: ["true", "false"],
};
const SELECTORS = ["@a", "@e", "@p", "@r", "@s"];
const ITEM_SLOTS = [
  "weapon.mainhand", "weapon.offhand", "armor.head", "armor.chest", "armor.legs", "armor.feet",
  "horse.saddle", "horse.armor", "villager.0", "villager.1", "enderchest.0",
  ...Object.entries({ hotbar: 9, inventory: 27, container: 54 }).flatMap(([slot, count]) =>
    Array.from({ length: count }, (_, index) => `${slot}.${index}`)),
];
const ARGUMENT_REGISTRIES = {
  advancement: "advancement", recipe: "recipe", sound: "sound_event", effect: "mob_effect",
  enchantment: "enchantment", attribute: "attribute", entity: "entity_type", item: "item", block: "block",
  particle: "particle_type", damageType: "damage_type", rule: "game_rule",
};
const byCommand = new Map(COMMAND_CATALOG.map((entry) => [entry.base.join(" "), entry]));
const fallbackRoot = { children: {} };
for (const command of COMMAND_CATALOG) {
  let node = fallbackRoot;
  for (const name of command.base) {
    node.children ||= {};
    node = node.children[name] ||= { type: "literal" };
  }
  for (const field of command.fields) {
    node.children ||= {};
    node = node.children[field.name] ||= {
      type: "argument", options: field.options,
      parser: field.type === "player" || field.name === "destination" ? "minecraft:entity"
        : field.type === "number" ? "brigadier:integer" : "brigadier:string",
      properties: { type: field.trailing && field.name !== "destination" ? "greedy_phrase" : "word" },
    };
  }
}

function registryKey(name, node) {
  const parser = node.parser?.split(":").at(-1);
  return node.properties?.registry?.replace(/^minecraft:/, "") || REGISTRIES[parser]
    || (parser === "resource_location" || parser === "string" ? ARGUMENT_REGISTRIES[name] : "");
}

export function completionRegistries(tree, registries) {
  const wanted = new Set([...Object.values(REGISTRIES), ...Object.values(ARGUMENT_REGISTRIES)]);
  function visit(node) {
    for (const [name, child] of Object.entries(node.children || {})) {
      const key = registryKey(name, child);
      if (key) wanted.add(key);
      visit(child);
    }
  }
  visit(tree);
  return Object.fromEntries([...wanted].flatMap((key) =>
    [key, `tag/${key}`].filter((name) => Array.isArray(registries[name])).map((name) => [name, registries[name]])));
}

// Whitespace inside selectors, quoted text and component/NBT values stays in one token.
function commandTokens(value) {
  const tokens = [];
  let start = -1, depth = 0, quote = "", escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (!quote && !depth && /\s/.test(char)) {
      if (start >= 0) tokens.push({ text: value.slice(start, i), start, end: i });
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    if (escaped) escaped = false;
    else if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
  }
  if (start >= 0) tokens.push({ text: value.slice(start), start, end: value.length });
  return tokens;
}

function optionsFor(name, node, players, registries) {
  const parser = node.parser?.split(":").at(-1);
  if (node.options || CHOICES[parser]) return node.options || CHOICES[parser];
  if (parser === "item_slot") return ITEM_SLOTS;
  if (parser === "item_slots") return [...ITEM_SLOTS, "weapon.*", "armor.*", "hotbar.*", "inventory.*", "container.*"];
  if (["entity", "game_profile", "score_holder"].includes(parser)) {
    const selectors = SELECTORS.filter((selector) =>
      selector !== "@e" || (parser !== "game_profile" && node.properties?.type !== "players"));
    return [...players, ...selectors.map((selector) =>
      node.properties?.amount === "single" && ["@a", "@e"].includes(selector) ? `${selector}[limit=1]` : selector),
      ...(parser === "score_holder" && node.properties?.amount !== "single" ? ["*"] : [])];
  }
  const registry = registryKey(name, node);
  if (!registry) return [];
  const qualify = (value) => value.includes(":") ? value : `minecraft:${value}`;
  const values = (registries[registry] || []).map(qualify);
  if (parser?.includes("_or_tag") || ["block_predicate", "item_predicate", "function"].includes(parser)) {
    values.push(...(registries[`tag/${registry}`] || []).map((value) => `#${qualify(value)}`));
  }
  return values;
}

const COORDINATE = /^(?:[~^](?:-?(?:\d+(?:\.\d*)?|\.\d+))?|-?(?:\d+(?:\.\d*)?|\.\d+))$/;
function coordinateCount(node) {
  return { vec2: 2, vec3: 3, block_pos: 3, column_pos: 2, rotation: 2 }[node.parser?.split(":").at(-1)] || 0;
}

function accepts(node, value) {
  const parser = node.parser?.split(":").at(-1);
  if (node.options || ["gamemode", "difficulty", "bool", "entity_anchor", "operation"].includes(parser)) {
    return (node.options || CHOICES[parser]).includes(value);
  }
  if (parser === "time") return /^-?(?:\d+(?:\.\d*)?|\.\d+)[dst]?$/.test(value);
  if (["integer", "long", "float", "double"].includes(parser)) return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
  if (["game_profile", "entity"].includes(parser)) return /^@|^[\w-]+$/.test(value);
  if (["item_stack", "item_predicate", "block_state", "block_predicate", "resource_location"].includes(parser) || node.properties?.registry) return /^#?[\w.:/\-]+/.test(value);
  return true;
}

export function completeCommand(value, cursor = value.length, data = {}, players = []) {
  if (value.length > 2048) return { suggestions: [], hint: "" };
  const leading = value.match(/^\s*\/?/)[0];
  const offset = leading.length;
  if (cursor < offset) return { suggestions: [], hint: "" };
  const tokens = commandTokens(value.slice(offset));
  const position = cursor - offset;
  const completed = tokens.filter((token) => token.end < position);
  const active = tokens.find((token) => token.start <= position && token.end >= position);
  const prefix = active ? active.text.slice(0, position - active.start).toLowerCase() : "";
  const from = (active?.start ?? position) + offset;
  const to = (active?.end ?? position) + offset;
  const root = data.tree || fallbackRoot;
  const suggestions = new Map();
  const hints = new Set();
  const visited = new Map();

  function add(text, detail, resource = false) {
    const lower = text.toLowerCase();
    if (!lower.startsWith(prefix) && (prefix.includes(":") || !lower.replace(/^minecraft:/, "").startsWith(prefix))) {
      if (!resource) return;
      const [namespace, path] = lower.split(":");
      const [queryNamespace, queryPath] = prefix.includes(":")
        ? prefix.split(":")
        : [prefix.startsWith("#") ? "#minecraft" : "minecraft", prefix.replace(/^#/, "")];
      if (namespace !== queryNamespace || !(path?.startsWith(queryPath) || path?.includes(`_${queryPath}`))) return;
    }
    suggestions.set(text, { text, detail });
  }

  function visit(node, index, path = "") {
    if (!node) return;
    const positions = visited.get(node) || new Set();
    if (positions.has(index)) return;
    visited.set(node, positions);
    positions.add(index);
    const redirect = node.redirect?.reduce((target, key) => target?.children?.[key], root);
    if (redirect) visit(redirect, index, path);
    for (const [name, child] of Object.entries(node.children || {})) {
      const label = path ? `${path} ${name}` : name;
      if (index === completed.length) {
        if (child.type === "literal") {
          const command = byCommand.get(label);
          if (node !== root || leading.includes("/") || value.trim()) add(node === root && prefix.startsWith("minecraft:") ? `minecraft:${name}` : name, command?.syntax || "");
        } else {
          hints.add(name);
          const resource = Boolean(registryKey(name, child));
          for (const option of optionsFor(name, child, players, data.registries || {})) add(option, name, resource);
        }
        continue;
      }
      const token = completed[index].text;
      if (child.type === "literal") {
        if (token === name || (node === root && token === `minecraft:${name}`)) {
          // The generated reports omit the redirect back to the root after execute run.
          visit(node === root.children?.execute && name === "run" ? root : child, index + 1, label);
        }
        continue;
      }
      const count = coordinateCount(child);
      if (count) {
        const values = completed.slice(index, index + count);
        if (values.every((part) => COORDINATE.test(part.text))) {
          if (values.length < count) hints.add(`${name} · ${count} coordinates`);
          else visit(child, index + count, path);
        }
      } else if (child.properties?.type !== "greedy_phrase" && child.parser !== "minecraft:message" && accepts(child, token)) {
        visit(child, index + 1, path);
      }
    }
  }
  visit(root, 0);
  return { from, to, hint: [...hints].join(" / "), suggestions: [...suggestions.values()].sort((a, b) => a.text.localeCompare(b.text)) };
}
