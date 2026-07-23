# RepoRescue 冻结档案

本目录保存 2026-07-23 已发布讯飞星辰 Agent 的可恢复快照。即使原平台记录丢失，也可依据这里的原始工作流、提示词、MCP 服务代码和配置说明重建。

## 档案清单

- `xfyun/workflow-648761.yml`：从讯飞后台直接下载的 UTF-8 工作流原件。
- `xfyun/platform-config.md`：作品、工作流、应用、模型及 MCP 标识。
- `xfyun/prompts.md`：生产提示词、推理指令、输入输出定义。
- `xfyun/test-evidence.md`：本地与平台验证证据、已知故障及修复。
- `xfyun/restore.md`：从 GitHub 恢复讯飞 Agent 的步骤。
- `product/requirements.md`：完整产品范围、交互、可信度和评审需求。
- `product/positioning.md`：市场定位、竞品差异和履历表述。
- `product/strategy-comparison.md`：RepoRescue、兴趣类比讲解器和榜单产品的取舍。

仓库根目录中的运行代码、测试、OpenClaw 迁移说明和 `skills/verified-code-rescue/` 也是快照的一部分，不能只复制本目录。

## 冻结版本

- Git commit：以标签 `repo-rescue-xfyun-v1.0.0` 指向的提交为准。
- 源码发布仓库：<https://github.com/wenjieding327/repo-rescue-mcp>
- 讯飞 Agent：<https://agent.xfyun.cn/agentbuilder/chat?botId=5773337>

## 恢复完整性

文件哈希记录在 `SHA256SUMS.txt`。工作流中的密钥只允许引用环境变量，仓库不得保存真实密钥。
