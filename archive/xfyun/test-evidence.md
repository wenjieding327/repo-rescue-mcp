# 测试与证据

## 2026-08-30 v0.4.0 候选版（尚未重新发布）

本节只证明当前源码候选，不代表公开星辰 Agent 已经使用这些能力。

- `npm test`：40/40 通过；除 snippet 隔离/fail-closed/最小 npm 包外，新增 20 个 GitHub Actions bridge mock 测试，覆盖 2026-03-10 dispatch、私有 job ID 与公开 request nonce 分离、真实 API 的三种合法 workflow path 形态及错误 ref 拒绝、run/head/payload/artifact digest 绑定、安全 ZIP、真实 patch/evidence/report 正文、prepare capability 一次消费、并发 reservation、分钟/小时配额、严格部署 allowlist、POST 不确定态不重派、429/5xx/断流重试、请求硬超时、stale job 回收和 token 脱敏。snippet child 现在使用显式最小环境，PAT、Actions 配置、模型 key 和 `NODE_OPTIONS` 均不继承。
- `npm run benchmark`：14/14 预期状态通过，错误成功 0。
  - 已验证修复：IndexError、ZeroDivisionError、TypeError、KeyError、SyntaxError、无限循环。
  - 正确降级或拒绝：不安全导入、错误候选、原代码本来通过、超过 4 个用例、缺少预期输出、随机状态复放、结果序列化污染、私有运行时属性逃逸。
- `.venv\Scripts\python.exe -m pytest`：155/155 通过。其中 12 项直接覆盖 Actions runner 的 strict base64/gzip、55000 字节双边界、固定 allowlist、mode/request/run/head 绑定、最多 3×12000 字符补丁、token 清除、强制 Docker、成功/失败 result artifact，以及 artifact 三件套/超限清理；另有 Docker 探测超时回归，确保 `docker info` 卡住时返回可控不可用而不是 traceback。
- Python MCP stdio、Streamable HTTP、真实 SSE 握手均通过：发现 11 个工具，`serverInfo.version=0.4.0`；内置 Demo 为 `verified_repair`；`get_repair_artifact` 可读取完整 patch。
- 新增无独立模型 API Key 的短调用路径：`start_prepare_github_repair` → `get_repair_job` → 星辰模型生成有界完整文件替换 → `start_verify_github_patch` → `get_repair_job` 同命令复验。任务 ID 256 bit、单 worker、活动队列与结果缓存分别限额，长轮询不阻塞 ASGI 事件循环。
- 依赖安装失败现在可进入 Repair Agent；修复现有依赖清单后重新分析并在新隔离验证中重新安装。若基线 pytest 因安装失败而没有可比较覆盖，修后即使通过也降级为 `repair_tests_passed_uncompared`，不标为 `verified_repair`。
- prepare/verify 现在同时绑定 commit 与 baseline SHA；默认禁止新增依赖发行包名，关闭 pytest 插件自动加载，并由可信父控制器解析子进程 JUnit，拒绝强制退出、全跳过、测试收集缩减与仓库代码篡改验证计数。
- Repair Agent 只能修改初始 inventory 中的精确路径；Windows 8.3/大小写别名以及测试目录中的 helper/fixture 均不能绕过测试保护。
- Git 在 checkout 前先用 tree 元数据执行 5000 文件/50 MB 预检；Linux Docker 映射宿主 uid:gid，避免 bind mount 留下 root 文件；服务错误响应不暴露本机路径或底层 stderr。
- Node v4 只承担片段执行；原代码与候选代码分别在全新的 Pyodide 子进程中顺序运行，任何时刻最多驻留一个 Pyodide worker，并受原有硬墙钟、V8 heap、协议与输出上限约束。精确调度测试会记录 start/finish 顺序并断言最大并发数为 1；Node `reproduce_python_project` 兼容入口在 clone 或宿主 Python 之前固定返回 `repository_execution_disabled`；所有仓库复现与修复统一路由到 Python v0.4 MCP。
- 新增星辰托管 `platform` toolset：只暴露片段工具与三个 Actions 异步仓库工具。Node 不执行仓库，GitHub Ubuntu runner 构建 digest 固定的 Python 3.11 verifier 镜像并调用 Python v0.4 prepare/verify；成功 verify 的 terminal result 直接带回真实 patch、evidence JSON 和 report 正文。此路径不需要额外模型 API Key，但需要只具控制仓库 Actions read/write 的 fine-grained PAT。
- 固定 verifier 基础镜像后重新运行 `docker build` 与 `scripts/smoke_docker.py`：`verified_repair`，修改前 exit 1、修改后 exit 0、patch 存在。
- 低内存定向验收在 Linux Node 18、禁网、`memory.max=268435456`（256 MB）且 swap 同限容器中完成真实调用：进程退出码 0，返回 `worker_execution_strategy=sequential_fresh_children`、修改前 `IndexError`、修改后 stdout `3`、`fix_verified=true`。

