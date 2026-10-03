#!/usr/bin/env node
// Build standalone paste-ready nodes. No model, network, credentials or eval.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = join(ROOT, "dist", "xfyun-code-nodes");
const ENCODING = "# -*- coding: utf-8 -*-\n";
const SOURCES = {
  router: "xfyun-request-router.py", binding: "xfyun-candidate-binding.py",
  snippet: "xfyun-snippet-report.py", repository: "xfyun-repository-report.py",
};

export function selectPython(root = ROOT) {
  const local = join(root, ".venv", "Scripts", "python.exe");
  return existsSync(local) ? local : "python";
}

const COMMON = `import json

def _node_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def _node_unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result

def _node_constant(value):
    raise ValueError("non-finite JSON number")

def _node_load(value, maximum=4000000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError("bounded JSON string required")
    result = json.loads(value, object_pairs_hook=_node_unique, parse_constant=_node_constant)
    _node_json(result).encode("utf-8")
    return result

def _node_object(value, fields, maximum=200000):
    result = _node_load(value, maximum)
    if not isinstance(result, dict) or set(result) != set(fields):
        raise ValueError("missing or unknown input field")
    return result

def _node_output(value, detail):
    return {"key0": value, "key1": [], "key2": {"key21": detail}}

def _node_context(value):
    result = _node_object(value, ("route", "original_code", "repo_url", "test_cases", "has_oracle", "message", "prompt", "request_started_at"))
    if type(result["has_oracle"]) is not bool or any(not isinstance(result[key], str) for key in ("original_code", "repo_url", "test_cases", "message", "prompt", "request_started_at")):
        raise ValueError("invalid context field type")
    return result

def _node_request(value):
    result = _node_load(value, 200000)
    if not isinstance(result, dict):
        raise ValueError("request must be an object")
    route = result.get("route")
    fields = {"snippet": ("route", "original_code", "candidate_code", "test_cases"), "github": ("route", "repo_url", "job_id", "request_started_at"), "advice": ("route",)}
    if not isinstance(route, str) or route not in fields or set(result) != set(fields[route]):
        raise ValueError("unknown route or request fields")
    if route == "snippet":
        if not isinstance(result["original_code"], str) or not isinstance(result["candidate_code"], str) or not isinstance(result["test_cases"], list):
            raise ValueError("invalid snippet request types")
        for case in result["test_cases"]:
            if not isinstance(case, dict) or set(case) - {"name", "stdin", "expected_stdout"}:
                raise ValueError("unknown case fields")
    elif route == "github" and any(not isinstance(result[key], str) for key in fields[route]):
        raise ValueError("invalid repository request types")
    return result

def _node_plugin(value):
    result = _node_load(value)
    if not isinstance(result, dict) or set(result) - {"content", "isError", "receipt_url"}:
        raise ValueError("unknown MCP envelope fields")
    content = result.get("content")
    if type(result.get("isError")) is not bool or not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], dict) or set(content[0]) != {"type", "text"} or content[0]["type"] != "text":
        raise ValueError("invalid direct MCP envelope")
    business = _node_load(content[0]["text"])
    if not isinstance(business, dict):
        raise ValueError("invalid business JSON object")
    return result
`;

