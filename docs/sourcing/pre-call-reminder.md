# Current call reminders — #449

Callie uses the existing actionable-notification ledger and current Today projection
to offer one reminder in the fifteen minutes before an owned, active Cal.com-derived
call. The reminder opens the existing authorized meeting brief. It does not create,
move or cancel appointments, replace Cal.com reminders, or confirm attendance.

The occurrence includes the durable meeting ID, current Cal.com booking UID and
current start time. A replacement booking at the same time is still a different
occurrence. Exact current-target validation rejects cancelled, moved, replaced and
formerly owned context. An older Cal.com delivery cannot revive a cancelled call.
Server acknowledgement and the desktop's final current read retain separate roles:
a replayed acknowledgement receipt does not itself authorize navigation.

Retained schema66 targets may omit the booking UID and remain readable. They cannot
authorize the current occurrence. An existing attempt for the same meeting/start
must continue to suppress another native submission when its older record cannot
prove a different booking. Durable markers are not deleted or rewritten to retry.
An unknown native result stays unknown unless native evidence settles it.
Legacy native history suppresses a second show for the same meeting/start after a
database restore. Its old identifier cannot prove the current booking UID was
shown: current-occurrence receipt state stays unknown. A click still needs fresh
authorized context before it can open the current brief.
An old handle's later failure also stays unknown for the current booking; it
cannot attest failure of a native submission that never happened.

The authenticated, awake desktop checks all hours, including evening calls. Sleep
and closed-app delivery are not promised. Suspend retains the original native
object while invalidating old callbacks; resume rebinds current authority without
showing it again. Offline status, attempted submission, observed native show,
unknown outcome and acknowledgement remain distinct. Today work is completed
through its own existing workflow.

## Verification boundaries

The approved persistent seam uses the public Cal.com ingestion and notification
candidate/read/claim/observe/acknowledgement operations against real local
PostgreSQL with controlled times. Existing meeting-brief and firm-reassignment
operations verify current context and ownership. Legacy receipt SQL is fixture
setup, not a behavioral assertion.

The desktop seam uses the real authenticated HTTP client and notification runtime
with controlled remote responses and native handles, plus the visible notification
status component. These checks cover one show through resume, current routing,
cancelled-context refusal, offline recovery without replay, truthful unknown status
and suppression of an older read after the current call disappears.

The original behavioral red reproduced an obsolete same-time replacement reminder
opening a target. A second red reproduced an unversioned retained target still
authorizing navigation. The coordinated current-booking identity and legacy
deduplication fixes pass both public regressions. The retained native-history red
also passes without another native show and without falsely observing delivery of
the current booking UID.

Migration 0068 extends only the notification target CHECK to accept an optional
validated Cal.com UID, preserving earlier targets and durable markers. Schema 67→68
verification preserves legacy history, accepts a current UID claim and remains
idempotent. The seven focused notification, migration and mandatory constraint
suites passed 1,677 checks. Five desktop runtime/API suites passed 24 checks, including
call-specific UI coverage, alias activation and current revalidation after an old
acknowledgement replay. Contract/domain/desktop typechecking and owned-file lint
are required before the owned commit. Focused receipts remain in local
`.context/449-*.txt`; combined repository checks, exact schema63→68 upgrade
verification and independent review remain the integrating coordinator's work.

These checks do not establish real signed macOS delivery, a production backend
release, or signed desktop publication; those belong to #466 and the normal
release gates. Sending safeguards, original Shirley cadence, admission and routine
reply controls, autonomous calling, budgets and provider permissions are unchanged.
