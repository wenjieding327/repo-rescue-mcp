# 独立验证门禁（同一工作流草稿接线中）

状态：2026-10-04。同一 workflow `648761` / Bot `5773337` 的 draft 已接入三个生成的 Python 节点和一个独立执行插件。平台片段正负例及新的 canary 仓库闭环已取得真实证据，但参数错误的恢复路径仍在修复与验收，尚未据此发布最终版本。生成文件、通过本地测试或回放历史 fixture，都不能替代新的平台调用轨迹，也不得把历史失败改记为通过。

## 三个 paste-ready 节点，底层四个模块

运行 `node scripts/build-xfyun-code-nodes.mjs` 生成可整段粘贴的三个文件。不要把四个底层源码各自当成四个独立平台节点；最终报告文件已经封装片段、仓库两种判定，不需再插入两个报告节点。

| 生成文件（`dist/xfyun-code-nodes/`） | 平台输入与输出 | 职责 |
| --- | --- | --- |
| `request-router.py` | `main(input)`：input 直接引用开始节点用户输入；key0 为冻结上下文 JSON | 保守提取原代码或单仓库，冻结完整 stdout、整程序用例及 UTC 请求起点。多仓库、仓库与代码混合或边界不明转为 advice。底层为 `scripts/xfyun-request-router.py`。 |
| `candidate-binding.py` | `main(input, input2)`：input 直接引用 router key0，input2 为候选 Agent output；key0 为 request_json | 只接受候选代码、待查 job ID 或 advice 之一；冻结用户原代码、oracle、仓库和请求起点，拒绝模型覆盖及混杂字段。底层为 `scripts/xfyun-candidate-binding.py`。 |
| `final-report.py` | `main(input, input2)`：input 引用同次 binding key0，input2 直接引用独立插件 result_json；key0 为最终报告 | 根据绑定路由选择片段或仓库门禁，固定输出真实证据与结论；advice 输出未执行。底层同时封装 `scripts/xfyun-snippet-report.py` 和 `scripts/xfyun-repository-report.py`。 |

三个生成节点均返回平台通用字段 key0（String）、key1（空数组）、key2（含 key21 的对象）；有效路由或诊断状态也会写入 key2.key21，但最终用户答案应引用 final-report.key0，而不是 Agent output。

底层四个模块均使用 Python 标准库，不读取凭据、用户文件或网络，不执行用户/候选字符串。binding 仅做 AST 解析与 print 调用数量检查，不证明语义，也不能防止全部硬编码；原代码语法错误时跳过该数量检查并披露。job ID 的格式不证明归属或成功。来源鉴权和同次调用参数/返回关联仍由平台与网关负责；这些节点不是身份认证或收据验签服务。

## 完整 stdout 与证据来源

同一整段程序依次打印三行 `-2\n4\n0` 时，用一个 `complete_program` 用例的 `expected_stdout` 保存全部三行，不拆成三次程序运行并分别要求单行输出。F-S02 历史错误正是把完整输出与单行 oracle 混淆；F-S04 的原程序在首个打印处抛出 KeyError，真实 before stdout 为空，不得补写未执行的第二行。

预期只能从本轮用户显式完整 stdout 或独立规格冻结；router 支持 JSON 字符串 `expected_stdout` 及声明行数的完整输出。LLM 不得生成、补全、改写或回填 oracle。没有预期时保留一个含空 stdin、无 `expected_stdout` 的整程序用例；执行结果最多降级为候选已运行，不能据此宣称修复已验证。比较规则为 CRLF 转 LF 后按后端 trimEnd 比较完整 stdout，不从日志抽取某一行。

工具执行节点必须独立于候选生成 Agent。final-report 直接解析插件 `result_json` → `content[0].text`，不能搜索或解析 Agent 的 `REASONING_CONTENT`、回答、DOM 截图或模型制造的“工具 JSON”作为生产可信证据。HTTP 200、`is_error=false`、`ok=true`、`job.status=succeeded` 或非空链接均不能单独决定通过。模型可以提出修复候选，但不能决定最终证据区或验证结论。

