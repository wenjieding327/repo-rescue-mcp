# RepoRescue v4 星辰部署清单

状态口径：**本清单描述固定的 v4 发布门槛，不承载易过期的线上状态；实际 MCP/Agent 发布时间与平台回归结论以复赛材料 `03-演示材料/发布验收.json` 为准。**

## 1. 冻结源码

- 完整测试必须通过：`npm test`、`npm run benchmark`、`python -m pytest`、`python scripts/smoke_stdio.py`、`python scripts/smoke_sse.py`、`python scripts/smoke_mcp.py`；具备 Docker 的发布主机还必须运行 `python scripts/smoke_docker.py`。
- 推送后记录唯一 commit SHA，MCP 源码包必须固定到该 SHA，不能使用会漂移的 branch ZIP。
- 星辰私有 MCP 英文名固定为 `repo-rescue-actions-bridge-v4`，包版本为 `0.4.0`。

## 2. Node v4 MCP（片段执行 + GitHub Actions 仓库桥）

- 入口：`node stdio-server.mjs`。
- 服务侧默认兼容模式必须发现 4 个工具：`rescue_python_snippet`、`inspect_github_project`、`reproduce_python_project`、`windows_environment_probe`。
- 星辰复赛托管实例必须设置 `REPO_RESCUE_NODE_TOOLSET=platform`，此时 `tools/list` 必须恰好发现 `rescue_python_snippet`、`start_prepare_github_repair`、`get_repair_job`、`start_verify_github_patch`；直接调用 legacy/full 隐藏工具必须返回 `tool_unavailable`。
- 256 MB 托管实例中，原代码与候选代码默认由两个全新 Pyodide 子进程**顺序**执行，任何时刻最多驻留一个 Pyodide worker；两次运行仍完全隔离，且单 worker 的 6000 ms 墙钟、192 MB V8 heap、协议与输出上限均不放宽。不需要新增环境变量，也不要把两次 worker 改回并行。上层 MCP 工具调用超时必须至少容纳两份单 worker 预算与冷启动余量（默认约 12 秒加冷启动开销）。
- Node 宿主仍不得克隆或执行仓库；三个仓库工具只把有界请求 dispatch 到受保护 GitHub workflow，并轮询该次 run 的绑定 artifact。
- npm 包必须由 `package.json.files` 只包含 `stdio-server.mjs`、`actions-bridge.mjs` 和 snippet worker 运行时，不得上传 `archive/`、测试、复赛材料或 Python 后端。
- 托管环境必须配置 `REPO_RESCUE_GITHUB_TOKEN`（只给控制仓库 Actions read/write 的 fine-grained token）、固定 `REPO_RESCUE_ACTIONS_REPOSITORY=wenjieding327/repo-rescue-mcp`、`REPO_RESCUE_ACTIONS_WORKFLOW=repo-rescue-actions-bridge.yml`、受保护 `REPO_RESCUE_ACTIONS_REF`，以及与 workflow 完全一致的 `REPO_RESCUE_ALLOWED_REPOS`。漏任一关键配置必须 `configuration_required`，不得发 HTTP。
- 该托管 MCP 保持**私有**，不发布 MCP 广场；复赛对外入口是绑定它并完成平台验收后的 RepoRescue Agent。PAT 只能保存在私有 MCP 环境变量中，不能写进 Prompt、workflow input、仓库文件、截图或回答。
- PAT 选择最短可用有效期，只允许可信管理员查看私有 MCP 环境变量；比赛结束或任何疑似泄漏时立即 revoke 并重新签发。Actions write 不只是 dispatch，还可能影响 runs/artifacts 和 workflow 状态，因此不能把它描述为只写入一次任务。
- 默认最多 1 个活动 job，与 workflow 的全局单并发保持一致；每分钟 3 次、每小时 12 次新 start。不同调用者绝不共享内部 job capability。公开 Actions run 只显示独立 request correlation nonce，不显示 MCP `job_id`。verify 必须提交仍存活的 `preparation_job_id`，且 repo/commit/baseline 完全匹配；一个 preparation capability 只能消费一次，同一 verify 重试返回已启动的 verify job。POST 结果不确定时只按原 request nonce 发现 run，绝不隐式重派。普通 API 15 秒、artifact 30 秒硬超时，暂时性 429/5xx/断流保留 job 重试。
- 冷启动后跑空列表除零、类型错误、5 用例拒绝以及隐藏工具拒绝断言。
- 发布管理员还要设置进程级 token 和 `REPO_RESCUE_ACTIONS_EXPECTED_HEAD_SHA` 后运行 `node scripts/live_actions_bridge_smoke.mjs`；脚本必须在团队 canary 上断言 Docker、同命令 exit 1→0、pytest 2/3→3/3、唯一源文件修改及三份 artifact 正文/hash。token 不得写进命令行、仓库或 `.env`。

