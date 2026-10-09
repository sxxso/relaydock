import { expect, it } from "vitest";
import { invitationLink, invitationUrlSchema, invitationMessages, publicInvitationError, parseInvitationCode } from "../src/lib/invitation";

it("validates only a bounded invitation code, never a provider message", () => {
  expect(parseInvitationCode({ success: true, data: "Ab_19" })).toBe("Ab_19");
  for (const data of ["", "x".repeat(129), "<script>", "a b", { code: "ok" }])
    expect(() => parseInvitationCode({ success: true, data })).toThrow();
  expect(() => parseInvitationCode({ success: false, data: "ok", message: "private-token" })).toThrow("邀请接口未返回有效邀请码");
});
it("uses the site origin registration path and preserves custom base paths and parameters", () => {
  expect(invitationLink("https://site.example/keys", "abc")).toBe("https://site.example/sign-up?aff=abc");
  expect(invitationLink("https://site.example/", "abc", "https://site.example/prefix/register")).toBe("https://site.example/prefix/register?aff=abc");
  expect(invitationLink("https://site.example", "abc", "https://join.example/signup?lang=zh&aff=old")).toBe("https://join.example/signup?lang=zh&aff=abc");
});
it("publishes known safe outcomes only, preserving useful diagnostics without exposing raw errors", () => {
  expect(publicInvitationError(new Error(invitationMessages.unsupported))).toBe(invitationMessages.unsupported);
  expect(publicInvitationError(new Error(invitationMessages.unauthorized))).toBe(invitationMessages.unauthorized);
  expect(publicInvitationError(new Error("private-token body"))).toBe(invitationMessages.failed);
});
it("refuses unsafe and secret-bearing manual links", () => {
  for (const url of ["javascript:alert(1)", "https://u:p@example.com/register", "https://site.example/register?token=private", "https://site.example/#access_token=private", "http://127.0.0.1/register", "https://localhost/register", "https://site.example/" + "x".repeat(2048)])
    expect(invitationUrlSchema.safeParse(url).success).toBe(false);
  expect(invitationUrlSchema.safeParse("https://site.example/register?aff=Ab12").success).toBe(true);
});
