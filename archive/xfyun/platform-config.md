# 讯飞平台配置快照

快照时间：2026-07-23（Europe/London）

> **历史恢复快照，不是 v4 上线证明。** 本页保留 2026-07-23 的 v3 配置，便于回滚与核对旧工作流；其中“发布中”、最大循环 10、旧 MCP ID 与“v4 尚未创建/绑定”只描述当时状态。最终 v4 是否已发布、四工具是否发现及平台 canary 是否通过，只以复赛材料 `03-演示材料/发布验收.json` 和对应原始截图为准。

## Agent

- 名称：RepoRescue｜AI代码急救与项目复现
- Bot ID：`5773337`
- 发布页面：<https://agent.xfyun.cn/agentbuilder/chat?botId=5773337>
- 编辑页面：<https://agent.xfyun.cn/agentbuilder/work_flow/648761/arrange?botId=5773337>
- 作品说明：代码看不懂、报错修不好，或整个 GitHub 项目跑不起来？直接粘贴代码、错误或仓库地址，RepoRescue 会主动解释、生成可复制的修复代码，并真实运行修改前后结果；从单段代码急救到科研项目复现，一个入口完成。
- 状态：发布中

## 工作流

- 工作流编号/导出 ID：`648761`
- Flow ID：`7485839455273943040`
- APPID：`e8d169d3`（RepoRescue科研复现引擎）
- 工作流内部 appId：`12a0a7e2`
- 模型：DeepSeek-V3
- 调用策略：ReACT MCP
- 最大循环轮数：10
- 自动保存确认时间：2026-07-23 03:49:27
- 官方导出地址（需登录）：<https://agent.xfyun.cn/xingchen-api/workflow/export/648761>

## 当前 MCP

- 名称：RepoRescue｜代码急救轻量验证版
- 英文名：`repo-rescue-verified-code-v3`
- MCP ID：`7485884555159117824`
- SSE：<https://xingchen-api.xf-yun.com/mcp/7485884555159117824/sse>
- 固定源码包：<https://github.com/wenjieding327/repo-rescue-mcp/archive/a80450aabbeb5e47050282f0b05bad96200c3c68.tar.gz>
- 固定源码提交：`a80450aabbeb5e47050282f0b05bad96200c3c68`

历史 v2 MCP ID 为 `7485881572182695936`。它曾在冷启动时返回 504；提交 `a80450a` 将 pytest 改为按需加载后部署为 v3。

## v4 复赛目标配置（尚未创建/绑定）

- 形态：星辰私有托管 Node stdio MCP，不发布 MCP 广场；对外只发布完成验收的 Agent。
- toolset：专用 `repo-rescue-mcp-platform` bin 在代码中强制 `REPO_RESCUE_NODE_TOOLSET=platform`，只暴露片段验证和三个 GitHub Actions 异步仓库工具。
- Actions 控制仓库：`wenjieding327/repo-rescue-mcp`。
- workflow：`.github/workflows/repo-rescue-actions-bridge.yml`。
- ref：`main` 已启用分支保护、线性历史、禁止强推/删除，并要求 Ubuntu、Windows、Docker 三项 CI；部署值不能来自用户参数。
- 目标仓库 allowlist：`platform-entry.mjs` 固定列表与 workflow 固定列表必须完全一致；当前比赛候选为 `wenjieding327/repo-rescue-canary`、`wenjieding327/repo-rescue-mcp`。
- 凭据：fine-grained PAT 只授予上述控制仓库 Actions read/write；值不写入本快照。星辰托管表单仅声明 `REPO_RESCUE_GITHUB_TOKEN` 且不提供默认值，只在私有 MCP 绑定团队 APPID 时注入。使用最短可用有效期，仅可信管理员可查看；比赛结束或疑似泄漏时立即 revoke 并替换。缺少 token 时工具必须 fail closed；ref、allowlist 及其他非秘密配置的漂移由专用入口覆盖并由测试阻断。
- 专用 bin 固定边界：1 个活动 job（与 workflow 的全局单并发一致）、每分钟 3 次且每小时 12 次 start、2 秒最小轮询、15 分钟结果 TTL、2 分钟 dispatch 发现、22 分钟最大 run、15 秒 GitHub API、30 秒 artifact 及 6 秒片段 worker 超时；workflow 自身限制 20 分钟，artifact 保留 1 天。

GitHub Actions live prepare→verify 已在受保护 `main` 的 workflow 提交 `27754b066969ab3cd3f0a171eeabac46f186b6c1` 上通过；第一轮 prepare `33352299438` → verify `33352330215`，第二轮 prepare `33352415731` → verify `33352460409`，团队 canary 的同一 pytest 命令均 exit 1→0。生产修复链的运行时基线为 `acd2b1c01a56e1cb825dea640e742dcaba347222`，CI `33352931860` 三项全绿；随后候选提交 `e11cf82f4efe00f7ee4e9f78e6e7f67fb9d47d08` 只修正证据文档与 CI stdio smoke 的协议握手，不改变 Actions bridge、workflow、Docker 或 Python verifier，且 `main` CI `33355251695` 的 Ubuntu、Windows、Docker 再次全绿。此配置仍须在私有 MCP 创建成功、Agent 四工具发现与平台端闭环通过后，才能替换上方“当前 MCP”并标为已发布。

## 可迁移资产

- 核心 MCP 服务与复赛固定入口：`stdio-server.mjs`、`platform-entry.mjs`
- Python 沙箱与测试：`sandbox/`、`tests/`
- OpenClaw 迁移说明：`OPENCLAW.md`
- 可复用 Skill：`skills/verified-code-rescue/`
- 讯飞原始编排：`archive/xfyun/workflow-648761.yml`

平台专属节点不能直接当成 OpenClaw Skill 使用；可迁移的是提示词、流程、测试案例和独立 MCP 能力。
