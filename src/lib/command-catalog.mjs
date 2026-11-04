const PLAYER = { name: "player", label: "Player", type: "player", required: true, placeholder: "Player name or @a" };
const advancedCommand = (id, name, category, description, syntax, base = [id], required = true) => ({
  id,
  name,
  category,
  description,
  syntax,
  base,
  fields: syntax === base.join(" ") ? [] : [{
    name: "arguments",
    label: "Arguments",
    type: "text",
    trailing: true,
    required,
    placeholder: syntax.slice(base.join(" ").length).trim(),
  }],
});

export const COMMAND_CATALOG = [
  { id: "list", name: "List players", category: "Players", description: "Show every connected player.", syntax: "list", base: ["list"], fields: [] },
  { id: "say", name: "Broadcast message", category: "Communication", description: "Send a message to everyone on the server.", syntax: "say <message>", base: ["say"], fields: [{ name: "message", label: "Message", type: "text", required: true, trailing: true }] },
  { id: "gamemode", name: "Change gamemode", category: "Players", description: "Change a player's game mode.", syntax: "gamemode <mode> [player]", base: ["gamemode"], fields: [{ name: "mode", label: "Gamemode", type: "select", required: true, options: ["survival", "creative", "adventure", "spectator"] }, { ...PLAYER, required: false }] },
  { id: "difficulty", name: "Change difficulty", category: "World", description: "Change the server difficulty.", syntax: "difficulty <difficulty>", base: ["difficulty"], fields: [{ name: "difficulty", label: "Difficulty", type: "select", required: true, options: ["peaceful", "easy", "normal", "hard"] }] },
  { id: "give", name: "Give an item", category: "Players", description: "Give an item to a player.", syntax: "give <player> <item> [amount]", base: ["give"], fields: [PLAYER, { name: "item", label: "Item ID", type: "text", required: true, placeholder: "minecraft:diamond" }, { name: "amount", label: "Amount", type: "number", min: 1, max: 6400, default: "1" }] },
  { id: "teleport", name: "Teleport player", category: "Players", description: "Teleport a player to another player or coordinates.", syntax: "tp <player> <destination>", base: ["tp"], fields: [PLAYER, { name: "destination", label: "Player or coordinates", type: "text", required: true, trailing: true, placeholder: "Player2 or 0 80 0" }] },
  { id: "time-set", name: "Set time", category: "World", description: "Set the current world time.", syntax: "time set <time>", base: ["time", "set"], fields: [{ name: "time", label: "Time", type: "select", required: true, options: ["day", "noon", "night", "midnight"] }] },
  { id: "weather", name: "Change weather", category: "World", description: "Set the world's weather.", syntax: "weather <type> [seconds]", base: ["weather"], fields: [{ name: "type", label: "Weather", type: "select", required: true, options: ["clear", "rain", "thunder"] }, { name: "duration", label: "Duration (seconds)", type: "number", min: 1, max: 1000000 }] },
  { id: "kick", name: "Kick player", category: "Moderation", description: "Disconnect a player with an optional reason.", syntax: "kick <player> [reason]", base: ["kick"], danger: true, fields: [PLAYER, { name: "reason", label: "Reason", type: "text", trailing: true }] },
  { id: "ban", name: "Ban player", category: "Moderation", description: "Ban a player from the server.", syntax: "ban <player> [reason]", base: ["ban"], danger: true, fields: [PLAYER, { name: "reason", label: "Reason", type: "text", trailing: true }] },
  { id: "pardon", name: "Pardon player", category: "Moderation", description: "Remove a player from the ban list.", syntax: "pardon <player>", base: ["pardon"], fields: [PLAYER] },
  { id: "op", name: "Make operator", category: "Moderation", description: "Grant server operator permissions.", syntax: "op <player>", base: ["op"], danger: true, fields: [PLAYER] },
  { id: "deop", name: "Remove operator", category: "Moderation", description: "Remove server operator permissions.", syntax: "deop <player>", base: ["deop"], danger: true, fields: [PLAYER] },
  { id: "whitelist-add", name: "Whitelist player", category: "Access", description: "Add a player to the whitelist.", syntax: "whitelist add <player>", base: ["whitelist", "add"], fields: [PLAYER] },
  { id: "whitelist-remove", name: "Remove from whitelist", category: "Access", description: "Remove a player from the whitelist.", syntax: "whitelist remove <player>", base: ["whitelist", "remove"], danger: true, fields: [PLAYER] },
  { id: "whitelist-list", name: "List whitelist", category: "Access", description: "Show whitelisted players.", syntax: "whitelist list", base: ["whitelist", "list"], fields: [] },
  { id: "whitelist-on", name: "Enable whitelist", category: "Access", description: "Only allow whitelisted players to join.", syntax: "whitelist on", base: ["whitelist", "on"], fields: [] },
  { id: "whitelist-off", name: "Disable whitelist", category: "Access", description: "Allow players who are not whitelisted to join.", syntax: "whitelist off", base: ["whitelist", "off"], danger: true, fields: [] },
  { id: "save-all", name: "Save world", category: "Server", description: "Save all server data immediately.", syntax: "save-all flush", base: ["save-all", "flush"], fields: [] },
  { id: "seed", name: "Show world seed", category: "World", description: "Display the current world seed.", syntax: "seed", base: ["seed"], fields: [] },
  { id: "setworldspawn", name: "Set world spawn", category: "World", description: "Set world spawn to coordinates or the current position.", syntax: "setworldspawn [x y z]", base: ["setworldspawn"], fields: [{ name: "coordinates", label: "Coordinates", type: "text", trailing: true, placeholder: "0 80 0 (optional)" }] },
  { id: "worldborder", name: "Set world border", category: "World", description: "Set the world border diameter.", syntax: "worldborder set <diameter>", base: ["worldborder", "set"], fields: [{ name: "diameter", label: "Diameter", type: "number", required: true, min: 1, max: 59999968 }] },
  { id: "experience", name: "Give experience", category: "Players", description: "Give experience points or levels to a player.", syntax: "experience add <player> <amount> <points|levels>", base: ["experience", "add"], fields: [PLAYER, { name: "amount", label: "Amount", type: "number", required: true, min: -2147483648, max: 2147483647 }, { name: "unit", label: "Unit", type: "select", required: true, options: ["points", "levels"] }] },
  { id: "effect-give", name: "Apply effect", category: "Players", description: "Apply a status effect to a player.", syntax: "effect give <player> <effect> [seconds] [amplifier]", base: ["effect", "give"], fields: [PLAYER, { name: "effect", label: "Effect ID", type: "text", required: true, placeholder: "minecraft:speed" }, { name: "seconds", label: "Seconds", type: "number", min: 1, max: 1000000, default: "30" }, { name: "amplifier", label: "Amplifier", type: "number", min: 0, max: 255, default: "0" }] },
  { id: "effect-clear", name: "Clear effects", category: "Players", description: "Clear status effects from a player.", syntax: "effect clear [player]", base: ["effect", "clear"], fields: [{ ...PLAYER, required: false }] },
  { id: "kill", name: "Kill entity", category: "Players", description: "Kill a player or target selector.", syntax: "kill <target>", base: ["kill"], danger: true, fields: [{ name: "target", label: "Target", type: "player", required: true, placeholder: "Player name or selector" }] },
  { id: "help", name: "Server help", category: "Server", description: "Ask the server for its available commands.", syntax: "help [command]", base: ["help"], fields: [{ name: "command", label: "Command", type: "text", placeholder: "Optional command name" }] },
  { id: "stop", name: "Stop server", category: "Server", description: "Save and stop the Minecraft server.", syntax: "stop", base: ["stop"], danger: true, fields: [] },
  advancedCommand("advancement", "Manage advancements", "Advanced", "Grant, revoke, or inspect player advancements.", "advancement <grant|revoke> <player> <advancement…>"),
  advancedCommand("attribute", "Manage attributes", "Advanced", "Read or change an entity attribute.", "attribute <target> <attribute> <action…>"),
  advancedCommand("ban-ip", "Ban IP address", "Moderation", "Ban an IP address from the server.", "ban-ip <address|player> [reason]"),
  advancedCommand("banlist", "Show ban list", "Moderation", "Show banned players or IP addresses.", "banlist [ips|players]", ["banlist"], false),
  advancedCommand("bossbar", "Manage boss bars", "Advanced", "Create and configure custom boss bars.", "bossbar <add|get|list|remove|set> …"),
  advancedCommand("clear", "Clear inventory", "Players", "Remove items from a player's inventory.", "clear [player] [item] [maxCount]", ["clear"], false),
  advancedCommand("clone", "Clone blocks", "World", "Copy blocks from one region to another.", "clone <begin> <end> <destination> [options…]"),
  advancedCommand("damage", "Damage entity", "Advanced", "Apply a specific amount and type of damage.", "damage <target> <amount> [damageType] [source…]"),
  advancedCommand("data", "Manage NBT data", "Advanced", "Read or modify block, entity, or storage data.", "data <get|merge|modify|remove> …"),
  advancedCommand("datapack", "Manage data packs", "Server", "Enable, disable, or list server data packs.", "datapack <disable|enable|list> …"),
  advancedCommand("debug", "Debug profiling", "Server", "Start, stop, or create a debug report.", "debug <start|stop|function> …"),
  advancedCommand("defaultgamemode", "Set default gamemode", "World", "Set the gamemode used by new players.", "defaultgamemode <mode>"),
  advancedCommand("enchant", "Enchant held item", "Players", "Apply an enchantment to a player's selected item.", "enchant <player> <enchantment> [level]"),
  advancedCommand("execute", "Execute command conditionally", "Advanced", "Run another command with changed context or conditions.", "execute <subcommands…> run <command>"),
  advancedCommand("fill", "Fill block region", "World", "Fill a region with a selected block.", "fill <from> <to> <block> [mode]"),
  advancedCommand("fillbiome", "Change biome region", "World", "Replace biomes within a region.", "fillbiome <from> <to> <biome> [replace…]"),
  advancedCommand("forceload", "Manage forced chunks", "World", "Keep selected chunks loaded.", "forceload <add|remove|query> …"),
  advancedCommand("function", "Run data-pack function", "Advanced", "Execute a function from an enabled data pack.", "function <name> [arguments…]"),
  advancedCommand("gamerule", "Change game rule", "World", "Read or change a world game rule.", "gamerule <rule> [value]"),
  advancedCommand("item", "Modify inventory item", "Advanced", "Replace or modify items in inventories.", "item <modify|replace> …"),
  advancedCommand("jfr", "Java Flight Recorder", "Server", "Start or stop a Java Flight Recorder profile.", "jfr <start|stop>"),
  advancedCommand("locate", "Locate structure or biome", "World", "Find the nearest matching structure, biome, or point of interest.", "locate <structure|biome|poi> <id>"),
  advancedCommand("loot", "Generate loot", "Advanced", "Generate loot into a target inventory or location.", "loot <target…> <source…>"),
  advancedCommand("me", "Action message", "Communication", "Broadcast an action-style message.", "me <message>"),
  advancedCommand("msg", "Private message", "Communication", "Send a private message to one or more players.", "msg <targets> <message>"),
  advancedCommand("pardon-ip", "Pardon IP address", "Moderation", "Remove an IP address from the ban list.", "pardon-ip <address>"),
  advancedCommand("particle", "Spawn particles", "World", "Display a particle effect.", "particle <particle> [position] [delta] [speed] [count] [mode] [viewers]"),
  advancedCommand("place", "Place world feature", "World", "Place a configured feature, structure, template, or jigsaw.", "place <feature|jigsaw|structure|template> …"),
  advancedCommand("playsound", "Play sound", "Players", "Play a sound for selected players.", "playsound <sound> <source> <targets> [position] [volume] [pitch]"),
  advancedCommand("random", "Generate random value", "Advanced", "Draw a random value or roll a sequence.", "random <value|roll|reset> …"),
  advancedCommand("recipe", "Manage recipes", "Players", "Grant or revoke recipes from players.", "recipe <give|take> <players> <recipe|*>"),
  advancedCommand("reload", "Reload data packs", "Server", "Reload server data packs and functions.", "reload"),
  advancedCommand("ride", "Manage entity riding", "Advanced", "Make an entity mount or dismount another entity.", "ride <target> <mount|dismount> …"),
  advancedCommand("rotate", "Rotate entity", "Advanced", "Set an entity's rotation or face it toward a target.", "rotate <target> <rotation|facing…>"),
  advancedCommand("schedule", "Schedule function", "Advanced", "Schedule a data-pack function for later.", "schedule <function|clear> …"),
  advancedCommand("scoreboard", "Manage scoreboard", "Advanced", "Manage scoreboard objectives and player scores.", "scoreboard <objectives|players> …"),
  advancedCommand("setblock", "Set a block", "World", "Place or replace one block at a position.", "setblock <position> <block> [destroy|keep|replace|strict]"),
  advancedCommand("setidletimeout", "Set idle timeout", "Server", "Set minutes before idle players are kicked.", "setidletimeout <minutes>"),
  advancedCommand("spawnpoint", "Set player spawn", "Players", "Set a player's individual spawn point.", "spawnpoint [player] [position] [angle]", ["spawnpoint"], false),
  advancedCommand("spectate", "Spectate entity", "Players", "Make a spectator watch an entity.", "spectate [target] [player]", ["spectate"], false),
  advancedCommand("spreadplayers", "Spread players", "Players", "Spread entities around a location.", "spreadplayers <center> <distance> <range> <respectTeams> <targets>"),
  advancedCommand("stopsound", "Stop sound", "Players", "Stop sounds for selected players.", "stopsound <targets> [source] [sound]"),
  advancedCommand("summon", "Summon entity", "World", "Summon an entity at a position.", "summon <entity> [position] [nbt]"),
  advancedCommand("tag", "Manage entity tags", "Advanced", "Add, remove, or list scoreboard tags.", "tag <targets> <add|remove|list> [name]"),
  advancedCommand("team", "Manage teams", "Advanced", "Create and configure scoreboard teams.", "team <add|empty|join|leave|list|modify|remove> …"),
  advancedCommand("teammsg", "Send team message", "Communication", "Send a message to the executing player's team.", "teammsg <message>"),
  advancedCommand("tellraw", "Send JSON message", "Communication", "Send a formatted JSON message to players.", "tellraw <players> <json>"),
  advancedCommand("tick", "Control server ticks", "Server", "Freeze, step, sprint, or change the server tick rate.", "tick <freeze|rate|step|sprint|status|unfreeze> …"),
  advancedCommand("title", "Display screen title", "Players", "Show a title, subtitle, or actionbar message.", "title <players> <clear|reset|title|subtitle|actionbar|times> …"),
  advancedCommand("transfer", "Transfer players", "Players", "Transfer players to another Minecraft server.", "transfer <hostname> [port] [players]"),
  advancedCommand("version", "Show server version", "Server", "Show server implementation and version details.", "version", ["version"]),
];

