# DeepSeek Harness Windows 桌面打包器

这是独立于 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的 Windows x64 打包项目。官方源码只作为构建输入；桌面端代码保存在 `overlay/apps/desktop`，构建时注入到临时检出目录，不会改动、提交或推送官方仓库。

用户把本仓库下载下来，双击 `build.cmd` 即可生成 Windows 安装包，无需手动维护上游源码。

## 一键打包

环境要求：

- Windows x64
- Node.js 24 或更高版本（并启用 corepack）
- Git
- 可访问 GitHub、npm 和 Electron 下载源的网络

把整个仓库下载或克隆到本地后，直接双击 `build.cmd`。脚本会自动：

1. 从上游仓库 `clone` 或 `fetch` 到 `.cache/upstream`；
2. 在系统临时目录创建短路径的一次性检出，避免 Windows 深层依赖路径过长；
3. 注入 `overlay/apps/desktop` 并同步上游根版本号；
4. 使用上游 `packageManager` 字段固定的 pnpm 版本安装构建依赖，并跳过与桌面打包无关的 Codex 产品测试二进制；
5. 运行桌面端单元测试和运行时闭包预检；
6. 生成 NSIS 安装包和 SHA-256 元数据；
7. 删除临时源码。

最终文件位于 `dist/`：

```text
DeepSeek-Harness-Setup-<version>-x64.exe
DeepSeek-Harness-Setup-<version>-x64.json
```

构建日志位于 `logs/`。安装包没有数字签名，因此 Windows SmartScreen 可能提示未知发布者。

安装完成后即可使用随包提供的 `dsh` 和 `pnpm` 来管理插件，详见下方“安装后如何添加插件”。

## 安装后如何添加插件

安装并首次启动桌面应用后，桌面端使用 `web` profile。插件通过随包提供的 `dsh` 命令管理，不需要另装 Node.js 或 pnpm。

先新开一个 PowerShell 窗口（让 `PATH` 生效），然后运行：

```powershell
dsh plugin --profile web add <插件包名>
```

`<插件包名>` 填写 npm 包名；具体支持的参数格式可先运行 `dsh plugin --help` 查看。

常用命令：

```powershell
# 添加插件
dsh plugin --profile web add <插件包名>

# 查看当前 web profile 已安装的插件/依赖
dsh plugin --profile web list

# 移除插件
dsh plugin --profile web remove <插件包名>
```

插件状态保存在 `%APPDATA%\DeepSeek Harness\dsh-home`，命令行和桌面应用共用同一份数据。添加或移除插件后，**重启桌面应用**（完全退出后重新打开）即可重新加载插件。

如果不确定某个插件的准确包名，先确认它已发布到 npm，再把包名传给 `add` 命令。

## 打包环境不满足怎么办

`build.cmd` 会先自动检查环境。如果缺少 Git、Node.js 24+ 或 corepack，会明确提示缺少哪些工具以及下载地址，不会直接抛出一堆看不懂的错误。

手动安装：

- Git：https://git-scm.com/download/win
- Node.js 24 或更高版本：https://nodejs.org/ （corepack 随 Node.js 一起安装）

如果你的 Windows 已自带 winget（Windows 11 通常都有），可以直接运行：

```powershell
.\build.cmd -AutoInstall
```

脚本会尝试用 winget 自动安装缺失的 Git 或 Node.js。安装完成后需要关闭并重新打开命令窗口，再双击 `build.cmd`。

注意：自动安装依赖 winget，且可能需要管理员权限；如果自动安装失败，按提示手动安装即可。

## 配置上游仓库地址

上游地址默认指向官方仓库，会自动从 GitHub 拉取。如果需要换源（例如 fork、镜像或私有仓库），编辑根目录的 `build.config.ps1`：

```powershell
$UpstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'
# 可选：固定到某个标签、分支或提交；留空使用上游默认分支的最新提交
# $UpstreamRef = 'v0.1.0'
```

也可以在命令行直接覆盖，命令行参数优先级最高：

```powershell
.\build.cmd -UpstreamUrl https://github.com/your-name/deepseek-harness.git
.\build.cmd -UpstreamUrl https://github.com/your-name/deepseek-harness.git -UpstreamRef v0.1.0
```

优先级：命令行参数 > `build.config.ps1` > 脚本内默认值。

切换过上游地址后，如果 `.cache/upstream` 里已经缓存了旧仓库，需要先删除 `.cache` 目录再重新构建。

## 官方项目更新后重新打包

再次双击 `build.cmd` 即可。默认流程每次都会执行 `git fetch`，并从上游默认分支的最新提交重新构建，不需要把打包代码合并进官方项目。

需要固定到某个官方标签或提交时：

```powershell
.\build.cmd -UpstreamRef v0.1.0
```

需要使用本地仓库中已经提交的 `HEAD` 时：

```powershell
.\build.cmd -SourceRoot D:\code\github\deepseek-harness
```

本地模式只读取指定仓库的已提交快照，不读取未提交修改，也不会改变该仓库。网络不可用且已经有上游缓存时可加 `-Offline`。

## 维护打包代码

- 桌面应用和 Electron 打包逻辑：`overlay/apps/desktop`
- 上游检出、注入、版本同步和产物整理：`scripts/build.ps1`
- 可复用的注入函数：`scripts/Packager.Common.ps1`
- 可选的本地配置：`build.config.ps1`
- 隔离性测试：`tests/packager.tests.ps1`

修改注入脚本后运行 `test.cmd`。修改桌面端后应执行完整的 `build.cmd`；构建过程会验证部署后的 Web 运行时可以实际启动，然后才生成安装包。

上游若改名、删除桌面端依赖的 workspace 包，打包会明确失败。此时需要更新覆盖层的依赖和运行时闭包，而不是修改官方仓库。

## 许可证

覆盖层基于 DeepSeek Harness 的 MIT 许可代码，详见 `LICENSE`。
