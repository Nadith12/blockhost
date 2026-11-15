# Windows installation and upgrades

## Install BlockHost

1. On the GitHub Releases page, download `BlockHostSetup-x64.exe` from the latest stable release. Check that Windows shows the publisher listed in the release notes.
2. Run the installer, then open **BlockHost Manager** from the Start menu. The installer uses the current Windows account. Java is selected when a supported server needs it.
3. Choose **New server** for a new Minecraft server, **Import server** to restore an existing server, or **Modpacks** to browse supported packs. Then open your server and choose **Start server**. If you and the server are on the same PC, use Minecraft Java Edition’s **Multiplayer → Direct Connection** and enter `localhost` for the default port. Add the port when it differs, such as `localhost:25566`.

Open **Settings → About and updates** to see the installed version or check manually. After a download, stop running servers normally and let backups or transfers finish before choosing **Restart to update**. The update replaces the application files and keeps server data. The Windows preview installer has its own application identity and profile for testing. The Microsoft Store manages upgrades for its edition.

## Prepare a release

- Build on Windows x64 using Node 24 and `npm ci`. Increment `package.json` and the lockfile together, then create a matching `vMAJOR.MINOR.PATCH` tag. Keep the product name and installer app ID stable so installed copies keep the same data and upgrade path.
- For local testing, run `npm run make:windows:preview`. The setup file appears under `out/windows-preview/<version>/`. Preview files are unsigned and have the application updater disabled.
- Set `BLOCKHOST_WINDOWS_PUBLISHER` to the exact certificate subject Windows reports. For a certificate in the Windows certificate store, set `BLOCKHOST_WINDOWS_CERT_THUMBPRINT` to its thumbprint. This supports local builds with providers that expose the signing key through Windows SignTool, including cloud key adapters and hardware tokens. Use `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object Subject,Thumbprint,NotAfter` to find the values after enrolling. Keep credentials in the signing provider or protected CI environment.
- The GitHub workflow supports the standard electron-builder `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` secrets for compatible signing providers. Certificate providers that keep the key in the cloud or on a hardware token may require their specific runner integration. Start with a signed local build and attach its files to a GitHub draft if needed.
- Run `npm run make:windows` locally with signing configured, or dispatch **Prepare Windows release** for the tag. The workflow creates a draft. The installer, blockmap, `latest.yml`, and `SHA256SUMS.txt` must stay together. The script verifies the installer and app executable against the configured signer before the workflow can upload them.
- The updater uses public GitHub Releases. If the source repo is private, set `BLOCKHOST_RELEASE_REPOSITORY` to a public distribution repo in `owner/repository` format before the first signed build. Create the version tag in that repo as well and configure its scoped release token as `BLOCKHOST_RELEASE_TOKEN` for the workflow. Public installers carry the selected feed identity. Keep the feed reachable across upgrades.
- After verifying the signed release, publish the draft as a regular release. The website download button can point to `/releases/latest/download/BlockHostSetup-x64.exe` on the release repository. Include the expected publisher and the minimum Windows version you have tested in the release notes.

## Test a signed upgrade

Use a disposable, standard-user Windows VM and a separate public test-release feed. Install one signed version and create a throwaway server or import a disposable world. Publish a higher signed version to the same test feed. Verify **Check for updates**, download progress, a blocked restart while the server is running, and successful restart after the server stops and finishes saving. Verify the same world, server settings and backups afterward. Also test fetching with the network disconnected and a signed update from the wrong publisher. An unsigned or unverifiable update must fail. Keep installer signing and Store distribution sufficiently separate to exercise each channel's actual install and upgrade behavior.
