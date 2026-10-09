import { expect, it } from "vitest";
import { accountInput, moveInput, batchInput } from "../src/lib/validation";
const id = "6dd4f13e-6d94-4f4b-85e5-f02acfa5f2e2",
  group = "长".repeat(50);
it("keeps 50-character renamed groups valid for account edit/backup schemas", () => {
  expect(
    accountInput.safeParse({
      name: "夹具",
      siteUrl: "https://fixture.invalid",
      group,
    }).success,
  ).toBe(true);
});
it("can move into an existing 50-character renamed group", () => {
  expect(
    moveInput.safeParse({
      id,
      group,
      beforeId: null,
      expectedUpdatedAt: "2026-10-05T00:00:00.000Z",
    }).success,
  ).toBe(true);
});
it("can batch assign an existing 50-character renamed group", () => {
  expect(
    batchInput.safeParse({ ids: [id], operation: { kind: "group", group } })
      .success,
  ).toBe(true);
});
