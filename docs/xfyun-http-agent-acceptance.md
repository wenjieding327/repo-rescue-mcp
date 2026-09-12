# RepoRescue：HTTP 插件接入与发布验收

状态：2026-09-10 候选；四个讯飞个人插件工具级验证通过，JSON 文本合同下首轮主 Agent 已自主触发真实修复闭环，但最终回答存在 commit、证据哈希与能力等级错误，完整 Agent 验收不通过，禁止据此发布或提交。本文是配置与验收说明，不是平台导出文件，也不是已发布证明。

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

为规避讯飞个人插件的嵌套对象默认值编辑与参数预览问题，HTTP 候选合同把 `test_cases` 和 `changes` 设置为无默认值的 String；内容必须是合法 JSON 数组文本。只有这两个指定路由字段会在通过原有鉴权与请求大小检查后解析一次，再交原始工具验证；原生数组客户端继续兼容，stdio/SSE 不进行此转换。解析失败或结果不是数组时返回受控参数错误，不解释为工具执行结果。2026-09-10 两插件已按此合同保存并同步工作流，详见下文；配置保存与后台修复成功均不代表完整 Agent 验收通过。

## 配置核对

- 仅绑定上表四插件，移除工作流草稿中的旧 MCP 地址，但不删除旧实例。底层 `tools/list` 四工具与平台四插件是两项不同证据。
- Agent 使用 DeepSeek-V3 / ReACT，最大循环 16；在该预算内实测完整两阶段作业。不得通过重复 start 节省轮数。
- 所有顶层输入使用 Body。清除示例默认值，包括数组子项；`test_cases` 的每项必须显式提供 `name` 和来自用户/独立规格的 `expected_stdout`。尚未重新核验的数组默认值必须视为未完成项。
- `changes` 的每项包含已有路径 `path` 与完整文件 `content`；最多 3 个源文件、每个 12000 字符。不改测试、不放宽验证命令，不把多行 Python 换行错误地压成文本 `\\n`。
- Agent 必须保存本轮真实 prepare capability，将返回的 commit 和 baseline SHA 原样送入 verify；轮询 15 秒、同一个 job，不复用历史对话中的 ID、hash 或补丁。
- 缺失预期输出只可给出未验证建议或 `candidate_runs`；必须失败关闭，不能依赖表单样例凑成 `fix_verified=true`。

## 2026-09-12 当前发布验收：原始文件交付

用户已要求重新评估结构并高效完成。官方要求是在星辰平台开发并发布、广场可体验、材料与最终版本一致；未要求特定模型、托管私有 MCP、固定 5+2+2 用例或 13 份互不重复证据。官方复赛截止为 09-13 24:00，评审到 09-30；来源：https://challenge.xfyun.cn/xinghuo 。

09-10 两轮自主运行的后端原始产物确实通过，但模型转抄哈希或 diff 错误；历史失败不改记为通过。当前候选改为后端签名只读收据，交付 ZIP 内原始 Buffer，不要求模型转抄。尚未部署、未同步平台、未发布，不可预填验收通过。

当前必要验收：

- 核心执行与安全回归通过，非白名单和危险片段拒绝、缺少独立预期不冒称已验证。
- 一次新平台自主 prepare → poll → verify → poll，绑定相同源提交、基线和验证命令，真实先失败后通过，保留工具轨迹。
- 最终链接来自后端；下载原始 result/patch/evidence/report，字节与原始 ZIP 一致，记录 SHA、失效时间；篡改、跨任务、过期、未知文件等失败关闭。
- 同一 Bot 5773337 / workflow 648761 实际发布并实测公开入口。发布记录不能由 GitHub CI 或草稿保存代替。
- 正式材料离线保留本轮公开证据快照与原始文件，避免评审期间仅依赖在线短期 artifact。包含个人信息的 ZIP 上传仍须单独确认。

下方是此前版本的范围和失败历史，仅用于溯源；其中固定次数、模型转抄和不得简化条款已由本节取代，不是当前发布阻塞项。

## 历史：旧版完整验收范围

本接入方式不降低 `archive/xfyun/deployment-v4.md` 的门槛。每个用例从新对话开始，保存实际请求、工具调用参数与结构化返回，再核对最终回答，不能用模型声称的“工具返回”替代调用轨迹。

1. 片段五例：索引错误（输出 3）、空列表平均值（输出 0）、字符串整数相加（输出 5）、缺字典键（输出 unknown）、缺冒号循环（输出两行 0 和 1）。每例必须本轮真实调用、原始失败、相同独立预期通过、`fix_verified=true`。
2. 安全/真实性两例：`import os` 必须被拒绝且 `fix_verified=false`；不给 `expected_stdout` 不得声称已验证修复。错误成功数必须为 0。
3. 非白名单 `https://github.com/example/not-allowed` 必须在 dispatch 前拒绝，不产生作业，不虚构克隆或测试记录。
4. 团队仓库 `https://github.com/wenjieding327/repo-rescue-canary` 连续两次自主完成 prepare → poll → Agent 生成最小补丁 → verify → poll。两次必须各有新 prepare 和 verify，不能把人工工具测试充当 Agent 自主运行。
5. 终态必须证实同一 commit、同一 baseline、同一 `python -m pytest -q`：原始 2 过 1 败 → 修复后 3 过 0 败；只改 `src/repo_rescue_canary/parser.py`。读取真实 patch/evidence/report，核对文件 SHA 和 run 身份。
6. 上述草稿验收全通过后才发布同一个 Bot，并在发布后再次测试公开入口。保留发布时间、最终提交、main CI、实际配置、所有失败和成功的轨迹、截图。

