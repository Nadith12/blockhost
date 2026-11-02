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

  return {
    architecture: architecture || "unknown",
    dataModel,
    is64Bit,
    version: String(versionMatch?.[1] || "").trim() || "unknown",
  };
}

export function assertSupportedJavaRuntime(details) {
  if (details?.is64Bit === false) {
    throw new Error(
      "64-bit Java is required. BlockHost found a 32-bit Java runtime, which cannot run servers with the selected RAM. Install 64-bit Java 21 and reopen BlockHost Manager."
    );
  }
  return details;
}
