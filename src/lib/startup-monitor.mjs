import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { defaultAppOptions } from "./app-settings-options.mjs";

const readiness = /\bDone \([\d.,]+\s*s\)! For help\b/i;
const progress = /\b(?:loading \d+ mods|loading (?:minecraft|libraries|properties)|starting minecraft server|preparing (?:level|spawn area|start region)|preparing spawn:|loaded \d+ (?:recipes|advancements|mods|chunks)|preparing (?:server|world) spawn|scanning for mods|launching target ['"]?(?:forgeserver|neoforgeserver)|successfully loaded)\b/i;
const fatal = /^(?:Encountered an unexpected exception|Failed to start (?:the )?(?:minecraft )?server\b|An unexpected error occurred while starting the server|A problem occurred running the Server launcher|Exception in server tick loop|Could not start (?:the )?(?:Minecraft )?server\b|Mod loading (?:has )?failed\b|Error: Could not create the Java Virtual Machine)/im;
const rules = [
  {
    kind: "client-mod",
    match: /Attempted to load class .+ for invalid dist DEDICATED_SERVER|Cannot load class .+ in environment type SERVER|(?:NoClassDefFoundError|ClassNotFoundException):\s*(?:net[./]minecraft[./]client[./]|com[./]mojang[./]blaze3d[./])|Cannot (?:run|load) (?:a )?client.only mod on (?:a )?dedicated server/i,
    problem: "A mod tried to load client-only code on a dedicated server.",
    cause: "The startup log references Minecraft client code that is unavailable to a dedicated server.",
    fix: "Open Mods to review the affected mod. Disable it if it is client-only, or install a dedicated-server compatible release.",
  },
  {
    kind: "dependency",
    match: /Missing (?:or unsupported )?mandatory dependenc|Missing required mods|ModResolutionException|Mod ID:.{1,140}Requested by:.{1,140}Actual version:|requires .{1,200}(?:which is missing|which is not installed|but (?:only|no matching|it is not installed))|depends on .{1,180}which is missing/i,
    problem: "A required mod dependency is missing or incompatible.",
    cause: "The loader reported that the installed mods do not satisfy a dependency requirement.",
    fix: "Open Mods to add a matching file from the publisher or update the dependency already installed.",
  },
  {
    kind: "java",
    match: /UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime|Could not create the Java Virtual Machine|Could not reserve enough space for .*object heap|Invalid maximum heap size|java\.lang\.OutOfMemoryError|Unrecognized VM option|requires Java \d+ or (?:above|later|newer)|A fatal error has been detected by the Java Runtime Environment/i,
    problem: "Java could not start or complete server initialization.",
    cause: "The JVM reported a Java version, memory, or launch-option error.",
    fix: "Open Server settings to check the Java runtime and RAM allocation.",
  },
  {
    kind: "port",
    match: /FAILED TO BIND TO PORT|java\.net\.BindException: Address already in use/i,
    problem: "The server could not bind to its network port.",
    cause: "Another process may have acquired the configured address or port.",
    fix: "Stop the process using that port or choose an available port in Server settings.",
  },
  {
    kind: "incompatible-mod",
    match: /Incompatible mods found|Some of your mods are incompatible|(?:MixinApplyError|InvalidMixinException|MixinTransformerError)|ModLoadingException|Unsupported mod version|Incompatibilities between mods/i,
    problem: "A mod could not load with this server configuration.",
    cause: "The loader or mixin system reported an incompatibility or initialization error.",
    fix: "Open Mods to review the affected mod. Use the publisher’s matching dedicated-server release when available.",
  },
];

const modId = "([a-z][a-z0-9_.-]{0,63})";
const fabricRequirement = new RegExp(
  `^-?\\s*(?:Mod )?'(.{1,120}?)' \\(${modId}\\) .{1,100}? requires (.{1,200}?) of ` +
  `(?:(?:mod )?'(.{1,120}?)' \\(${modId}\\)|${modId}), ` +
  `(which is missing|which is disabled for this environment \\(client/server only\\)|but only the wrong versions? (?:is|are) present: (.{1,120}?))!$`,
);
const forgeRequirement = new RegExp(
  `^Mod ID: '${modId}', Requested by: '${modId}', Expected range: '([^']{1,200})', Actual version: '([^']{1,120})'$`,
);
const runtimeNames = new Map([
  ["minecraft", "Minecraft"], ["fabricloader", "Fabric Loader"], ["forge", "Forge"],
  ["neoforge", "NeoForge"], ["quilt_loader", "Quilt Loader"], ["java", "Java"],
]);

function cleanLogLine(value) {
  return stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0a-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 1000);
}

function logMessage(line) {
  return line.replace(/^\[[^\n]*?\]:\s*/, "");
}

function parseDependency(message) {
  const fabric = fabricRequirement.exec(message);
  if (fabric) {
    const [, requiredByName, requiredBy, version, dependencyName, namedId, bareId, result, installedVersion = ""] = fabric;
    const kind = result === "which is missing" ? "missing" : result.startsWith("which is disabled") ? "environment" : "incompatible";
    return { kind, modId: namedId || bareId, requiredBy, requiredByName, dependencyName, version, installedVersion };
  }
  const forge = forgeRequirement.exec(message);
  if (!forge) return null;
  const [, modId, requiredBy, version, foundVersion] = forge;
  const missing = foundVersion === "[MISSING]";
  return { kind: missing ? "missing" : "incompatible", modId, requiredBy, version, installedVersion: missing ? "" : foundVersion };
}

function dependencyDiagnosis(requirements) {
  // The loader reports the requirement, but the mod ID does not identify a publisher or a downloadable release.
  const requirement = requirements.find(item => item.kind === "environment")
    || requirements.find(item => item.kind === "missing" && !runtimeNames.has(item.modId))
    || requirements.find(item => runtimeNames.has(item.modId)) || requirements[0];
  const { kind, modId, requiredBy, requiredByName, dependencyName, version, installedVersion } = requirement;
  const runtime = runtimeNames.get(modId);
  const owner = requiredByName || requiredBy;
  const dependency = runtime || dependencyName || modId;
  const fields = { mod: requiredBy, requirements };
  if (runtime) {
    const javaMajor = modId === "java" ? Number(/^version (\d{1,2})(?: or later)?$/.exec(version)?.[1]) || undefined : undefined;
    return {
      ...fields,
      kind: modId === "java" ? "java" : "runtime",
      problem: modId === "java" ? "This pack needs a different Java version." : `This pack needs a different ${runtime} version.`,
      cause: `${owner} needs ${dependency} (${version}).${installedVersion ? ` Found ${installedVersion}.` : ""}`,
      fix: modId === "java" ? "Select a compatible Java runtime in Server settings, then retry." : "Use a server release that matches the publisher’s Minecraft and loader versions.",
      ...(javaMajor ? { javaMajor } : {}),
    };
  }
  if (kind === "environment") {
    return {
      ...fields,
      kind: "client-mod",
      problem: "A dependency cannot run on a dedicated server.",
      cause: `${owner} needs ${dependency}, which the loader disabled on the server.`,
      fix: "Open Mods to review the mod that needs this dependency. Use a dedicated-server compatible release.",
    };
  }
  return {
    ...fields,
    kind: "dependency",
    problem: "A required mod dependency is missing or incompatible.",
    cause: kind === "missing" ? `${owner} needs ${dependency} (${version}).`
      : `${owner} needs ${dependency} (${version}). Found ${installedVersion}.`,
    fix: kind === "missing" ? "Open Mods to add the publisher’s matching file, then retry."
      : "Open Mods to replace the dependency with the publisher’s matching release, then retry.",
  };
}

function requiredJavaVersion(lines) {
  const versions = lines.map(line => {
    const explicit = /\brequires Java (\d{1,2}) or (?:above|later|newer)\b/i.exec(line);
    if (explicit) return Number(explicit[1]);
    const compiled = /(?:UnsupportedClassVersionError|compiled by a more recent version).{1,350}?\bclass file version (\d{2,3})\.0\b/i.exec(line);
    return compiled ? Number(compiled[1]) - 44 : 0;
  });
  return Math.max(0, ...versions.filter(version => version >= 8 && version <= 99));
}

function identifyMod(lines) {
  for (const line of lines) {
    const match = line.match(/(?:provided by|from) mod ['"`]?([\w.-]+)|(?:mod|provided by) ['"`]([^'"`]+)['"`]/i);
    if (match) return (match[1] || match[2]).slice(0, 100);
  }
  return "";
}

export function createStartupMonitor(startedAt, options = defaultAppOptions) {
  let lastProgressAt = startedAt;
  let lastProgress = "";
  let lastMilestone = "";
  let terminal = false;
  const evidence = [];
  const recent = [];
  const idleMinutes = options.startupIdleMinutes;
  const deadlineMinutes = options.startupDeadlineMinutes;

  function observe(value, now) {
    const line = cleanLogLine(value);
    if (!line) return false;
    const message = logMessage(line);
    recent.push(line);
    if (recent.length > 16) recent.shift();
    if (rules.some(rule => rule.match.test(message)) || fatal.test(message) || parseDependency(message)) {
      if (!evidence.includes(line) && evidence.length < 32) evidence.push(line);
    }
    if (fatal.test(message)
      || /Incompatible mods found!|ModResolutionException|^Missing (?:or unsupported )?mandatory dependencies\b|UnsupportedClassVersionError|FAILED TO BIND TO PORT|Could not reserve enough space for .*object heap|Invalid maximum heap size|Unrecognized VM option/i.test(message)
      || /^(?:Exception in thread "(?:main|Server thread)"|A fatal error has been detected by the Java Runtime Environment)/i.test(message)) terminal = true;
    if (progress.test(message) && message !== lastMilestone) {
      lastProgressAt = now;
      lastProgress = line;
      lastMilestone = message;
    }
    return readiness.test(message);
  }

  function diagnose(status, reason = "", reportLines = []) {
    const lines = [...new Set([...evidence, ...reportLines.map(cleanLogLine).filter(Boolean), ...recent])];
    const requirements = new Map();
    const requirementLines = [];
    if (status !== "startup-stalled") {
      for (const line of lines) {
        const requirement = parseDependency(logMessage(line));
        if (!requirement) continue;
        requirementLines.push(line);
        const { kind, modId, requiredBy, version } = requirement;
        requirements.set(JSON.stringify([kind, modId, requiredBy, version]), requirement);
      }
      if (requirements.size) {
        return {
          ...dependencyDiagnosis([...requirements.values()]),
          evidence: [...new Set([...requirementLines, ...evidence, ...recent.slice(-4)])].slice(0, 8),
        };
      }
    }
    const rule = rules.find(candidate => lines.some(line => candidate.match.test(line)));
    if (rule && status !== "startup-stalled") {
      const matches = lines.filter(line => rule.match.test(line));
      const mod = ["client-mod", "dependency", "incompatible-mod"].includes(rule.kind)
        ? identifyMod(matches) || identifyMod(lines.filter(line => /entrypoint|mixin|failure message/i.test(line))) : "";
      const javaMajor = rule.kind === "java" ? requiredJavaVersion(matches) : 0;
      return { kind: rule.kind, problem: rule.problem, cause: rule.cause, fix: rule.fix, mod,
        ...(javaMajor ? {
          javaMajor,
          problem: `This pack needs Java ${javaMajor} or later.`,
          cause: "The Java runtime could not load a class required by the server.",
          fix: `Select Java ${javaMajor} or a compatible newer runtime in Server settings, then retry.`,
        } : {}),
        evidence: [...new Set([...matches, ...evidence, ...recent.slice(-4)])].slice(0, 8) };
    }
    if (status === "startup-stalled") {
      const hardLimit = reason === "deadline";
      return {
        kind: "stall",
        problem: hardLimit ? "The server exceeded its startup time limit." : "The server is still running without a new startup milestone.",
        cause: hardLimit ? `No readiness message arrived within ${deadlineMinutes} minutes.` : `No startup progress was recognized for ${idleMinutes} minutes.`,
        fix: "Check the last console messages and resource usage. Slow modpacks may still finish. If this server normally takes longer, increase the startup timeouts in App Settings.",
        evidence: [...new Set([lastProgress, ...recent.slice(-5)].filter(Boolean))],
      };
    }
    return {
      kind: "unknown",
      problem: status === "crashed" ? "The server process exited unexpectedly." : "Server startup reported a fatal error.",
      cause: reason || "The console confirms startup failed, but the available evidence does not identify a specific cause.",
      fix: "Review the earliest error below and the surrounding Console output. Check the server’s Java version, loader, and recent mod changes.",
      evidence: [...new Set([...evidence, ...reportLines.slice(0, 4), ...recent.slice(-6)])].slice(0, 8),
    };
  }

  function check(now) {
    if (terminal) return "startup-failed";
    if (now - startedAt >= deadlineMinutes * 60_000) return "deadline";
    if (now - lastProgressAt >= idleMinutes * 60_000) return "idle";
    return "starting";
  }

  return { observe, check, diagnose };
}

export async function readStartupCrashReport(serverFolder, startedAt) {
  try {
    const directory = path.join(await fs.realpath(serverFolder), "crash-reports");
    if (!(await fs.lstat(directory)).isDirectory()) return [];
    const names = await fs.readdir(directory);
    for (const name of names.filter(name => /^crash-[\d_.-]+-(?:server|fml)\.txt$/i.test(name)).sort().reverse().slice(0, 8)) {
      const file = path.join(directory, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.mtimeMs < startedAt) continue;
      const handle = await fs.open(file, "r");
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const lines = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/).map(cleanLogLine);
        return lines.filter(line => /^(?:Description:|Caused by:|Mod File:|Failure message:|Exception message:)|(?:Error|Exception):|from mod /i.test(line)
          || parseDependency(line)).slice(0, 48);
      } finally {
        await handle.close();
      }
    }
  } catch { /* Reports may be absent, incomplete, or unreadable. Console evidence is still available. */ }
  return [];
}
