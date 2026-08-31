# RepoRescue v4 星辰部署清单

状态：**代码候选已实现，本清单尚未代表公开 Agent 已重新发布。**

## 1. 冻结源码

- 完整测试必须通过：`npm test`、`npm run benchmark`、`python -m pytest`、`python scripts/smoke_stdio.py`、`python scripts/smoke_sse.py`、`python scripts/smoke_mcp.py`；具备 Docker 的发布主机还必须运行 `python scripts/smoke_docker.py`。
- 推送后记录唯一 commit SHA，MCP 源码包必须固定到该 SHA，不能使用会漂移的 branch ZIP。
- Node 服务构建标识应为 `repo-rescue-verified-code-20260830-v4`，包版本为 `0.4.0`。

## 2. Node v4 MCP（仅片段执行）

- 入口：`node stdio-server.mjs`。
- 服务侧默认兼容模式必须发现 4 个工具：`rescue_python_snippet`、`inspect_github_project`、`reproduce_python_project`、`windows_environment_probe`。
- 星辰托管实例必须设置 `REPO_RESCUE_NODE_TOOLSET=snippet`，此时 `tools/list` 只能发现 `rescue_python_snippet`，直接调用其他三个工具必须返回 `tool_unavailable`。
- 256 MB 托管实例中，原代码与候选代码默认由两个全新 Pyodide 子进程**顺序**执行，任何时刻最多驻留一个 Pyodide worker；两次运行仍完全隔离，且单 worker 的 6000 ms 墙钟、192 MB V8 heap、协议与输出上限均不放宽。不需要新增环境变量，也不要把两次 worker 改回并行。上层 MCP 工具调用超时必须至少容纳两份单 worker 预算与冷启动余量（默认约 12 秒加冷启动开销）。
- 兼容保留的 `reproduce_python_project` 必须固定返回 `repository_execution_disabled` 且 `executed=false`，不得调用宿主 Python 或下载仓库。
- npm 包必须由 `package.json.files` 只包含 Node 运行时，不得上传 `archive/`、测试、复赛材料或 Python 后端。
- 冷启动后跑空列表除零、类型错误、5 用例拒绝以及隐藏工具拒绝断言。

## 3. Python v0.4 MCP（完整修复与 artifacts）

- 安装：`python -m pip install .`。
- 入口：`repo-rescue-mcp`；命令型 MCP 使用 `REPO_RESCUE_TRANSPORT=stdio`，外部旧客户端可用根路径 `/sse` + `/messages/`，新客户端优先根路径 `/mcp` 的 `streamable-http`。需要 URL 前缀时由反向代理改写，不设置 FastMCP 运行时 mount path。
- 必须发现 11 个工具：
  - `inspect_github_project`
  - `reproduce_python_project`
  - `repair_github_project`
  - `prepare_github_repair`
  - `verify_github_patch`
  - `start_prepare_github_repair`
  - `start_verify_github_patch`
  - `get_repair_job`
  - `run_interview_demo`
  - `get_repair_artifact`
  - `windows_environment_probe`
- 环境变量：
  - `REPO_RESCUE_ALLOWED_REPOS`：仅列复赛已验收公开仓库。
  - `REPO_RESCUE_ALLOWED_ADDITIONAL_DEPENDENCIES`：默认留空；只有管理员审核确认修复确实需要新增发行包名时才逐个加入。
  - `REPO_RESCUE_ARTIFACTS_DIR`：平台可写、会定期清理的目录。
  - `REPO_RESCUE_JOB_MAX_JOBS=16`：queued/running 的活动任务上限；已完成结果不会占用该队列槽。
  - `REPO_RESCUE_JOB_MAX_RESULTS=64`、`REPO_RESCUE_JOB_TTL_SECONDS=900`：进程内完成结果的数量与存活时间上限，超量先淘汰最旧结果。
  - `REPO_RESCUE_JOB_MAX_LONG_POLLS=8`：长轮询并发上限；等待在线程中完成，不能阻塞 ASGI 事件循环。
  - 本地/独立主机默认 Docker；只有整个 MCP 已处于一次性资源受限容器中时，才设置 `REPO_RESCUE_EXECUTION_BACKEND=direct`。
  - 无 API Key 路径不设置 `OPENAI_API_KEY`，由星辰模型调用异步 prepare/verify job 工具。
- 星辰普通命令托管没有 Docker/特权容器保证，不能默认承担不可信仓库执行；完整仓库闭环优先部署到自控 Linux VM + Docker，再将公网 MCP 地址接回星辰。
- 当前 job store 是进程内实现：比赛部署固定为 1 个应用进程、1 个副本，不做滚动发布；多 worker/多副本商业版必须改用 Redis/数据库队列与结果存储。公网入口必须由 TLS、鉴权、请求体上限和按租户限流网关保护。

## 4. 星辰工作流

- 同时绑定 Node v4 snippet-only MCP 与 Python MCP。
- 将 Agent instruction/reasoning 更新为 `prompts-v4.md`。
- 仓库任务固定走 `start_prepare_github_repair` → `get_repair_job` → `start_verify_github_patch` → `get_repair_job`；轮询不得重复启动任务。
- Node 托管端通过 toolset 开关消除同名工具冲突；Python 的同步 prepare/verify 保留给本地/长调用宿主，但公开星辰 Prompt 不使用。
- 对外文案在公开验收前写“受限公开 Python 仓库 Beta”，不能写“任意 GitHub”。

## 5. 发布门槛

- `prompts-v4.md` 中适用于公开 Agent 的全部片段与仓库用例都要重新跑通；Node 直连烟测在服务侧单独执行。
- 片段至少 5/5 正常修复、安全拒绝 2/2、错误成功 0。
- 内置 Demo 连续 3 次成功，patch 能通过 `get_repair_artifact` 读取。
- 至少 1 个固定提交的公开故障仓库连续 2 次完成异步 prepare → verify 闭环；正式提交前再补 1 个团队控制仓库，避免把第三方 canary 误写成生产故障。
- GitHub Actions 的 Docker smoke 必须完成 baseline 失败 → 确定性 Repair Agent 修改 → 相同 pytest 命令通过；这只验收隔离编排，不替代真实模型/外部仓库证据。
- 保存页面截图、原始回答、commit、运行时间和 artifact SHA；失败记录也必须保留。

任何一项未满足时不把 v4 标为最终复赛版本。
