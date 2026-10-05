import { describe, it, expect } from "vitest";
import { ScanQueue } from "@/lib/scan-queue";

describe("ScanQueue", () => {
  it("runs one at a time, queues the next, and refuses when the queue is full", async () => {
    const q = new ScanQueue(1, 2);
    const order: string[] = [];

    const first = q.tryEnter()!;
    const second = q.tryEnter()!;
    const third = q.tryEnter()!;
    expect(q.tryEnter()).toBeNull(); // 1 active + 2 waiting, so the 4th is refused

    const releaseFirst = await first;
    second.then(() => order.push("second"));
    third.then(() => order.push("third"));
    await Promise.resolve();
    expect(order).toEqual([]);

    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(["second"]);
    expect(q.tryEnter()).not.toBeNull(); // a waiting place has opened

    releaseSecond();
    await third;
    expect(order).toEqual(["second", "third"]);
  });

  it("ignores a second call to the same release function", async () => {
    const q = new ScanQueue(1, 1);
    const release = await q.tryEnter()!;
    release();
    release();
    const a = q.tryEnter();
    const b = q.tryEnter();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(q.tryEnter()).toBeNull();
  });
});
