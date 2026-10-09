import { expect, it } from "vitest";
import { listenerPids, processStartTicks } from "../scripts/linux-listener-snapshot";

it("captures all listener owners deterministically and refuses hidden owners", () => {
  expect(listenerPids("")).toEqual([]);
  expect(listenerPids('LISTEN 0 511 *:3000 *:* users:(("node",pid=42,fd=20),("node",pid=7,fd=21))\nLISTEN 0 511 [::]:3000 *:* users:(("node",pid=42,fd=22))')).toEqual([7, 42]);
  expect(() => listenerPids("LISTEN 0 511 *:3000 *:*")).toThrow(/incomplete snapshot/);
});

it("uses kernel start ticks to detect PID reuse and handles parenthesized process names", () => {
  const stat = (ticks: string) => `42 (node (fixture)) S ${Array(18).fill("0").join(" ")} ${ticks} 0`;
  expect(processStartTicks(stat("12345"), 42)).toBe("12345");
  expect(processStartTicks(stat("12346"), 42)).not.toBe(processStartTicks(stat("12345"), 42));
  expect(() => processStartTicks(stat("12345"), 43)).toThrow(/identity changed/);
  expect(() => processStartTicks("42 (node) S 0", 42)).toThrow();
});