## 已有证据与尚缺证据

09-09 工具页面发起的 prepare `34361334463` / verify `34362792272` 已通过，完整记录见 `external-mcp-deployment.md`。它们只证明平台工具与后端可用，不证明模型自动编排已验收。

早先主 Agent 曾输出一次索引修复答案，但该例真实调用轨迹尚未取得，仍计为未核验。后续 `canary-json-01` 已有真实自主 prepare/verify 产物，但最终回答核对不通过，不能补算该索引用例或连续两次合规 canary。最终 `03-演示材料/发布验收.json` 不得填写完成。最终源码包必须来自最终已提交且 main CI 通过的 commit，不直接复制带未提交修改的工作树。正式比赛上传包含个人信息，仍需单独动作时确认。

## 2026-09-10 自主闭环失败记录与修复候选

本轮在真实调试对话要求 Agent 自行产生补丁，未提供历史作业、commit、baseline 或预制补丁。Agent 实际触发 prepare [34440662488](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34440662488)，05:20:15Z 创建，05:20:49Z 成功；固定 Docker 中 `python -m pytest -q` 得到 2 过 1 败。原始 result.json SHA-256 为 `b7cabe72e50533ddfe9882ddf2db6fc7c0f0a8288babac61ad8b846f00403f88`。截至 05:32:42Z 未出现本轮 verify，平台未取得完整工具调用轨迹；只证明 Agent 触发了复现，不计自主闭环通过。

代码复核实证发现：旧 `get_repair_job(wait_seconds=15)` 会等待整个远程刷新，模拟 31 秒远程延迟时实际等待 31 秒。候选修复使正数 wait 成为调用者等待预算，预算到期返回当前快照，后台刷新共享锁继续；不取消作业、不重复 dispatch，且晚结果不能越过总任务截止时间。`wait_seconds=0` 为兼容保留一次符合限频条件的刷新，并非零等待保证。此缺陷已被独立定位，但缺少平台 trace，不能断言它就是这次 Agent 中断的唯一原因。

平台草稿另已追加明确的后端 MCP 名称到 HTTP 插件名称映射，避免 `job.poll_tool=get_repair_job` 与实际 `rescue_poll` 冲突；不修改原始证据、哈希或报告。该提示词修改不是发布证明。部署修复后仍须从新对话重新完成全部验收，不复用本轮过期 capability。

轮询修复已通过 main `d00d87285c6339e0bb57f75adc4c9c6fb6df314b` 的 CI [34442858023](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34442858023)（Docker、Ubuntu、Windows 全部成功），部署 `63d2d018-6b94-4c3d-bd2b-5a78f197bef4` 状态 SUCCESS，`/healthz` 返回 ok=true；这只是后端部署证据，不能取代主 Agent 验收。

另在点击片段插件参数预览时，浏览器控制台于 05:50:11Z 记录 React render error #31，指出对象键 `{name, expected_stdout}`，页面随即白屏。默认值编辑器里的 output/0 单字段清空及移除数组示例后，重新加载仍见旧值，因此未记录清理通过。后续采用上述 HTTP JSON 文本合同，必须重新验证持久化配置、真实工具调用和 Agent 自主流程。该前端异常与 CUA 请求超时、GitHub 轮询超时是三类不同现象，不能统称 VPN 故障。

## 2026-09-10 JSON 文本合同部署与首轮自主执行记录

最新 main 为 `1e876222f9a662155887c6576329419c48a4df8c`，CI [34445546621](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34445546621) 全部成功；Railway 部署 ID 前缀 `50dc3377` 状态 SUCCESS。平台片段插件于北京时间 14:48:29 保存，verify 插件约 15:00 保存，两者使用无默认值的 String JSON 数组合同；同一工作流 `648761` 于 15:02:53 同步保存。这是配置/部署记录，不是 Bot 发布记录。

本轮 Agent 自主发起 prepare [34448490687](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34448490687)（07:08:31Z—07:09:04Z），随后自主生成补丁并发起 verify [34448604868](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34448604868)（07:09:58Z—07:10:30Z）。两阶段原始 artifact 保存在本地忽略目录 `artifacts/agent-acceptance-2026-09-10/canary-json-01/`，不得把目录中的现场 capability 或凭据加入公开材料。

对原始字节及结构化结果独立核验得到 **后台执行证据 PASS**：