export function commandDefinition(id) {
  return COMMAND_CATALOG.find((command) => command.id === id) || null;
}

export function searchCommands(query = "") {
  const terms = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return COMMAND_CATALOG;
  return COMMAND_CATALOG.filter((command) => {
    const haystack = `${command.name} ${command.category} ${command.description} ${command.syntax}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function buildCommand(id, values = {}) {
  const definition = commandDefinition(id);
  if (!definition) throw new Error("Choose a supported command");
  const parts = [...definition.base];
  for (const field of definition.fields) {
    const raw = values[field.name] ?? field.default ?? "";
    const value = String(raw).trim();
    if (/\r|\n/.test(String(raw))) throw new Error(`${field.label} cannot contain a new line`);
    if (!value) {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    if (field.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`${field.label} must be a number`);
      if (field.min !== undefined && number < field.min) throw new Error(`${field.label} must be at least ${field.min}`);
      if (field.max !== undefined && number > field.max) throw new Error(`${field.label} must be no more than ${field.max}`);
    }
    if (field.options && !field.options.includes(value)) throw new Error(`Choose a valid ${field.label.toLowerCase()}`);
    parts.push(value);
  }
  return parts.join(" ");
}

export function normalizeRawCommand(value) {
  const command = String(value || "").trim().replace(/^\/+/, "");
  if (/\r|\n/.test(command)) throw new Error("A command must use a single line");
  return command;
}
