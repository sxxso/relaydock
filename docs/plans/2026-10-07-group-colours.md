# Group Colours Implementation Plan
> For agent: use Superpowers Sections 4/5, 7, 9 and 10. User has approved the design and implementation in this session.

**Goal:** Durable editable group colours and a more responsive Bauhaus workspace without colour/animation regressions.
**Architecture:** Separate revisioned group-colour metadata; shared pure contrast/style helper; accessible modal; consolidate existing theme/motion owners.
**Tech Stack:** Next 16 / React 19 / TypeScript / Zod / SQLite / Vitest / existing Playwright fixture harness.

## Tasks
1. Write `tests/group-colours.test.ts` for the public `map/groups/color` command and read model. Run `npm test -- tests/group-colours.test.ts`; before implementation the route must fail 404 (expected 200). Test reopening, reset, known groups, exact HEX, auth/CSRF, stale revision, rename and backup preview/import.
2. Add `src/lib/group-colors.ts`: strict six-digit HEX normalized uppercase, bounded unique group entries, revision schema and set/reset command. Add tested luminance/foreground/style resolution shared by clients. Store mutation is transaction + expectedRevision; API returns model with accounts and rename response. Backups include optional colour entries and validate known groups. Run focused tests then existing group/backup suites.
3. Add accessible `src/components/group-color-editor.tsx` + CSS module. Use existing Modal/AtlasSelect, eight button swatches with aria-pressed, native colour input and HEX text input, local preview, reset, cancel/save and inline error. Save uses POST `{name,color,expectedRevision}`; errors retain draft. Wire `workspace.tsx`, `atlas-map.tsx`, `map-minimap.tsx` with shared groupStyle.
4. Consolidate final tokens into root in `src/app/globals.css` and remove obsolete loading/view-switch overrides. Single ownership of interactive motion in `src/components/interaction-motion.css`. Keep layout breakpoints and d3 transforms intact. Add richer triggered motion and one global reduced/disabled rule. Delegate this disjoint CSS work while main implementation covers TS and CSS module.
5. Move rename into existing more-filter panel; add colour entry beside group selector. Add `workspace-loading.tsx` with known layout skeleton and matching stylesheet. Prevent empty-state flash before account read; do not mask load failures.
6. Extend `scripts/verify-ui.ts` before UI implementation; expected RED is missing group-colour entry. Verify runtime colour/contrast/cancel/save/reload/reset/rename, screenshots, mobile/reduced-motion. Run `npm run build`, `npm run typecheck`, `npm test`, `npm run test:e2e`, relevant interaction/group browser harnesses. Inspect screenshots and fix concrete issues.

No broad staging or commits: relaydock is an untracked directory in a larger unrelated working tree and Git metadata is protected. Preserve other user changes.

## Completion evidence (2026-10-07)

- All six tasks completed; final source review found no remaining P1/P2 issues in the approved scope.
- `npm run build` and `npm run typecheck`: exit 0. Final browser build ID: `SwjslMSY-Eak5N4qoJA2K`.
- `npm test`: 49 files, 820 passed, 5 existing skipped (825 total).
- `npm run test:e2e`: 18 checkpoints, no page errors; isolated fixture database and local synthetic provider only.
- `npm run test:interactions`: 18 checks passed. `npm run test:group-layout`: 13 checks passed, including touch and 503-site group dragging.
- Added RED/GREEN checks for failed-save cancellation, explicit 409 retry, stale same-revision colour reads, legacy blank groups, delayed initial account reads and cross-session readiness. For the final readiness test, deliberately removing the guard only in a disposable build copy reproduced the expected failure; the intact build passed the full run.
- Inspected current light/dark editor, mobile sticky actions, desktop workspace and actual loading skeleton screenshots. Recorded `output/playwright/bauhaus-motion.webm` using read-only preview/cancel actions and fixture data.
- No real account/database edits, provider queries, dependency changes or Git staging/commits. Docker and real provider integration were not part of this visual-feature verification.
