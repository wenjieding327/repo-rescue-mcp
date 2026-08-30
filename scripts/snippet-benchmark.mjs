import { spawn } from "node:child_process";


const benchmarkCases = [
  {
    name: "index-error",
    expectedStatus: "fix_verified",
    arguments: {
      original_code: "numbers = [1, 2, 3]\nprint(numbers[3])",
      candidate_code: "numbers = [1, 2, 3]\nprint(numbers[-1])",
      test_cases: [{ name: "last item", expected_stdout: "3" }],
    },
  },
  {
    name: "zero-division",
    expectedStatus: "fix_verified",
    arguments: {
      original_code: "def average(items):\n    return sum(items) / len(items)\nprint(average([]))",
      candidate_code: "def average(items):\n    return sum(items) / len(items) if items else 0\nprint(average([]))",
      test_cases: [{ name: "empty list", expected_stdout: "0" }],
    },
  },
  {
    name: "type-error",
    expectedStatus: "fix_verified",
    arguments: {
      original_code: "print('2' + 3)",
      candidate_code: "print(int('2') + 3)",
      test_cases: [{ name: "mixed input", expected_stdout: "5" }],
    },
  },
  {
    name: "missing-key",
    expectedStatus: "fix_verified",
    arguments: {
      original_code: "user = {'name': 'Ana'}\nprint(user['age'])",
      candidate_code: "user = {'name': 'Ana'}\nprint(user.get('age', 'unknown'))",
      test_cases: [{ name: "missing age", expected_stdout: "unknown" }],
    },
  },
  {
    name: "syntax-error",
    expectedStatus: "fix_verified",
    arguments: {
      original_code: "for item in range(2) print(item)",
      candidate_code: "for item in range(2):\n    print(item)",
      test_cases: [{ name: "loop output", expected_stdout: "0\n1" }],
    },
  },
  {
    name: "runaway-loop",
    expectedStatus: "fix_verified",
    arguments: {
      original_code: "while True:\n    pass",
      candidate_code: "print('stopped')",
      test_cases: [{ name: "bounded", expected_stdout: "stopped" }],
    },
  },
  {
    name: "unsafe-import-rejected",
    expectedStatus: "candidate_failed",
    arguments: {
      original_code: "print('safe')",
      candidate_code: "import os\nprint(os.getcwd())",
      test_cases: [{ name: "sandbox", expected_stdout: "safe" }],
    },
  },
  {
    name: "incorrect-candidate-rejected",
    expectedStatus: "candidate_failed",
    arguments: {
      original_code: "print(1 / 0)",
      candidate_code: "print(2)",
      test_cases: [{ name: "wrong answer", expected_stdout: "3" }],
    },
  },
  {
    name: "unchanged-code-not-called-repair",
    expectedStatus: "candidate_runs",
    arguments: {
      original_code: "print(1)",
      candidate_code: "print(1)",
      test_cases: [{ name: "already passing", expected_stdout: "1" }],
    },
  },
  {
    name: "too-many-cases-rejected",
    expectedStatus: "invalid_request",
    arguments: {
      original_code: "print(0)",
      candidate_code: "print(1)",
      test_cases: Array.from({ length: 5 }, (_, index) => ({ name: `case-${index + 1}`, expected_stdout: "1" })),
    },
  },
  {
    name: "missing-oracle-not-called-verified",
    expectedStatus: "candidate_runs",
    arguments: {
      original_code: "print(1 / 0)",
      candidate_code: "print(999)",
      test_cases: [{ name: "runtime-only" }],
    },
  },
  {
    name: "deterministic-random-replay",
    expectedStatus: "candidate_runs",
    arguments: {
      original_code: "import random\nprint(random.randint(0, 1))",
      candidate_code: "import random\nprint(random.randint(0, 1))",
      test_cases: [{ name: "seeded", expected_stdout: "1" }],
    },
  },
  {
    name: "serializer-corruption-rejected",
    expectedStatus: "candidate_failed",
    arguments: {
      original_code: "raise ValueError('original')",
      candidate_code: "import json\njson.dumps = lambda *args, **kwargs: '{\\\"ok\\\": true}'\nraise RuntimeError('still broken')",
      test_cases: [{ name: "serializer", expected_stdout: "safe" }],
    },
  },
  {
    name: "private-runtime-escape-rejected",
    expectedStatus: "candidate_failed",
    arguments: {
      original_code: "raise RuntimeError('original')",
      candidate_code: "import collections\nprint(collections._sys.version_info.major)",
      test_cases: [{ name: "private-runtime", expected_stdout: "3" }],
    },
  },
];


function runBenchmark() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["stdio-server.mjs"], {
      cwd: new URL("..", import.meta.url),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`benchmark server exited ${code}: ${stderr}`));
        return;
      }
      const responses = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      resolve(responses);
    });
    const requests = benchmarkCases.map((item, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params: { name: "rescue_python_snippet", arguments: item.arguments },
    }));
    child.stdin.end(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  });
}


const started = Date.now();
const responses = await runBenchmark();
const results = benchmarkCases.map((item, index) => {
  const response = responses.find((candidate) => candidate.id === index + 1);
  const payload = response?.result?.content?.[0]?.text
    ? JSON.parse(response.result.content[0].text)
    : { status: "missing_response", error: response?.error || null };
  return {
    name: item.name,
    expected_status: item.expectedStatus,
    actual_status: payload.status,
    passed: payload.status === item.expectedStatus,
    fix_verified: Boolean(payload.fix_verified),
    submitted_cases: payload.case_counts?.submitted ?? null,
    executed_cases: payload.case_counts?.executed ?? null,
  };
});
const passed = results.filter((item) => item.passed).length;
const report = {
  benchmark: "repo-rescue-snippet-reliability-v1",
  passed,
  total: results.length,
  duration_seconds: Math.round((Date.now() - started) / 100) / 10,
  error_successes: results.filter((item) => item.actual_status === "fix_verified" && item.expected_status !== "fix_verified").length,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (passed !== results.length || report.error_successes !== 0) process.exitCode = 1;
