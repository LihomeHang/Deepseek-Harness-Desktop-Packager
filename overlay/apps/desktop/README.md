# DeepSeek Harness Desktop

English | [中文](README.zh.md)

DeepSeek Harness Desktop is the Windows application for the shipped Web profile. It starts the same `dsh web` backend on loopback and displays the official Web UI in an Electron window; the installer includes the Node runtime and built-in plugin closure, so ordinary use does not require a separate Node.js installation.

## Run

Install `DeepSeek-Harness-Setup-<version>-x64.exe`, then open **DeepSeek Harness** from the Start menu or desktop shortcut. The first launch creates:

- application state under `%APPDATA%\DeepSeek Harness\dsh-home`
- the default workspace at `%USERPROFILE%\Documents\DeepSeek Harness Workspace`

Use the onboarding dialog or model settings in the Web UI to configure a DeepSeek API key. Uninstalling the application keeps the Harness state and sessions unless the user removes that directory explicitly.

## Command line

The installer adds a `dsh` command to your user `PATH`. It is a small shim that launches the bundled Node runtime and the bundled `@deepseek-ai/dsh` CLI, so it works without a separate Node.js installation. Open a new terminal after installing and run `dsh --help` to verify. Uninstalling the application removes the `dsh` entry from `PATH`.

## Runtime

The Electron process accepts one application instance, selects the first available loopback port from `3080` through `3179`, starts the bundled Node executable, and loads only that local origin. External HTTP links open in the system browser. Closing the application terminates the complete backend process tree before Electron exits.

The following environment variables are development and test overrides:

| Variable | Purpose |
|---|---|
| `DSH_DESKTOP_HOME` | Replace the desktop-owned `DSH_HOME`. |
| `DSH_DESKTOP_NODE` | Replace the Node executable outside a packaged build. |
| `DSH_DESKTOP_PORT` | Set the first loopback port to probe. |
| `DSH_DESKTOP_WORKSPACE` | Replace the default workspace directory. |

Backend output is appended to `%APPDATA%\DeepSeek Harness\logs\desktop-backend.log`.

## Build

Packaging requires Windows x64, Node 24 or newer, and the repository-pinned pnpm through Corepack. From the repository root:

```sh
corepack pnpm install
corepack pnpm --filter @deepseek-ai/dsh-desktop run package:win
```

The build compiles the Host, Client, Web, and desktop artifacts; deploys a symlink-free production dependency tree; embeds the current Node executable and its license; and writes the NSIS installer to `apps/desktop/dist/`.

## Limitations

The package target is Windows x64 only. Local development installers are unsigned, so Windows may display a SmartScreen warning. DeepSeek Harness remains a developer preview and may introduce compatibility-breaking changes.
