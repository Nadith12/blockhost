import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildInitialServerProperties,
  buildPropertiesModel,
  buildPropertiesText,
  loadServerProperties,
  parseProperties,
  propertySchemaForVersion,
  rollbackServerProperties,
  saveServerProperties,
  validateRawPropertiesText,
  validatePropertyValues,
} from "../src/lib/server-properties.mjs";
import { commitFileBackup } from "../src/lib/safe-filesystem.mjs";

test("new server quick defaults override only selected properties supported by that version", () => {
  const source = "motd=Pack settings\ndifficulty=normal\nview-distance=12\n";
  const defaults = { difficulty: "hard", "simulation-distance": 7, "max-players": 14 };
  const old = parseProperties(buildInitialServerProperties(source, "seed", defaults, "1.16.5")).values;
  assert.equal(old.difficulty, "hard");
  assert.equal(old["max-players"], "14");
  assert.equal(old["level-seed"], "seed");
  assert.equal(old["view-distance"], "12");
  assert.equal(old["simulation-distance"], undefined);
  const modern = parseProperties(buildInitialServerProperties(source, "", defaults, "1.21.1")).values;
  assert.equal(modern["simulation-distance"], "7");
});

test("properties parser supports comments, escaped separators, unicode and continuations", () => {
  const source = [
    "# comment remains",
    "motd=Hello\\ World",
    "custom\\:key:some\\ value",
    "unicode=Block\\u0048ost",
    "continued=first\\",
    "  second",
    "",
  ].join("\n");
  const parsed = parseProperties(source);
  assert.equal(parsed.values.motd, "Hello World");
  assert.equal(parsed.values["custom:key"], "some value");
  assert.equal(parsed.values.unicode, "BlockHost");
  assert.equal(parsed.values.continued, "firstsecond");
  assert.equal(parsed.entries[0].type, "comment");
});

test("a trailing backslash on a comment cannot hide a subsequent property", () => {
  const source = [
    "server-ip=first",
    "  # comment\\",
    "server-ip=last",
    "\t! another comment\\",
    "level-name=Custom World",
    "motd=Continued \\",
    "  # as part of the value",
  ].join("\r\n");
  const parsed = parseProperties(source);
  assert.equal(parsed.values["server-ip"], "last");
  assert.equal(parsed.values["level-name"], "Custom World");
  assert.equal(parsed.values.motd, "Continued # as part of the value");
  assert.equal(parsed.entries.filter(entry => entry.type === "comment").length, 2);
});

test("properties builder updates known values while preserving comments and custom values", () => {
  const source = [
    "# user comment",
    "motd=Old name",
    "motd=Duplicate that currently wins",
    "custom-setting=keep-me",
    "removed-setting=remove-me",
    "",
  ].join("\n");
  const model = buildPropertiesModel(source, true);
  const next = buildPropertiesText(source, {
    values: { ...model.values, motd: "New name", "max-players": 12 },
    customProperties: "custom-setting=still-here\nnew-setting=added",
  });
  const parsed = parseProperties(next);

  assert.match(next, /# user comment/);
  assert.equal((next.match(/^motd=/gm) || []).length, 1);
  assert.equal(parsed.values.motd, "New name");
  assert.equal(parsed.values["max-players"], "12");
  assert.equal(parsed.values["custom-setting"], "still-here");
  assert.equal(parsed.values["new-setting"], "added");
  assert.equal(Object.hasOwn(parsed.values, "removed-setting"), false);
});

test("property validation rejects dangerous world names and invalid ranges", () => {
  assert.throws(() => validatePropertyValues({ "level-name": "../world" }), /World folder name/);
  assert.throws(() => validatePropertyValues({ "server-port": 70000 }), /between 1 and 65535/);
  assert.throws(() => validatePropertyValues({ gamemode: "invalid" }), /unsupported value/);
});

test("property schemas and presets respect the Minecraft version", () => {
  assert.equal(propertySchemaForVersion("1.17.1").some((item) => item.key === "simulation-distance"), false);
  const model = buildPropertiesModel("motd=Old\n", true, "1.17.1");
  assert.equal(model.presets.every((preset) => !Object.hasOwn(preset.values, "simulation-distance")), true);
  assert.equal(model.minecraftVersion, "1.17.1");
});

test("new property models keep the player allowlist disabled by default", () => {
  const model = buildPropertiesModel("# new server\n", false, "1.21.11");
  assert.equal(model.values["white-list"], false);
});

test("new server properties apply an optional seed and keep the allowlist off", () => {
  const seeded = parseProperties(buildInitialServerProperties("motd=Hello\nwhite-list=true\n", "BlockHost seed = 42"));
  assert.equal(seeded.values["white-list"], "false");
  assert.equal(seeded.values["enforce-whitelist"], "false");
  assert.equal(seeded.values["level-seed"], "BlockHost seed = 42");

  const random = parseProperties(buildInitialServerProperties("motd=Hello\n", ""));
  assert.equal(Object.hasOwn(random.values, "level-seed"), false);
  assert.throws(() => buildInitialServerProperties("", "bad\nseed"), /one line/);
});

test("prepared imports retain access settings and publisher installs disable remote administration", () => {
  const existing = "white-list=true\nenforce-whitelist=true\nonline-mode=false\nenable-rcon=true\nrcon.password=publisher\n";
  const prepared = parseProperties(buildInitialServerProperties(existing, "", {}, "1.20.1", { preserveAccess: true }));
  assert.equal(prepared.values["white-list"], "true");
  assert.equal(prepared.values["enforce-whitelist"], "true");
  const online = parseProperties(buildInitialServerProperties(existing, "", {}, "1.20.1", { publisherPack: true }));
  assert.equal(online.values["online-mode"], "true");
  assert.equal(online.values["enable-rcon"], "false");
  assert.equal(online.values["rcon.password"], "");
});

test("raw editor validates known values and preserves unknown lines", () => {
  assert.throws(() => validateRawPropertiesText("server-port=70000\n"), /between 1 and 65535/);
  const raw = buildPropertiesText("", { mode: "raw", rawText: "# expert\nfuture-setting=yes" });
  assert.equal(raw, "# expert\nfuture-setting=yes\n");
});

test("saving creates a backup and rollback restores the previous properties", () => {
  const folder = fs.mkdtempSync(path.join(process.cwd(), ".test-tmp-properties-"));
  try {
    const file = path.join(folder, "server.properties");
    fs.writeFileSync(file, "# original\nmotd=Before\ncustom=value\n", "utf8");
    const model = loadServerProperties(folder);
    const saved = saveServerProperties(folder, {
      values: { ...model.values, motd: "After" },
      customProperties: model.customProperties,
    });
    assert.equal(parseProperties(fs.readFileSync(file, "utf8")).values.motd, "After");
    assert.equal(fs.existsSync(`${file}.blockhost-backup`), true);
    rollbackServerProperties(saved.transaction);
    assert.equal(fs.readFileSync(file, "utf8"), "# original\nmotd=Before\ncustom=value\n");
    commitFileBackup(saved.transaction);
    assert.equal(fs.existsSync(`${file}.blockhost-backup`), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
