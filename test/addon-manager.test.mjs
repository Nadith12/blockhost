import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yazl from "yazl";
import {
  cleanupAbandonedAddonTransactions,
  commitAddonTransaction,
  describeLocalInstalledAddons,
  findBundledPackDependency,
  getAddonProfile,
  identifyInstalledAddons,
  installManualAddon,
  installModrinthAddon,
  inspectAddonJar,
  listServerAddons,
  recordModpackInventory,
  removeAddon,
  rollbackAddonTransaction,
  scanServerAddons,
  searchCompatibleAddons,
  recommendCompatibleAddons,
  setAddonEnabled,
} from "../src/lib/addon-manager.mjs";
import { clientModList } from "../src/lib/addon-sides.mjs";

function fixture(type = "fabric") {
  const folderPath = fs.mkdtempSync(path.join(process.cwd(), ".test-tmp-addons-"));
  return {
    folderPath,
    server: { id: 101, name: "Test", type, typeLabel: type, version: "1.21.1", folderPath },
    cleanup: () => fs.rmSync(folderPath, { recursive: true, force: true }),
  };
}

function jarBuffer(label) {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(label)]);
}

function validEmptyJar() {
  return Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64");
}

test("previously installed CurseForge mods retain local dependency controls", t => {
  const { folderPath, server, cleanup } = fixture();
  t.after(cleanup);
  const mods = path.join(folderPath, "mods");
  fs.mkdirSync(mods);
  for (const fileName of ["base.jar", "extension.jar"]) {
    fs.writeFileSync(path.join(mods, fileName), validEmptyJar());
  }
  fs.writeFileSync(path.join(folderPath, "addons-lock.json"), JSON.stringify({ entries: [
    { id: "curseforge:10", source: "curseforge", projectId: "10", fileName: "base.jar" },
    { id: "curseforge:11", source: "curseforge", projectId: "11", fileName: "extension.jar", dependencies: ["curseforge:10"] },
  ] }));
  const listing = listServerAddons(server);
  assert.deepEqual(listing.items.find(item => item.id === "curseforge:10").dependents.map(item => item.id), ["curseforge:11"]);
  const change = setAddonEnabled(server, "curseforge:10", false, { cascade: true });
  commitAddonTransaction(change.transaction);
  assert.equal(listServerAddons(server).items.every(item => !item.enabled), true);
});

test("abandoned add-on recovery rejects paths outside the server and restores a valid toggle", t => {
  const { folderPath, server, cleanup } = fixture();
  t.after(cleanup);
  const serversRoot = path.join(folderPath, "servers");
  server.folderPath = path.join(serversRoot, "pack");
  const mods = path.join(server.folderPath, "mods");
  fs.mkdirSync(mods, { recursive: true });
  const jar = path.join(mods, "bundled.jar");
  const outside = path.join(folderPath, "outside.jar");
  fs.writeFileSync(jar, validEmptyJar());
  fs.writeFileSync(outside, "untouched");
  const addon = listServerAddons(server).items[0];
  setAddonEnabled(server, addon.id, false);
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(server.folderPath, `.blockhost-addon-journal-${id}.json`), JSON.stringify({
    id, previousLockExisted: false, previousLockText: "", newFiles: [outside], renames: [], backups: [],
  }));
  assert.deepEqual(cleanupAbandonedAddonTransactions(serversRoot), [server.folderPath]);
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
  assert.equal(fs.existsSync(jar), true);
  assert.equal(fs.existsSync(jar + ".disabled"), false);
});

