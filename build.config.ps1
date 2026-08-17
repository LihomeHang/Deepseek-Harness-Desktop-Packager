# build.config.ps1
# DeepSeek Harness Windows 桌面打包器的可选配置。
# 优先级：命令行参数 > 本配置文件 > 脚本内默认值。
# 不改这个文件也能直接使用默认配置。

# 上游 DeepSeek Harness 仓库地址。构建时会自动 git clone/fetch 到 .cache/upstream。
$UpstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'

# 可选：固定到某个标签、分支或提交。留空（默认）则使用上游默认分支的最新提交。
# $UpstreamRef = 'v0.1.0'
# $UpstreamRef = 'main'