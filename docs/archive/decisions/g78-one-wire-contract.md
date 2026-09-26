# g78: one wire contract for every desktop read

Lane g78, 25 September 2026. Audit items D01–D07, T04 and B01
(`GPT6-ASTRA-EXHAUSTIVE-20260925.md`, section 2).

## The drift class

The Mac parsed most API answers with schemas it wrote itself, in
`apps/desktop/src/main/*Bridge.ts` and `apps/desktop/src/renderer/*Contract.ts`. The
unit fixtures were written to those same schemas, so each suite agreed with itself
while the real answers drifted away:

- D01: the step schema was strict and did not know `sequenceVersionId`, which `toStep`
  puts on every step. Every populated version failed to parse.
- D02: the enrollment schema was strict and missed four of the thirteen fields. Every
  populated enrollment list failed to parse.
- D03: the classifier effort stopped at `high`; the server also accepts `xhigh` and `max`.
- D04: the history schema stripped `current` and every version's `value`, and nothing
  drew the versions anyway.
- D05: the transport kept only a refusal's code, the CRM bridge never set `merge`, and a
  replayed refusal came from a receipt that did not keep the conflicts.
- D06: a failed sequence read became an empty list, indistinguishable from "none".
- D07: some copies were strict, some `.loose()`, and vocabularies were `z.string()`.

g69 found the same class in the sending section (release.md 8.0ae).

## Decision

**Each response DTO is declared once, in `packages/contracts/src`.** New files:
`sequences.ts`, `replies.ts`, `outbound.ts`, `today.ts` and `wire.ts`. `settings.ts`,
`crm.ts` and `dial.ts` gain the history, alert-acknowledgement, stages, firm-list,
board, merge-refusal and calling-number-change answers. The desktop imports them.
What stays on the Mac is view state: the IPC state schemas, the LinkedIn card, the
encrypted cache's shape, and the projections a bridge makes (the reply window keeps
three of the classifier's seven fields).

**Exact at the route, tolerant on the Mac.** The response objects are `z.object`, which
strips a key it does not declare instead of refusing the answer. Each route's own API
test runs its real answer through `wireDrift(schema, answer)`. `wireDrift` is the parse
plus a list of every key the parse dropped. An undeclared key, a missing key, a wrong
type or a value outside a vocabulary is a line in that list, and the test fails in the
API's CI.

Strict parsing on the Mac was rejected because of the version ceiling
(`g78-version-ceiling.md`). An API is now routinely deployed ahead of installed
desktops. A strict parser would turn every field the API adds into an answer those
desktops cannot read, and that is D01 with the sides swapped.

**Vocabularies are the domain's, spelled once.** The desktop cannot import
`@fss/domain` (14.2), so `@fss/contracts` spells each closed list, for example
`CLASSIFIER_EFFORTS`, `ENROLLMENT_END_REASONS` and `TODAY_LANES`.
`apps/api/test/wireVocabulary.test.ts` compares each spelling with the domain's list.
The one list with no domain array, the confirmation consequences, is compared with
migration 0011's CHECK. The domain is unchanged.

**Every window's read is checked end to end.** `test/release/sequences.check.ts`,
`replies.check.ts`, `settingsHistory.check.ts` and `crmMerge.check.ts` follow
`sendingSection.check.ts`. Each runs the real route over a real database and session,
feeds the answer to the real bridge and view, and asserts what is rendered. They also
hold the unit fixtures in `apps/desktop/test/support/` to the routes, key for key and
type for type.

**A failed read says so.** Each sequence slice carries a `readErrors` entry. The window
draws one grey line with the code and a Retry button where the slice would be, the
pattern g69 used for sending.

**A refusal's body travels.** The transport keeps a refused answer's body beside its
code, and it never leaves the main process. `runCommand` stores a refusal's typed
details in the receipt as `{ reason, details }`. A bare string still reads as before, so
old receipts replay unchanged, and a replayed merge refusal carries its conflicts.

## What this promises, and what it does not

For an API admitting a 1.x line, compatible means:

- every route an admitted build calls still exists;
- every field it reads keeps its name and type;
- no closed vocabulary it validates gains a value.

Adding a response field is compatible, because the Mac strips it. Adding a vocabulary
value is not: an installed Mac refuses the answer. For a new value the desktop that
knows it ships first, then the API starts sending it.

The DTOs that were already in `@fss/contracts` and strict are unchanged: the session
grant, the client-version notice, the firm page and the calling identity. Installed
1.0.x builds parse them strictly, so adding a field to any of them is a breaking change
until the minimum passes 1.0.5. `wireDrift` works on them too, and they can move to
stripping objects in a later lane.
