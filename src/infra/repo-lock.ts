/**
 * RepoLock - Per-repository locking for serializing git operations
 *
 * When multiple parallel processes work on the same repository, certain
 * git operations (like creating branches) can conflict. This module provides
 * a lock per repository to serialize these operations.
 *
 * Uses a simple mutex pattern with a queue of promises.
 */

/** Map of repository path -> current lock chain */
const repoLockChains = new Map<string, Promise<void>>();

/**
 * Acquire a lock for a repository.
 * If another process holds the lock, this will wait until it's released.
 *
 * @param repoPath - Path to the repository
 * @returns A function to release the lock
 */
export async function acquireRepoLock(repoPath: string): Promise<() => void> {
  // Normalize the path
  const normalizedPath = repoPath.replace(/\/+$/, "");

  // Get the current lock chain (or a resolved promise if none)
  const previousLock = repoLockChains.get(normalizedPath) ?? Promise.resolve();

  // Create our release mechanism
  let releaseFunc!: () => void;
  const ourLock = new Promise<void>((resolve) => {
    releaseFunc = resolve;
  });

  // Chain our lock after the previous one
  // This ensures strict FIFO ordering
  repoLockChains.set(
    normalizedPath,
    previousLock.then(() => ourLock)
  );

  // Wait for the previous lock to be released before we can proceed
  await previousLock;

  // Return the release function that lets the next waiter proceed
  return () => {
    releaseFunc();
    // Clean up if we're the last in the chain
    const currentChain = repoLockChains.get(normalizedPath);
    if (currentChain) {
      // Check if the chain resolves immediately (no more waiters)
      // We can't really know, so we just leave it for now
      // It will be garbage collected when the promise chain completes
    }
  };
}

/**
 * Execute a function while holding the repo lock.
 * The lock is automatically released when the function completes (or throws).
 *
 * @param repoPath - Path to the repository
 * @param fn - Function to execute while holding the lock
 * @returns The result of the function
 */
export async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireRepoLock(repoPath);
  try {
    return await fn();
  } finally {
    release();
  }
}
