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

### Independent text receipt inspection

Text-only recovery now requires a complete scheduled list, a unique candidate and independent saved-detail readback. It compares account, text, date/time and timezone; partial lists, duplicate matches, missing rows and provider failures remain unknown. An empty scheduled list does not prove that an earlier submission failed: the post may already have published.

Closed navigation binds a detail read to the exact clicked native receipt, with a one-use document-local token. It cannot assign a receipt to an independently opened composer. Sixteen focused tests, desktop typecheck and focused lint pass. Full live adapter/session wiring and product acceptance remain pending; images are still unsupported for delivery.

### Text adapter composition and restart recovery

A text-only adapter now composes staging, guarded submission, independent receipt inspection and cancellation. The delivery runner passes the original approval snapshot into both new attempts and restart recovery, so recovery does not depend on downloading retained media. A lost-click-response test verifies a native receipt without a second click. Cancellation re-verifies the target; an already-absent row remains unknown because publication could have occurred between reads.

Twenty focused adapter/runner/delivery tests and the full desktop suite (1,495 passed, 23 skipped) pass. Typecheck and focused lint pass. This is local composition, not live delivery activation: product-owned account/navigation/list/detail ports and platform acceptance still remain. Images remain refused, and the final guard holds when browser and approved timezone differ.

### Product browser port wiring

The adapter now has browser ports for account checks, composer entry, scheduled-list navigation, list readback and exact saved-detail inspection. Navigation uses only the observed clock and Scheduled tab, acts once per state, and stops after bounded polling. The sidebar identity probe supports the composer route without navigating away from staged content.

Fourteen focused tests and the full desktop suite (1,501 passed, 23 skipped) pass; typecheck and focused lint pass. These ports are not registered for delivery yet. The complete flow still needs an integrated Electron fixture and live product-session acceptance; prior live tests used the separate Codex browser.

### Integrated hidden Electron verification

The complete text flow now passes against a local synthetic platform using the actual browser ports, adapter and delivery loop: prepare → one final click → independent receipt readback → close/reopen account browser → reinspect → cancel. Separate cases lose the final-click response or change the saved text. Lost response still produces one submission; changed text remains unknown and is not cancelled.

All 12 social Electron host checks pass. Windows stay hidden and unfocused and close cleanly. HTTPS is intercepted locally; no LinkedIn content was sent. Persistence is tested across browser-window recreation within one Electron process, not an operating-system/app restart. Typecheck and focused lint pass. Live product-session and actual future-publication acceptance are still outstanding.

### Package and repository gate preparation

Built commit `740039d8` as a separate ad-hoc local-smoke Mac app under `/tmp/callie-social-smoke-740039d8/`, with API/update URLs pointing at an unused loopback port. The integrity verifier passed (signature, bundled resources, fuses and stamped commit). This is not a notarized release, was not installed or launched, and does not replace the installed Callie app.

The first complete repository gate exposed missing social directory copies/build-context rules in both server images, missing social job-class expectations, and 75 uncovered social database constraints. Added both image paths, updated the bulk-job expectation, and added actual failing-insert cases for all 75 constraints. Two redundant asset guards are isolated within rolled-back test transactions, following existing constraint-suite practice; production schema was not weakened or changed. The focused constraints/image/job checks pass 1,569 tests.

The gate also required the explicit API route/module inventory and provider-call boundary inventory to include social. Sharp’s local `extract` crop is documented as a non-provider name collision; social model generation remains checked at its single budget-gated owner. The sequential application suites pass: contracts 99, domain 4,118 (3 skipped), API 624, worker 647, desktop 1,501 (26 skipped; host checks separate). Earlier worker timeouts during concurrent full-suite runs did not recur when run sequentially. The final operations suite passes 549 tests, and the full `gate:greenfield` command exits 0: 7,538 passed and 29 skipped, with typecheck and lint clean. The separate full-history secret scan failed in the history-scan phase without returning a findings report. A diagnostic retry is in progress; this is not release clearance.

### Upgrade and signing verification

The local upgrade rehearsal from schema 56 (base checkout `61727744`) to 60 passes, including existing-data preservation, runtime-role workflow checks, migration failure atomicity and refusal to run the schema-56 application against schema 60. Evidence is under `/tmp/social-upgrade-56-60`; no production migration was run.

The social bucket Terraform posture test passes with its mocked AWS provider. A new test uses the actual AWS S3 presigner with synthetic credentials and no network: upload checksum, length, type, upload identity and conditional overwrite refusal are signed headers; URLs expire after ten minutes, and downloads request attachment disposition. All four social asset API tests, API typecheck and focused lint pass. This does not establish deployed IAM/S3 access; an actual private-object round trip remains a release check.

### Published-post evidence reader

Read-only inspection of an existing post in the hidden Codex browser confirmed that its activity permalink ID differs from the share ID exposed by the same detail page’s native Boost link. The Boost link was read, not clicked. Added a text-only detail reader that requires one post, one explicit share mapping and one profile author; preserves explicit line breaks; rejects media and collapsed text; and never invents a publication timestamp. Four synthetic DOM tests pass, along with desktop typecheck and focused lint.

This is an evidence primitive only. It is not wired into recovery, does not establish a successful scheduled-to-published transition, and cannot certify image posts. Exact approved-content/account/receipt comparison and product-session publication acceptance remain required. No existing post was changed, and the temporary inspection tab was closed.

### Exact publication recovery wiring

A read-only lookup of a known published share URL opened the same native post detail and independently exposed the distinct activity ID. The browser port now accepts only a validated stored share receipt, reads that detail with bounded polling, and restores the own-profile surface before checking the signed-in account again. It stops on session invalidation or unexpected navigation.

Text-only recovery may report published only after the approved schedule time, with the exact stored share receipt, author, text and activity permalink. Missing receipts, changed content/account/session and malformed links remain unknown; no submission retry or cancellation follows from absence. Actual publication time is not inferred from the receipt.

The full desktop suite passes 1,514 tests (26 skipped). Four focused hidden Electron flows pass, including scheduled-to-published recovery across account-window recreation with exactly one submission and zero deletion. Typecheck and focused lint pass. This is a local synthetic platform test, not live acceptance. The broader host suite had 25 passing tests and one package-launch failure: installed Callie was running, and the production entry point refuses a second instance. No repeat package launch or interruption of the installed app was attempted. Package launch remains unverified.

The secret-scan diagnostic identified an 11-minute parent timeout (ETIMEDOUT/SIGTERM), not a findings report. A retry with a 30-minute bound and unchanged full-history scan coverage is running separately; no release clearance is claimed.
