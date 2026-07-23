---
name: verified-code-rescue
description: Repair code with before-and-after execution evidence instead of unverified suggestions. Use when a user pastes a code snippet, error message, assignment function, Python file, notebook, or public GitHub repository and wants it explained, debugged, minimally fixed, run, tested, or reproduced. Route small snippets to verified quick rescue and full repositories to evidence-graded project reproduction; explain results for beginners and never overclaim the scope of verification.
---

# Verified Code Rescue

Turn vague “this code does not work” requests into a low-friction rescue flow: understand the user's goal, generate the smallest useful repair, execute it when a safe runtime is available, and report exactly what the evidence proves.

## Route by input size

Choose the smallest mode that can solve the request:

1. **Snippet rescue** — pasted code, a function, an assignment, or an error. Generate the repair, then call `rescue_python_snippet` with the original and candidate code.
2. **File rescue** — one source file or notebook. Inspect the whole file, preserve public behavior, add focused tests, run them, and summarize the diff.
3. **Project rescue** — a public GitHub repository. Call `inspect_github_project` before `reproduce_python_project`; separate repository inspection, test execution, official-demo reproduction, and paper-metric reproduction.

Do not force a repository workflow on a small question. Do not ask users to extract metadata that the available tools can discover.

## Rescue workflow

1. Restate the intended behavior in one sentence. Infer obvious intent from the code and error; ask only when two materially different behaviors are plausible.
2. Explain the root cause in beginner-friendly language. Name the exact line or behavior, not a generic list of possibilities.
3. Generate a minimal candidate repair. Preserve names, interfaces, comments, and style unless they cause the defect.
4. Build one to four focused cases from supplied examples or obvious edge cases. Never invent hidden assignment requirements.
5. Execute before and after:
   - For Python snippets, call `rescue_python_snippet` with both versions and the focused cases.
   - For files or repositories, run the narrowest relevant tests first, then broaden only when useful.
6. Iterate on the candidate when the tool returns `candidate_failed`. Do not stop at the first plausible edit.
7. Report the result using the concise format below. Put raw logs behind an optional evidence section.

## Truth rules

- Say **verified fix** only when the original fails a stated case and the candidate passes that same case.
- Say **candidate runs** when the candidate passes but no before-failure was observed.
- Say **suggested fix** when execution is unavailable.
- Never convert snippet success into a claim that a file, project, official demo, or paper result is reproducible.
- Treat repository inspection as read-only evidence, not execution evidence.
- Distinguish an AI inference from a tool observation in every uncertain conclusion.
- Refuse to hide failures by deleting tests, weakening assertions, hard-coding expected outputs, or skipping the broken path.

Read [references/evidence-levels.md](references/evidence-levels.md) when grading file, repository, demo, or paper evidence. Read [references/response-contract.md](references/response-contract.md) when producing a user-facing rescue report or GitHub/portfolio demo.

## Default response

Lead with the outcome:

```text
结果：✅ 已验证修复 / ⚠️ 可运行但未证明修复 / ❌ 仍未通过 / 💡 未执行建议
问题：一句话说明根因
修改：一句话说明最小改动
验证：修改前怎样失败 → 修改后通过哪些用例
代码：给出可直接使用的最终版本或紧凑 Diff
```

Add technical evidence only after the readable result. Include commands, exit codes, commit SHA, logs, and hashes when available, but never make users decode them to understand whether their problem was solved.

## Product behavior

- Accept imperfect prompts such as “这段代码怎么错了” without demanding a formal specification.
- Prefer a working final answer over a long tutorial, then offer the explanation depth the user needs.
- Keep code generation central: produce the repaired code, not only a diagnosis checklist.
- Use verification as the differentiator: show the change from failing to passing whenever possible.
- For beginners, translate exceptions and environment terminology into actions they can follow.
- For advanced users, preserve access to diffs, tests, logs, environment facts, and limitations.