## 当前单链与独立 rescue_execute 插件

当前 draft 接线方案为：开始 → request-router → 候选/仓库编排 Agent → candidate-binding → 独立 rescue_execute 插件 → final-report → 固定模板结束。它不要求在平台增加 snippet-report、repository-report 两个节点，也不把报告再次交给 LLM 改写。

运行 `node scripts/build-http-plugin-contracts.mjs` 生成 `dist/http-plugins/rescue_execute.json` 及 `rescue_execute.instructions.txt`。该插件操作名为 `rescue_execute`，固定 POST `/xfyun/execute`，唯一顶层输入为必填 Body `request_json:String`。直接绑定 candidate-binding.key0，不能绑定 Agent 回答或 reasoning；不要给它填写默认值、示例代码、旧 job ID 或模型生成的预期。

鉴权沿用现有独立网关 Bearer 凭据：平台 Service > Header 中参数名为 Authorization。凭据不进入请求 JSON、Prompt、URL、合同、默认值或截图。该路由复用既有 Origin 拒绝、1 MiB 请求上限、共享限流和 worker 容量门禁，不增加 MCP 工具或仓库派发权限。

| request_json 内部路由 | 实际动作 | 用户可见界限 |
| --- | --- | --- |
| snippet | 仅向既有 `rescue_python_snippet` 传入冻结原代码、候选及原生 test_cases 数组 | 只有完整独立 oracle、同用例原始失败与候选通过才能判片段修复已验证；不代表整个仓库已修复。 |
| github | 仅对已有 job ID 调用 `get_repair_job`，固定 wait_seconds=15 | 这是一次有等待预算的轮询，可提前返回；不派发 prepare/verify，不自动重复轮询。仍 pending 时固定报告未完成，不补写成功。 |
| advice | 网关返回固定未执行 MCP 结果；不 dispatch worker | 明确未执行、未验证；模型自述成功不能进入最终报告。 |

内部 request_json 必须是严格 JSON 对象且只含对应路由字段，拒绝重复键、隐藏 tool name 和混杂文字。snippet 的 test_cases 在这个内部对象中是数组，不是再次编码的数组字符串；最外层 HTTP Body 才用 request_json 字符串承载它。

完整仓库修复仍需既有 prepare → poll 至终态 → 生成最小补丁 → verify → poll 的异步流程，由仓库编排 Agent 使用已有插件完成，并返回本轮真实 verify job ID 给 binding。准备 capability、commit、baseline 必须绑定真实本轮结果，不复用历史任务或重复 start 代替轮询。独立 rescue_execute 再查询该 ID，final-report 校验冻结仓库、ID、请求起点、新鲜度、同命令 Docker pytest 失败到通过、未缩减范围与原始 artifact 哈希；缺证据、过期、排队或失败均不能变绿。

同一 workflow `648761` 的单链输入引用、独立插件和结束模板已用真实调用检查。2026-10-04 的 G-CANARY-1004 从新 prepare 开始，经 verify 和独立 poll，固定目标提交 `04c26b6ee1b10e64336efffdf130716b52be0266`、同一 `python -m pytest -q`：原始 2 passed / 1 failed，候选 3 passed / 0 failed，仅修改 `src/repo_rescue_canary/parser.py`。控制器 Actions 成功不等于修复成功，结论来自实际 repair/evidence。上一次 G-CANARY-final 因 changes 编码错误而 HTTP 400 中断的失败记录仍保留，不改记为通过。

