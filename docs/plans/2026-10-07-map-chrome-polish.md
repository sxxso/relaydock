# Map chrome screenshot repair

The user supplied close-ups of the background selector and lower map/detail area. Keep the approved Bauhaus palette and existing navigation/account semantics; this is a bounded visual repair, not a new theme.

## Diagnosis and design

- `globals.css` frames the background-control wrapper, while the shared select independently draws its pill border. The nested shapes (and independent hover translation) cause the double-frame appearance. Let the trigger alone own a single small square printed frame; leave its wrapper structural/transparent. Align the move launcher to the same right edge and width.
- The minimap's world camera is already clamped and projected correctly; the screenshot does not establish a coordinate overflow. Its broad orange viewport fill, generic rounded card and detached/faint legend conflict with the rest of the controls. Keep exact camera geometry and drag/keyboard behavior, use a light blue tint with a blue outline, contain SVG paint, and place the existing size disclaimer inside its card. Retain the standalone disclaimer when the minimap is hidden.
- Reduce the contours' orange visual weight with a subtle ink-colored line, without changing texture sampling or camera transforms. No new idle animation or neon.
- Retain warm paper/surface, navy ink and brick action buttons, current typeface and existing brief interaction motion. Align controls with consistent small corner radii, spacing and useful labels.

## Verification

Add an isolated production-browser regression before changing the styles: single-frame selector, aligned controls, minimap paint containment and size legend, low-opacity viewport fill, layout/focus at 375/768/1440, and geometry/keyboard/pointer behavior. Inspect supplied originals and save final renders after finite animations settle. Run relevant unit, type/build and browser regression. No real data, environment files, credentials, deployment-setting mutations or Git staging/commits.

## Delivered and verified (2026-10-07, Asia/Shanghai)

- The background select now owns its only 2px printed frame. Its structural wrapper has a computed 0px border. Background/move controls share width, right edge and spacing; keyboard focus remains visible.
- Overview and selector corners are 2px. Overview viewport paint is blue with 0.04 fill opacity; SVG paint stays contained. Group colours and camera/pointer projection are unchanged. The overview owns its size disclaimer, without duplicate text beside it.
- The review caught an existing mobile rule hiding the standalone disclaimer when the overview was closed. Reproduced with a failing 375px visibility check, then restored a wrapping paper-backed caption above the zoom controls. Bounds/non-overlap and light/dark screenshots now pass.
- The new coarse-pointer 44px control-height rule was added after a failing real touch-context target-size check. Both corner controls satisfy it.
- Original styles failed the new single-frame assertion (wrapper 2px instead of 0px). Final computed values are saved in `output/playwright/map-chrome-geometry.json`.
- Screenshot settling uses a bounded current-animation-state check in the theme/viewport loop. An earlier unbounded `finished`-promise wait stalled; the final focused and full browser suites completed normally. No application animation was removed to make screenshots pass.

### Fresh final checks

- `npm.cmd run build`: exit 0, production build `3GkzMsDhECw_0bp4-Vcwk`.
- `npm.cmd run typecheck`: exit 0.
- `npm.cmd test`: 52 files, 853 tests passed, 5 intentionally skipped.
- `ATLAS_MAP_CHROME_FOCUS=1 npm.cmd run test:e2e`: passed, including 375/768/1440 light/dark layouts, mobile overview-off disclaimer, keyboard focus/Escape, and synthetic touch context with reduced motion.
- `npm.cmd run test:e2e`: 21 checkpoints passed, no browser errors. Includes long/short-screen dropdowns, nested menus, undo recovery/pause/races, colour editing and readable notifications. Two requests were sent only to the local fixture provider.
- `npm.cmd run test:interactions`: 18 checkpoints passed, no failures/browser errors, no external queries. Both final browser reports reference the same production build above.

### Rendered evidence

Visually inspected the final desktop control/overview composition and mobile light/dark overview-off and touch renders. These images use four synthetic test accounts, not the user's records:

- `output/playwright/map-chrome-light-1440.png`
- `output/playwright/map-chrome-dark-1440.png`
- `output/playwright/map-chrome-light-375-no-overview.png`
- `output/playwright/map-chrome-dark-375-no-overview.png`
- `output/playwright/map-chrome-touch.png`

The isolated browser harness copies build output without environment files and uses temporary databases. No real accounts/passwords, Git state, deployment settings or real providers were changed or queried. Docker/deployment and real-provider operation are not certified by these UI checks.
