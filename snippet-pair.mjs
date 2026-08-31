// Keep the two untrusted revisions in separate disposable workers while
// avoiding two Pyodide runtimes being resident at the same time. The caller's
// runWorker function creates a fresh child process for every invocation.
export async function runSequentialSnippetPair(runWorker, originalCode, candidateCode, cases) {
  const beforeBatch = await runWorker(originalCode, cases);
  const afterBatch = await runWorker(candidateCode, cases);
  return { beforeBatch, afterBatch };
}
