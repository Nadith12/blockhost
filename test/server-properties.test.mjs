import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
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
