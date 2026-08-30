# RepoRescue v4 星辰部署清单

状态：**代码候选已实现，本清单尚未代表公开 Agent 已重新发布。**

## 1. 冻结源码

- 完整测试必须通过：`npm test`、`npm run benchmark`、`python -m pytest`、`python scripts/smoke_stdio.py`、`python scripts/smoke_mcp.py`。
- 推送后记录唯一 commit SHA，MCP 源码包必须固定到该 SHA，不能使用会漂移的 branch ZIP。
- Node 服务构建标识应为 `repo-rescue-verified-code-20260830-v4`，包版本为 `0.3.0`。

## 2. Node v4 MCP（仅片段执行）

- 入口：`node stdio-server.mjs`。
- 必须发现 4 个工具：`rescue_python_snippet`、`inspect_github_project`、`reproduce_python_project`、`windows_environment_probe`。
- 兼容保留的 `reproduce_python_project` 必须固定返回 `repository_execution_disabled` 且 `executed=false`，不得调用宿主 Python 或下载仓库。
- 冷启动后跑空列表除零、类型错误、5 用例拒绝以及仓库执行禁用断言；公开 Agent 只绑定 Node 的 `rescue_python_snippet`。

## 3. Python v0.3 MCP（完整修复与 artifacts）

- 安装：`python -m pip install .`。
- 入口：`repo-rescue-mcp`，星辰命令型 MCP 使用 `REPO_RESCUE_TRANSPORT=stdio`。
- 必须发现 8 个工具：
  - `inspect_github_project`
  - `reproduce_python_project`
  - `repair_github_project`
  - `prepare_github_repair`
  - `verify_github_patch`
  - `run_interview_demo`
  - `get_repair_artifact`
  - `windows_environment_probe`
- 环境变量：
  - `REPO_RESCUE_ALLOWED_REPOS`：仅列复赛已验收公开仓库。
  - `REPO_RESCUE_ALLOWED_ADDITIONAL_DEPENDENCIES`：默认留空；只有管理员审核确认修复确实需要新增发行包名时才逐个加入。
  - `REPO_RESCUE_ARTIFACTS_DIR`：平台可写、会定期清理的目录。
  - 本地/独立主机默认 Docker；只有整个 MCP 已处于一次性资源受限容器中时，才设置 `REPO_RESCUE_EXECUTION_BACKEND=direct`。
  - 无 API Key 路径不设置 `OPENAI_API_KEY`，由星辰模型调用 prepare/verify 两段工具。

## 4. 星辰工作流

- 同时绑定 Node v4 MCP 与 Python v0.3 MCP。
- 将 Agent instruction/reasoning 更新为 `prompts-v4.md`。
- 若平台出现同名工具冲突，只保留 Python 的仓库工具和 Node 的 `rescue_python_snippet`；不得让模型随机选择两套仓库验证器。
- 对外文案在公开验收前写“受限公开 Python 仓库 Beta”，不能写“任意 GitHub”。

## 5. 发布门槛

- `prompts-v4.md` 中适用于公开 Agent 的全部片段与仓库用例都要重新跑通；Node 直连烟测在服务侧单独执行。
- 片段至少 5/5 正常修复、安全拒绝 2/2、错误成功 0。
- 内置 Demo 连续 3 次成功，patch 能通过 `get_repair_artifact` 读取。
- 至少 1 个团队控制的公开故障仓库连续 2 次完成 prepare → verify 闭环。
- GitHub Actions 的 Docker smoke 必须完成 baseline 失败 → 确定性 Repair Agent 修改 → 相同 pytest 命令通过；这只验收隔离编排，不替代真实模型/外部仓库证据。
- 保存页面截图、原始回答、commit、运行时间和 artifact SHA；失败记录也必须保留。

任何一项未满足时不把 v4 标为最终复赛版本。