function renameMain(source, replacement, label) {
  const matches = [...source.matchAll(/^def main\(/gm)];
  if (matches.length !== 1) throw new Error(`${label}: exactly one top-level main definition is required`);
  if (new RegExp(`^def ${replacement}\\(`, "m").test(source)) throw new Error(`${label}: wrapper target name already exists`);
  return source.replace(/^def main\(/m, `def ${replacement}(`).trimEnd();
}

function lexicalGate(source, name, parameters) {
  if (/^from __future__ import /m.test(source) || /^if __name__\s*==/m.test(source)) {
    throw new Error(`${name}: unsupported top-level future import or executable CLI block`);
  }
  if ([...source.matchAll(/^def main\(/gm)].length !== 1) throw new Error(`${name}: exactly one main is required`);
  const indented = source.trimEnd().split(/\r?\n/).map((line) => `    ${line}`).join("\n");
  return `def ${name}(${parameters}):\n${indented}\n    return main(${parameters})\n`;
}

export async function buildXfyunCodeNodes({ outputDirectory = OUTPUT, python = selectPython() } = {}) {
  const sources = {};
  for (const [name, filename] of Object.entries(SOURCES)) sources[name] = await readFile(join(ROOT, "scripts", filename), "utf8");
  const router = `${ENCODING}# Independent request router; key0 must be bound directly to the next node.\n${renameMain(sources.router, "_route_input", "router")}\n\n${COMMON}\ndef main(input):
    context = _route_input(input)
    return _node_output(_node_json(context), context["route"])
`;
  const binding = `${ENCODING}# Candidate data only; key0 is request_json for /xfyun/execute.\n${renameMain(sources.binding, "_bind", "binding")}\n\n${COMMON}\ndef main(input, input2):
    try:
        context = _node_context(input)
        result = _bind(context, input2)
        route = result["route"]
        if route == "advice":
            return _node_output(_node_json({"route": "advice"}), "未执行、未验证：没有可靠执行绑定，模型建议或自述成功不构成运行证据。")
        request = _node_load(result["binding"], 200000)
        if not isinstance(request, dict):
            raise ValueError("invalid binding object")
        request["route"] = route
        request_json = _node_json(request)
        _node_request(request_json)
        return _node_output(request_json, result["report"])
    except (TypeError, ValueError, UnicodeError, RecursionError, MemoryError):
        return _node_output(_node_json({"route": "advice"}), "未执行、未验证：输入字段或冻结候选绑定不可靠，已拒绝执行。")
`;
  const report = `${ENCODING}# The plugin result_json MUST be a direct independent tool-node reference.\n${COMMON}\n${lexicalGate(sources.snippet, "_snippet_gate", "result_json, original_code, candidate_code, test_cases")}\n${lexicalGate(sources.repository, "_repository_gate", "result_json, repo_url, job_id, request_started_at")}\ndef main(input, input2):
    try:
        request = _node_request(input)
        route = request["route"]
        if route == "advice":
            return _node_output("未执行、未验证：本轮仅为建议或格式澄清，没有实际工具执行证据。", "advice_not_executed")
        _node_plugin(input2)
        if route == "snippet":
            result = _snippet_gate(input2, request["original_code"], request["candidate_code"], request["test_cases"])
        else:
            result = _repository_gate(input2, request["repo_url"], request["job_id"], request["request_started_at"])
        if not isinstance(result, dict) or not isinstance(result.get("report"), str) or not isinstance(result.get("status"), str):
            raise ValueError("invalid gate outputs")
        return _node_output(result["report"], result["status"])
    except (TypeError, ValueError, UnicodeError, RecursionError, MemoryError, OverflowError):
        return _node_output("未验证修复：请求或独立插件原始返回缺失、字段非法或 JSON 结构不可靠。", "invalid_evidence")
`;
  const generated = { "request-router.py": router, "candidate-binding.py": binding, "final-report.py": report };
  await mkdir(outputDirectory, { recursive: true });
  const files = [];
  for (const [name, source] of Object.entries(generated)) {
    const path = join(outputDirectory, name);
    await writeFile(path, source, "utf8");
    files.push({ name, path, bytes: Buffer.byteLength(source), sha256: createHash("sha256").update(source).digest("hex") });
  }
  const compiler = spawnSync(python, ["-B", "-c", "import pathlib,sys\nfor name in sys.argv[1:]:\n compile(pathlib.Path(name).read_text(encoding='utf-8'), name, 'exec')\n", ...files.map((file) => file.path)], { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, shell: false });
  if (compiler.error || compiler.status !== 0) throw new Error(`Generated Python compilation failed: ${compiler.error?.message || compiler.stderr || compiler.stdout}`);
  return { outputDirectory, python, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Code-node output paths are fixed; CLI arguments are not accepted.");
  process.stdout.write(`${JSON.stringify(await buildXfyunCodeNodes(), null, 2)}\n`);
}
