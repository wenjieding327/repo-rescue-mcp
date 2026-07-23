# 测试与证据

## 本地自动化测试

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
