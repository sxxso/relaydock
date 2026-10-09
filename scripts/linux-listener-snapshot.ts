import assert from "node:assert/strict";

// ss is restricted to one listening port. Never inspect command lines or environments.
export function listenerPids(text: string): number[] {
  const pids = new Set<number>();
  for (const line of text.split(/\r?\n/).filter((value) => value.trim())) {
    const matches = [...line.matchAll(/\bpid=(\d+),/g)];
    assert.ok(matches.length, "Cannot identify a listening process; refuse an incomplete snapshot");
    for (const match of matches) pids.add(Number(match[1]));
  }
  return [...pids].sort((a, b) => a - b);
}

export function processStartTicks(stat: string, pid: number): string {
  assert.ok(stat.startsWith(`${pid} (`), "Process identity changed while reading listener metadata");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  // proc(5): field 22, relative to field 3 after the parenthesized comm field.
  assert.match(fields[19] || "", /^\d+$/);
  return fields[19];
}
