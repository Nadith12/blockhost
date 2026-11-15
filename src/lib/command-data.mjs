import { completionRegistries } from "./command-completion.mjs";

const cache = new Map();

async function report(version, name, fetchImpl) {
  const url = `https://raw.githubusercontent.com/misode/mcmeta/${version}-summary/${name}/data.min.json`;
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok || !response.body) throw new Error("The Minecraft command report is unavailable.");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 ** 2) throw new Error("The Minecraft command report is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function loadCommandData(version, fetchImpl = fetch) {
  if (typeof version !== "string" || !/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(version)) return Promise.resolve(null);
  if (!cache.has(version)) {
    const pending = Promise.all([report(version, "commands", fetchImpl), report(version, "registries", fetchImpl)])
      .then(([tree, registries]) => ({ tree, registries: completionRegistries(tree, registries) }))
      .catch(() => {
        if (cache.get(version) === pending) cache.delete(version);
        return null;
      });
    cache.set(version, pending);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  return cache.get(version);
}
