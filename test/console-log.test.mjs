import assert from "node:assert/strict";
import test from "node:test";
import { attachErrorGroup, consoleOccurrenceTime, parseConsoleLine, updateOnlinePlayers } from "../src/lib/console-log.mjs";

test("console parser identifies standard levels and player activity", () => {
  const joined = parseConsoleLine("[12:30:01] [Server thread/INFO]: Nadith12 joined the game", { receivedAt: "2026-11-04T02:00:00Z" });
  assert.equal(joined.minecraftTime, "12:30:01");
  assert.equal(joined.level, "info");
  assert.equal(joined.event, "player-join");
  assert.equal(joined.playerName, "Nadith12");
  const players = updateOnlinePlayers([], joined);
  assert.deepEqual([...players], ["Nadith12"]);
  assert.equal(updateOnlinePlayers(players, parseConsoleLine("[12:31:01] [Server thread/INFO]: Nadith12 left the game")).size, 0);
});

test("console parser groups an error and its Java stack trace", () => {
  const state = {};
  const error = attachErrorGroup(parseConsoleLine("[12:30:01] [Server thread/ERROR]: Failed to load world"), state);
  const cause = attachErrorGroup(parseConsoleLine("java.lang.IllegalStateException: damaged"), state);
  const frame = attachErrorGroup(parseConsoleLine("\tat net.minecraft.Main.main(Main.java:20)"), state);
  assert.equal(error.level, "error");
  assert.ok(error.errorGroupId);
  assert.equal(cause.errorGroupId, error.errorGroupId);
  assert.equal(frame.errorGroupId, error.errorGroupId);
});

test("console parser strips terminal formatting and recognises commands", () => {
  assert.equal(parseConsoleLine("\u001b[31m[APP] Start failed: bad Java\u001b[0m").level, "error");
  const command = parseConsoleLine("> list");
  assert.equal(command.level, "command");
  assert.equal(command.message, "list");
});

test("console parser supports Paper compact and NeoForge extended prefixes", () => {
  const paper = parseConsoleLine("[11:26:15 INFO]: Done (6.971s)! For help, type help");
  assert.equal(paper.minecraftTime, "11:26:15");
  assert.equal(paper.message, "Done (6.971s)! For help, type help");
  const neoForge = parseConsoleLine("[04Nov2026 11:26:15.123] [Server thread/WARN] [net.minecraft/Main]: Slow server");
  assert.equal(neoForge.level, "warn");
  assert.equal(neoForge.message, "Slow server");
  const paperError = parseConsoleLine("[11:35:27 INFO]: An unexpected error occurred trying to execute that command");
  assert.equal(paperError.level, "error");
});

test("each log occurrence uses its Minecraft clock instead of batch receive time", () => {
  const receivedAt = "2026-11-04T01:39:56.000Z";
  const first = parseConsoleLine("[11:39:28 INFO]: First", { receivedAt });
  const second = parseConsoleLine("[11:39:29 WARN]: Second", { receivedAt });
  assert.notEqual(first.occurredAt, second.occurredAt);
  assert.equal(new Date(second.occurredAt).getTime() - new Date(first.occurredAt).getTime(), 1000);
  const dated = new Date(consoleOccurrenceTime("04Nov2026 11:39:30.125", receivedAt));
  assert.deepEqual(
    [dated.getFullYear(), dated.getMonth(), dated.getDate(), dated.getHours(), dated.getMinutes(), dated.getSeconds(), dated.getMilliseconds()],
    [2026, 10, 4, 11, 39, 30, 125]
  );
});
