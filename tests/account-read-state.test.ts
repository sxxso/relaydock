import { describe, expect, it } from "vitest";
import {
  AccountReadState,
  accountWriteRequest,
} from "../src/lib/account-read-state";

describe("account reads crossing canonical mutations", () => {
  it("rejects a delayed old GET after a newer create or rename has committed", () => {
    const state = new AccountReadState();
    const stale = state.beginRead();
    const finish = state.beginWrite();
    finish();
    expect(state.canApply(stale)).toBe(false);
    expect(state.canApply(state.beginRead())).toBe(true);
  });
  it("does not apply reads while any concurrent account write is pending", () => {
    const state = new AccountReadState();
    const endA = state.beginWrite(),
      endB = state.beginWrite();
    const during = state.beginRead();
    endA();
    expect(state.canApply(during)).toBe(false);
    expect(state.canApply(state.beginRead())).toBe(false);
    endB();
    expect(state.canApply(during)).toBe(false);
    expect(state.canApply(state.beginRead())).toBe(true);
  });
  it("allows a canonical recovery read after a failed mutation and releases exactly once", () => {
    const state = new AccountReadState();
    const stale = state.beginRead(),
      end = state.beginWrite();
    end(); // finally runs on success and failure
    const recovery = state.beginRead();
    end();
    expect(state.canApply(stale)).toBe(false);
    expect(state.canApply(recovery)).toBe(true);
  });
  it("accepts only the latest read even when GETs complete out of order", () => {
    const state = new AccountReadState();
    const old = state.beginRead(),
      newer = state.beginRead();
    expect(state.canApply(newer)).toBe(true);
    expect(state.canApply(old)).toBe(false);
  });
});

describe("account write boundary", () => {
  it("protects canonical balances returned by a batch check-in from stale reads", () => {
    const state = new AccountReadState();
    const before = state.beginRead();
    expect(accountWriteRequest("checkin/batch", "POST")).toBe(true);
    const finish = accountWriteRequest("checkin/batch", "POST") ? state.beginWrite() : () => {};
    const during = state.beginRead();
    expect(state.canApply(during)).toBe(false);
    finish();
    expect(state.canApply(before)).toBe(false);
    expect(state.canApply(during)).toBe(false);
    expect(state.canApply(state.beginRead())).toBe(true);
    expect(accountWriteRequest("checkin/batch", "GET")).toBe(false);
  });
  it.each([
    ["accounts", "POST"],
    ["accounts/id", "PATCH"],
    ["accounts/id", "DELETE"],
    ["accounts/move", "POST"],
    ["accounts/batch", "POST"],
    ["accounts/undo", "POST"],
    ["accounts/id/balance", "POST"],
    ["accounts/id/sync", "POST"],
    ["accounts/id/test", "POST"],
    ["accounts/id/favorite", "POST"],
    ["map/groups/rename", "POST"],
    ["backup/import", "POST"],
  ])("tracks %s %s, including persisted test diagnostics", (path, method) => {
    expect(accountWriteRequest(path, method)).toBe(true);
  });
  it.each([
    ["accounts", "GET"],
    ["accounts/id/history", "GET"],
    ["backup/export", "GET"],
    ["query/test", "POST"],
    ["settings", "PATCH"],
    ["map/groups/move", "POST"],
    ["auth/login", "POST"],
  ])("does not treat %s %s as an account mutation", (path, method) => {
    expect(accountWriteRequest(path, method)).toBe(false);
  });
});

