import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "./rate-limiter";
import { collectQuery } from "./chunked-export";
import type { SqlChunkResponse } from "../types";

describe("RateLimiter", () => {
  it("enforces start-to-start spacing for fast requests", async () => {
    let now = 1000;
    const limiter = new RateLimiter({
      capacity: 27,
      windowMs: 60_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    expect(limiter.spacingMs).toBe(2223);
    expect(limiter.waitMs()).toBe(0);

    // Request 1 starts at T=1000
    await limiter.acquire();
    now = 1100; // Query took 100 ms

    // Next request at T=1100 must wait for 2223 start-to-start spacing
    expect(limiter.waitMs()).toBe(1000 + 2223 - 1100); // 2123 ms
  });

  it("adds zero extra delay when previous request was slower than spacing", async () => {
    let now = 1000;
    const limiter = new RateLimiter({
      capacity: 27,
      windowMs: 60_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    await limiter.acquire();
    now = 4000; // Query took 3000 ms (> 2223 ms spacing)

    expect(limiter.waitMs()).toBe(0);
  });

  it("enforces rolling window capacity limit when window is full", async () => {
    let now = 0;
    const limiter = new RateLimiter({
      capacity: 3,
      windowMs: 60_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    // Acquire 3 slots, spaced by acquire
    await limiter.acquire(); // starts at T=0
    await limiter.acquire(); // waits spacing (20001), starts at T=20001
    await limiter.acquire(); // waits spacing (20001), starts at T=40002

    expect(limiter.usedInWindow).toBe(3);

    // At T=45000:
    // Spacing wait: 40002 + 20001 - 45000 = 15003 ms (starts at 60003)
    // Window wait: 0 + 60000 - 45000 = 15000 ms
    // Max wait = 15003 ms
    now = 45000;
    expect(limiter.waitMs()).toBe(15003);

    // Advance time past T=60000: first request leaves window
    now = 60001;
    expect(limiter.usedInWindow).toBe(2);
    // At T=60001, spacing wait from last (40002) is 40002 + 20001 - 60001 = 2 ms
    expect(limiter.waitMs()).toBe(2);
  });

  it("waits for overflow index when 429 reduces capacity below current window count", async () => {
    let now = 0;
    const limiter = new RateLimiter({
      capacity: 4,
      windowMs: 60_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    // 4 requests spaced at 15001 ms: T=0, T=15001, T=30002, T=45003
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(limiter.usedInWindow).toBe(4);

    // 429 drops capacity to 3 (floor(4 * 0.75))
    limiter.noteRateLimited();
    expect(limiter.effectiveCapacity).toBe(3);
    // starts = [0, 15001, 30002, 45003]
    // starts.length (4) >= effectiveCapacity (3)
    // overflowIndex = 4 - 3 = 1 -> starts[1] = 15001
    // wait for starts[1] to leave window: 15001 + 60000 - 45003 = 30002 - 3 = 29998
    // Spacing wait: last (45003) + spacingMs (20001) - 45003 = 20001
    // Window wait: 15001 + 60000 - 45003 = 29998 ms (> spacing wait 20001 ms)
    expect(limiter.waitMs()).toBe(15001 + 60_000 - 45003);
  });

  it("restores capacity dynamically on success", () => {
    const limiter = new RateLimiter({ capacity: 20 });
    limiter.noteRateLimited();
    expect(limiter.effectiveCapacity).toBe(15);

    // Successive successes restore penalty towards 1
    for (let i = 0; i < 20; i++) {
      limiter.noteSuccess();
    }
    expect(limiter.effectiveCapacity).toBe(20);
  });

  it("supports pendingSpacing for extra gaps between files or targets", async () => {
    let now = 1000;
    const limiter = new RateLimiter({
      capacity: 27,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    await limiter.acquire();
    limiter.requestSpacing(5000);

    now = 2000;
    // Spacing should be max(spacingMs, 5000) = 5000 from last start
    expect(limiter.waitMs()).toBe(1000 + 5000 - 2000); // 4000 ms
  });

  it("rejects immediately if signal is already aborted", async () => {
    const limiter = new RateLimiter();
    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(controller.signal)).rejects.toThrow("Run dihentikan oleh pengguna.");
    expect(limiter.usedInWindow).toBe(0);
  });

  it("serializes concurrent acquire calls without leaking slots", async () => {
    let now = 0;
    const limiter = new RateLimiter({
      capacity: 10,
      windowMs: 60_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    const calls: number[] = [];
    const p1 = limiter.acquire(undefined, () => {}).then(() => { calls.push(1); });
    const p2 = limiter.acquire(undefined, () => {}).then(() => { calls.push(2); });

    await Promise.all([p1, p2]);
    expect(calls).toEqual([1, 2]);
    expect(limiter.usedInWindow).toBe(2);
  });
});

describe("collectQuery rate limiter integration", () => {
  const chunk = (rows: unknown[][], hasMore = false): SqlChunkResponse => ({
    ok: true,
    message: "OK",
    columns: ["id"],
    rows,
    hasMore,
  });

  it("integrates with limiter: calls acquire, noteSuccess, and paces requests", async () => {
    let now = 0;
    const limiter = new RateLimiter({
      capacity: 27,
      windowMs: 60_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    const acquireSpy = vi.spyOn(limiter, "acquire");
    const successSpy = vi.spyOn(limiter, "noteSuccess");

    const request = vi.fn<() => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce(chunk([[1]], true))
      .mockResolvedValueOnce(chunk([[2]]));

    const accept = vi.fn(async () => {});
    await collectQuery(request, accept, () => false, vi.fn(), undefined, { limiter, minIntervalMs: 0 });

    expect(acquireSpy).toHaveBeenCalledTimes(2);
    expect(successSpy).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("calls noteRateLimited when receiving 429", async () => {
    const limiter = new RateLimiter({
      sleep: async () => {},
    });
    const limitedSpy = vi.spyOn(limiter, "noteRateLimited");

    const request = vi.fn<() => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce({ ok: false, message: "DB engine Error 429 Too Many Requests: 30 per 1 minute" })
      .mockResolvedValueOnce(chunk([[1]]));

    await collectQuery(request, vi.fn(async () => {}), () => false, vi.fn(), undefined, {
      limiter,
      minIntervalMs: 0,
      rateLimitDelayMs: 0,
    });

    expect(limitedSpy).toHaveBeenCalledTimes(1);
  });
});
