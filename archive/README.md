# RepoRescue 历史档案与候选附录

2026-07-23 已发布讯飞星辰 Agent 的历史原始版本由 Git 标签 `repo-rescue-xfyun-v1.0.0` 冻结。即使原平台记录丢失，也可检出该标签，并依据其中的原始工作流、提示词、MCP 服务代码和配置说明重建当时版本。

当前分支的 `archive/` 还包含复赛候选附录和持续维护的产品文档，因此不能把当前目录整体描述为不可变的 2026-07-23 快照，也不能把候选内容当成已经公开部署的历史事实。

## 档案清单

- `xfyun/workflow-648761.yml`：从讯飞后台直接下载的 UTF-8 工作流原件。
- `xfyun/platform-config.md`：作品、工作流、应用、模型及 MCP 标识。
- `xfyun/prompts.md`：生产提示词、推理指令、输入输出定义。
- `xfyun/test-evidence.md`：历史证据以及明确标注“尚未重新发布”的候选版测试附录。
- `xfyun/restore.md`：从 GitHub 恢复讯飞 Agent 的步骤。
- `xfyun/prompts-v4.md`、`xfyun/deployment-v4.md`：复赛候选配置与重新发布清单，不是历史线上配置。
- `product/requirements.md`：持续维护的目标产品范围、交互、可信度和评审需求。
- `product/positioning.md`：持续维护的市场定位、竞品差异和履历表述。
- `product/strategy-comparison.md`：RepoRescue、兴趣类比讲解器和榜单产品的取舍。
- `product/commercial-validation-plan.md`：复赛候选商业验证计划，不代表已有用户或收入。

恢复历史版本时，仓库根目录中的运行代码、测试、OpenClaw 迁移说明和 `skills/verified-code-rescue/` 也属于对应标签，不能只复制本目录。评估当前候选版时则以当前提交的根目录代码、README 和候选证据为准。

## 历史冻结版本

- Git commit：以标签 `repo-rescue-xfyun-v1.0.0` 指向的提交为准。
- 源码发布仓库：<https://github.com/wenjieding327/repo-rescue-mcp>
- 讯飞 Agent：<https://agent.xfyun.cn/agentbuilder/chat?botId=5773337>

## 历史完整性与当前候选

当前分支的 `SHA256SUMS.txt` 覆盖本目录除清单自身外的全部当前文件，用于核对复赛候选档案与附录；每次候选内容变更都必须同步刷新。历史冻结版及其当时的清单保存在 `repo-rescue-xfyun-v1.0.0` 标签中，应检出该标签核验，不能用当前候选清单冒充历史清单。

无论历史版还是候选版，工作流中的密钥都只允许引用环境变量，仓库不得保存真实密钥。候选能力只有在部署清单完成并重新验收后，才能改写为当前线上能力。
