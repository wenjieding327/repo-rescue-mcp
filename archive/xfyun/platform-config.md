# 讯飞平台配置快照

快照时间：2026-07-23（Europe/London）

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

## 可迁移资产

- 核心 MCP 服务：`stdio-server.mjs`
- Python 沙箱与测试：`sandbox/`、`tests/`
- OpenClaw 迁移说明：`OPENCLAW.md`
- 可复用 Skill：`skills/verified-code-rescue/`
- 讯飞原始编排：`archive/xfyun/workflow-648761.yml`

平台专属节点不能直接当成 OpenClaw Skill 使用；可迁移的是提示词、流程、测试案例和独立 MCP 能力。
