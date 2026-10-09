"use client";
import { useEffect, useRef, useState } from "react";
import type { Settings } from "@/lib/validation";
import { createThemeController, type ResolvedTheme } from "@/lib/appearance";

export function useAppearance(settings: Settings, ready: boolean) {
  const controller = useRef<ReturnType<typeof createThemeController> | null>(
    null,
  );
  const initialized = useRef(false);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");
  useEffect(() => {
    const style = document.documentElement.style;
    const color = settings.inkColor;
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      style.setProperty("--ink-visual-color", color);
      style.setProperty("--ink-decoration", [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)).join(","));
    } else {
      style.removeProperty("--ink-visual-color");
      style.removeProperty("--ink-decoration");
    }
    return () => {
      style.removeProperty("--ink-visual-color");
      style.removeProperty("--ink-decoration");
    };
  }, [settings.inkColor]);
  useEffect(() => {
    controller.current = createThemeController(document);
    return () => {
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    const color = matchMedia("(prefers-color-scheme: dark)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      const theme =
        settings.theme === "system"
          ? color.matches
            ? "dark"
            : "light"
          : settings.theme;
      document.documentElement.dataset.motion = String(settings.motion);
      controller.current?.apply(theme, {
        motion: settings.motion,
        reduced: reduced.matches,
        initial: !initialized.current,
      });
      setResolvedTheme(theme);
      if (ready) initialized.current = true;
    };
    apply();
    color.addEventListener("change", apply);
    reduced.addEventListener("change", apply);
    return () => {
      color.removeEventListener("change", apply);
      reduced.removeEventListener("change", apply);
    };
  }, [settings.theme, settings.motion, ready]);
  return resolvedTheme;
}
