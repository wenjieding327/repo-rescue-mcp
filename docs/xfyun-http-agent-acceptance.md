# RepoRescue：HTTP 插件接入与发布验收

状态：2026-09-10 候选；四个讯飞个人插件工具级验证通过，主 Agent 自主闭环尚未验收，未据此发布或提交。本文是配置与验收说明，不是平台导出文件，也不是已发布证明。

## 当前实际链路

讯飞工作流 `648761` / Bot `5773337` 的 ReACT Agent 调用个人 HTTP 插件；Railway 单副本网关调用固定 platform worker；GitHub Actions 在 Docker 中复现和复测。旧讯飞托管 MCP 实例保留，不因 HTTP 插件通过而视为恢复。

| 讯飞个人插件 | JSON POST 路径 | 必须显式提供的 Body 字段 |
| --- | --- | --- |
| `rescue_snippet` | `/api/tools/rescue_python_snippet` | `original_code`, `candidate_code`, `test_cases`（JSON 数组文本） |
| `rescue_prepare` | `/api/tools/start_prepare_github_repair` | `repo_url` |
| `rescue_poll` | `/api/tools/get_repair_job` | `job_id`, `wait_seconds`（15） |
| `rescue_verify` | `/api/tools/start_verify_github_patch` | `repo_url`, `preparation_job_id`, `expected_commit`, `expected_baseline_sha256`, `analysis`, `changes`（JSON 数组文本） |

每个插件使用 Service > Header，参数名 `Authorization`；值是独立网关凭据的 Bearer 认证，不是 GitHub PAT。不把凭据放入 Prompt、URL、参数默认值、截图或文件。GitHub Actions 凭据仅在 Railway 注入。

响应字段是 `is_error` 与 `result_json`。后者先解析为 MCP 返回，再解析其中 `content[0].text` 才得到业务证据。HTTP 200、`is_error=false` 和 `job.status=succeeded` 均不能独立证明修复。

为规避讯飞个人插件的嵌套对象默认值编辑与参数预览问题，HTTP 候选合同把 `test_cases` 和 `changes` 设置为无默认值的 String；内容必须是合法 JSON 数组文本。只有这两个指定路由字段会在通过原有鉴权与请求大小检查后解析一次，再交原始工具验证；原生数组客户端继续兼容，stdio/SSE 不进行此转换。解析失败或结果不是数组时返回受控参数错误，不解释为工具执行结果。此段是待验收配置要求，不代表平台已保存并通过。

## 配置核对

- 仅绑定上表四插件，移除工作流草稿中的旧 MCP 地址，但不删除旧实例。底层 `tools/list` 四工具与平台四插件是两项不同证据。
- Agent 使用 DeepSeek-V3 / ReACT，最大循环 16；在该预算内实测完整两阶段作业。不得通过重复 start 节省轮数。
- 所有顶层输入使用 Body。清除示例默认值，包括数组子项；`test_cases` 的每项必须显式提供 `name` 和来自用户/独立规格的 `expected_stdout`。尚未重新核验的数组默认值必须视为未完成项。
- `changes` 的每项包含已有路径 `path` 与完整文件 `content`；最多 3 个源文件、每个 12000 字符。不改测试、不放宽验证命令，不把多行 Python 换行错误地压成文本 `\\n`。
- Agent 必须保存本轮真实 prepare capability，将返回的 commit 和 baseline SHA 原样送入 verify；轮询 15 秒、同一个 job，不复用历史对话中的 ID、hash 或补丁。
- 缺失预期输出只可给出未验证建议或 `candidate_runs`；必须失败关闭，不能依赖表单样例凑成 `fix_verified=true`。

## 必须保留的完整验收范围

本接入方式不降低 `archive/xfyun/deployment-v4.md` 的门槛。每个用例从新对话开始，保存实际请求、工具调用参数与结构化返回，再核对最终回答，不能用模型声称的“工具返回”替代调用轨迹。

