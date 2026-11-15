const SIDES = {
  client_and_server: { label: "Client + server", group: "Required on clients" },
  server_only_client_optional: { label: "Client optional", group: "Optional on clients" },
  client_or_server_prefers_both: { label: "Client optional · best on both", group: "Optional on clients" },
  client_or_server: { label: "Client or server", group: "Optional on clients" },
  client_only_server_optional: { label: "Client mod · server optional", group: "Client-side extras" },
  client_only: { label: "Client only", group: "Client-side extras" },
  server_only: { label: "Server only" },
  dedicated_server_only: { label: "Server only" },
  singleplayer_only: { label: "Singleplayer only" },
  both_supported: { label: "Client + server · verify requirement", group: "Check with the mod author" },
  unknown: { label: "Side unverified", group: "Check with the mod author" },
};

export function addonSide(environment) {
  return Object.hasOwn(SIDES, environment) ? SIDES[environment] : SIDES.unknown;
}

export function declaredModEnvironment(metadata) {
  const environments = Array.isArray(metadata?.environment) ? [...new Set(metadata.environment)] : [metadata?.environment];
  if (environments.length > 1) return "";
  const [environment] = environments;
  if (environment && environment !== "unknown" && Object.hasOwn(SIDES, environment)) return environment;
  const client = metadata?.client_side;
  const server = metadata?.server_side;
  if (client === "required" && server === "required") return "client_and_server";
  if (client === "required" && server === "optional") return "client_only_server_optional";
  if (client === "required" && server === "unsupported") return "client_only";
  if (client === "optional" && server === "required") return "server_only_client_optional";
  if (client === "unsupported" && ["required", "optional"].includes(server)) return "server_only";
  return "";
}

export function clientModList(items) {
  const groups = new Map([
    ["Required on clients", []],
    ["Optional on clients", []],
    ["Client-side extras", []],
    ["Check with the mod author", []],
  ]);
  for (const item of items) {
    if (!item.enabled) continue;
    groups.get(addonSide(item.environment).group)?.push(item);
  }
  return [...groups].filter(([, mods]) => mods.length);
}
