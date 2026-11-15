import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const stableVersion = /^\d+\.\d+\.\d+$/;

const signatureScript = Buffer.from(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$file = Get-Item -LiteralPath $env:BLOCKHOST_UPDATE_INSTALLER
$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
[pscustomobject]@{
  status = [string] $signature.Status
  type = [string] $signature.SignatureType
  subject = $signature.SignerCertificate.Subject
  version = $file.VersionInfo.ProductVersion
  product = $file.VersionInfo.ProductName
} | ConvertTo-Json -Compress
`, "utf16le").toString("base64");

export async function verifyWindowsInstaller(file, publisher, version, execute = run) {
  const powershellDirectory = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
  const powershell = path.join(powershellDirectory, "powershell.exe");
  const { stdout } = await execute(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", signatureScript], {
    env: { ...process.env, PSModulePath: path.join(powershellDirectory, "Modules"), BLOCKHOST_UPDATE_INSTALLER: file },
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16_384,
  });
  const result = JSON.parse(stdout.trim());
  if (result.status !== "Valid" || result.type !== "Authenticode" || result.product !== "BlockHost Manager"
    || result.subject?.trim().toLowerCase() !== publisher.trim().toLowerCase()
    || (version && result.version !== version)) {
    throw new Error("The installer signature, publisher, or version could not be verified.");
  }
}

export function createAppUpdates({ updater, publisher, version, notify, canRestart, install, onError, verify = verifyWindowsInstaller }) {
  let state = { version, status: updater ? "idle" : "unavailable" };
  let downloaded;
  let work;
  const snapshot = () => ({ ...state });
  const set = (status, fields = {}) => {
    state = { version, status, ...fields };
    notify(snapshot());
  };
  const fail = error => {
    downloaded = undefined;
    onError(error);
    set("error");
  };

  if (updater) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    // The bundled v6 verifier can skip verification when PowerShell fails.
    updater.verifyUpdateCodeSignature = async (_names, file) => {
      try {
        await verify(file, publisher);
        return null;
      } catch {
        return "BlockHost could not verify the signed installer.";
      }
    };
    updater.on("update-not-available", () => set("current"));
    updater.on("update-available", info => set("downloading", { availableVersion: info.version, percent: 0 }));
    updater.on("download-progress", progress => {
      const percent = Math.max(0, Math.min(100, Math.floor(Number(progress.percent) || 0)));
      if (state.status === "downloading" && state.percent !== percent) {
        set("downloading", { availableVersion: state.availableVersion, percent });
      }
    });
    updater.on("update-downloaded", info => {
      if (!stableVersion.test(info.version) || !path.win32.isAbsolute(info.downloadedFile || "")) {
        fail(new Error("The downloaded release has invalid metadata."));
        return;
      }
      downloaded = { file: info.downloadedFile, version: info.version };
      set("ready", { availableVersion: info.version });
    });
    updater.on("error", fail);
  }

  return {
    snapshot,
    async check() {
      if (!updater || work || downloaded) return snapshot();
      set("checking");
      work = Promise.resolve().then(async () => {
        const result = await updater.checkForUpdates();
        if (result?.downloadPromise) await result.downloadPromise;
        if (state.status === "checking") set("current");
      });
      try {
        await work;
      } catch (error) {
        if (state.status !== "error") fail(error);
      } finally {
        work = null;
      }
      return snapshot();
    },
    async restart() {
      if (state.status !== "ready" || !downloaded) return snapshot();
      const blocked = canRestart();
      if (blocked) return { ...snapshot(), message: blocked };
      set("verifying", { availableVersion: downloaded.version });
      try {
        await verify(downloaded.file, publisher, downloaded.version);
      } catch (error) {
        downloaded = undefined;
        fail(error);
        return snapshot();
      }
      const stillBlocked = canRestart();
      if (stillBlocked) {
        set("ready", { availableVersion: downloaded.version });
        return { ...snapshot(), message: stillBlocked };
      }
      set("installing", { availableVersion: downloaded.version });
      try {
        install();
      } catch (error) {
        downloaded = undefined;
        fail(error);
      }
      return snapshot();
    },
  };
}
