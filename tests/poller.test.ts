import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { startPollScheduler } from "../src/mail/poller.ts";

test("poll scheduler honors intervals, retries, remaining batches, and shutdown", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE mailboxes(id TEXT PRIMARY KEY,poll_seconds INTEGER NOT NULL); INSERT INTO mailboxes VALUES('box',60)");
  let now = 1_000_000;
  let calls = 0;
  const scheduler = startPollScheduler(db,"unused", { now:() => now, random:() => 0.5, tickMs:5, poll:async () => {
    calls++;
    if (calls === 1) throw new Error("offline");
    return { remaining: calls === 2 ? 1 : 0 };
  } });
  try {
    await Bun.sleep(25);
    expect(calls).toBe(0);
    now += 60_000;
    await Bun.sleep(25);
    expect(calls).toBe(1);
    now += 29_999;
    await Bun.sleep(25);
    expect(calls).toBe(1);
    now += 1;
    await Bun.sleep(25);
    expect(calls).toBe(2);
    now += 999;
    await Bun.sleep(25);
    expect(calls).toBe(2);
    now += 1;
    await Bun.sleep(25);
    expect(calls).toBe(3);
    await scheduler.stop();
    now += 120_000;
    await Bun.sleep(25);
    expect(calls).toBe(3);
  } finally { await scheduler.stop(); db.close(); }
});
