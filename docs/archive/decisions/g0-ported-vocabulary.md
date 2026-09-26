# G0: what the ported modules changed, and what they kept

The brief says "copy logic, not files, and rename to the spec's vocabulary". These are
the renames and the judgement calls that went with them.

## The template sign-off is configuration, not a repository literal

`src/shared/contracts/replyTemplateContract.ts` pins `REPLY_TEMPLATE_SIGN_OFF` to a
literal containing a real name, a real phone number and a real site. COMMON-G says no
real addresses in fixtures, and a repository literal is worse than a fixture.

`packages/domain/src/rules/templates.ts` takes a `FooterConfiguration` —
`{ signOff, postalAddress, stopLine? }` — and `footerBlock` composes it. The old rule
survives exactly: an approved body must end with the footer, and the postal address
lives in configuration so one edit changes every footer and an address change leaves
every approval behind. What does not survive is the contact detail in the source.

The stop line itself (`SENDING_STOP_LINE`) is still pinned in code: it is product
copy that specification 12.6 requires, it contains no personal data, and an edit to it
should be a visible diff.

The old `template_sign_off_missing` issue is renamed `template_footer_missing`, and the
old Callie-specific `template_product_sentence_missing` becomes an optional
`requiredSentence` rule rather than a hard-coded sentence.

## The state map is a fallback, not the calling window's zone

`TERRITORY_STATE_TIME_ZONES` used to be *the* source of a firm's calling-window zone.
Revision 3 section 9.2 resolves the firm's actual IANA zone from its location, and
"multi-zone states do not use a state-wide time-zone shortcut".

So `stateDefaultZone(state)` returns a zone only for a state that observes one, and
returns `null` for every state in `MULTI_ZONE_STATES` — Texas included, which the old
build mapped to `America/Chicago`. `resolveFirmZone(location, sources)` is the seam:
it prefers a zone already recorded for the firm, then each supplied source (G3 and G10
fill in postal and coordinate lookups), then the single-zone state default. A
multi-zone state with no source is `unresolved: state_spans_zones`, which blocks
calling, which is what section 9.2 requires.

The clearance texts themselves — statements, federal citations, and the Rhode Island,
Massachusetts and Texas summaries and quotations — are carried over byte for byte and
asserted against the old module in the oracle test. Nothing was re-drafted.

## Reply classification: the old kinds map onto revision 3's five classes

| Old `kind` | Revision 3 `class` |
|---|---|
| `opt_out` | `opt_out` |
| `out_of_office` | `automated` |
| `delivery_failure` | `bounce` |
| `rejection`, `substantive`, `scheduling`, `mixed`, `ambiguous` | `uncertain` |

The deterministic layer never returns `human` on its own. Specification 12.4 says a
human classification sets manual only through deterministic proof or salesperson
confirmation, so `classifyReply` returns `human` only when a confirmation is passed
in, and everything it cannot prove is `uncertain` — which holds every automated action
for the firm. The old module's disposition-shaped kinds survive as
`suggestedDisposition`, which is advisory and never acts.

`applyModelSuggestion` changes no class at all. It attaches a label and a signal and
leaves `uncertain` where it was, which is Appendix G 34: a confident "automated" from
the model does not release a message, and malformed output is uncertain.

## The cadence walk kept its shape

`advanceCadence` keeps the old `advanceTerritorySequence` behaviour of walking *past* a
step it cannot execute and recording it as held with its reason, rather than stopping.
It keeps start-anchored timing: a step's delay counts from the enrollment's start, not
from the previous completion, so a firm that waited in a queue does not have its whole
cadence pushed out.

What it drops is the old single-firm territory vocabulary — re-entry counters, rest
periods, `entries`, the Places audience — which revision 3 replaces with enrollments,
immutable sequence versions and `step_executions`. Those belong to the slice that owns
enrollment, not to the foundation.

## The calling window kept its floor

`narrowCallingWindow` is the old rule unchanged: a configured window may only narrow
the floor fixed in code (Monday to Friday, 08:00 to 20:00 on the firm's own clock),
never widen it, and a configuration that leaves nothing is the floor itself. The old
hold words (`state_not_cleared`, `zone_unknown`, `outside_hours`) are replaced by the
specification's closed codes; `zone_unknown` survives as a window-level refusal because
section 9.2 evaluates the window only after the zone is established.
