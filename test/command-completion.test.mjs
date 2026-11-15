import assert from "node:assert/strict";
import test from "node:test";
import { completeCommand, completionRegistries } from "../src/lib/command-completion.mjs";
import { loadCommandData } from "../src/lib/command-data.mjs";

const literal = (children = {}) => ({ type: "literal", children });
const argument = (parser, children = {}, properties) => ({ type: "argument", parser, children, ...(properties && { properties }) });
const tree = { children: {
  give: literal({ targets: argument("minecraft:entity", { item: argument("minecraft:item_stack") }, { type: "players" }) }),
  fill: literal({ from: argument("minecraft:block_pos", { to: argument("minecraft:block_pos", { block: argument("minecraft:block_state") }) }) }),
  summon: literal({ entity: argument("minecraft:resource", {}, { registry: "minecraft:entity_type" }) }),
  say: literal({ message: argument("minecraft:message") }),
  execute: literal({ run: literal(), as: literal({ targets: { ...argument("minecraft:entity"), redirect: ["execute"] } }) }),
  tp: { ...literal(), redirect: ["teleport"] },
  teleport: literal({ target: argument("minecraft:entity", { destination: argument("minecraft:entity") }) }),
} };
const registries = { item: ["bedrock", "blue_banner", "blue_dye", "diamond", "white_bed"], block: ["blue_wool", "light_gray_wool"], entity_type: ["blaze", "cave_spider"], texture: ["unrelated"] };
const data = { tree, registries: completionRegistries(tree, registries) };
const suggest = (value, cursor = value.length) => completeCommand(value, cursor, data, ["Alex", "Steve"]);
const choices = (result) => result.suggestions.map(({ text }) => text);

test("slash lists every reported root and Minecraft namespaces work", () => {
  assert.deepEqual(choices(suggest("/")), ["execute", "fill", "give", "say", "summon", "teleport", "tp"]);
  assert.deepEqual(choices(suggest("/minecraft:gi")), ["minecraft:give"]);
  assert.deepEqual(choices(suggest("/minecraft:give Al")), ["Alex"]);
});

test("players and registries appear only in matching argument positions", () => {
  assert.deepEqual(choices(suggest("/give Al")), ["Alex"]);
  assert.deepEqual(choices(suggest("/give Alex minecraft:blu")), ["minecraft:blue_banner", "minecraft:blue_dye"]);
  assert.deepEqual(choices(suggest("/fill ~ ~ ~ ~1 ~1 ~1 blu")), ["minecraft:blue_wool"]);
  assert.deepEqual(choices(suggest("/summon bl")), ["minecraft:blaze"]);
  assert.deepEqual(choices(suggest("/say Al")), []);
  assert.equal(data.registries.texture, undefined);
});

test("redirects, quoted selectors and replacements respect the cursor", () => {
  assert.deepEqual(choices(suggest("/tp Alex St")), ["Steve"]);
  assert.deepEqual(choices(suggest('/execute as @a[tag="some tag"] run gi')), ["give"]);
  const line = "/give AleXXXX minecraft:diamond";
  const result = suggest(line, "/give Ale".length);
  assert.deepEqual(choices(result), ["Alex"]);
  assert.equal(line.slice(result.from, result.to), "AleXXXX");
  assert.equal(line.slice(result.to), " minecraft:diamond");
});

test("resource IDs match prefixes at underscore boundaries within the requested namespace", () => {
  for (const prefix of ["bed", "minecraft:bed"]) {
    assert.deepEqual(choices(suggest(`/give Alex ${prefix}`)), ["minecraft:bedrock", "minecraft:white_bed"]);
  }
  assert.deepEqual(choices(suggest("/give Alex other:bed")), []);
  assert.deepEqual(choices(suggest("/fill ~ ~ ~ ~1 ~1 ~1 gray_wo")), ["minecraft:light_gray_wool"]);
  assert.deepEqual(choices(suggest("/summon spi")), ["minecraft:cave_spider"]);
  assert.deepEqual(choices(completeCommand("/give ex", 8, data, ["Alex", "player_ex"])), []);
});

test("offline fallback supplies known commands and player names", () => {
  const value = "/give Al";
  assert.deepEqual(choices(completeCommand(value, value.length, {}, ["Alex"])), ["Alex"]);
  assert.ok(choices(completeCommand("/")).includes("whitelist"));
});

test("reports are requested for the exact version and cached", async () => {
  const requests = [];
  const mock = async (url, options) => {
    requests.push(new URL(url).pathname);
    assert.equal(options.redirect, "error");
    return Response.json(url.includes("/commands/") ? tree : registries);
  };
  assert.deepEqual(await loadCommandData("test-command-version", mock), data);
  await loadCommandData("test-command-version", mock);
  assert.deepEqual(requests, [
    "/misode/mcmeta/test-command-version-summary/commands/data.min.json",
    "/misode/mcmeta/test-command-version-summary/registries/data.min.json",
  ]);
  assert.equal(await loadCommandData("../unsafe", mock), null);
});
