# DeepSeek Harness Windows Desktop Packager

English | [中文](README.zh.md)

This is a Windows x64 packaging project that is independent of [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness). The official source is only used as build input; the desktop code lives in `overlay/apps/desktop` and is injected into a temporary checkout at build time. The upstream repository is never modified, committed to, or pushed.

Download or clone this repository and double-click `build.cmd` to produce a Windows installer. You do not need to maintain the upstream source yourself.

## One-click packaging

Requirements:

- Windows x64
- Node.js 24 or newer (with corepack enabled)
- Git
- Network access to GitHub, npm, and the Electron download source

After downloading or cloning the repository, simply double-click `build.cmd`. The script automatically:

1. Clones or fetches the upstream repository into `.cache/upstream`;
2. Creates a one-off checkout under a short path in the system temp directory to avoid over-long dependency paths on Windows;
3. Injects `overlay/apps/desktop` and syncs the version from the upstream root;
4. Installs build dependencies using the pnpm version pinned by the upstream `packageManager` field, skipping the Codex product test binaries that are unrelated to desktop packaging;
5. Runs focused desktop unit tests and a runtime-closure precheck;
6. Produces the NSIS installer and SHA-256 metadata;
7. Removes the temporary source.

The final files are written to `dist/`:

```text
DeepSeek-Harness-Setup-<version>-x64.exe
DeepSeek-Harness-Setup-<version>-x64.json
```

Build logs are written to `logs/`. The installer is not code-signed, so Windows SmartScreen may show an unknown-publisher warning.

After installation you can use the bundled `dsh` and `pnpm` commands to manage plugins; see "Installing plugins after installation" below.

## Installing plugins after installation

After installing and launching the desktop app for the first time, the desktop uses the `web` profile. Plugins are managed through the bundled `dsh` command, with no separate Node.js or pnpm installation required.

Open a new PowerShell window first (so the updated `PATH` takes effect), then run:

```powershell
dsh plugin --profile web add <plugin-package-name>
```

`<plugin-package-name>` is an npm package name. Run `dsh plugin --help` to see the exact supported argument formats.

Common commands:

```powershell
# Add a plugin
dsh plugin --profile web add <plugin-package-name>

# List plugins/dependencies installed in the current web profile
dsh plugin --profile web list

# Remove a plugin
dsh plugin --profile web remove <plugin-package-name>
```

Plugin state is stored in `%APPDATA%\DeepSeek Harness\dsh-home`, which is shared by the CLI and the desktop app. After adding or removing a plugin, **restart the desktop app** (fully quit and reopen it) to reload plugins.

If you are unsure about a plugin's exact package name, confirm that it is published to npm and pass that package name to the `add` command.

## If the build environment is missing

`build.cmd` checks the environment first. If Git, Node.js 24+, or corepack is missing, it tells you exactly which tools are missing and where to download them, instead of dumping a wall of hard-to-read errors.

Manual installation:

- Git: https://git-scm.com/download/win
- Node.js 24 or newer: https://nodejs.org/ (corepack is installed together with Node.js)

If your Windows already has winget (Windows 11 usually does), you can run:

```powershell
.\build.cmd -AutoInstall
```

The script will try to use winget to install the missing Git or Node.js automatically. After installation, close and reopen the command window, then double-click `build.cmd` again.

Note: automatic installation relies on winget and may require administrator privileges. If it fails, install the missing tools manually using the links above.

## Configuring the upstream repository URL

The upstream URL defaults to the official repository and is fetched from GitHub automatically. To switch sources (for example, a fork, mirror, or private repository), edit `build.config.ps1` in the repository root:

```powershell
$UpstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'
# Optional: pin a tag, branch, or commit; leave empty to use the latest commit on the upstream default branch
# $UpstreamRef = 'v0.1.0'
```

You can also override it directly on the command line. Command-line arguments have the highest priority:

```powershell
.\build.cmd -UpstreamUrl https://github.com/your-name/deepseek-harness.git
.\build.cmd -UpstreamUrl https://github.com/your-name/deepseek-harness.git -UpstreamRef v0.1.0
```

Priority: command-line arguments > `build.config.ps1` > built-in defaults.

After switching the upstream URL, if `.cache/upstream` still contains a cached old repository, delete the `.cache` directory and rebuild.

## Rebuilding after an upstream update

Just double-click `build.cmd` again. By default each run performs `git fetch` and rebuilds from the latest commit on the upstream default branch, so you do not need to merge the packaging code into the official project.

To pin a specific official tag or commit:

```powershell
.\build.cmd -UpstreamRef v0.1.0
```

To use the committed `HEAD` of a local repository:

```powershell
.\build.cmd -SourceRoot D:\code\github\deepseek-harness
```

Local mode reads only the committed snapshot of the given repository; it does not read uncommitted changes and does not modify that repository. Add `-Offline` when the network is unavailable and an upstream cache already exists.

## Maintaining the packaging code

- Desktop app and Electron packaging logic: `overlay/apps/desktop`
- Upstream checkout, injection, version sync, and artifact collection: `scripts/build.ps1`
- Reusable injection helpers: `scripts/Packager.Common.ps1`
- Optional local configuration: `build.config.ps1`
- Isolation tests: `tests/packager.tests.ps1`

Run `test.cmd` after changing the injection scripts. After changing the desktop app, run the full `build.cmd`; the build verifies that the deployed Web runtime can actually start before producing the installer.

If upstream renames or removes a workspace package that the desktop app depends on, packaging will fail explicitly. In that case, update the overlay dependencies and runtime closure instead of modifying the official repository.

## License

The overlay is based on DeepSeek Harness code under the MIT license; see `LICENSE`.