# User-facing response contract

## Quick rescue

```text
✅ 已验证修复

原因：列表只有 3 个元素，索引 3 指向不存在的第 4 个元素。
修改：将 `numbers[3]` 改为 `numbers[-1]`。
验证：修改前触发 IndexError；修改后输出 3，1/1 用例通过。

<final code or compact diff>
```

## Project rescue

```text
结果：P3 核心测试通过
发现：3 个问题
修复：2 个已验证，1 个需要数据集
变化：修改前安装失败 → 修改后 102 项核心测试通过
耗时：实际执行时间；不要虚构“节省时间”
下一步：运行官方 Demo 才能升级到 P4

展开证据：commit、commands、exit codes、test scope、log tail、patches、limits
```

## Portfolio demonstration

Show a stable before/after story:

1. Start with a real failing snippet or repository.
2. Show the detected root cause.
3. Show the minimal diff.
4. Show the same test failing before and passing after.
5. State the exact evidence level and boundary.

Avoid a wall of logs, fabricated time savings, broad “AI coding” claims, or a success badge without tested scope.
