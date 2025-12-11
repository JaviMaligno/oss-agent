import { describe, it, expect } from "vitest";
import { Semaphore } from "../../src/infra/semaphore.js";

describe("Semaphore", () => {
  describe("constructor", () => {
    it("should create semaphore with valid max", () => {
      const sem = new Semaphore(3);
      expect(sem.getMax()).toBe(3);
      expect(sem.available()).toBe(3);
      expect(sem.acquired()).toBe(0);
      expect(sem.waiting()).toBe(0);
    });

    it("should throw if max is less than 1", () => {
      expect(() => new Semaphore(0)).toThrow("Semaphore max must be at least 1");
      expect(() => new Semaphore(-1)).toThrow("Semaphore max must be at least 1");
    });

    it("should allow max of 1 (mutex)", () => {
      const sem = new Semaphore(1);
      expect(sem.getMax()).toBe(1);
    });
  });

  describe("acquire and release", () => {
    it("should acquire immediately when slots available", async () => {
      const sem = new Semaphore(2);

      await sem.acquire();
      expect(sem.acquired()).toBe(1);
      expect(sem.available()).toBe(1);

      await sem.acquire();
      expect(sem.acquired()).toBe(2);
      expect(sem.available()).toBe(0);
    });

    it("should release slot correctly", async () => {
      const sem = new Semaphore(2);

      await sem.acquire();
      await sem.acquire();
      expect(sem.available()).toBe(0);

      sem.release();
      expect(sem.available()).toBe(1);
      expect(sem.acquired()).toBe(1);

      sem.release();
      expect(sem.available()).toBe(2);
      expect(sem.acquired()).toBe(0);
    });

    it("should queue when all slots taken", async () => {
      const sem = new Semaphore(1);

      await sem.acquire();
      expect(sem.waiting()).toBe(0);

      // This will queue
      const acquirePromise = sem.acquire();
      expect(sem.waiting()).toBe(1);

      // Release to allow queued acquire to proceed
      sem.release();
      await acquirePromise;
      expect(sem.waiting()).toBe(0);
      expect(sem.acquired()).toBe(1);
    });

    it("should process queue in FIFO order", async () => {
      const sem = new Semaphore(1);
      const order: number[] = [];

      await sem.acquire();

      // Queue multiple acquires
      const p1 = sem.acquire().then(() => order.push(1));
      const p2 = sem.acquire().then(() => order.push(2));
      const p3 = sem.acquire().then(() => order.push(3));

      expect(sem.waiting()).toBe(3);

      // Release and verify FIFO order
      sem.release();
      await p1;
      expect(order).toEqual([1]);

      sem.release();
      await p2;
      expect(order).toEqual([1, 2]);

      sem.release();
      await p3;
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("concurrent usage", () => {
    it("should limit concurrent operations", async () => {
      const sem = new Semaphore(2);
      let concurrent = 0;
      let maxConcurrent = 0;

      const task = async (id: number): Promise<number> => {
        await sem.acquire();
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);

        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));

        concurrent--;
        sem.release();
        return id;
      };

      // Run 5 tasks with concurrency limit of 2
      const results = await Promise.all([task(1), task(2), task(3), task(4), task(5)]);

      expect(results).toEqual([1, 2, 3, 4, 5]);
      expect(maxConcurrent).toBe(2);
    });

    it("should handle rapid acquire/release cycles", async () => {
      const sem = new Semaphore(3);
      const iterations = 100;

      const task = async (): Promise<void> => {
        await sem.acquire();
        // Immediate release
        sem.release();
      };

      // Run many rapid cycles
      await Promise.all(Array.from({ length: iterations }, () => task()));

      expect(sem.acquired()).toBe(0);
      expect(sem.waiting()).toBe(0);
      expect(sem.available()).toBe(3);
    });
  });

  describe("edge cases", () => {
    it("should handle release without acquire gracefully", () => {
      const sem = new Semaphore(2);

      // Release without acquiring - current goes to -1
      sem.release();

      // acquired() will be -1 and available() = max - current = 2 - (-1) = 3
      // This is technically invalid state but we test current behavior
      expect(sem.acquired()).toBe(-1);
      expect(sem.available()).toBe(3); // max - current = 2 - (-1) = 3
    });

    it("should handle single slot (mutex) correctly", async () => {
      const sem = new Semaphore(1);
      let inCriticalSection = false;
      let violations = 0;

      const task = async (): Promise<void> => {
        await sem.acquire();

        if (inCriticalSection) {
          violations++;
        }
        inCriticalSection = true;

        await new Promise((r) => setTimeout(r, 5));

        inCriticalSection = false;
        sem.release();
      };

      await Promise.all([task(), task(), task(), task()]);

      expect(violations).toBe(0);
    });
  });
});
