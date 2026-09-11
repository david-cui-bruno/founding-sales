# Retired Today views and capture launchers

Task 3 removes renderer/tool islands only. No application behavior change is intended.

## Replacements and retained boundaries

- `BacklogCard`, `NextUpCard`, `TodayLane`, and `TriageMode` had no renderer consumer. The finite `app/routeRegistry.tsx` still selects `TodayRoute`, its current Native Desk workspace, and its supported legacy queue. `TodayPage`/`TodayQueueRow` render main's order and explicit contact selection. Only the unused `onStartTriage` view prop is removed.
- `DiscoverySection` was test-only. Its compact read projection is now `SuggestedContacts`. Explicit preparation belongs to provider-owned `ContactPreparation`, and evidence/override disclosure belongs to `SelectedDiscovery`/`DiscoveryBrief` in the selected contact workspace.
- Applicable assertions remain in `contactPreparation.test.tsx`, `SuggestedContacts.test.tsx`, `DiscoveryBrief.test.tsx`, selected discovery/override cases in `LeadInspectorProvider.test.tsx`, and Today route/page/navigation tests. Coverage includes read-only selection, one selected workspace, evidence disclosure, sanitized refresh failure/recovery, malformed reads, bounded nonoverlapping polling, stale evidence, wrong-owner receipts, exact retry identity and successful preparation surviving a later read failure. Old shortlist expansion and direct shortlist preparation are intentionally not recreated in the three-name read-only suggestion surface.
- `today.css` loses only selectors exclusive to the old cards/lanes/triage/discovery dashboard and unused queue-done/bento wrappers. Mixed rules retain active summary focus/cursor selectors. Queue rows, context menus, small dialogs, dial meter, current header, suggestions and density rules remain.

No Today/discovery preload or shared contract, triage queue API, database/history/receipt, policy, lifecycle, suppression, provider lifetime, editor identity or worker adapter is removed. `ManualQuickAdd`, `nativeDesk.css`, Native Desk implementation, unsupported-platform declarations and backend code remain untouched. Historical studies/images/design references remain historical records.

## Capture replacement map

Both retired scripts launched a hardcoded packaged `out` executable via ad hoc CDP/process cleanup. Neither had a production consumer. Use maintained test harnesses, not those launchers:

| Old useful capture | Maintained replacement |
| --- | --- |
| `designV2Screenshots`: Leads, Today, Settings, light/dark | `tests/e2e/bauhausWorkflow.spec.ts`, all-workspaces test: named route captures at 1440 and 1050 widths in both themes |
| Command palette and import dialog, light/dark | Same test: `${theme}-command-palette.png` and `${theme}-import.png`, visibility, accessibility, overflow and focus checks |
| `polishScreenshots`: Conversations, Learnings, Review, Friday, Settings, light/dark | Same route matrix. Review's current name is Inbox (`#/review` remains an alias), rendering the same `ReviewRoute` |
| Top-left wordmark/traffic-light region, light/dark | Both-theme full-shell route captures include that region. Bauhaus identity test additionally asserts brand/native-controls nonoverlap, real shell typography and persistent theme |
| Current Today beyond legacy queue | `tests/browser/nativeDesk.spec.ts` and `nativeDeskComposition.spec.ts`: actual Native Desk themes, geometry, selection, editor identity and current A composition captures |

No missing current capture required a new outside-owned test. No browser/Electron acceptance suite was run by this worker. The coordinator should run the following only under its approved fixture/artifact environment and serial acceptance schedule:

```sh
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx playwright test --workers=1 tests/e2e/bauhausWorkflow.spec.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx playwright test --workers=1 tests/browser/nativeDesk.spec.ts tests/browser/nativeDeskComposition.spec.ts
```

The maintained environment and teardown support is preserved. Do not point acceptance at the installed app or real profile.
