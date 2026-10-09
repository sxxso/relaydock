export type ResolvedTheme = "light" | "dark";
type ThemeOptions = { motion: boolean; reduced: boolean; initial?: boolean };
type ThemeDocument = Pick<Document, "documentElement" | "visibilityState"> &
  Partial<Pick<Document, "startViewTransition">>;

/** Owns only the theme snapshot, never a persistent animation loop. */
export function createThemeController(doc: ThemeDocument) {
  let version = 0;
  let active: ViewTransition | undefined;
  const root = doc.documentElement;
  const stop = () => {
    active?.skipTransition();
    active = undefined;
    delete root.dataset.themeTransition;
  };
  return {
    apply(theme: ResolvedTheme, options: ThemeOptions) {
      const current = ++version;
      stop();
      const apply = () => {
        if (current === version) root.dataset.theme = theme;
      };
      if (
        root.dataset.theme === theme ||
        options.initial ||
        !options.motion ||
        options.reduced ||
        doc.visibilityState === "hidden" ||
        typeof doc.startViewTransition !== "function"
      ) {
        apply();
        return;
      }
      try {
        root.dataset.themeTransition = "running";
        const transition = doc.startViewTransition(apply);
        active = transition;
        void transition.ready
          .then(() => {
            if (current !== version) return;
            root.animate(
              [
                { clipPath: "polygon(100% 0%, 100% 0%, 100% 100%, 200% 100%)" },
                { clipPath: "polygon(-100% 0%, 100% 0%, 100% 100%, 0% 100%)" },
              ],
              {
                duration: 520,
                easing: "cubic-bezier(0.22, 1, 0.36, 1)",
                pseudoElement: "::view-transition-new(root)",
              },
            );
          })
          .catch(() => {
            /* Hidden tabs and interrupted snapshots skip animation. */
          });
        void transition.finished.then(
          () => {
            if (current !== version) return;
            active = undefined;
            delete root.dataset.themeTransition;
          },
          () => {
            if (current === version) stop();
          },
        );
      } catch {
        stop();
        apply();
      }
    },
    dispose() {
      ++version;
      stop();
    },
  };
}
