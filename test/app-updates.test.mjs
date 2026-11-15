import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { createAppUpdates, verifyWindowsInstaller } from "../src/lib/app-updates.mjs";

const publisher = "CN=BlockHost Test";
const installer = "C:\\BlockHost Test\\BlockHostSetup-x64.exe";

function fixture(options = {}) {
  const updater = new EventEmitter();
  const reports = [];
  const errors = [];
  let installed = 0;
  updater.checkForUpdates = async () => {
    updater.emit("update-available", { version: "2.1.0" });
    updater.emit("download-progress", { percent: 53.4 });
    updater.emit("update-downloaded", { version: "2.1.0", downloadedFile: installer });
  };
  const manager = createAppUpdates({
    updater, publisher, version: "2.0.0", notify: report => reports.push(report),
    onError: error => errors.push(error), canRestart: () => "", verify: async () => {},
    install: () => { installed += 1; }, ...options,
  });
  return { manager, updater, reports, errors, installed: () => installed };
}

test("a download can become ready but only an explicit idle restart installs it", async () => {
  let busy = "Stop the server first.";
  const verified = [];
  const { manager, updater, reports, installed } = fixture({
    canRestart: () => busy,
    verify: async (...args) => { verified.push(args); },
  });
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  const result = await manager.check();
  assert.equal(result.status, "ready");
  assert.ok(reports.some(report => report.percent === 53));
  assert.equal((await manager.restart()).message, busy);
  assert.equal(installed(), 0);
  busy = "";
  assert.equal((await manager.restart()).status, "installing");
  assert.deepEqual(verified, [[installer, publisher, "2.1.0"]]);
  assert.equal(installed(), 1);
  await manager.restart();
  assert.equal(installed(), 1);
});

test("restart rechecks server activity after verifying the cached installer", async () => {
  let blocked = false;
  const { manager, installed } = fixture({
    canRestart: () => blocked ? "Backup in progress." : "",
    verify: async () => { blocked = true; },
  });
  await manager.check();
  assert.equal((await manager.restart()).message, "Backup in progress.");
  assert.equal(manager.snapshot().status, "ready");
  assert.equal(installed(), 0);
});

test("verifier errors and a substituted cached installer prevent installation", async () => {
  const { manager, updater, installed, errors } = fixture({
    verify: async () => { throw new Error("verification failed"); },
  });
  assert.match(await updater.verifyUpdateCodeSignature([publisher], installer), /could not verify/);
  await manager.check();
  assert.equal((await manager.restart()).status, "error");
  assert.equal(installed(), 0);
  assert.equal(errors.length, 1);
  assert.equal((await manager.check()).status, "ready");
});

test("Windows verification rejects unsigned, wrong publisher, catalog and wrong-version files", async () => {
  const signed = { status: "Valid", type: "Authenticode", subject: publisher, version: "2.1.0", product: "BlockHost Manager" };
  const check = result => verifyWindowsInstaller(installer, publisher, "2.1.0", async (_file, _args, options) => {
    assert.equal(options.env.BLOCKHOST_UPDATE_INSTALLER, installer);
    return { stdout: JSON.stringify(result) };
  });
  await check(signed);
  for (const change of [
    { status: "NotSigned" }, { subject: "CN=Different Publisher" }, { type: "Catalog" }, { version: "2.0.0" }, { product: "Another App" },
  ]) await assert.rejects(check({ ...signed, ...change }), /could not be verified/);
});