function createJar(filePath, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(filePath);
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
    for (const [name, value] of entries) zip.addBuffer(Buffer.from(value), name);
    zip.end();
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fileResponse(buffer) {
  return new Response(buffer, {
    status: 200,
    headers: { "content-length": String(buffer.length) },
  });
}

function version({ id, projectId, fileName, buffer, dependencies = [] }) {
  return {
    id,
    project_id: projectId,
    version_number: "1.0.0",
    version_type: "release",
    status: "listed",
    game_versions: ["1.21.1"],
    loaders: ["fabric"],
    dependencies,
    files: [{
      filename: fileName,
      primary: true,
      size: buffer.length,
      url: `https://cdn.modrinth.com/data/${projectId}/versions/${id}/${fileName}`,
      hashes: { sha512: crypto.createHash("sha512").update(buffer).digest("hex") },
    }],
  };
}

test("add-on profiles distinguish mods, Paper plugins, and unsupported Vanilla", () => {
  assert.deepEqual(getAddonProfile({ type: "paper" }).kind, "plugins");
  assert.equal(getAddonProfile({ type: "neoforge" }).loader, "neoforge");
  assert.equal(getAddonProfile({ type: "vanilla" }).supported, false);
});

test("a repair can identify one disabled publisher JAR from loader metadata", async t => {
  const { server, folderPath, cleanup } = fixture();
  t.after(cleanup);
  server.modpack = { name: "Bundled pack", version: "1" };
  server.modpackSetup = { status: "repair", diagnosis: {
    kind: "dependency", requirements: [{ kind: "missing", modId: "modmenu", version: "any version" }],
  } };
  const mods = path.join(folderPath, "mods");
  fs.mkdirSync(mods);
  const mod = (id, version, name = id) => [["fabric.mod.json", JSON.stringify({ id, version, name, environment: "client" })]];
  const disabled = path.join(mods, "publisher-name.jar.disabled");
  await createJar(disabled, mod("modmenu", "7.2.2", "Mod Menu"));
  await createJar(path.join(mods, "modmenu.jar.disabled"), mod("othermod", "7.2.2"));
  recordModpackInventory(folderPath, { name: server.modpack.name, packVersion: server.modpack.version, type: server.type });
  await createJar(path.join(mods, "manually-added.jar.disabled"), mod("modmenu", "8.0.0"));
  const candidate = await findBundledPackDependency(server);
  assert.equal(candidate.name, "Mod Menu");
  assert.deepEqual((await describeLocalInstalledAddons(server)).bundledDependency, { modId: "modmenu", name: "Mod Menu" });

  const { transaction } = setAddonEnabled(server, candidate.id, true);
  assert.equal(fs.existsSync(disabled), false);
  assert.equal(fs.existsSync(path.join(mods, "publisher-name.jar")), true);
  rollbackAddonTransaction(transaction);
  assert.equal(fs.existsSync(disabled), true);
  assert.equal(fs.existsSync(path.join(mods, "publisher-name.jar")), false);

  const [requirement] = server.modpackSetup.diagnosis.requirements;
  requirement.version = "version 8.0.0";
  assert.equal(await findBundledPackDependency(server), null);
  requirement.version = "version 7.2.2";
  assert.equal((await findBundledPackDependency(server)).id, candidate.id);
  requirement.version = "any version";
  recordModpackInventory(folderPath, { name: server.modpack.name, packVersion: server.modpack.version, type: server.type });
  assert.equal(await findBundledPackDependency(server), null);
});

test("existing mods are classified from their release or JAR, with unverified requirements kept separate", async () => {
  const { server, folderPath, cleanup } = fixture("fabric");
  try {
    const mods = path.join(folderPath, "mods");
    fs.mkdirSync(mods);
    for (const [name, environment] of [["Both.jar", "*"], ["Server.jar", "server"], ["Disabled.jar.disabled", "*"]]) {
      await createJar(path.join(mods, name), [["fabric.mod.json", JSON.stringify({ name, environment })]]);
    }
    fs.writeFileSync(path.join(mods, "Required.jar"), jarBuffer("required"));
    fs.writeFileSync(path.join(folderPath, "addons-lock.json"), JSON.stringify({ entries: [
      { fileName: "Required.jar", source: "modrinth", projectId: "project1", versionId: "release1", enabled: true },
    ] }));
    const listing = await describeLocalInstalledAddons(server);
    const patches = await identifyInstalledAddons(server, listing, { fetchImpl: async (url) => {
      switch (new URL(url).pathname) {
        case "/v2/version_files": return jsonResponse({});
        case "/v2/versions": return jsonResponse([{ id: "release1", project_id: "project1", environment: "client_and_server" }]);
        case "/v2/projects": return jsonResponse([{ id: "project1", icon_url: "https://cdn.modrinth.com/data/project1/icon.png" }]);
        default: assert.fail(url);
      }
    } });
    assert.equal(patches.length, 1);
    assert.equal(patches[0].environment, "client_and_server");
    assert.match(patches[0].iconUrl, /project1\/icon\.png$/);
    listing.items.find((item) => item.id === patches[0].id).environment = patches[0].environment;
    assert.equal(listing.items.find((item) => item.fileName === "Server.jar").environment, "dedicated_server_only");
    assert.deepEqual(clientModList(listing.items).map(([heading, items]) => [heading, items.map((item) => item.fileName)]), [
      ["Required on clients", ["Required.jar"]],
      ["Check with the mod author", ["Both.jar"]],
    ]);
  } finally { cleanup(); }
});

test("installed mods use local metadata across enabled and disabled files", async () => {
  const { server, folderPath, cleanup } = fixture("forge");
  try {
    const mods = path.join(folderPath, "mods");
    const lock = path.join(folderPath, "addons-lock.json");
    fs.mkdirSync(mods);
    const toml = [
      "[[mods]]",
      'modId = "example"',
      'displayName = "Example\'s Mod" # display title',
      'version = "${file.jarVersion}"',
      'logoFile = "logo.png"',
      'description = """',
      '[[dependencies.example]]',
      'modId = "minecraft"',
      'versionRange = "[0]"',
      '"""',
      '[[dependencies.other_mod]]',
      'modId = "minecraft"',
      'versionRange = "[1.19]"',
      '[[dependencies."example"]] # actual dependency',
      'modId = "minecraft"',
      'versionRange = "[1.20.1,1.21)"',
      'side = "BOTH"',
    ].join("\n");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2R8AAAAASUVORK5CYII=", "base64");
    const jar = path.join(mods, "example-release.jar");
    await createJar(jar, [
      ["fabric.mod.json", JSON.stringify({ name: "Fabric title", version: "3.0", environment: "client" })],
      ["META-INF/mods.toml", toml],
      ["META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nImplementation-Version: 2.0.\r\n 0\r\n\r\n"],
      ["logo.png", png],
    ]);
    fs.writeFileSync(path.join(mods, "unreadable.jar"), jarBuffer("not a zip"));

    const quick = await scanServerAddons(server);
    assert.equal(quick.items[0].fileName, "example-release.jar");
    assert.equal(quick.items[0].iconUrl, "");
    const listing = await describeLocalInstalledAddons(server, quick);
    const [example, unreadable] = listing.items;
    assert.equal(example.title, "Example's Mod");
    assert.equal(example.versionNumber, "2.0.0");
    assert.equal(example.loader, "forge");
    assert.equal(example.minecraftVersion, "[1.20.1,1.21)");
    assert.equal(example.environment, "");
    assert.equal(example.managed, false);
    assert.equal(example.projectId, null);
    assert.equal(example.iconUrl, `data:image/png;base64,${png.toString("base64")}`);
    assert.equal(unreadable.loader, "unknown");
    assert.equal(fs.existsSync(lock), false);

    const disabled = setAddonEnabled(server, example.id, false);
    commitAddonTransaction(disabled.transaction);
    const refreshed = (await describeLocalInstalledAddons(server)).items[0];
    assert.equal(refreshed.id, example.id);
    assert.equal(refreshed.enabled, false);
    assert.equal(refreshed.title, example.title);
    assert.equal(refreshed.versionNumber, example.versionNumber);
    assert.equal(refreshed.minecraftVersion, example.minecraftVersion);
    assert.equal(refreshed.iconUrl, example.iconUrl);
    await createJar(`${jar}.disabled`, [["META-INF/mods.toml", toml.replace('logoFile = "logo.png"', 'logoFile = "missing.png"')]]);
    const replaced = (await describeLocalInstalledAddons(server)).items[0];
    assert.equal(replaced.iconUrl, "");
    assert.notEqual(replaced.sha512, example.sha512);
  } finally {
    cleanup();
  }
});

test("Modrinth identifies renamed JARs by their exact digest without adopting them", async () => {
  const { server, folderPath, cleanup } = fixture();
  try {
    const mods = path.join(folderPath, "mods");
    fs.mkdirSync(mods);
    fs.writeFileSync(path.join(mods, "renamed.jar.disabled"), jarBuffer("exact match fixture"));
    fs.writeFileSync(path.join(mods, "repacked.jar"), jarBuffer("different bytes"));
    const listing = await scanServerAddons(server);
    const [renamed, repacked] = ["renamed.jar", "repacked.jar"].map((fileName) => listing.items.find((item) => item.fileName === fileName));
    const requests = [];
    const options = { fetchImpl: async (url, request) => {
      const route = new URL(url).pathname;
      requests.push(route);
      if (route === "/v2/version_files") {
        const body = JSON.parse(request.body);
        assert.equal(body.algorithm, "sha512");
        assert.deepEqual(body.hashes.toSorted(), [renamed.sha512, repacked.sha512].toSorted());
        const release = { id: "identified-release", project_id: "identified-project", version_number: "2.3.4", loaders: ["fabric"],
          game_versions: ["1.21.1"], environment: "dedicated_server_only", files: [{ hashes: { sha512: renamed.sha512 } }] };
        return jsonResponse({ [renamed.sha512]: release, [repacked.sha512]: release });
      }
      if (route === "/v2/projects") return jsonResponse([{ id: "identified-project", title: "Catalogue Title", icon_url: "https://cdn.modrinth.com/data/identified-project/logo.png" }]);
      assert.fail(url);
    } };
    const patches = await identifyInstalledAddons(server, listing, options);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].id, renamed.id);
    assert.equal(patches[0].enabled, false);
    assert.deepEqual(patches[0].catalogue, { source: "modrinth", projectId: "identified-project", versionId: "identified-release" });
    assert.equal(patches[0].title, "Catalogue Title");
    assert.equal(patches[0].iconUrl, "https://cdn.modrinth.com/data/identified-project/logo.png");
    assert.deepEqual(await identifyInstalledAddons(server, listing, options), patches);
    assert.deepEqual(requests, ["/v2/version_files", "/v2/projects"]);
    assert.equal(fs.existsSync(path.join(folderPath, "addons-lock.json")), false);
  } finally { cleanup(); }
});

