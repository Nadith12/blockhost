import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { openAppPreferences } from "../src/lib/app-preferences.mjs";
import { defaultAppOptions } from "../src/lib/app-settings-options.mjs";
import { normalizeServerIcon } from "../src/lib/app-themes.mjs";

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(process.cwd(), ".app-preferences-test-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "app-preferences.json");
  return { file, open: () => openAppPreferences(file) };
}

test("Minecraft is the default app theme and saved choices are kept", async t => {
  const { file, open } = await fixture(t);
  assert.equal(open().snapshot().theme, "minecraft");
  await fs.writeFile(file, JSON.stringify({ theme: "unsupported" }));
  assert.equal(open().snapshot().theme, "minecraft");
  open().setTheme("normal");
  assert.equal(open().snapshot().theme, "normal");
  assert.equal(normalizeServerIcon(), "normal");
});

test("legacy encrypted keys stay on disk and are absent from app settings", async t => {
  const { file, open } = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ curseForgeKey: "legacy-encrypted-value", curseForgeSetupDismissed: true }));
  const settings = open();
  assert.equal(Object.hasOwn(settings.snapshot(), "keyStatus"), false);
  assert.equal(Object.hasOwn(settings.snapshot(), "promptForKey"), false);
  settings.setTheme("minecraft");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).curseForgeKey, "legacy-encrypted-value");
});

test("desktop preferences and optional quick defaults survive reopening", async t => {
  const { open } = await fixture(t);
  const settings = open();
  assert.equal(settings.snapshot().desktop.notifyTray, true);
  settings.setDesktopOptions({ ...settings.snapshot().desktop, reopenServer: true, notifyBackup: true, notifyTray: false });
  settings.rememberServer(123);
  const bounds = { x: 10, y: 20, width: 1180, height: 820 };
  settings.rememberWindow(bounds);
  settings.setQuickDefaults({ difficulty: "hard", "max-players": 14, "view-distance": "" });
  assert.throws(() => settings.setQuickDefaults({ difficulty: "invalid" }), /Difficulty/);
  const reopened = open();
  assert.equal(reopened.snapshot().lastServerId, 123);
  assert.equal(reopened.snapshot().desktop.notifyBackup, true);
  assert.equal(reopened.snapshot().desktop.notifyTray, false);
  assert.equal(reopened.snapshot().desktop.reopenServer, true);
  assert.deepEqual(reopened.windowBounds(), bounds);
  assert.deepEqual(reopened.snapshot().quickDefaults, { difficulty: "hard", "max-players": 14 });
});

test("server defaults, console and gradient options are validated and persisted together", async (t) => {
  const { file, open } = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ theme: "minecraft", options: { consoleTimestamps: false, gradientStrength: "bad" } }));
  const settings = open();
  assert.deepEqual(settings.snapshot().options, { ...defaultAppOptions, consoleTimestamps: false });

  const options = {
    ...defaultAppOptions,
    serverType: "fabric", minecraftVersion: "1.20.1", maxMemoryMb: 3072,
    consoleFilter: "warnings", consoleFontSize: 16, consoleTimestamps: false,
    consoleAutoScroll: false, gradientStrength: 0,
  };
  settings.setOptions(options, 4096);
  assert.throws(() => settings.setOptions({ ...options, maxMemoryMb: 4352 }, 4096), /at most 4096 MB/);
  assert.throws(() => settings.setOptions({ ...options, gradientStrength: 201 }, 4096), /gradientStrength/);
  assert.throws(() => settings.setOptions({ ...options, startupIdleMinutes: 10, startupDeadlineMinutes: 9 }, 4096), /at least the idle timeout/);
  assert.deepEqual(open().snapshot().options, options);
  assert.equal(open().snapshot().theme, "minecraft");
});

test("legacy appearance names resolve to their supported equivalents", async (t) => {
  const { file, open } = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ theme: "terminal" }));
  const settings = open();
  assert.equal(settings.snapshot().theme, "monarch");
  assert.equal(normalizeServerIcon("terminal"), "monarch");
  assert.throws(() => settings.setTheme("unsupported"), /supported BlockHost theme/);
  assert.equal(settings.setTheme("monarch").theme, "monarch");
  assert.equal(open().snapshot().theme, "monarch");
});
