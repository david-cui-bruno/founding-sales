# Separate commercial stages from outreach control

The approved broader CRM spec #479 and multiple-opportunity slice #486 allow several commercial initiatives at one firm. Humans explicitly create, label, reopen and select initiatives. Each retains its own stage, contacts, work and outcome. A firm-wide outreach stop still applies regardless of commercial context, and the existing one-active-prospecting-plan restriction is unchanged.

Stage authority is independent of outreach mode and its mutable origin. Existing opportunities default to legacy stage rules; versioned creation and reopening explicitly establish human stage control. Automated conversation evidence cannot advance a human-controlled opportunity. Changing outreach control does not remove that commercial authority.

Actions preserve their exact recorded opportunity, including a deliberately unresolved context. A callback and a callback-time Today item inherit the callback or originating call's context; a contradictory submitted opportunity is refused before writes. Unique-open fallback applies only when the source did not explicitly establish a context. Several plausible deals require review rather than choosing the first. Plural reads expose all retained initiatives, while the Open opportunities count includes only open records. Legacy singleton endpoints refuse ambiguity, and opt-in call/callback context reads preserve default response shapes.

Firm deletion removes human-entered opportunity names while preserving opaque deal identity, stage authority and history. Contact-only deletion does not erase unrelated initiative labels. These source contracts and controlled tests do not establish production migration, signed desktop acceptance or activation. Preserve the release hold and every sending safeguard.
