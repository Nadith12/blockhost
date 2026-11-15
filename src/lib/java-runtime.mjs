function normalizeArchitecture(value) {
  return String(value || "").trim().toLowerCase();
}

export function parseJavaRuntimeDetails(output) {
  const text = String(output || "");
  const dataModelMatch = text.match(/sun\.arch\.data\.model\s*=\s*(\d+)/i);
  const architectureMatch = text.match(/os\.arch\s*=\s*([^\r\n]+)/i);
  const versionMatch = text.match(/java\.version\s*=\s*([^\r\n]+)/i)
    || text.match(/(?:java|openjdk) version\s+"([^"]+)"/i);
  const dataModel = dataModelMatch ? Number(dataModelMatch[1]) : null;
  const architecture = normalizeArchitecture(architectureMatch?.[1]);

  let is64Bit = null;
  if (dataModel === 64) is64Bit = true;
  else if (dataModel === 32) is64Bit = false;
  else if (/^(?:amd64|x86_64|aarch64|arm64|ppc64|s390x)$/.test(architecture)) is64Bit = true;
  else if (/^(?:x86|i[3-6]86|arm|arm32)$/.test(architecture)) is64Bit = false;

  const version = String(versionMatch?.[1] || "").trim() || "unknown";
  const versionParts = version.match(/^(?:1\.)?(\d+)/);
  const majorVersion = versionParts ? Number(versionParts[1]) : null;

  return {
    architecture: architecture || "unknown",
    dataModel,
    is64Bit,
    version,
    majorVersion,
  };
}

export function assertSupportedJavaRuntime(details, minimumMajor = 21) {
  if (details?.is64Bit === false) {
    throw new Error(
      `64-bit Java ${minimumMajor} is required. BlockHost found a 32-bit Java runtime, which cannot run servers with the selected RAM.`
    );
  }
  if (!Number.isSafeInteger(details?.majorVersion) || details.majorVersion < minimumMajor) {
    throw new Error(`Java ${minimumMajor} or newer is required. BlockHost found Java ${details?.version || "of an unknown version"}.`);
  }
  return details;
}

export function requiredJavaVersion(minecraftVersion, type = "") {
  const value = String(minecraftVersion || "").trim();
  const modern = value.match(/^(\d{2,})(?:\.|$)/);
  if (modern && Number(modern[1]) >= 26) return 25;
  const release = value.match(/^1\.(\d+)(?:\.(\d+))?(?:$|[-+])/);
  if (!release) return 21;
  const minor = Number(release[1]);
  const patch = Number(release[2] || 0);
  if (type === "paper" || type === "purpur") {
    if (minor >= 20) return 21;
    if (minor >= 17) return 17;
    if (minor === 16 && patch >= 5) return 16;
    if (minor >= 12) return 11;
  }
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

export function javaRequirement(server) {
  const baseline = requiredJavaVersion(server.version, server.type);
  const official = Number(server.minecraftJavaMajor);
  const hasOfficial = Number.isSafeInteger(official) && official >= 8 && official <= 99;
  const minimum = hasOfficial && server.type === "vanilla" ? official : baseline;
  const recommendation = Number(server.recommendedJavaMajor);
  const hasRecommendation = Number.isSafeInteger(recommendation) && recommendation >= minimum && recommendation <= 99;
  const requiredMajor = hasRecommendation ? recommendation : minimum;
  const knownVersion = /^(?:1\.\d+(?:\.\d+)?|(?:2[6-9]|[3-9]\d)\.\d+)(?:$|[.-])/.test(String(server.version || ""));
  return { requiredMajor, warning: knownVersion || hasOfficial || hasRecommendation ? "" : "Minecraft version could not be determined. Java " + requiredMajor + " is the suggested runtime." };
}
