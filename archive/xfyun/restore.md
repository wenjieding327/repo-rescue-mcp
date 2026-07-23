# 恢复指南

## 1. 恢复源码和固定版本

```bash
git clone https://github.com/wenjieding327/repo-rescue-mcp.git
cd repo-rescue-mcp
git checkout repo-rescue-xfyun-v1.0.0
npm ci
npm test
```

Python 验证：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .[test]
python -m pytest
```

## 2. 恢复 MCP

优先部署冻结提交对应源码，不要让托管平台追踪会变化的 `main`。配置所需环境变量时参考 `.env.example`，真实密钥不得写进 Git。

对讯飞：

1. 新建 MCP 服务并上传冻结源码包。
2. 启动入口使用仓库现有 Node 服务配置。
3. 等待服务就绪，记录新的 SSE 地址。
4. 将 `archive/xfyun/workflow-648761.yml` 导入或照原图重建。
5. 仅替换工作流中的 MCP SSE，不改提示词和输出定义。

## 3. 恢复 Agent

1. 模型选 DeepSeek-V3，策略选 ReACT MCP，最大循环 10。
2. 复制 `prompts.md` 中的角色提示词和推理规则。
3. Query 设置为 `{{input}}`，输出变量设置为 `output`。
4. 重新填写 `platform-config.md` 中的名称和作品说明。
5. 依次运行 `test-evidence.md` 的片段和仓库案例。
6. 只有两类测试均达到记录结果后再发布。

## 4. 迁移到 OpenClaw

不要尝试直接搬讯飞专属节点。复用本仓库的 MCP、提示词、测试案例和 `skills/verified-code-rescue/`，再依据 `OPENCLAW.md` 在 OpenClaw 重编排。

迁移验收标准：

- 同一输入产生同一类任务路由；
- 修复必须保留“修改前失败 → 修改后成功”的证据；
- 测试通过、官方 Demo 复现和论文指标复现必须分级；
- 未执行时绝不显示“已验证”。
