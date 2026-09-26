# G20: an automated email carries no postal address

**Date:** 22 September 2026. **Decided by:** David. **Lane:** G20.

## The decision

Automated email sent by FSS carries no postal address. The footer of every approved
template is the sign-off and then the stop line:

```
<workspace sign-off>
Reply "stop" and I will not email you again.
```

Nothing stands between those two lines, and there is nowhere in the product to
configure an address for them.

The decision was made after the risk was put to him. The coordinator told David twice
that the footer exists because commercial email in the United States must carry a
physical postal address, and that removing it is a compliance decision he owns. His
answer was: "i dont want address at all for i2." This lane carries that out. It is
his decision, not an engineering simplification, and it is recorded here so that the
next person to read `footerBlock` and wonder where the address went finds the reason
rather than an omission.

## What does not change

Specification 12.6 in full. Every automated template still explains how to stop by
replying, and there is still no web unsubscribe link anywhere:

* `SENDING_STOP_LINE` is still the last line of every approvable body, and
  `templateTextIssues` still refuses one that does not end with the footer block
  (`template_footer_missing`);
* `template_versions_approved_has_stop_line` still refuses an approved row whose body
  does not contain `Reply "stop"`;
* `template_versions_no_unsubscribe_link` still refuses any body or subject
  containing the word `unsubscribe`;
* the rolling primary-domain guard of 12.6 (4,000 personal-Gmail recipients per 24
  hours while reply-only opt-out remains configured) is untouched.

The content hash still covers the whole body, so an approval is still bound to the
exact bytes that may be sent — including the footer, because the footer is inside the
body rather than appended at send time.

## Where it deviates from revision 3

Three lines of `FSS-GREENFIELD-SPEC-REV3-20260919.md`:

| Line | What the specification says | What is true now |
|---|---|---|
| 303 | "Admins maintain versioned state postures, call windows, approved template versions, **the postal footer**, sending limits, …" | There is no postal footer to maintain. The `postal_footer` settings slice is gone from `SETTING_KEYS`, from `workspace_settings_key_known` and from the Mac's administration page. |
| 350 | "Email steps reference immutable approved template versions containing subject, body, **footer**, required variables, and content hash." | The stored footer is the sign-off alone. `template_versions.footer_postal_address` is dropped by migration 0015. |
| 436 | "Every automated template's approved footer explains how to stop by replying. No web unsubscribe link is included." | Unchanged and still enforced. The line is listed only because the footer it describes is now two lines rather than three. |

The coordinator updates the specification-deviations review and the `.context`
documents; this record is the engineering half.

## The consequences, stated

* **A United States compliance obligation is not met by the software.** FSS neither
  records nor sends a physical postal address on automated mail. Nothing in the
  product warns about this at send time, because a warning nobody can act on is
  noise; the decision is recorded here instead.
* **Approvals made under the old rule do not survive by accident.** The rule changed,
  so a body that ends in sign-off + address + stop line no longer ends with the
  footer block and cannot be approved. Production has never run, so no approved row
  exists anywhere; a body carried from the old stack arrives unapproved and has to
  have its address block edited out before it can be approved here.
* **The old carry's address is dropped rather than migrated.** The old table's
  `footerPostalAddress` is read nowhere and written nowhere. This supersedes the
  paragraph headed "`footer_postal_address` is null" in
  `docs/archive/decisions/g11-template-importer-seam.md`, which described a column that no
  longer exists; that record is left as written because it is a record of what was
  decided then.
* **Reversing it is a new migration, not a revert.** `footer_postal_address` is
  dropped, not nullable. Bringing the address back means a new column, a new settings
  slice and a new approval rule, and every version approved in between would have to
  be re-approved because the footer block would change again.

## Two engineering choices this lane made under the decision

**The stop line moved to `@fss/contracts`.** The Mac's template panel shows "the
footer block the body must end with" and says whether the body carries it. Before
this lane that block was the sign-off and the address, both of which travelled on the
template row; now it is the sign-off and a sentence the renderer would otherwise have
to re-type, and `apps/desktop` may not depend on `@fss/domain` (14.2). So
`SENDING_STOP_LINE` is declared in `packages/contracts/src/templates.ts` and
re-exported from `packages/domain/src/rules/templates.ts`. Every existing importer is
unchanged, and there is one spelling of the sentence rather than two.

**The `postal_footer` settings history is deleted, not retained.** Migration 0015
deletes every row of the slice, superseded versions included, before it narrows the
CHECK. A superseded row would still break the narrowed constraint, and keeping the
history of a setting that no longer exists would leave `POST /settings/history` able
to answer about a key `SETTING_KEYS` does not have. `workspace_settings` is not one
of the append-only tables — migration 0001's `REVOKE UPDATE, DELETE, TRUNCATE` names
`audit_events` and `suppression_events`, and neither is touched. The delete removes
nothing on any database this statement will ever meet, because production has never
run, but it is written so that it would be correct if it did.
