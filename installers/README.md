# Desktop installers

These installers include the compiled Goodfinds plugin. Users do not extract an archive, build the source, install a language runtime, or edit a configuration file.

The installer adds Goodfinds to the current user's personal plugin catalog at `~/.agents/plugins/marketplace.json`. The user finishes installing the plugin in ChatGPT. Existing catalog entries and saved shopping data are preserved. Setup does not grant browser permissions or enable schedules.

## macOS

Build the plugin for `aarch64-apple-darwin` and `x86_64-apple-darwin` from the same source revision. Keep each packaged directory, then combine them and build one Mac installer:

```sh
python3 installers/macos/universal.py /path/to/arm-package /path/to/intel-package dist/goodfinds-marketplace-universal
installers/macos/build.sh dist/goodfinds-marketplace-universal
python3 installers/macos/check-package.py dist/Goodfinds-<version>-macos-universal.pkg
```

The merge rejects mismatched plugin files and missing architecture slices. Both the setup app and Rust server contain Apple silicon and Intel code; macOS selects the right slice. Shared plugin files are included once. The output is `dist/Goodfinds-<version>-macos-universal.pkg`, requiring macOS 13 or later. Single-architecture payloads remain accepted for development builds.

Set `GOODFINDS_INSTALLER_OUTPUT` to build and test in a separate output directory. `GOODFINDS_TEST_ARCH=arm64` or `x86_64` selects a slice for tests; running the Intel slice on Apple silicon requires an existing Rosetta installation. The CI workflow expands the same universal package and runs its bundled helper and postinstall on native Apple silicon and Intel runners, using disposable homes.

Opening the downloaded `.pkg` starts Apple's Installer immediately. Choose **Continue**, then **Install**. Setup prepares the files for the current user and opens Goodfinds' local plugin page using the [documented local plugin link](https://learn.chatgpt.com/docs/reference/commands#local-plugin). Choose **Install** in ChatGPT. There is no disk image to mount, second app icon to open, drag-to-Applications step, or administrator password.

The package only enables the current-user home installation domain with `auth="none"`. Its postinstall runs the bundled native helper with Installer's destination home, preserving the same atomic catalog updates as the standalone setup app. The helper and its payload live in Installer's temporary scripts directory; no permanent setup app is installed. CLI installs remain noninteractive. If ChatGPT is unavailable, the completion screen explains how to find Goodfinds under the personal plugin source.

Packaging uses macOS's built-in `pkgbuild` and `productbuild`; no third-party disk-image tooling is needed. The native setup app remains available in the build output for development. To review its screens without writing files or opening ChatGPT, run `Contents/MacOS/GoodfindsInstaller --preview`. Its primary button uses the system's paired label and bezel colours so it remains readable in active and inactive windows.

The app installs an immutable, content-addressed copy under `~/.local/share/goodfinds-plugins/`. Reinstalling the same payload reuses that copy. Installation updates the catalog atomically and rejects malformed catalogs. It does not edit the host's `config.toml` or replace the user's existing Goodfinds workspace.

Set `GOODFINDS_SIGN_IDENTITY` to a valid Developer ID Application identity and `GOODFINDS_INSTALLER_SIGN_IDENTITY` to a Developer ID Installer identity when building a release. Both identities are required for signed packages. Set `GOODFINDS_NOTARY_PROFILE` to a preconfigured `notarytool` Keychain profile to submit and staple the package. Without those settings the build is a local test artifact; do not publish it as a signed release. Credentials must never be committed.

## Windows

Build the Windows x64 plugin on Windows, install Inno Setup 6 on the build machine, then run:

```powershell
./installers/windows/build.ps1
```

The output is `dist/Goodfinds-<version>-windows-x64.exe`. It installs for the current user, registers the plugin, and provides an uninstaller. The user restarts ChatGPT, opens Plugins, chooses their personal source, and installs Goodfinds. The small registration helper uses Windows' built-in .NET Framework; no extra runtime download is required. It removes only its own catalog entry on uninstall and leaves shopping data intact. Sign and test the installer on Windows before publishing it.

The manual [Desktop installers workflow](../.github/workflows/installers.yml) builds one universal Mac installer and a Windows x64 installer. It does not publish or sign releases. Linux plugin ZIPs remain available through the existing native build workflow; no Linux graphical installer is included here.

## Releases and website downloads

GitHub Releases hosts installers and checksums. Cloudflare serves the website. No R2 bucket is required.

Use stable asset names inside each versioned release:

- `Goodfinds-macos-universal.pkg`
- `Goodfinds-windows-x64.exe`
- `SHA256SUMS.txt`

The build scripts produce versioned local filenames; rename copies to the names above when uploading. Set `GOODFINDS_RELEASE_REPOSITORY=owner/repository` when generating release metadata, or let the script read the GitHub origin from the local checkout. `bun scripts/sync-release.ts` creates the ignored `website/downloads/release.json` manifest for deployment after the package assets are published.

For each release:

1. Build the supported platform installers with the Desktop installers workflow. Sign release binaries, notarize the Mac packages, and run installer and host discovery checks. The workflow currently produces unsigned artifacts; signing and publication are release-owner steps.
2. Create a draft GitHub Release for a version tag pointing to the plugin source revision. Upload the verified installers and their SHA-256 checksums. Check the uploaded hashes before publishing. Include every previously supported platform in the new release so stable links keep working.
3. Run `bun scripts/sync-release.ts` to generate the local download manifest from the published release. Run `bun test tests/downloads.test.ts` and `bun run site:check`, then deploy with `bun run site:deploy`, which refreshes the manifest before publishing.

The Mac download uses a published universal `.pkg`. The written steps and film describe the package installer. JavaScript loads the local release manifest and enables the verified download.

The page uses the verified manifest directly. Visitors do not wait on the GitHub API, and API rate limits cannot disable their download buttons. Downloads remain pinned to the release that was verified for that website deployment. Source archives, drafts, incomplete uploads and unrelated repositories cannot be used as installers.

The page quietly detects macOS or Windows and preselects the operating system. Mac users always receive the universal installer, with no CPU detection or chip choice. Windows client hints can identify unsupported Windows architectures. Platform choices remain editable; late detection never overrides a manual selection. Phones and tablets receive desktop choices without a false device recommendation.

A platform without a verified published installer displays its availability instead of a download link.

## Installation film

The 21-second walkthrough is authored in Remotion under `video/install/`. Its interfaces are illustrations, containing no personal chats or screenshots. The page supplies written steps and respects reduced-motion and data-saving preferences.

```sh
cd video/install
bun install --frozen-lockfile
bun run render:package
bun run poster:package
```

Rendering writes the package walkthrough and poster into `website/media/`. The original `render` and `poster` scripts retain the disk-image walkthrough for older releases. The video dependencies are isolated from the plugin workspace and are never shipped inside its installers.
