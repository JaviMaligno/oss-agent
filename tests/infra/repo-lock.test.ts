import { describe, it, expect } from "vitest";
import { acquireRepoLock, withRepoLock } from "../../src/infra/repo-lock.js";

describe("RepoLock", () => {
  describe("acquireRepoLock", () => {
    it("should acquire and release a lock", async () => {
      const release = await acquireRepoLock("/test/repo");
      expect(typeof release).toBe("function");
      release();
    });

    it("should serialize concurrent access to the same repo", async () => {
      const order: number[] = [];
      const repo = "/test/repo-serial";

      // Start two concurrent operations
      const op1 = acquireRepoLock(repo).then(async (release) => {
        order.push(1);
        // Simulate some work
        await new Promise((r) => setTimeout(r, 50));
        order.push(2);
        release();
      });

      const op2 = acquireRepoLock(repo).then(async (release) => {
        order.push(3);
        await new Promise((r) => setTimeout(r, 10));
        order.push(4);
        release();
      });

      await Promise.all([op1, op2]);

      // op1 should complete (1, 2) before op2 starts (3, 4)
      expect(order).toEqual([1, 2, 3, 4]);
    });

    it("should allow concurrent access to different repos", async () => {
      const order: string[] = [];

      const op1 = acquireRepoLock("/test/repo-a").then(async (release) => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-end");
        release();
      });

      const op2 = acquireRepoLock("/test/repo-b").then(async (release) => {
        order.push("b-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("b-end");
        release();
      });

      await Promise.all([op1, op2]);

      // Both should start before either finishes (concurrent execution)
      expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("a-end"));
      expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("b-end"));
      // b should finish before a (since it's faster and they're concurrent)
      expect(order.indexOf("b-end")).toBeLessThan(order.indexOf("a-end"));
    });
  });

  describe("withRepoLock", () => {
    it("should execute function with lock and return result", async () => {
      const result = await withRepoLock("/test/repo-with", async () => {
        return 42;
      });
      expect(result).toBe(42);
    });

    it("should release lock even if function throws", async () => {
      const repo = "/test/repo-throw";

      // First operation throws
      await expect(
        withRepoLock(repo, async () => {
          throw new Error("Test error");
        })
      ).rejects.toThrow("Test error");

      // Second operation should be able to acquire the lock immediately
      const start = Date.now();
      const result = await withRepoLock(repo, async () => "success");
      const duration = Date.now() - start;

      expect(result).toBe("success");
      expect(duration).toBeLessThan(50); // Should not have waited
    });

    it("should serialize three concurrent operations", async () => {
      const order: number[] = [];
      const repo = "/test/repo-three";

      const ops = [1, 2, 3].map((n) =>
        withRepoLock(repo, async () => {
          order.push(n * 10); // start marker (10, 20, 30)
          await new Promise((r) => setTimeout(r, 20));
          order.push(n * 10 + 1); // end marker (11, 21, 31)
          return n;
        })
      );

      const results = await Promise.all(ops);

      expect(results).toEqual([1, 2, 3]);
      // Each operation should complete before the next starts
      expect(order).toEqual([10, 11, 20, 21, 30, 31]);
    });
  });

  describe("path normalization", () => {
    it("should treat paths with trailing slash as same repo", async () => {
      const order: number[] = [];

      const op1 = withRepoLock("/test/repo/", async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 30));
        order.push(2);
        return 1;
      });

      const op2 = withRepoLock("/test/repo", async () => {
        order.push(3);
        order.push(4);
        return 2;
      });

      await Promise.all([op1, op2]);

      // Should be serialized (same path after normalization)
      expect(order).toEqual([1, 2, 3, 4]);
    });
  });
});
