import { describe, it, expect, vi } from "vitest";
import { createThemeController } from "../src/lib/appearance";

async function subject() {
  return createThemeController as (doc: unknown) => {
    apply(
      theme: string,
      options: { motion: boolean; reduced: boolean; initial?: boolean },
    ): void;
    dispose(): void;
  };
}
const options = { motion: true, reduced: false };
function browserFixture({
  supported = true,
  hidden = false,
  delayed = false,
} = {}) {
  const root = {
    dataset: { theme: "light" } as Record<string, string>,
    animate: vi.fn(
      (_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
        finished: Promise.resolve(),
      }),
    ),
  };
  let callback: (() => void) | undefined;
  let ready: (() => void) | undefined, finished: (() => void) | undefined;
  const transition = {
    ready: new Promise<void>((r) => (ready = r)),
    finished: new Promise<void>((r) => (finished = r)),
    skipTransition: vi.fn(() => {
      ready?.();
      finished?.();
    }),
  };
  const start = vi.fn((update: () => void) => {
    callback = update;
    if (!delayed) update();
    return transition;
  });
  const doc = {
    documentElement: root,
    visibilityState: hidden ? "hidden" : "visible",
    ...(supported ? { startViewTransition: start } : {}),
  };
  return {
    root,
    doc,
    start,
    transition,
    run: () => callback?.(),
    ready: () => ready?.(),
    finish: () => finished?.(),
  };
}
describe("主题揭幕的渐进增强与生命周期", () => {
  it("新主题从右上揭开至左下，使用短时快照而不是循环", async () => {
    const make = await subject(),
      b = browserFixture();
    const c = make(b.doc);
    c.apply("dark", options);
    b.ready();
    await Promise.resolve();
    expect(b.root.dataset.theme).toBe("dark");
    expect(b.start).toHaveBeenCalledOnce();
    expect(b.root.animate.mock.calls[0]?.[0]).toEqual([
      { clipPath: "polygon(100% 0%, 100% 0%, 100% 100%, 200% 100%)" },
      { clipPath: "polygon(-100% 0%, 100% 0%, 100% 100%, 0% 100%)" },
    ]);
    expect(b.root.animate.mock.calls[0]?.[1]).toMatchObject({
      duration: 520,
      pseudoElement: "::view-transition-new(root)",
    });
    b.finish();
    await Promise.resolve();
    expect(b.root.dataset.themeTransition).not.toBe("running");
    c.dispose();
  });
  it.each([
    { ...options, motion: false },
    { ...options, reduced: true },
    { ...options, initial: true },
  ])("禁用条件下直接切换，不创建快照：%j", async (flags) => {
    const make = await subject(),
      b = browserFixture();
    const c = make(b.doc);
    c.apply("dark", flags);
    expect(b.root.dataset.theme).toBe("dark");
    expect(b.start).not.toHaveBeenCalled();
    c.dispose();
  });
  it.each([{ supported: false }, { hidden: true }])(
    "旧浏览器或隐藏页面保持可用：%j",
    async (flags) => {
      const make = await subject(),
        b = browserFixture(flags);
      const c = make(b.doc);
      c.apply("dark", options);
      expect(b.root.dataset.theme).toBe("dark");
      expect(b.start).not.toHaveBeenCalled();
      c.dispose();
    },
  );
  it("重复设置相同主题不重播", async () => {
    const make = await subject(),
      b = browserFixture();
    const c = make(b.doc);
    c.apply("light", options);
    expect(b.start).not.toHaveBeenCalled();
    c.dispose();
  });
  it("旧快照的延迟回调不能覆盖较新的主题", async () => {
    const make = await subject(),
      b = browserFixture({ delayed: true });
    const c = make(b.doc);
    c.apply("dark", options);
    c.apply("light", { ...options, motion: false });
    b.run();
    b.ready();
    b.finish();
    await Promise.resolve();
    expect(b.root.dataset.theme).toBe("light");
    expect(b.root.animate).not.toHaveBeenCalled();
    expect(b.transition.skipTransition).toHaveBeenCalled();
    c.dispose();
  });
  it("快照创建失败时仍设置主题", async () => {
    const make = await subject(),
      b = browserFixture();
    b.start.mockImplementation(() => {
      throw new Error("unavailable");
    });
    const c = make(b.doc);
    c.apply("dark", options);
    expect(b.root.dataset.theme).toBe("dark");
    c.dispose();
  });
});
