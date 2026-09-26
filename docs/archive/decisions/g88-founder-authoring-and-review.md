# g88: a founder authors and starts a sequence, reviews a resume, picks a reply's conversation, and confirms a number

**Date:** 25 September 2026 · **Lane:** g88 founder gaps, part 2 · **Spec:** 4.3, 7.2, 7.4,
8.2, 9.1, 11.1, 11.2, 12.3, 12.6, 14.2 · **Audit:** `GPT6-ASTRA-EXHAUSTIVE-20260925.md` G03,
G06, G07, G08, C19, C20, C21, and the route-usability gap lane g84 reported

## What was wrong

* **G03.** The sequence editor showed a sequence and could not make one. `saveDraft` was
  declared in the window's contract and exposed by the preload script, and no main-process
  handler answered it. Nothing wrote a template. Nothing on the Mac enrolled anybody.
* **G06.** "Review and resume" resumed on the first press and rendered nothing, where 4.3
  asks the salesperson to "review the rendered future steps and explicitly resume".
* **G07.** An ambiguous reply listed its candidate firms as paragraphs; the window could
  not send G7's resolution, and the confirmation refuses an unresolved ambiguity.
* **G08.** Settings edited every slice as a JSON textarea, printed endpoint paths and lane
  names, and showed raw codes (`admin_only`) as reasons; the sequence editor printed a
  content hash and raw stop-condition codes on the face of every template and version.
* **C19.** The new-firm query joined only the open opportunity, so a Won or Lost firm read
  as never contacted and came back on Today as a new firm.
* **C20.** The contact editor sends null for an emptied title and the bridge dropped the
  field — which in a patch means "unchanged". Worse than the audit said: the bridge sent
  the fields beside `contactId` rather than in the `patch` the route's strict schema reads,
  so **every** contact save from the Mac was a 400.
* **C21.** Firms without a pipeline placement vanished from the board. **Already fixed** by
  lane g84 (PR 225): the bridge keeps `unplacedFirms` and the window lists them under "Not
  in the pipeline yet". Nothing was changed here.
* **Routes.** A number added or imported from the Mac is `candidate`, `authorizeDial` step 3
  refuses a candidate, and nothing on the Mac could make one usable, so a firm just added
  could be called by nobody.

## Decisions

### 1. Authoring is the existing commands, in the order a founder meets them

No new sequence or template endpoint. The editor drives `POST /sequences/create`,
`/sequences/versions/draft`, `/sequences/versions/steps`, `/templates/create`,
`/templates/approve`, `/sequences/versions/publish` and `/enrollments/enroll`, each a
command with a receipt.

* **New sequence** is one press and two commands: the sequence, then its first empty
  draft, because a sequence with no draft opens to nothing to type into.
* **The step editor** holds the draft's steps as typed controls — channel (Call or
  Email), a delay in business days or hours after enrolment, the template an email sends
  or what a call does when nobody answers — with up, down and remove on hover. Nothing is
  sent until **Save draft**; a step's ordinal is its place in the list, assigned at save,
  so a reorder can never leave the gap `publishVersion` refuses. **Publish** is disabled
  while the editor holds unsaved changes. A published version offers **Edit as a new
  draft** (11.1's "editing a published sequence creates a new draft") when no draft is open.
* **No LinkedIn step is offered** (David dropped LinkedIn). A draft copied from a version
  that has one still shows it, marked "no longer offered", and it can only be removed;
  silently dropping it on save would be deleting a step nobody chose to delete.
* **The founder default is a fill, not a sequence.** An empty draft offers "Start from the
  suggested plan": a call the day of enrolment, an email two business days later (naming
  the newest approved template, if any), and a call two business days after that. It fills
  the editor; saving makes it a draft; only Publish publishes it. A server-side default
  sequence was rejected: it would exist in every workspace whether wanted or not, and an
  email step cannot be saved without a template the workspace may not have yet.
