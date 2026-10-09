import { describe, expect, it } from "vitest";
import { makeUndoEntry, sameStringArray } from "../src/lib/undo";

describe("undo helpers", () => {
  it("keeps only explicitly changed allowlisted fields and copies tag arrays", () => {
    const tags = ["old"];
    const entry = makeUndoEntry("account", "2026-10-05T00:00:00.000Z", {
      tags,
      credential: "must-not-be-kept",
    } as never);
    tags.push("mutated");
    expect(entry).toEqual({
      id: "account",
      expectedUpdatedAt: "2026-10-05T00:00:00.000Z",
      restore: { tags: ["old"] },
    });
  });

  it("does not create an undo entry for an empty restore", () => {
    expect(makeUndoEntry("account", "2026-10-05T00:00:00.000Z", {})).toBeNull();
  });

  it("compares tag order and values exactly", () => {
    expect(sameStringArray(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameStringArray(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameStringArray(["a"], ["a", "b"])).toBe(false);
  });
});