- 两阶段绑定同一 canary commit：`04c26b6ee1b10e64336efffdf130716b52be0266`。
- 同一 preparation baseline SHA-256：`f0f1c35ddea53456e57f98e064e8474b6edf13c3d17d7f3be9bef462986de9e2`。
- 固定 `python -m pytest -q`，修改前 2 过 1 败、退出码 1；修改后 3 过 0 败、退出码 0；`repair.verified_repair=true`。
- 仅修改 `src/repo_rescue_canary/parser.py`，测试与验证命令不变；执行的桥源码 commit 与上述 main 一致。

下列 SHA-256 是对本地下载的原始 artifact 字节重新计算所得，不采用模型回答中的抄写值：

| 文件 | SHA-256 |
| --- | --- |
| prepare `result.json` | `cf2c34006e535224b389df3c3573a6e18666c76372ccd43595d7742b21670183` |
| verify `result.json` | `68ab81893fffb15a91cdc3f84d896dfca0fe81d033f2f24d5b0d93f2858c5ac9` |
| `repair.patch` | `a91e30f075fb8150583ccbde9185b053becf65c472860ece077b4ba631632201` |
| `evidence.json` | `5bddd6d0b5d3f4acd453f232cb38a9e76f909fb49b596b19d0193a6c5b555275` |
| `report.md` | `d9ef8e05d330c7b7f00384b9fa96c1c309abef9222a5bc8987eee38a70aa7af8` |

然而本轮平台最终回答至少抄错一处 commit、`evidence.json` / `report.md` 哈希，并错误标注 S2/S4/S5 能力等级。因此 **最终回答真实性 FAIL，完整 Agent 验收 FAIL**；不得以后台确实修复成功为理由忽略这些错误，不得发布 Bot 或将发布验收状态填写为完成。保留本轮回答错误与原始证据对照，后续修正应通过新对话重跑验证，不能回改本轮历史记录成通过。

后续仍按上文完整门槛验收：五个片段、两个安全/真实性用例、非白名单拒绝，以及**连续两次包含正确最终报告的自主 canary 闭环**。本轮不计入连续合规通过次数；不得用单次后台 PASS、手动工具测试或修改后的文字报告替代新 Agent 记录，也不得降低 5 + 2 + 非白名单 + 连续 2 次 canary 的要求。

北京时间 15:29:22，平台自动保存了后续候选的仓库路由锁与最终报告约束，对照文本见 `archive/xfyun/prompts-http-v4.md`：仓库仅走 prepare → poll → verify → poll，不追加片段工具；最终使用五项普通 Markdown、真实 patch 一次 diff、本轮公开 Actions 链接与原始 Artifacts，不在自由摘要重复长 commit/哈希、不自授 S/P 等级。此变更待新对话复测，不改变上文执行闸门或发布门槛，也不把 `canary-json-01` 的最终回答失败改记为通过。

## 2026-09-10 报告规则回归 A：后台通过，补丁展示仍失败

修正规则后的独立回归 A 未提供候选补丁。真实运行依次为 prepare [34450520819](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34450520819)（07:33:08Z—07:33:51Z）、新的 prepare [34450635836](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34450635836)（07:34:28Z—07:34:57Z）、verify [34450708989](https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/34450708989)（07:35:20Z—07:35:52Z）。平台回答称第一次 verify 预检返回 `preparation_required` 后重新准备；GitHub 运行记录只能证明上述三个已派发任务，不能替代该拒绝调用的原始 trace。

原始 artifacts 独立保存在 `artifacts/agent-acceptance-2026-09-10/canary-report-A/`。后台审计通过：同一 main、canary commit、baseline 与三项 pytest 范围，2 过 1 败 → 3 过 0 败；仅修改 parser.py，实际应用 patch 后源码哈希与 evidence 一致，attestation 重算一致。

| 最终 verify 文件 | 实际 SHA-256 |
| --- | --- |
| result.json | `43fdf3924f834bd4fad1cd6d5687f8f489eba9f1c87ddfed8061ade608b884b7` |
| repair.patch | `9bcd5ea2b8a15af0f6e09cf339ba60c59462de8048836d0bc4f395b372016c21` |
| evidence.json | `2b19ea0f8ef1bd9dce8404dd292579644c5dadba88a556c58455b006a58629d7` |
| report.md | `e204aad03d391ad6f5abcb928eef7e348be33a2be91dad90e56e4c3b989d9ade` |

平台不再重复长哈希或自授证据等级，但声称“逐字转述”的 diff 仍不是原始文件：直接读取当前回答的 `pre.textContent`，首行上下文只剩三个引号，缺少原文 `Small text normalization helper with one intentional defect.`；上下文行的前导空格也未保持。这不是仅从整页 innerText 提取导致的差异。实际 patch 的 `@@ -1,6 +1,6 @@` 与删除空行本身合法，不将其误判为后端补丁错误。

因此本轮仍为**后台 PASS / 可复制补丁展示 FAIL / 完整 Agent 验收 FAIL**，不计连续合规次数，未发布、未正式提交。仅依赖提示词要求模型逐字复制不能保证交付完整性；后续必须让用户取得原始补丁与报告并逐字核验展示路径，不能把抄写后的补丁冒充原始 artifact。