* **The template form** takes a name, a subject, the email and the sign-off. The bridge
  appends the sign-off and 12.6's stop line, because the approval requires the body to
  *end* with them and a founder should never have to type that correctly. The declared
  variables are the ones the text names, and the form refuses before sending a variable
  Callie cannot fill (`TEMPLATE_VARIABLE_NAMES`, now in `@fss/contracts` so the form and
  the filler share one list), an unsubscribe link (the database's CHECK), and an email over
  89 words (the approval's limit). Approval stays a separate press (11.1).
* **A refused approval names every issue.** The API puts them after the code
  (`template_unapproved:a,b,c`), and the Mac's transport keeps a code only up to 80
  characters — three issues came back as `http_409`. The bridge reads the reason from the
  refusal's body.
* **Enrolment is on the Firm page**, in a Sequences section: the running enrolments by
  sequence name and version, and a contact and a published version to enrol. The firm
  and its open opportunity are the page's, never the window's word. A firm with no
  opportunity is offered **Add to pipeline** first (`/opportunities/open`, stage New); a
  Won or Lost firm is enrolled from nowhere. The published list is three existing reads —
  `/sequences`, each sequence's `/sequences/versions`, `/enrollments` for the firm — rather
  than a new endpoint, because a founder has a handful of sequences.

### 2. The resume review is a read, computed by the function the confirmation runs

`previewResume` (`packages/domain/sequences/resume.ts`) and `resumeEnrollment` share one
`resumeDecisionFor`: the same window, the same next channel, the same action kinds, the same
database clock. The preview applies the shift with the same `shiftDueInstant`, locks
nothing and writes nothing — not even the `review_required` flag an automatic
reconsideration writes. `POST /enrollments/resume/preview` returns it with `asOf`.

The window shows what held the enrollment, then each remaining step with its date now and
the date a confirmation gives it, in the firm's frozen zone, and **Resume with these dates**
is the only control that resumes. The bridge enforces the order: asked to resume an
enrollment whose review is not on screen, it opens the review and resumes nothing. When
something is still holding the enrollment the review says so and offers no confirmation.
The confirmation decides again under its lock; the dates are the review's unless a hold
opened in between, and then the answer says nothing moved.

### 3. The candidate selector sends G7's resolution with `human: false`

One radio per candidate, nothing chosen until the person chooses, and **This one** sends
`POST /messages/resolve-ambiguity` — the one resolution path
`docs/archive/decisions/g7b-ambiguity-stays-where-g7-put-it.md` says the window should use.
`human` is false: choosing the conversation is not saying the reply is a person's, and the
disposition confirmed next is what sets the opportunity to manual (12.4). The resolution's
only consequence is 12.3's: the other candidates' ambiguity holds are released after a
fresh check, and the chosen one keeps an `uncertain_reply` hold until the reply's
disposition is confirmed. The bridge refuses an opportunity that is not one of the open card's candidates
without sending anything. The card stays open and is read again, so the next question
appears.

### 4. Settings has typed controls; machinery is behind "Details"

Following the postures form (lane g84): the business zone is a picker of the same US zones
Add firm offers; production sending is a switch and a release-gate reference; the supported
versions are two fields; the ten alarm thresholds are labelled numbers and a time.
`settingFields` builds them from a slice's value and `settingValueFrom` reads them back;
nothing is clamped, and the server's `invalid_value` is still the answer. The version and
when it changed, and the value as JSON, are behind each setting's **Details**; alarm
thresholds and versions are behind **Advanced**; the other settings are listed by topic,
with their endpoints and owning lanes behind **Where each is changed**. Reasons read as
sentences. A slice this build does not know is edited as JSON under Details, so a slice the
API gains is never uneditable. This supersedes `docs/archive/decisions/g9-settings-editing-is-json.md`
for the four slices that exist.

In the sequence editor the content hash, the footer block and the declared variables are
behind a template's **Details**, and the stop conditions read as one sentence with the codes
behind the version's **Details**.

### 5. A person confirms a phone number; an address is not confirmed by hand

`POST /contacts/routes/confirm { routeKind: 'phone', routeId, routeVersion }` runs
`confirmPhoneRoute`. Section 7.4 makes a route usable only when "a versioned provider/source
policy satisfies both technical-validation and association-confidence thresholds". For a
phone number in version one the person is the provider: a call is a `tel:` handoff, nothing
Callie runs sees the line, and lane g60 made the same judgement for the number a call
leaves on (`docs/archive/decisions/g60-calling-identities-are-attested-in-version-one.md`). So the
confirmation supplies both halves — `technical_validation = 'passed'`, confidence 1 — and
`decideRouteEligibility` still decides; nothing writes `usable` itself. The source is left
as it was: a person vouching for an imported number did not type it.

* **Who and when** is the command's receipt and an audit event `route.phone.confirmed` with
  the actor, database time, and `method: 'person_confirmed'`, which is what tells a later
  reader this route was vouched for rather than validated by a provider.
* **The version bumps**, because the eligibility moved and 9.1's card compares against it.
* **The version on screen travels with the command**; a number changed since the page was
  drawn is refused `route_version_stale`. A usable number is answered as it is, without a
  bump. A number that failed validation is refused `route_invalid`: the policy says a
  failure is a new retrieval, not a higher confidence.
* **Email is phone-only by design, not by omission.** An address's technical validation is
  deliverability — a mailbox that exists and accepts mail — which a person looking at an
  address cannot supply, and email is the automated channel, where an unvalidated address
  is a bounce against the domain's reputation (12.6, 12.7). The wire schema's
  `z.literal('phone')` is the rule. The Firm page says under an unconfirmed address why
  there is no button. Making addresses usable needs a validator — the route policy's lane —
  before sending opens on about 1 October.

### 6. Won and Lost firms are not new firms

`newFirmSource` excludes a firm with any closed opportunity. A firm reopened after a loss is
not new either, whatever stage the reopened opportunity stands at: it has been worked.

## Compatibility

**No migration**; the schema range is unchanged. Two new endpoints —
`/enrollments/resume/preview` and `/contacts/routes/confirm` — and two new CRM refusal codes
(`route_version_stale`, `route_invalid`) that only the new endpoint returns. No existing
response changed shape. The installed 1.0.5 never calls either endpoint, and its contact
saves were already failing. The new desktop needs the new API, so the API is deployed first.
