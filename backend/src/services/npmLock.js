const queues = new Map();

/**
 * Serializes npm operations against the same directory. Two `npm install`
 * (or `npm audit`) processes running concurrently in the same project can
 * corrupt package-lock.json / node_modules - npm has no cross-process lock
 * for that. The dependency-audit stage and the code-quality stage both
 * touch the same extracted codebase's npm state and now run concurrently,
 * so every npm invocation against a given directory must go through here.
 */
export function withNpmLock(dir, fn) {
  const prev = queues.get(dir) || Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(
    dir,
    run.catch(() => {})
  );
  return run;
}