test("search uses exact loader, game version, server environment, and identifying user agent", async () => {
  const { server, cleanup } = fixture("fabric");
  try {
    let requested;
    const result = await searchCompatibleAddons(server, "map", async (url, options) => {
      requested = { url: new URL(url), options };
      return jsonResponse({ hits: [{ project_id: "root", title: "Map Mod", description: "A map", author: "author", downloads: 1000, icon_url: "https://cdn.modrinth.com/data/root/icon.png" }] });
    });
    assert.equal(result.results[0].title, "Map Mod");
    const facets = JSON.parse(requested.url.searchParams.get("facets"));
    assert.ok(facets.some((group) => group.includes("categories:fabric")));
    assert.ok(facets.some((group) => group.includes("versions:1.21.1")));
    assert.ok(facets.some((group) => group.includes("environment:server_only")));
    assert.equal(result.results[0].iconUrl, "https://cdn.modrinth.com/data/root/icon.png");
    assert.match(requested.options.headers["User-Agent"], /BlockHost-Manager/);
  } finally {
    cleanup();
  }
});

test("browse supports purpose categories and sorting without requiring a query", async () => {
  const { server, cleanup } = fixture("fabric");
  try {
    let requested;
    const result = await searchCompatibleAddons(server, "", { category: "performance", sort: "updated" }, async (url) => {
      requested = new URL(url);
      return jsonResponse({ hits: [] });
    });
    const facets = JSON.parse(requested.searchParams.get("facets"));
    assert.ok(facets.some((group) => group.includes("categories:optimization")));
    assert.equal(requested.searchParams.has("query"), false);
    assert.equal(requested.searchParams.get("index"), "updated");
    assert.equal(result.category, "performance");
    assert.equal(result.sort, "updated");
  } finally {
    cleanup();
  }
});