### 真实公开故障仓库异步闭环（部署前本地后端验收）

- 历史第三方 canary 仓库：`pserrano95/repojanitor-canary`（只保留既有本地验收证据；当前部署 allowlist 已改为团队仓库 `wenjieding327/repo-rescue-canary`，等待 live Actions 后另行追加证据。）
- 固定 commit：`7653fba05df872da0609d20e4a007ccb0eac5c93`
- 运行路径：异步 prepare job → 轮询终态 → 有界完整文件补丁 → 异步 verify job → 轮询终态。
- Docker 内相同命令：`python -m pytest -q`
- 修改前：exit 1，1 failed / 1 passed；修改后：exit 0，2 passed。
- 最终状态：`verified_repair=true`；run ID `20260830T225632Z-961e37b5`。
- Artifact SHA-256：`repair.patch=505f45fb9488539d62ed13c50c9df776b080bc6252be9765521e98505f4703ff`；`evidence.json=839fc2ca952dc620eb95cef799c3e3470bd8869aa726b969d75b8a9b293e2791`；`report.md=c0a7a4a3d2d0149213a38dcd5f4201800b6804c43f80da9766ccd7cf612b8622`。
- 本次候选补丁由确定性验收脚本提供，用于证明后端异步闭环、隔离、绑定哈希和 artifact 真实可用；它**不冒充星辰模型已经在线自动生成该补丁**。

测试边界：14/14 benchmark 验证的是片段执行和判定后端，候选修复代码由测试提供，**不代表大模型面对任意片段时的自动修复成功率**。公开星辰 Agent 仍需在 v4 部署后完成同类平台端调用，才能把这项能力写成线上能力。

GitHub Actions bridge 当前证明范围仍是本地 mock/runner/Docker 验收；workflow 尚未进入受保护远端 ref，也尚未用真实 PAT 完成 live dispatch。因此本节不能替代复赛发布前的真实 Actions prepare→verify、星辰私有 MCP 四工具发现和 Agent 端闭环验收。

### 公开 Agent 回归发现（旧部署）

2026-08-30 对公开页面的三次冒烟测试均未完成承诺闭环：

- 空列表除零：只给本地命令和预期退出码，没有调用真实片段执行工具。
- 明确要求 `rescue_python_snippet`：Agent 回答当前工具列表不包含它。
- `https://github.com/psf/requests`：返回通用“请刷新再试”，没有结构化 unsupported 或证据。

因此旧公开版本不得继续宣称“任意代码/仓库可真实运行”。只有完成 `deployment-v4.md` 的发布后验收，才能把 v0.4.0 能力改写为线上能力。

## v1 已发布归档：本地自动化测试

冻结前已验证：

- `npm test`：3/3 通过
  - 可验证的代码片段修复
  - 拒绝不安全导入
  - 阻止无限循环超出预算
- `.venv\Scripts\python.exe -m pytest`：11 passed
- `skills/verified-code-rescue/`：结构校验通过

## 讯飞平台：代码片段急救

输入：

```text
我是初学者，这段 Python 代码报错了，请直接修好并真实运行验证。预期输出 3：

numbers = [1, 2, 3]
print(numbers[3])
```

平台最终结果：

- 状态：✅已验证修复
- 根因：列表索引越界
- 修改：`numbers[3]` 改为 `numbers[2]`
- 修改前：`IndexError: list index out of range`
- 修改后 stdout：`3`
- 验证用例：检查输出是否为 3，1 个用例通过

这证明的是片段级同用例前后验证，不代表文件、完整项目或论文指标已复现。

## 讯飞平台：公开仓库指定测试

- 仓库：`pallets/click`
- Commit：`398f9154317f6c54bf98fe3359672ad5cb851585`
- 后端：`pyodide_wasm_allowlist`
- 验证命令：`pytest -q -p no:cacheprovider tests/test_basic.py`
- 退出码：0
- 结果：102 passed
- 第二次证明哈希：`4aaa94ac33af2877b481a8e67f733428515d8160d76bf567c922fd142110fd90`
- 修复结果：重复调用不再出现 `path '/project' is already a file system mount point`

这只能表述为“P3 指定测试范围通过”，不能表述为官方 Demo、数据集或论文指标完全复现。

## 已知故障及处理

v2 托管 MCP 冷启动曾返回 `504 Gateway Timeout`。根因是启动阶段提前加载 pytest，首包过慢。提交 `a80450a` 改为仅在需要执行测试时加载 pytest，随后部署 v3 并完成上述片段验证。

## 仍需补充的高难度证据

- 依赖版本冲突：失败 → 诊断 → 修复 → 再验证
- README 缺少步骤：自动补全可执行流程
- 数据路径、权重或配置缺失：明确哪些能自动修、哪些需用户授权
- 官方 Demo 与论文核心指标验证
- GPU、Docker、数据库和联网服务的受控支持
