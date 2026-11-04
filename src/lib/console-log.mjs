const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const LEVEL_PATTERN = /\b(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE)\b/i;
const STACK_PATTERN = /^\s*(?:at\s+\S+\(|Caused by:|Suppressed:|\.\.\. \d+ more|[\w.$]+(?:Exception|Error)(?::|$))/;
const ERROR_PATTERN = /(?:^|\b)(?:error|exception|fatal|crash(?:ed)?|failed to|failure|unable to|could not)(?:\b|:)/i;
const USERNAME = "([A-Za-z0-9_]{1,16})";
const MONTHS = new Map([["jan", 0], ["feb", 1], ["mar", 2], ["apr", 3], ["may", 4], ["jun", 5], ["jul", 6], ["aug", 7], ["sep", 8], ["oct", 9], ["nov", 10], ["dec", 11]]);

export function stripConsoleFormatting(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "").replace(/\r/g, "");
}

export function consoleOccurrenceTime(minecraftTime, receivedAt) {
  const fallback = Number.isFinite(Date.parse(receivedAt)) ? new Date(receivedAt) : new Date();
  const value = String(minecraftTime || "");
  const clock = value.match(/(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (!clock) return fallback.toISOString();
  const occurred = new Date(fallback);
  const dated = value.match(/(\d{2})([A-Za-z]{3})(\d{4})/);
  if (dated && MONTHS.has(dated[2].toLowerCase())) {
    occurred.setFullYear(Number(dated[3]), MONTHS.get(dated[2].toLowerCase()), Number(dated[1]));
  }
  occurred.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3]), Number(String(clock[4] || "0").padEnd(3, "0")));
  if (!dated && occurred.getTime() - fallback.getTime() > 300_000) occurred.setDate(occurred.getDate() - 1);
  return occurred.toISOString();
}

export function parseConsoleLine(value, options = {}) {
  const raw = stripConsoleFormatting(value).trimEnd();
  const receivedAt = Number.isFinite(Date.parse(options.receivedAt))
    ? new Date(options.receivedAt).toISOString()
    : new Date().toISOString();
  let message = raw;
  let minecraftTime = "";
  let thread = "";
  let level = String(options.level || "").toLowerCase();
  const source = String(options.source || "server");

  const standard = raw.match(/^\[([^\]]+)\]\s+\[([^\]/]+)\/(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE)\](?:\s+\[[^\]]+\])?\s*:\s*(.*)$/i);
  if (standard) {
    [, minecraftTime, thread, level, message] = standard;
    level = level.toLowerCase().replace("warning", "warn");
  } else if (raw.match(/^\[([^\]]+?)\s+(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE)\]\s*:\s*(.*)$/i)) {
    const compact = raw.match(/^\[([^\]]+?)\s+(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE)\]\s*:\s*(.*)$/i);
    [, minecraftTime, level, message] = compact;
    level = level.toLowerCase().replace("warning", "warn");
  } else if (/^\[APP\]\s*/i.test(raw)) {
    message = raw.replace(/^\[APP\]\s*/i, "");
    level ||= /failed|error|could not/i.test(message) ? "error" : "app";
  } else if (/^>\s*/.test(raw)) {
    message = raw.replace(/^>\s*/, "");
    level = "command";
  } else {
    const levelMatch = raw.match(LEVEL_PATTERN);
    if (levelMatch) level = levelMatch[1].toLowerCase().replace("warning", "warn");
  }

  const stackTrace = STACK_PATTERN.test(message) || /^\s+at\s/.test(raw);
  if (!level) level = stackTrace || ERROR_PATTERN.test(message) ? "error" : "info";
  if (level === "info" && ERROR_PATTERN.test(message)) level = "error";
  if (level === "fatal") level = "error";

  let category = level === "error" ? "error" : level === "warn" ? "warning" : "general";
  let playerName = "";
  let event = "";
  const playerPatterns = [
    [new RegExp(`^${USERNAME} joined the game(?:$|\\s)`, "i"), "player-join"],
    [new RegExp(`^${USERNAME} left the game(?:$|\\s)`, "i"), "player-leave"],
    [new RegExp(`^${USERNAME} lost connection(?::|$)`, "i"), "player-leave"],
    [new RegExp(`^<${USERNAME}>\\s`, "i"), "player-chat"],
  ];
  for (const [pattern, kind] of playerPatterns) {
    const match = message.match(pattern);
    if (!match) continue;
    playerName = match[1];
    event = kind;
    category = "player";
    break;
  }

  return {
    id: Number(options.id) || 0,
    receivedAt,
    occurredAt: consoleOccurrenceTime(minecraftTime, receivedAt),
    minecraftTime,
    thread: thread.trim(),
    source,
    level,
    category,
    event,
    playerName,
    stackTrace,
    errorStart: level === "error" && !stackTrace,
    message,
    raw,
    errorGroupId: "",
  };
}

export function attachErrorGroup(entry, state = {}) {
  const next = { ...entry };
  if (next.errorStart) {
    state.sequence = (Number(state.sequence) || 0) + 1;
    state.activeGroupId = `error-${state.sequence}`;
  } else if (!next.stackTrace) {
    state.activeGroupId = "";
  }
  if ((next.errorStart || next.stackTrace) && state.activeGroupId) {
    next.errorGroupId = state.activeGroupId;
  }
  return next;
}

export function updateOnlinePlayers(players, entry) {
  const next = new Set(players || []);
  if (entry?.event === "player-join" && entry.playerName) next.add(entry.playerName);
  if (entry?.event === "player-leave" && entry.playerName) next.delete(entry.playerName);
  return next;
}
