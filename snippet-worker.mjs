#!/usr/bin/env node

import { loadPyodide } from "pyodide";

// This process is a disposable execution boundary. Stdout is reserved for one
// bounded JSON response; all Pyodide and incidental output is discarded here.
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
for (const level of ["log", "info", "warn", "debug", "error"]) {
  console[level] = () => {};
}

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_CASES = 4;
const MAX_CAPTURE_CHARS = 64 * 1024;
const MAX_ERROR_CHARS = 3_000;

function send(value) {
  protocolWrite(`${JSON.stringify(value)}\n`);
}

function executionFailure(type, message) {
  const bounded = String(message || type).slice(-MAX_ERROR_CHARS);
  return {
    ok: false,
    stdout: "",
    stderr: bounded,
    stdout_chars: 0,
    stderr_chars: bounded.length,
    stdout_complete: true,
    stderr_complete: true,
    error_type: type,
    error_message: bounded.split("\n").at(-1) || bounded,
  };
}

async function executeCase(runtime, code, stdinText) {
  runtime.globals.set("_rr_code", code);
  runtime.globals.set("_rr_stdin", String(stdinText ?? ""));
  runtime.globals.set("_rr_capture_limit", MAX_CAPTURE_CHARS);
  let proxy;
  try {
    proxy = await runtime.runPythonAsync(`
import ast as _rr_ast, builtins as _rr_builtins, importlib as _rr_importlib, io as _rr_io, sys as _rr_sys

_rr_allowed_imports = {
    'math', 'statistics', 'random', 're', 'json', 'collections', 'itertools',
    'functools', 'decimal', 'fractions', 'datetime', 'string', 'heapq', 'bisect'
}
_rr_forbidden_names = {
    'open', 'exec', 'eval', 'compile', '__import__', 'breakpoint', 'globals',
    'locals', 'vars', 'getattr', 'setattr', 'delattr', 'memoryview'
}

def _rr_validate(tree):
    for node in _rr_ast.walk(tree):
        if isinstance(node, (_rr_ast.Import, _rr_ast.ImportFrom)):
            names = [alias.name.split('.')[0] for alias in node.names] if isinstance(node, _rr_ast.Import) else [(node.module or '').split('.')[0]]
            if any(name not in _rr_allowed_imports for name in names):
                raise PermissionError('Only safe standard-library imports are available in quick rescue mode.')
        if isinstance(node, _rr_ast.Name) and node.id in _rr_forbidden_names:
            raise PermissionError(f'Unsafe operation is not allowed: {node.id}')
        if isinstance(node, _rr_ast.Attribute) and node.attr.startswith('_'):
            raise PermissionError('Private attribute access is not allowed in quick rescue mode.')

class _RRBoundedText:
    def __init__(self, limit):
        self.limit = limit
        self.value = ''
        self.total = 0
        self.complete = True
    def write(self, value):
        text = str(value)
        length = len(text)
        self.total += length
        combined = self.value + text
        if len(combined) > self.limit:
            self.complete = False
            self.value = combined[-self.limit:]
        else:
            self.value = combined
        return length
    def flush(self):
        return None
    def getvalue(self):
        return self.value

# Reset every allowed module before each input case. A snippet may mutate an
# imported module, but that mutation cannot become trusted worker state.
for _rr_module_name in tuple(_rr_sys.modules):
    if _rr_module_name.split('.')[0] in _rr_allowed_imports:
        _rr_sys.modules.pop(_rr_module_name, None)
_rr_random = _rr_importlib.import_module('random')
_rr_random.seed(0)

_rr_result = {
    'ok': False, 'stdout': '', 'stderr': '',
    'stdout_chars': 0, 'stderr_chars': 0,
    'stdout_complete': True, 'stderr_complete': True,
    'error_type': None, 'error_message': None,
}
_rr_out = _RRBoundedText(_rr_capture_limit)
_rr_err = _RRBoundedText(_rr_capture_limit)
try:
    _rr_tree = _rr_ast.parse(_rr_code, filename='<student-code>')
    _rr_validate(_rr_tree)
    _rr_real_import = _rr_builtins.__import__
    def _rr_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name.split('.')[0] not in _rr_allowed_imports:
            raise PermissionError(f'Import is not allowed in quick rescue mode: {name}')
        return _rr_real_import(name, globals, locals, fromlist, level)

    _rr_safe_builtins = dict(vars(_rr_builtins))
    for _rr_name in _rr_forbidden_names:
        _rr_safe_builtins.pop(_rr_name, None)
    _rr_safe_builtins['__import__'] = _rr_import
    _rr_lines = iter(_rr_stdin.splitlines())
    _rr_safe_builtins['input'] = lambda prompt='': (print(prompt, end='') or next(_rr_lines))
    _rr_old_out, _rr_old_err = _rr_sys.stdout, _rr_sys.stderr
    _rr_events = 0
    def _rr_trace(frame, event, arg):
        global _rr_events
        if event in ('line', 'call'):
            _rr_events += 1
            if _rr_events > 100000:
                raise TimeoutError('Execution budget exceeded; check for an infinite loop.')
        return _rr_trace
    try:
        _rr_sys.stdout, _rr_sys.stderr = _rr_out, _rr_err
        _rr_sys.settrace(_rr_trace)
        _rr_builtins.exec(_rr_builtins.compile(_rr_tree, '<student-code>', 'exec'), {'__builtins__': _rr_safe_builtins}, {})
        _rr_result['ok'] = True
    finally:
        _rr_sys.settrace(None)
        _rr_sys.stdout, _rr_sys.stderr = _rr_old_out, _rr_old_err
except BaseException as _rr_exc:
    _rr_result['error_type'] = type(_rr_exc).__name__
    _rr_message = str(_rr_exc)
    _rr_result['error_message'] = _rr_message[:3000]
    _rr_err.write(f'{type(_rr_exc).__name__}: {_rr_message[:3000]}\\n')
finally:
    _rr_result['stdout'] = _rr_out.getvalue()
    _rr_result['stderr'] = _rr_err.getvalue()
    _rr_result['stdout_chars'] = _rr_out.total
    _rr_result['stderr_chars'] = _rr_err.total
    _rr_result['stdout_complete'] = _rr_out.complete
    _rr_result['stderr_complete'] = _rr_err.complete
_rr_result
`);
    // Do not serialize through Python. Candidate code can mutate allowed Python
    // modules, so the trusted JS worker reads the PyProxy directly.
    return proxy.toJs({ dict_converter: Object.fromEntries });
  } catch (error) {
    const message = String(error?.message || error).slice(-MAX_ERROR_CHARS);
    const type = /PermissionError/.test(message)
      ? "PermissionError"
      : /SyntaxError/.test(message)
        ? "SyntaxError"
        : "RuntimeError";
    return executionFailure(type, message);
  } finally {
    proxy?.destroy?.();
  }
}

async function main(request) {
  if (!request || typeof request.code !== "string" || !Array.isArray(request.cases)) {
    throw new Error("Invalid snippet worker request.");
  }
  if (request.cases.length < 1 || request.cases.length > MAX_CASES) {
    throw new Error(`Snippet worker accepts 1-${MAX_CASES} cases.`);
  }
  const runtime = await loadPyodide({ stdout: () => {}, stderr: () => {} });
  const results = [];
  for (const item of request.cases) {
    results.push(await executeCase(runtime, request.code, item?.stdin ?? ""));
  }
  return { ok: true, results };
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
    send({ ok: false, error_type: "WorkerRequestTooLarge", error: "Worker request exceeded its byte limit." });
    process.exitCode = 2;
    process.stdin.destroy();
  }
});
process.stdin.on("end", async () => {
  if (process.exitCode) return;
  try {
    send(await main(JSON.parse(input)));
  } catch (error) {
    send({ ok: false, error_type: "WorkerRuntimeError", error: String(error?.message || error).slice(-MAX_ERROR_CHARS) });
    process.exitCode = 1;
  }
});
