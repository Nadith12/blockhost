import assert from "node:assert/strict";
import test from "node:test";
import { buildCommand, normalizeRawCommand, searchCommands } from "../src/lib/command-catalog.mjs";

test("guided commands build exact Minecraft console input", () => {
  assert.equal(buildCommand("gamemode", { mode: "creative", player: "Nadith12" }), "gamemode creative Nadith12");
  assert.equal(buildCommand("give", { player: "Nadith12", item: "minecraft:diamond", amount: 4 }), "give Nadith12 minecraft:diamond 4");
  assert.equal(buildCommand("say", { message: "Server restart in five minutes" }), "say Server restart in five minutes");
});

test("command validation rejects missing, invalid, and multiline arguments", () => {
  assert.throws(() => buildCommand("gamemode", { mode: "builder" }), /valid gamemode/i);
  assert.throws(() => buildCommand("give", { player: "Nadith12", item: "minecraft:stone", amount: 0 }), /at least 1/i);
  assert.throws(() => buildCommand("say", { message: "hello\nstop" }), /new line/i);
  assert.throws(() => normalizeRawCommand("list\nstop"), /single line/i);
});

test("command search covers names, descriptions, categories, and syntax", () => {
  assert(searchCommands("whitelist").length >= 4);
  assert(searchCommands("world weather").some((entry) => entry.id === "weather"));
  assert.equal(normalizeRawCommand("/list"), "list");
});
