# Social runtime and adapter verification

## Current status — 6 October 2026

Social delivery is not released or enabled. Two explicitly approved disposable LinkedIn native schedules were created in the Codex browser and immediately cancelled. The last readback showed Scheduled (0); neither test was publicly published.

The reusable runtime uses a hidden sandboxed Electron window, no Callie preload/Node integration, a hashed partition scoped to workspace/user/platform/account, denied popups/permissions/external navigation, and a bounded page load. Sign-out invalidates active work; explicit account disconnect clears that partition. Unit tests cover isolation, concurrency, cancellation and timeout. The actual Electron fixture probe is recorded separately from platform acceptance.

## LinkedIn inspection

David signed into the Codex browser. The observed account is his David Cui personal profile (`david-cui-589a20228`), not a company Page. The empty composer exposes account selection, audience, a textbox, Media, a Scheduled control and a disabled Post button. The Scheduled control did not open a date/time view with the composer empty. The composer was dismissed without entering content or submitting anything.

David subsequently opened the composer and clicked its clock himself. The resulting Schedule post panel was inspected on 6 October: it exposes a Scheduled (0) tab, Back, editable Date* (10/6/2026), Embedded calendar, editable Time* (7:00 AM), Open time picker, a “Posting at Tue, Oct 6, 7:00 AM” preview, and Confirm. No timezone identifier is exposed in this accessibility view. Clicking Embedded calendar through automation left the panel unchanged. No fields were changed and Confirm was not clicked.

This verifies that native scheduling controls are available to this account, but not reliable automated interaction. It does not establish the supported date range, timezone interpretation, receipt, cancellation, image behavior, or acceptance of Callie's separate hidden Electron session. Codex's session is not copied into Callie. Runtime scheduling remains unsupported until those product-owned acceptance checks pass.

Facebook Page and X account inspection and product-runtime acceptance remain pending. No paid scheduler or paid X fallback is selected.

## Authorized schedule and saved-detail tests — 6 October

Both tests used David Cui's personal profile, the synthetic Callie test image, the approved test text and alt text, and 13 October at noon Eastern. Each schedule was cancelled immediately after inspection. These were Codex-browser checks, not acceptance of the product-owned Electron adapter.

- First receipt: `urn:li:share:7513234862275706880`. Native scheduled-list text/time matched; cancellation returned Scheduled (0).
- Repeat receipt: `urn:li:share:7513240390708301825`. The saved edit view retained media ID `D4E22AQFOb-d1RVmqRw`, but its image alt attribute was empty. Opening Editor → Alternative text also showed an empty textarea. The pre-submission composer had shown the approved alt text. The cause is unresolved; this is not evidence that LinkedIn never supports saved alt text.
- The repeat inspection did not edit the saved post. Discarded the edit view, deleted the exact scheduled row, verified Scheduled (0), and closed the test tab.
- Local screenshots: `/tmp/callie-linkedin-saved-alt-missing.png` and `/tmp/callie-linkedin-repeat-cancelled.png`. These are diagnostic scratch artifacts, not durable repository evidence.

The saved-detail reader now preserves native media IDs and missing preview alt text, with `altTextVerified: false`. It cannot certify a full image match. Original uploaded-byte-to-native-media binding and saved alt verification remain required before image delivery can be enabled. Tests cover refusing draft blob URLs, foreign images, nested editor dialogs and unknown extra images.

A scheduling interaction also needs product acceptance: entering a time alone did not update the live summary until the visible time option was selected. Do not treat a local fixture's successful field assignment as proof of live staging.

The earlier inspection paragraphs describe the initial probes only. They do not supersede these later test results. Facebook and X, final submission coordination, original media binding and the product-owned session's live acceptance remain unfinished.

### Time-picker preparation correction

A read-only control inspection of an empty composer confirmed a `time-picker-clock-button` and a `time-picker-menu` linked by the time input's `aria-controls`. Options are `menuitemradio` elements with `time-picker-option`. No draft text, image, schedule or post was created during this inspection.

Preparation now opens that menu and selects the exact requested option before confirming the date/time panel. It refuses missing or duplicate options and rechecks date/time/zone afterward. Fifteen focused tests and seven hidden Electron host tests passed. This fixes the known interaction gap in code; live acceptance of the full product-owned scheduling flow remains outstanding.

### Composer media counting

The preparation reader now counts images even when their alt text is empty; previously it filtered those images out. It excludes only the known profile-avatar URL shape and rejects unknown image sources. A hidden Electron regression adds an unexpected image without alt text and confirms staging refuses it. Four image-staging host cases pass; the full desktop suite passes 1,475 tests with 22 skipped. This does not resolve the saved-post alt persistence issue above.

### Text-only final submission primitive

The local final-click primitive checks account display name, exact text, timezone, schedule summary, absence of media/progress and a unique enabled Schedule button. A document-bound attempt marker prevents repeating the click even with a different token. Its result means only that a click was attempted; it cannot report a scheduled receipt. The delivery caller must already hold a durable server submission marker and validate account/session/schedule before invoking it.

A hidden Electron fixture staged text and exercised exactly one click, refused a second token, made no external requests and closed cleanly. Twenty-three focused submission/delivery tests passed. The primitive is not wired into a live adapter; independent receipt verification and product-session acceptance are still required. Image submission remains refused.
