# DeepSeek Harness Desktop

[English](README.md) | 中文

DeepSeek Harness Desktop 是已发布 Web profile 的 Windows 应用。它在回环地址上启动同一个 `dsh web` 后端，并在 Electron 窗口中显示官方 Web UI；安装包包含 Node 运行时和内置插件依赖闭包，因此日常使用不要求另行安装 Node.js。

## 运行

安装 `DeepSeek-Harness-Setup-<version>-x64.exe`，然后从开始菜单或桌面快捷方式打开 **DeepSeek Harness**。首次启动会创建：

- 位于 `%APPDATA%\DeepSeek Harness\dsh-home` 的应用状态
- 位于 `%USERPROFILE%\Documents\DeepSeek Harness Workspace` 的默认 workspace

请通过 Web UI 的引导对话框或模型设置配置 DeepSeek API key。卸载应用时会保留 Harness 状态与会话，除非用户明确删除该目录。

## 命令行

安装程序会把 `dsh` 和随附的 `pnpm` 命令加入你的用户 `PATH`。它们会启动安装包内的 Node 运行时，因此无需单独安装 Node.js 或 pnpm。安装后请新开一个终端并运行 `dsh --help` 验证。

给桌面端的 Web profile 安装插件：

```powershell
dsh plugin --profile web add <插件包名>
```

查看已安装依赖可运行 `dsh plugin --profile web list`，删除插件可运行 `dsh plugin --profile web remove <插件包名>`。命令行和桌面应用共享 `%APPDATA%\DeepSeek Harness\dsh-home`；安装或删除后重启桌面应用即可重新加载插件。卸载应用时会从 `PATH` 中移除命令入口，但会保留 profile 数据。

## 运行时

Electron 进程只允许一个应用实例，从 `3080` 到 `3179` 中选择第一个可用回环端口，启动随附的 Node 可执行文件，并且只加载该本地来源。外部 HTTP 链接会在系统浏览器中打开。关闭应用时，Electron 会先终止完整的后端进程树再退出。

以下环境变量用于开发和测试覆盖：

| 变量 | 用途 |
|---|---|
| `DSH_DESKTOP_HOME` | 替换桌面应用拥有的 `DSH_HOME`。 |
| `DSH_DESKTOP_NODE` | 在非打包构建中替换 Node 可执行文件。 |
| `DSH_DESKTOP_PORT` | 设置要探测的第一个回环端口。 |
| `DSH_DESKTOP_WORKSPACE` | 替换默认 workspace 目录。 |

后端输出会追加到 `%APPDATA%\DeepSeek Harness\logs\desktop-backend.log`。

## 构建

打包要求 Windows x64、Node 24 或更高版本，并通过 Corepack 使用仓库固定的 pnpm。请在仓库根目录运行：

```sh
corepack pnpm install
corepack pnpm --filter @deepseek-ai/dsh-desktop run package:win
```

构建会编译 Host、Client、Web 和桌面端产物，部署不含符号链接的生产依赖树，嵌入当前 Node 可执行文件及其许可证，并将 NSIS 安装包写入 `apps/desktop/dist/`。

## 限制

当前打包目标仅支持 Windows x64。本地开发安装包没有数字签名，因此 Windows 可能显示 SmartScreen 警告。DeepSeek Harness 仍处于开发者预览阶段，可能引入破坏兼容性的变更。
