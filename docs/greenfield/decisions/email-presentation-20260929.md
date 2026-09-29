# The e-mail's presentation: no mandatory stop line, no banned word, still no opt-out link

**David, 29 September 2026.** Decided; migration 0023 and the code around it are the
change.

> The presentation decisions are now settled: remove the mandatory 'Reply "stop"'
> footer and remove the blanket database ban on the word 'unsubscribe.' Inspect the
> constraints and their callers before migrating them. Keep the no-visible-opt-out-link
> rule, automatic handling of stop requests in ordinary language, and
> eligibility/suppression checks.

## Why

**The stop line was a product decision, and it has been reversed.** `Reply "stop" and I
will not email you again.` was appended to every automated e-mail and required of every
approved body. It was never a legal obligation on this product — the obligation is not to
hide how to stop, and Callie does not: a stop request in ordinary language suppresses
automatically. It was a sentence the founder no longer wants at the bottom of a note that
is meant to read as though a person wrote it.

**The word ban banned the thing we want to allow.** `template_versions_no_unsubscribe_link`
and `outbound_messages_no_unsubscribe_link` refused the substring `unsubscribe`, in any
case, anywhere in a body or subject. That refuses *"just reply unsubscribe and I'll
stop"* — a sentence that is the opposite of a web opt-out link, and exactly what the
product does. A CHECK that cannot tell a link from a word was the wrong rule, not a strict
one.

## What is kept, and where it lives now

* **No visible opt-out link**, meaning (decided 29 September, after the review of PR
  311) a URL or `mailto:` on the same line as, or the line immediately before or after,
  an opt-out phrase: `unsubscribe`, `opt out` / `opt-out` / `optout`, `remove me`,
  `stop receiving`, `stop these emails|messages`, `no longer receive`, `list-manage`,
  `manage (your) preferences`. Normalised first — NFKC, named dashes to `-`, named
  spaces to ` `, case-folded — so a non-breaking hyphen does not walk past it.
  `template_versions_no_optout_link` and `outbound_messages_no_optout_link` both call
  `email_has_optout_link()` (migration 0023), and `OPT_OUT_LINK_PATTERN` /
  `hasOptOutLink` in `@fss/contracts` is the same rule for the Mac and the save; one
  table of examples is run against both.
  **Accepted limitations, written down rather than discovered later:** a bare shortener
  with no phrase near it passes, a Cyrillic `О` is not folded to a Latin `O`, and
  "You can opt out by replying. Our website is https://firm.example" is refused although
  the website is unrelated — the price of a rule a CHECK can enforce. The fix for a
  false refusal is a blank line between the link and the phrase; a touching line is
  adjacent.
* **The rule is applied to the final bytes.** The sign-off arrives as its own API field
  and a `{firm_website}` is whatever the CRM holds, so approval checks subject, body and
  sign-off, and the composition and the fence check the rendered subject and composed
  body. A violation there is a handled hold (`footer_not_composed`, detail
  `optout_link`) and never a database exception.
* **Stop requests in ordinary language.** `packages/domain/src/rules/replyClassification.ts`
  is untouched: explicit stop wording suppresses immediately, ambiguous wording holds for
  confirmation (Appendix G 35), and `packages/domain/test/domain/optOutWording.test.ts`
  asserts "please unsubscribe me" and "stop emailing me" still suppress after this change.
* **Eligibility and suppression checks** before every send: untouched.

## What changed in the bytes

The footer is the workspace sign-off, and the `postal_address` setting under it when
there is one (migration 0020). `SENDING_STOP_LINE` is appended nowhere.

Nothing rewrote a stored row. Every template approved and every fence prepared before
today ends with the sign-off and then the stop line; `composeSendBody` recognises that
block and *replaces* it with the one the workspace composes now, so the line goes at the
next send rather than in an `UPDATE`. A body that is signed but whose trailing block this
workspace's records cannot rebuild is held for a person (`footer_ambiguous`), as it was
before — the marker is now the sign-off itself as well as the legacy line.

`sendBodyIssue`, the fence's own guard, is the length question alone. It used to assert
"exactly one final stop line", which is the only thing a function given bytes and no
sign-off could check; with no mandatory line there is nothing left for it to ask, and
whether the footer is right is `composeSendBody`'s question, which is given the
workspace's records.

## The number

The brief provisionally called this migration 0024. The runner refuses a gap in the
sequence (`MIGRATION_VERSIONS_NOT_CONTIGUOUS`) and 0022 is the last file on main, so it
is **0023**. If another 0023 lands first, the coordinator renumbers this file and the
schema range with it.

## What this decision does not touch

Suppression, eligibility, holds, reply classification, the postal-address setting and its
own refusals, the sending gate, and the 12.7 rules about tracking pixels.