test("recommendations use server-only download rankings without a search query", async () => {
  const { server, cleanup } = fixture("fabric");
  try {
    let requested;
    const stableJar = jarBuffer("stable");
    const safeVersion = version({ id: "safe-release", projectId: "safe", fileName: "safe.jar", buffer: stableJar });
    const unsafeVersion = version({ id: "unsafe-release", projectId: "unsafe", fileName: "unsafe.jar", buffer: stableJar });
    const betaVersion = { ...version({ id: "beta-release", projectId: "beta-only", fileName: "beta.jar", buffer: stableJar }), version_type: "beta" };
    const result = await recommendCompatibleAddons(server, async (url) => {
      const requestedUrl = new URL(url);
      if (requestedUrl.pathname.endsWith("/search")) {
        requested = requestedUrl;
        return jsonResponse({ hits: [
          { project_id: "safe", title: "Recommended", downloads: 9000, icon_url: "https://cdn.modrinth.com/data/safe/icon.png" },
          { project_id: "unsafe", title: "Unsafe icon", downloads: 8000, icon_url: "https://example.com/icon.png" },
          { project_id: "beta-only", title: "Beta only", downloads: 7000, icon_url: "" },
        ] });
      }
      if (requestedUrl.pathname.includes("/project/safe/version")) return jsonResponse([safeVersion]);
      if (requestedUrl.pathname.includes("/project/unsafe/version")) return jsonResponse([unsafeVersion]);
      if (requestedUrl.pathname.includes("/project/beta-only/version")) return jsonResponse([betaVersion]);
      throw new Error(`Unexpected URL ${url}`);
    });
    assert.equal(requested.searchParams.has("query"), false);
    assert.equal(requested.searchParams.get("index"), "downloads");
    const facets = JSON.parse(requested.searchParams.get("facets"));
    const environment = facets.find((group) => group.some((item) => item.startsWith("environment:")));
    assert.deepEqual(environment, [
      "environment:server_only",
      "environment:server_only_client_optional",
      "environment:dedicated_server_only",
    ]);
    assert.equal(result.results[0].iconUrl, "https://cdn.modrinth.com/data/safe/icon.png");
    assert.equal(result.results[1].iconUrl, "");
    assert.equal(result.results[0].versionId, "safe-release");
    assert.equal(result.results.some((item) => item.projectId === "beta-only"), false);
  } finally {
    cleanup();
  }
});

