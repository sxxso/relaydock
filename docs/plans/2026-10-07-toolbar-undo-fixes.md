# Toolbar and undo contract repair

User reports undiscoverable toolbar functions, dropdown choices not visible and incomplete previously agreed undo.

- Retain Bauhaus styling and existing filtering/view semantics. Explain and label existing icon-only operations, give an honest saved-view empty choice and active-filter feedback; no new remote query triggers.
- Test long select lists and nested filters on desktop, mobile and short landscape viewports before fixing concrete clipping. Preserve Portal menus, keyboard navigation and parent-menu dismissal.
- Keep the October 6 undo scope: latest in-memory action, roughly six active seconds, only favorite/archive/batch group/tags, whole-batch conflict protection, never balances/credentials/history/permanent deletion.
- Repair loss on unrelated notices and temporary errors. Separate undo notice from ordinary messages, pause while hovered/focused/hidden/blocked by a dialog or while its request is pending, retain a retry action after temporary failure. Dismiss on logout and prevent delayed results from overwriting newer canonical accounts or newer undo entries.
- RED/GREEN tests: pure timed controller and account merging, failed/retried undo, unrelated saved-view message, overlapping response freshness, long and short-screen menus. Use isolated synthetic database and local fixture only, no real account changes or password reset. Build, typecheck and relevant browser regression, inspect actual screenshots. No Git staging or commits.

## Delivered behavior

- Visible toolbar labels: 配色, 收藏, 筛选 and 保存视图. The former group-rename action is available as 分组改名 inside 筛选. An empty saved-view menu explains how to create a view rather than showing pretend saved choices.
- Portal selects remain above filters/dialogs; the filter panel flips/clamps to the visible viewport and scrolls internally. Nested option selection and Escape preserve the parent menu and return focus appropriately.
- Separate ordinary and undo notices. Undo only retains the latest permitted account action, with six usable seconds; hover, keyboard focus, hidden tabs, blocking dialogs and pending requests pause expiry. Blocking dialogs temporarily hide the notice, and closing them restores it. Temporary failures retain retry; older results cannot clear a newer undo or overwrite a newer account response.
- Favorite/archive/batch producers guard the original account versions. Batch scope changes require explicit reconfirmation; stale versions reject the whole write. Restoring legacy empty groups is permitted without broadening the field whitelist.
- Preserve the Bauhaus group palette/custom colors, readable solid notices, interaction-triggered motion and reduced-motion support. No neon reintroduced.

## Verification — 2026-10-07

- `npm test`: 52 files passed, 853 tests passed, 5 existing tests skipped.
- `npm run build` and final `npm run typecheck`: passed. Latest production build: `qZrktSkqwMxYcZFpC8krQ`.
- `npm run test:e2e`: 20 checkpoints passed against that production build; no browser errors. Two intentional local provider-fixture requests, no real provider requests.
- `npm run test:interactions`: 18 checkpoints passed; `npm run test:management`: 28 passed; `npm run test:group-layout`: 13 passed. These independently isolated suites ran before the rebuild, against the same unchanged application source (`xEl5cherww_QdPw74MXlv`); no browser/cleanup errors or provider queries.
- Focused toolbar menus passed with 36 additional synthetic groups at 768×240, 768×360, 375×500 and 1440×720. The last keyboard-highlighted option must fit inside the actual scrolling viewport, not merely inside the browser window. Open group/nested-menu screenshots retained under `output/playwright/toolbar-*.png`.
- Focused undo recovery passed after holding a blocking dialog open for 6.5 seconds, a 503 retry, a 6.5-second keyboard-focus pause, a delayed busy request and a newer overlapping action. Desktop/mobile retry screenshots retained as `output/playwright/undo-retry*.png`. Pure tests additionally cover hidden/modal pause combinations and partial-second expiry.
- Visually inspected open desktop/mobile/short-screen menus, color editor, solid dark notification, completed list reveal and desktop/mobile retry notices. Screenshot capture waits for finite opening/reveal animations instead of recording partially transparent/clipped frames.
- Regression-harness correction: Popper placement and conditional scroll-button layout can settle after the opening animation. Wait for a usable scroll region before geometry assertions; do not patch application CSS based on a transient zero-height frame. Likewise, a notice intentionally hidden during a blocking dialog is not an expired undo: assert its return after closing the dialog.
- Management backup-time assertion now validates the actual export interval and canonical ISO timestamp instead of a hardcoded calendar date.
- All browser/unit account changes used isolated synthetic data. Actual deployment data, credentials and password were not read or modified; no Git staging/commits. Real providers and Docker were not verified by these UI checks.
