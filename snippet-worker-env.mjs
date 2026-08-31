// A snippet is untrusted code. Even though Pyodide blocks process/environment
// APIs, its child Node process must not inherit deployment credentials.
export function createSnippetWorkerEnvironment(source = process.env) {
  const allowed = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ];
  const environment = {};
  for (const name of allowed) {
    if (typeof source[name] === "string" && source[name]) environment[name] = source[name];
  }
  environment.NODE_NO_WARNINGS = "1";
  return environment;
}
