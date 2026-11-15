import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build as buildVite } from "vite";
import builder from "electron-builder";
import { verifyWindowsInstaller } from "../src/lib/app-updates.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = require("../package.json");
const preview = process.argv.includes("--preview");
const publisher = process.env.BLOCKHOST_WINDOWS_PUBLISHER?.trim();
const thumbprint = process.env.BLOCKHOST_WINDOWS_CERT_THUMBPRINT?.replace(/\s/g, "");
const releaseRepository = process.env.BLOCKHOST_RELEASE_REPOSITORY?.trim() || "Nadith12/blockhost";
if (process.platform !== "win32") throw new Error("Build the Windows installer on Windows.");
if (!preview && !publisher) {
  throw new Error("Set BLOCKHOST_WINDOWS_PUBLISHER to the code-signing certificate subject. Use --preview for a local unsigned build.");
}
if (thumbprint && !/^[a-f\d]{40}$/i.test(thumbprint)) throw new Error("Use the 40-digit Windows signing certificate thumbprint.");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Use a stable Major.Minor.Patch version.");
if (!/^[\w-]+\/[\w.-]+$/.test(releaseRepository)) throw new Error("Use a GitHub release repository in owner/repository format.");
const [owner, repo] = releaseRepository.split("/");

const output = path.join(root, "out", preview ? "windows-preview" : "windows-release", manifest.version);
const scratch = path.join(output, "build");
const appBuild = path.join(scratch, ".vite", "build");
const appRenderer = path.join(scratch, ".vite", "renderer", "main_window");
const external = ["electron", /^node:/, ...builtinModules];
await Promise.all([
  buildVite({
    root, configFile: path.join(root, "vite.main.config.mjs"),
    define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined", MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window") },
    build: {
      outDir: path.join(appBuild, "main"), emptyOutDir: true, copyPublicDir: false,
      lib: { entry: path.join(root, "src/main.js"), formats: ["cjs"], fileName: () => "main.js" },
      rollupOptions: { external },
    },
  }),
  buildVite({
    root, configFile: path.join(root, "vite.preload.config.mjs"),
    build: {
      outDir: path.join(appBuild, "preload"), emptyOutDir: true, copyPublicDir: false,
      lib: { entry: path.join(root, "src/preload.js"), formats: ["cjs"], fileName: () => "preload.js" },
      rollupOptions: { external },
    },
  }),
  buildVite({
    root, configFile: path.join(root, "vite.renderer.config.mjs"), base: "./",
    build: { outDir: appRenderer, emptyOutDir: true },
  }),
]);

const extraResources = ["app-icon.png", "app-icon-32.png"].map(name => ({ from: path.join(root, "assets", name), to: name }));
if (!preview) {
  const identity = path.join(scratch, "blockhost-release.json");
  await fs.writeFile(identity, JSON.stringify({ publisher }), "utf8");
  extraResources.push({ from: identity, to: "blockhost-release.json" });
}
if (preview) process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

const installer = preview ? "BlockHostSetup-x64-preview.exe" : "BlockHostSetup-x64.exe";
const productName = preview ? "BlockHost Manager Preview" : manifest.productName;
const { Platform, Arch } = builder;
await builder.build({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
  publish: "never",
  config: {
    appId: preview ? "com.blockhost.manager.preview" : "com.blockhost.manager",
    productName,
    extraMetadata: preview ? { productName, name: "blockhost-manager-preview" } : undefined,
    electronVersion: manifest.devDependencies.electron,
    electronDist: process.env.BLOCKHOST_ELECTRON_DIST || undefined,
    directories: { output },
    asar: true,
    files: [
      "package.json",
      { from: path.join(appBuild, "main"), to: ".vite/build", filter: ["main.js"] },
      { from: path.join(appBuild, "preload"), to: ".vite/build", filter: ["preload.js"] },
      { from: appRenderer, to: ".vite/renderer/main_window" },
    ],
    extraResources,
    forceCodeSigning: !preview,
    publish: preview ? null : [{ provider: "github", owner, repo, releaseType: "release" }],
    win: {
      icon: "assets/app-icon.ico",
      ...(preview ? {} : { signtoolOptions: { publisherName: publisher, certificateSha1: thumbprint } }),
    },
    nsis: {
      artifactName: installer,
      oneClick: true,
      perMachine: false,
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,
    },
  },
});

const installerPath = path.join(output, installer);
if (!preview) {
  await verifyWindowsInstaller(installerPath, publisher, manifest.version);
  await verifyWindowsInstaller(path.join(output, "win-unpacked", `${manifest.productName}.exe`), publisher);
  await fs.access(path.join(output, "latest.yml"));
}
const hash = createHash("sha256");
for await (const chunk of createReadStream(installerPath)) hash.update(chunk);
await fs.writeFile(path.join(output, "SHA256SUMS.txt"), `${hash.digest("hex")}  ${installer}\n`, "utf8");
console.log(installerPath);
