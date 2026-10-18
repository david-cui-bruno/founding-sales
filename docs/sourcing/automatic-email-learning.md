# Historical automatic email outcomes

Automatic email admission has been removed. The Learning screen retains read-only outcomes and recorded decisions from earlier operation. These records do not schedule work, grant admission authority or authorize contacting people. Ordinary enrollment remains an explicit manual action.

## Retained read path

`/sourcing/learning/v2` returns the existing authorized workspace report. The original endpoint retains its strict installed-client response. Administrators see workspace activity. Other members see admitted firms assigned to them. Unassigned prospect decisions and evidence remain administrator-only. Admitted firms are locked during outcome reads so reassignment cannot cross the visibility check.

Contacted cohorts use the first-contact interval `[from,to)` and accepted outcomes through `asOf`. Enrollment alone is not contact. Discovery hits and manually staged candidates remain separate. Historical automatic outcomes deduplicate committed enrollments and distinguish attempted, sent, unsettled and failed delivery. Replies, opt-outs, meeting records, held qualified conversations and unknown qualification remain separate facts. Provider submission is not proof of inbox placement or received authentication.

## Historical decisions

Retained audit entries contain the reasons, check counts, recorded wake times and owner/mailbox/sequence/evidence bindings actually committed at the time. Recorded wake times are historical, not scheduled work. Sparse old entries remain unavailable rather than gaining invented bindings. Current controls never rewrite historical decisions. The report always presents the removed automatic admission control as disabled.

Reply and firm navigation still open the ordinary Replies and meeting workflows. Existing CRM, conversation, audit and attribution records, retention/privacy behavior and historical migrations remain intact. Removing the automatic producer changes neither send approval nor ordinary sequence limits, ramp, suppression or reply stops.
