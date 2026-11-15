import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findJavaExecutable, installManagedJava, isManagedJavaReady } from "./managed-java.mjs";
import { parseJavaRuntimeDetails } from "./java-runtime.mjs";

const run = promisify(execFile);
const vendors = ["Java", "Eclipse Adoptium", "Microsoft", "Azul Systems", "Amazon Corretto", "BellSoft", "Semeru"];

export function discoverJavaExecutables(env = process.env, platform = process.platform) {
  const binary = platform === "win32" ? "java.exe" : "java";
  const candidates = new Set();
  const add = (candidate) => {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) candidates.add(candidate);
  };
  if (env.JAVA_HOME) add(path.join(env.JAVA_HOME.replace(/^"|"$/g, ""), "bin", binary));
  const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
  for (const directory of String(searchPath || "").split(path.delimiter)) {
    add(path.join(directory.replace(/^"|"$/g, ""), binary));
  }
  const roots = platform === "win32"
    ? [env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]
        .filter(Boolean).flatMap(base => vendors.map(vendor => path.join(base, vendor)))
    : ["/usr/lib/jvm", "/Library/Java/JavaVirtualMachines"];
  for (const root of new Set(roots)) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        add(path.join(root, entry.name, "bin", binary));
        if (platform === "darwin") add(path.join(root, entry.name, "Contents", "Home", "bin", binary));
      }
    } catch {}
  }
  return [...candidates];
}

async function inspectJava(command) {
  const result = await run(command, ["-XshowSettings:properties", "-version"], {
    windowsHide: true, maxBuffer: 1024 * 1024, timeout: 12_000,
  });
  return parseJavaRuntimeDetails(result.stdout + "\n" + result.stderr);
}

export class JavaRuntimeManager {
  #installs = new Map();
  #probes = new Map();

  constructor({ runtimeRoot, probe = inspectJava, discover = discoverJavaExecutables, install = installManagedJava, platform = process.platform, arch = process.arch }) {
    Object.assign(this, { runtimeRoot, probe, discover, install, platform, arch });
  }

  async validate(command, major) {
    if (!path.isAbsolute(command)) throw new Error("Select a full path to a Java executable.");
    const stat = await fs.promises.stat(command);
    if (!stat.isFile()) throw new Error("The selected Java executable is missing.");
    const cached = this.#probes.get(command);
    let details = cached?.details;
    if (!cached || cached.modified !== stat.mtimeMs || cached.size !== stat.size || cached.expires < Date.now()) {
      details = await this.probe(command);
      this.#probes.set(command, { details, modified: stat.mtimeMs, size: stat.size, expires: Date.now() + 60_000 });
    }
    if (details.is64Bit !== true || details.majorVersion !== major) {
      throw new Error("This server requires 64-bit Java " + major + ". The selected executable reports Java " + details.version + (details.is64Bit === false ? " (32-bit)." : "."));
    }
    return details;
  }

  async resolve(major, { customCommand, download = true, onProgress } = {}) {
    if (!Number.isSafeInteger(major) || major < 8 || major > 99) throw new Error("Invalid Java version requirement.");
    if (customCommand) {
      try {
        return { source: "custom", command: customCommand, details: await this.validate(customCommand, major) };
      } catch (error) {
        throw new Error("Custom Java could not be used: " + error.message + " Choose a compatible executable or switch to Automatic in Server settings.", { cause: error });
      }
    }
    const root = path.join(this.runtimeRoot, "java-" + major);
    try {
      const command = isManagedJavaReady(root) && findJavaExecutable(root, this.platform);
      if (command) return { source: "managed", command, details: await this.validate(command, major) };
    } catch {}
    if (this.#installs.has(major) && download) return this.#installs.get(major);
    for (const command of this.discover()) {
      try { return { source: "system", command, details: await this.validate(command, major) }; } catch {}
    }
    if (!download) return null;
    if (this.#installs.has(major)) return this.#installs.get(major);
    if (this.platform !== "win32" || this.arch !== "x64") {
      throw new Error("Java " + major + " is required. Automatic downloads are available for Windows x64. Choose an existing 64-bit executable in Server settings.");
    }
    const pending = this.install({
      runtimeRoot: this.runtimeRoot,
      javaVersion: major,
      validateJava: async command => ({ details: await this.validate(command, major) }),
      onProgress,
    }).then(result => {
      this.#probes.delete(result.executable);
      return { source: "managed", command: result.executable, details: result.details };
    }).catch(error => {
      throw new Error("Could not set up Java " + major + ": " + error.message, { cause: error });
    }).finally(() => this.#installs.delete(major));
    this.#installs.set(major, pending);
    return pending;
  }
}