HTTP 直接工具的两个数组文本字段（test_cases、changes）仍仅接受原生数组或恰好一次 JSON 解码后的数组，不接受递归解码、对象或伪造工具名。错误字符串现以 HTTP 200 的声明工具 envelope 返回 `is_error=true`、`status=invalid_request`、`executed=false`、`verified_repair=false`，无 job / receipt；这是可被 Agent 读取的拒绝，不是成功。拒绝发生在 worker 派发前，不消费 prepare。Agent 仅在该明确错误且 `correction_allowed=true` 时纠正编码一次；其他 start 错误或响应丢失不得盲目重复派发。鉴权、大小、Origin、协议格式等传输错误仍保留原 HTTP 拒绝状态。新恢复路径部署和平台验收通过后，才允许发布；保存 draft 不等于发布。

## 本地验证与发布边界

`verification-report.mjs` 是纯离线 L1 片段校验模块，不是已接入生产的工具、代码执行器或仓库验收器。不要通过 npx 下载/执行额外包来替代可信平台插件或生产门禁。

npm test 现已注册以下新增回归：`tests/verification-report.test.mjs`（片段证据门禁）、`tests/xfyun-execute.test.mjs`（独立执行路由及本地真实 Pyodide 正负例）、`tests/http-plugin-contracts.test.mjs`（无凭据 OpenAPI 合同及旧合同兼容）、`tests/xfyun-code-nodes.test.mjs`（三个生成节点的编译、接口与离线绑定/报告）。四个 `tests/test_xfyun_*.py` 文件由 unittest discovery 和 pytest 自动发现，不需增加第二个 Python 主测试入口。

复测命令（使用已安装的本地 Node/Python，禁止为此下载依赖）：

```text
npm test
python -m unittest discover -s tests -p "test_*.py"
python -m pytest
```

可将 `REPO_RESCUE_VERIFICATION_FIXTURES` 设置为本地冻结 `verification-20261003` 目录，启用对历史平台结构化调用与历史本地执行 JSON 的离线回放。回放只是在当前测试进程中读取旧证据验证判定逻辑，不是重新执行这些历史用例，也不能认证新的生产调用。模拟仓库证据只验证门禁规则，不是新的 Actions 运行。

必须分清本地真实代码执行、合成单元 fixture、历史证据回放和新的平台自主运行。前三类均不能证明当前星辰草稿接线可用或公开入口已经发布；新增回归后的最终测试计数以当前完整测试日志为准，不能沿用旧的阶段性计数冒称现版通过。

最终用户报告应如实区分“片段修复已验证”“缺少完整预期，未验证”“候选仍失败”“仓库作业尚未终止”和“未执行建议”，并注明只覆盖本轮代码、固定提交与记录测试范围。收据仅交付后端原始文件；报告不拼接链接、不重新抄写补丁，也不自行验签。

发布前仍需取得本轮新的平台独立工具轨迹，确认三个节点和独立插件的冻结参数绑定、完整 stdout、失败关闭及异步仓库闭环，并核验同一 Bot 的实际发布和公开入口。当前 UI 接线及完整平台验收未完成，不得更新发布完成状态或提交材料为通过。
# 2026-10-04 follow-up: bounded candidate syntax preflight

The deployment follow-up canary's first real verification failed: the generated
replacement introduced a fourth closing docstring quote. The verifier recorded
`SyntaxError`, zero passing tests and `verified_repair=false`. The platform then
terminated the conversation during a fresh second preparation; the precise
platform termination cause is not established. This failed run is retained,
not replaced by the earlier successful run.

Python replacements now receive a disposable Pyodide **compile-only** check
before Actions dispatch. The code object is never evaluated: imports, raises,
file operations and loops in the candidate do not execute. Rejection reports
only error type and line/column, not source or credentials; it does not consume
the preparation capability or mint a job/receipt. Worker failure is fail-closed.
This preliminary grammar check does not prove target-version compatibility or
repair correctness; the existing Docker pytest verifier remains authoritative.

The draft Agent permits one correction of an explicit pre-dispatch syntax
rejection. It dispatches at most one actual verification per conversation and
returns the terminal job to the independent report node on failure, rather than
starting another complete cloud preparation inside that conversation. Transport
failure is not permission to duplicate a start. Final public acceptance remains
pending a fresh run on this deployment and the same published Bot.
