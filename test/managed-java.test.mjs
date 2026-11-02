import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yazl from "yazl";
import { cleanupManagedJavaArtifacts, findJavaExecutable, installManagedJava, isManagedJavaReady } from "../src/lib/managed-java.mjs";

function zipBuffer(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    for (const [name, contents] of entries) zip.addBuffer(Buffer.from(contents), name);
    zip.end();
  });
}

test("managed Java installation verifies and activates an app-private runtime", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blockhost-java-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = await zipBuffer([
    ["jdk-21/bin/java.exe", "test-java"],
    ["jdk-21/legal/java.base/LICENSE", "Temurin test fixture"],
  ]);
  const checksum = crypto.createHash("sha256").update(archive).digest("hex");
  let request = 0;
  const fetchImpl = async () => {
    request += 1;
    if (request === 1) {
      return new Response(JSON.stringify([{ binary: { package: {
        link: "https://github.com/adoptium/test-runtime.zip",
        checksum,
        size: archive.length,
      } } }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(archive, { status: 200 });
  };
  let validated = "";
  const result = await installManagedJava({
    runtimeRoot: root,
    javaVersion: 21,
    fetchImpl,
    validateJava: async (executable) => { validated = executable; },
  });
  assert.equal(request, 2);
  assert.equal(result.executable, path.join(root, "java-21", "jdk-21", "bin", "java.exe"));
  assert.equal(validated.endsWith(path.join("bin", "java.exe")), true);
  assert.equal(findJavaExecutable(path.join(root, "java-21"), "win32"), result.executable);
  assert.equal(isManagedJavaReady(path.join(root, "java-21")), true);
  assert.equal(fs.readFileSync(result.executable, "utf8"), "test-java");
  assert.deepEqual(fs.readdirSync(root), ["java-21"]);
});

test("managed Java cleanup removes abandoned 1.0.2 staging data in the background", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blockhost-java-cleanup-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".java-install-12345678-1234-1234-1234-123456789abc", "jdk", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".java-download-12345678-1234-1234-1234-123456789abc.zip"), "partial");
  fs.mkdirSync(path.join(root, "java-21"), { recursive: true });
  fs.writeFileSync(path.join(root, "java-21", ".blockhost-java-ready"), "ready");
  await cleanupManagedJavaArtifacts(root);
  assert.deepEqual(fs.readdirSync(root), ["java-21"]);
});

test("managed Java installation rejects a bad published checksum without exposing a runtime", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blockhost-java-bad-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = await zipBuffer([["jdk-21/bin/java.exe", "test-java"]]);
  let request = 0;
  const fetchImpl = async () => {
    request += 1;
    if (request === 1) {
      return new Response(JSON.stringify([{ binary: { package: {
        link: "https://github.com/adoptium/test-runtime.zip",
        checksum: "0".repeat(64),
        size: archive.length,
      } } }]), { status: 200 });
    }
    return new Response(archive, { status: 200 });
  };
  await assert.rejects(() => installManagedJava({ runtimeRoot: root, javaVersion: 21, fetchImpl }), /SHA-256 verification/);
  assert.equal(findJavaExecutable(path.join(root, "java-21"), "win32"), "");
  assert.equal(isManagedJavaReady(path.join(root, "java-21")), false);
  assert.deepEqual(fs.readdirSync(root), []);
});