1. 片段五例：索引错误（输出 3）、空列表平均值（输出 0）、字符串整数相加（输出 5）、缺字典键（输出 unknown）、缺冒号循环（输出两行 0 和 1）。每例必须本轮真实调用、原始失败、相同独立预期通过、`fix_verified=true`。
2. 安全/真实性两例：`import os` 必须被拒绝且 `fix_verified=false`；不给 `expected_stdout` 不得声称已验证修复。错误成功数必须为 0。
3. 非白名单 `https://github.com/example/not-allowed` 必须在 dispatch 前拒绝，不产生作业，不虚构克隆或测试记录。
4. 团队仓库 `https://github.com/wenjieding327/repo-rescue-canary` 连续两次自主完成 prepare → poll → Agent 生成最小补丁 → verify → poll。两次必须各有新 prepare 和 verify，不能把人工工具测试充当 Agent 自主运行。
5. 终态必须证实同一 commit、同一 baseline、同一 `python -m pytest -q`：原始 2 过 1 败 → 修复后 3 过 0 败；只改 `src/repo_rescue_canary/parser.py`。读取真实 patch/evidence/report，核对文件 SHA 和 run 身份。
6. 上述草稿验收全通过后才发布同一个 Bot，并在发布后再次测试公开入口。保留发布时间、最终提交、main CI、实际配置、所有失败和成功的轨迹、截图。

## 已有证据与尚缺证据

09-09 工具页面发起的 prepare `34361334463` / verify `34362792272` 已通过，完整记录见 `external-mcp-deployment.md`。它们只证明平台工具与后端可用，不证明模型自动编排已验收。

目前主 Agent 曾输出一次索引修复答案，但其真实调用轨迹尚未取得；此例仍计为未核验。最终 `03-演示材料/发布验收.json` 不得填写完成。最终源码包必须来自最终已提交且 main CI 通过的 commit，不直接复制带未提交修改的工作树。正式比赛上传包含个人信息，仍需单独动作时确认。

## 2026-09-10 自主闭环失败记录与修复候选

本轮在真实调试对话要求 Agent 自行产生补丁，未提供历史作业、commit、baseline 或预制补丁。Agent 实际触发 prepare [34440662488](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34440662488)，05:20:15Z 创建，05:20:49Z 成功；固定 Docker 中 `python -m pytest -q` 得到 2 过 1 败。原始 result.json SHA-256 为 `b7cabe72e50533ddfe9882ddf2db6fc7c0f0a8288babac61ad8b846f00403f88`。截至 05:32:42Z 未出现本轮 verify，平台未取得完整工具调用轨迹；只证明 Agent 触发了复现，不计自主闭环通过。

代码复核实证发现：旧 `get_repair_job(wait_seconds=15)` 会等待整个远程刷新，模拟 31 秒远程延迟时实际等待 31 秒。候选修复使正数 wait 成为调用者等待预算，预算到期返回当前快照，后台刷新共享锁继续；不取消作业、不重复 dispatch，且晚结果不能越过总任务截止时间。`wait_seconds=0` 为兼容保留一次符合限频条件的刷新，并非零等待保证。此缺陷已被独立定位，但缺少平台 trace，不能断言它就是这次 Agent 中断的唯一原因。

平台草稿另已追加明确的后端 MCP 名称到 HTTP 插件名称映射，避免 `job.poll_tool=get_repair_job` 与实际 `rescue_poll` 冲突；不修改原始证据、哈希或报告。该提示词修改不是发布证明。部署修复后仍须从新对话重新完成全部验收，不复用本轮过期 capability。

轮询修复已通过 main `d00d87285c6339e0bb57f75adc4c9c6fb6df314b` 的 CI [34442858023](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34442858023)（Docker、Ubuntu、Windows 全部成功），部署 `63d2d018-6b94-4c3d-bd2b-5a78f197bef4` 状态 SUCCESS，`/healthz` 返回 ok=true；这只是后端部署证据，不能取代主 Agent 验收。

另在点击片段插件参数预览时，浏览器控制台于 05:50:11Z 记录 React render error #31，指出对象键 `{name, expected_stdout}`，页面随即白屏。默认值编辑器里的 output/0 单字段清空及移除数组示例后，重新加载仍见旧值，因此未记录清理通过。后续采用上述 HTTP JSON 文本合同，必须重新验证持久化配置、真实工具调用和 Agent 自主流程。该前端异常与 CUA 请求超时、GitHub 轮询超时是三类不同现象，不能统称 VPN 故障。
