# Booked-call preparation

Issue #454 extends the existing authorized meeting brief reader and desktop disclosure. No new brief store, model request, recording, analysis enablement, provider permission, paid work or external action is introduced.

Known workflow uses stored maintenance-workflow and software quotes with their observation date and source URL. External reports are explicitly attributed. Missing evidence remains Unknown; prepared research remains not verified by Callie. A recorded first-party workflow produces a suggested question asking whether it is still accurate, rather than converting website copy into current confirmed practice. The call objective and open question are deterministic, labeled inferred preparation prompts, not prospect statements or commitments.

Existing conversation context (recent logged calls/summary and email thread subject/date), objections, booking statements and commitments remain available with their provenance. Email body fetching and new transcript analysis are outside this ticket. Source links are offered only for HTTPS URLs; v1 reads keep their original strict response shape. New desktops opt into `GET /meetings/brief?version=2`; old retained briefs may lack the new optional sections and remain readable with Unknown preparation sections.

The established per-meeting and per-session memory remains authoritative: a definite not_found clears the brief, transient failure retains it, and older or mismatched reads cannot replace current context. Public real-PostgreSQL read and controlled desktop UI tests cover the extension alongside the existing isolation/revocation suite.

This is source completion only. Backend release, signed desktop publication, installed native acceptance, actual meeting usage and any paid recording/analysis activation retain their separate gates. Automatic admission, routine replies, calling, original enrollment holds, lower caps and uncertain-send safeguards are unchanged.
