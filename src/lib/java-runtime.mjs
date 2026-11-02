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

export function requiredJavaVersion(minecraftVersion) {
  const value = String(minecraftVersion || "").trim();
  const modern = value.match(/^(\d{2,})(?:\.|$)/);
  if (modern && Number(modern[1]) >= 26) return 25;
  return 21;
}