test("Modrinth installation resolves required dependencies, verifies hashes, and rolls back", async () => {
  const { server, folderPath, cleanup } = fixture("fabric");
  const rootJar = jarBuffer("root");
  const dependencyJar = jarBuffer("dependency");
  const rootVersion = version({
    id: "root-version",
    projectId: "root-project",
    fileName: "root.jar",
    buffer: rootJar,
    dependencies: [{ project_id: "dependency-project", version_id: "dependency-version", file_name: "dependency.jar", dependency_type: "required" }],
  });
  const dependencyVersion = version({
    id: "dependency-version",
    projectId: "dependency-project",
    fileName: "dependency.jar",
    buffer: dependencyJar,
  });
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/project/root-project/version?")) return jsonResponse([rootVersion]);
    if (value.endsWith("/version/dependency-version")) return jsonResponse(dependencyVersion);
    if (value.endsWith("/root.jar")) return fileResponse(rootJar);
    if (value.endsWith("/dependency.jar")) return fileResponse(dependencyJar);
    throw new Error(`Unexpected URL ${value}`);
  };

  try {
    const result = await installModrinthAddon(server, {
      projectId: "root-project",
      title: "Root Mod",
      iconUrl: "https://cdn.modrinth.com/data/root-project/icon.png",
    }, fetchImpl);
    assert.equal(result.installed, 2);
    assert.equal(fs.existsSync(path.join(folderPath, "mods", "root.jar")), true);
    assert.equal(fs.existsSync(path.join(folderPath, "mods", "dependency.jar")), true);
    const listing = listServerAddons(server);
    assert.equal(listing.items.length, 2);
    assert.equal(listing.items.find((item) => item.projectId === "root-project").iconUrl, "https://cdn.modrinth.com/data/root-project/icon.png");
    const dependency = listing.items.find((item) => item.projectId === "dependency-project");
    assert.throws(() => removeAddon(server, dependency.id), /required by/i);
    const cascaded = removeAddon(server, dependency.id, { cascade: true });
    assert.equal(cascaded.addons.items.length, 0);
    rollbackAddonTransaction(cascaded.transaction);
    assert.equal(listServerAddons(server).items.length, 2);

    rollbackAddonTransaction(result.transaction);
    assert.equal(fs.existsSync(path.join(folderPath, "mods", "root.jar")), false);
    assert.equal(fs.existsSync(path.join(folderPath, "addons-lock.json")), false);
  } finally {
    cleanup();
  }
});

