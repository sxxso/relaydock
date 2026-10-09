import { describe, expect, it } from "vitest";
import { isolatedSourceParent } from "../scripts/build-source-isolated";

describe("isolated production source volume", () => {
  it("keeps Windows source and dependencies on D when the system temp is on C", () => {
    expect(
      isolatedSourceParent(
        "D:\\projects\\atlas",
        "D:\\projects\\atlas\\node_modules",
        "C:\\Temp",
        "win32",
      ),
    ).toBe("D:\\projects\\atlas\\output\\isolated-builds");
  });
  it("keeps system temp when it already shares the dependency volume", () => {
    expect(
      isolatedSourceParent(
        "D:\\projects\\atlas",
        "C:\\shared\\node_modules",
        "C:\\Temp",
        "win32",
      ),
    ).toBe("C:\\Temp");
  });
  it("compares Windows drive names without case sensitivity", () => {
    expect(
      isolatedSourceParent(
        "D:\\projects\\atlas",
        "d:\\shared\\node_modules",
        "D:\\Temp",
        "win32",
      ),
    ).toBe("D:\\Temp");
  });
  it("rejects a cross-volume fallback outside the approved project", () => {
    expect(() =>
      isolatedSourceParent(
        "E:\\projects\\atlas",
        "D:\\shared\\node_modules",
        "C:\\Temp",
        "win32",
      ),
    ).toThrow("dependency volume");
  });
  it("does not change POSIX temporary paths", () => {
    expect(
      isolatedSourceParent(
        "/work/atlas",
        "/work/atlas/node_modules",
        "/tmp",
        "linux",
      ),
    ).toBe("/tmp");
  });
});
