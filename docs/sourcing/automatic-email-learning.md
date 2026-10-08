# Automatic email outcome visibility

Source implementation for #422; unreleased. Read this alongside the approved roadmap and automatic-email-worker.md. Database/API activation blocks remain unchanged. This read path does not authorize selection, contacting, calling or routine replies.

The existing Learning screen uses `/sourcing/learning/v2`. The original endpoint retains its strict installed-client response. Reports run inside the existing authorized workspace transaction. Administrators see workspace activity; other members see admitted firms assigned to them. Unassigned prospect decisions and their evidence are administrator-only. Admitted firms are locked during outcome reads so reassignment cannot cross the visibility check.

## Stages and intervals

- Existing contacted cohorts cover the first-contact interval `[from,to)` and current accepted outcomes through `asOf`. Enrollment alone cannot create a contacted cohort. Ordinary attribution reconciliation remains the source of first-contact facts.
- Retained discovery hits are source URLs retained during the interval. A candidate with multiple hits counts once as a supported prospect/admitted candidate. Supported email prospects require the current candidate revision, current qualification prompt/policy, complete fresh evidence and the unchanged email-fit predicate. Phone-policy review does not conceal email fit.
- Manual staging has no retained discovery-hit association and is shown separately, excluded from discovery yield. Candidate coverage is the broader inventory, including email admissions as well as call admissions.
- Automatic outcomes follow deduplicated enrollments committed by automatic admissions decided in the interval. Message attempts count claimed outbound messages with dispatch time through `asOf`; they are not rechecks, research dispatches or total network requests. Sent requires a durable sent state/time. Unsettled delivery stays separate from sent and confirmed failure.
- Delivery failures count observed bounce messages. Opt-outs and substantive replies are separate; ambiguous/multi-firm inbound associations are excluded. Replayed matching/booking events cannot inflate counts. A reply needing disposition is a classified human message without an accepted confirmation.
- Bookings count meeting records, independently of attendance. Held qualified conversations require current accepted qualification and confirmed attendance through `asOf`. Unknown qualification stays explicit. Provider submission does not prove inbox placement or received SPF/DKIM/DMARC.

## Decisions and follow-through

Worker batch decisions persist reasons, bounded check counts, next wake times, email rank, owner/mailbox/sequence, policy/prompt, evaluation/report digest, implementation/configuration binding and control revision in the same transaction as their disposition. Whole-batch refusals are observable even when no prospect was checked. No credentials, message bodies or invented people enter the decision audit.

The report joins retained qualification observations/fact block references and created firm/contact/route/plan/enrollment identifiers. Historic bindings come from the committed decision, not today's settings. Older sparse audit entries remain unavailable where they did not record a binding. The report shows the latest run disposition while retaining committed enrollment evidence on replay. Permanent deferrals and exhausted temporary checks have no automatic wake. Changing controls does not rewrite historical decisions.

Reply navigation opens the existing Replies workflow; firm navigation opens its existing meetings. David handles substantive replies within one business day and up to three introductory calls weekly. No proposed-recipient approval task or automatic routine reply is added. Three conversations and a two-week review remain outcomes/checkpoints, not engineering gates.

Remaining gates: #423 representative exact-version evaluation, #424 actual sending/received-authentication verification, and #425 conditional release/activation. This source work changes no production sending controls or Shirley enrollment/schedule.