test("a preflighted recommendation installs the exact verified release", async () => {
  const { server, folderPath, cleanup } = fixture("fabric");
  const rootJar = jarBuffer("recommended");
  const rootVersion = version({ id: "recommended-version", projectId: "recommended-project", fileName: "recommended.jar", buffer: rootJar });
  try {
    const result = await installModrinthAddon(server, {
      projectId: "recommended-project",
      versionId: "recommended-version",
      title: "Recommended Mod",
    }, async (url) => {
      const value = String(url);
      if (value.endsWith("/version/recommended-version")) return jsonResponse(rootVersion);
      if (value.endsWith("/recommended.jar")) return fileResponse(rootJar);
      throw new Error(`Unexpected URL ${value}`);
    });
    assert.equal(result.installed, 1);
    assert.equal(fs.existsSync(path.join(folderPath, "mods", "recommended.jar")), true);
  } finally {
    cleanup();
  }
});

test("manual add-ons can be disabled, restored by rollback, and removed transactionally", async () => {
  const { server, folderPath, cleanup } = fixture("paper");
  const source = path.join(folderPath, "source-plugin.jar");
  fs.writeFileSync(source, validEmptyJar());
  try {
    const installed = await installManualAddon(server, source);
    commitAddonTransaction(installed.transaction);
    let item = listServerAddons(server).items[0];
    assert.equal(item.enabled, true);

    const disabled = setAddonEnabled(server, item.id, false);
    item = disabled.addons.items[0];
    assert.equal(item.enabled, false);
    assert.equal(fs.existsSync(path.join(folderPath, "plugins", "source-plugin.jar.disabled")), true);
    rollbackAddonTransaction(disabled.transaction);
    assert.equal(listServerAddons(server).items[0].enabled, true);

    item = listServerAddons(server).items[0];
    const removed = removeAddon(server, item.id);
    assert.equal(removed.addons.items.length, 0);
    rollbackAddonTransaction(removed.transaction);
    assert.equal(listServerAddons(server).items.length, 1);
  } finally {
    cleanup();
  }
});

test("manual JAR inspection identifies loader metadata and blocks client-only or duplicate mods", async () => {
  const { server, folderPath, cleanup } = fixture("fabric");
  const clientJar = path.join(folderPath, "client.jar");
  const serverJar = path.join(folderPath, "server-mod.jar");
  const duplicateJar = path.join(folderPath, "same-mod.jar");
  try {
    await createJar(clientJar, [["fabric.mod.json", JSON.stringify({ id: "client", name: "Client Mod", version: "1.0.0", environment: "client" })]]);
    const inspected = await inspectAddonJar(clientJar);
    assert.equal(inspected.loader, "fabric");
    assert.equal(inspected.serverSide, "client");
    await assert.rejects(installManualAddon(server, clientJar), /client-only/);

    const metadata = JSON.stringify({ id: "server", name: "Server Mod", version: "2.0.0", environment: "server", depends: { minecraft: "1.21.1" } });
    await createJar(serverJar, [["fabric.mod.json", metadata]]);
    fs.copyFileSync(serverJar, duplicateJar);
    const installed = await installManualAddon(server, serverJar);
    commitAddonTransaction(installed.transaction);
    const item = listServerAddons(server).items[0];
    assert.equal(item.title, "Server Mod");
    assert.equal(item.versionNumber, "2.0.0");
    await assert.rejects(installManualAddon(server, duplicateJar), /exact JAR is already installed/);
  } finally {
    cleanup();
  }
});

test("a bad download hash changes no installed files", async () => {
  const { server, folderPath, cleanup } = fixture("fabric");
  const declared = jarBuffer("declared");
  const downloaded = jarBuffer("tampered");
  const rootVersion = version({ id: "bad-version", projectId: "bad-project", fileName: "bad.jar", buffer: declared });
  try {
    await assert.rejects(
      installModrinthAddon(server, { projectId: "bad-project", title: "Bad" }, async (url) => {
        if (String(url).includes("/project/bad-project/version?")) return jsonResponse([rootVersion]);
        return fileResponse(downloaded);
      }),
      /size did not match|verification/i
    );
    assert.equal(fs.existsSync(path.join(folderPath, "mods", "bad.jar")), false);
    assert.equal(fs.existsSync(path.join(folderPath, "addons-lock.json")), false);
  } finally {
    cleanup();
  }
});
