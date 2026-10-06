# Social runtime and adapter verification

## Current status — 6 October 2026

Social delivery is not released or enabled. No post or native schedule has been created.

The reusable runtime uses a hidden sandboxed Electron window, no Callie preload/Node integration, a hashed partition scoped to workspace/user/platform/account, denied popups/permissions/external navigation, and a bounded page load. Sign-out invalidates active work; explicit account disconnect clears that partition. Unit tests cover isolation, concurrency, cancellation and timeout. The actual Electron fixture probe is recorded separately from platform acceptance.

## LinkedIn inspection

David signed into the Codex browser. The observed account is his David Cui personal profile (`david-cui-589a20228`), not a company Page. The empty composer exposes account selection, audience, a textbox, Media, a Scheduled control and a disabled Post button. The Scheduled control did not open a date/time view with the composer empty. The composer was dismissed without entering content or submitting anything.

This establishes the visible composer surface only. It does not establish the supported date range, receipt, cancellation, image behavior, or acceptance of Callie's separate hidden Electron session. Codex's session is not copied into Callie. Runtime scheduling remains unsupported until those product-owned acceptance checks pass.

Facebook Page and X account inspection and product-runtime acceptance remain pending. No paid scheduler or paid X fallback is selected.