## 3. GitHub Actions 中的 Python v0.4（完整修复与 artifacts）

- workflow：`.github/workflows/repo-rescue-actions-bridge.yml`，必须存在默认分支并从受保护 ref dispatch；checkout/setup/upload action 均固定 commit SHA，checkout `persist-credentials=false`，工作流并发固定为 1、超时 20 分钟、artifact 保留 1 天。
- runner 安装：`python -m pip install .`，并从 `sandbox/Dockerfile.python311` 构建 `repo-rescue-python:3.11`。
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
  - `REPO_RESCUE_JOB_MAX_JOBS=16`：全部未过期 job 记录上限，包含 queued、running 与 completed；一次 prepare→verify 闭环占两条记录，因此默认 TTL 窗口内最多约 8 个完整闭环。
  - `REPO_RESCUE_JOB_MAX_RESULTS=64`、`REPO_RESCUE_JOB_TTL_SECONDS=900`：进程内完成结果的独立数量上限与存活时间，超量先淘汰最旧结果；两项限制都不能替代生产数据库/队列。
  - `REPO_RESCUE_JOB_MAX_LONG_POLLS=8`：长轮询并发上限；等待在线程中完成，不能阻塞 ASGI 事件循环。
  - 本地/独立主机默认 Docker；只有整个 MCP 已处于一次性资源受限容器中时，才设置 `REPO_RESCUE_EXECUTION_BACKEND=direct`。
  - 无 API Key 路径不设置 `OPENAI_API_KEY`，由星辰模型调用异步 prepare/verify job 工具。
- 星辰普通命令托管不承担 Docker；完整仓库闭环由 GitHub Ubuntu runner 承担。workflow 只接受 gzip+base64 JSON，编码和解压后都不超过 55000 字节，验证补丁最多 3 个文件、每个 12000 字符；只把本次通过固定 workflow allowlist 的 slug 设置成 Python 运行时唯一 allowlist。
- `GITHUB_TOKEN`/`GH_TOKEN` 在 Python controller step 被清空；Docker 只收到 runner.py 中固定的非敏感环境变量，绝不接收 Actions token。依赖安装容器可使用受限 bridge 网络，真正测试容器使用 `--network none`。
- verify 成功必须在同一 artifact 中存在 `result.json`、`repair.patch`、`evidence.json`、`report.md`。Node 端必须校验 run/ref/head SHA、request ID、payload SHA、artifact digest、ZIP 安全边界、patch SHA 与 evidence 关键字段，再把三份真实正文返回星辰。
- Node job 映射是托管进程内实现：进程重启后远端 Actions run 可能继续，但旧 job capability 不可轮询，Agent 必须从新 prepare 完整重来。比赛部署避免中途重启；商业版必须持久化映射并改用 GitHub App installation token。

## 4. 星辰工作流

- 只绑定一个 Node v4 `platform` MCP，避免同名工具冲突和外部 Docker 服务依赖。
- 将 Agent instruction/reasoning 更新为 `prompts-v4.md`。
- 将 ReACT 最大循环轮数从历史值 10 调整为 16，并实测两阶段 start + 多次 20 秒轮询在该预算内完成；不得通过重复 start 节省轮数。
- 仓库任务固定走 `start_prepare_github_repair` → `get_repair_job` → `start_verify_github_patch` → `get_repair_job`；轮询不得重复启动任务。
- Python 的同步 prepare/verify 保留给本地/长调用宿主；公开星辰只使用 Node bridge 的三个异步仓库工具。
- 对外文案在公开验收前写“受限公开 Python 仓库 Beta”，不能写“任意 GitHub”。

## 5. 发布门槛

- `prompts-v4.md` 中适用于公开 Agent 的全部片段与仓库用例都要重新跑通；Node 直连烟测在服务侧单独执行。
- 片段至少 5/5 正常修复、安全拒绝 2/2、错误成功 0。
- 本地 Python 后端发布门槛：`run_interview_demo` 连续 3 次成功，patch 能通过 `get_repair_artifact` 读取；这两个工具不在公开 `platform` 工具面，不能写成公开 Agent 调用步骤。
- 团队控制的固定 canary 至少连续 2 次完成异步 prepare → verify 闭环；当前验收对应 `33352299438 → 33352330215` 与 `33352415731 → 33352460409`。第三方 canary 只能列为历史证据，不能替代团队控制仓库。
- GitHub Actions 的 Docker smoke 必须完成 baseline 失败 → 确定性 Repair Agent 修改 → 相同 pytest 命令通过；这只验收隔离编排，不替代真实模型/外部仓库证据。
- 保存页面截图、原始回答、commit、运行时间和 artifact SHA；失败记录也必须保留。

任何一项未满足时不把 v4 标为最终复赛版本。
