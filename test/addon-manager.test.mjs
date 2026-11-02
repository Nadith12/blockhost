import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yazl from "yazl";
import {
  commitAddonTransaction,
  getAddonProfile,
  installManualAddon,
  installModrinthAddon,
  inspectAddonJar,
  listServerAddons,
  removeAddon,
  rollbackAddonTransaction,
  searchCompatibleAddons,
  recommendCompatibleAddons,
  setAddonEnabled,
} from "../src/lib/addon-manager.mjs";

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

test("recommendations use server-only download rankings without a search query", async () => {
  const { server, cleanup } = fixture("fabric");
  try {
    let requested;
    const result = await recommendCompatibleAddons(server, async (url) => {
      requested = new URL(url);
      return jsonResponse({ hits: [
        { project_id: "safe", title: "Recommended", downloads: 9000, icon_url: "https://cdn.modrinth.com/data/safe/icon.png" },
        { project_id: "unsafe", title: "Unsafe icon", downloads: 8000, icon_url: "https://example.com/icon.png" },
      ] });
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
