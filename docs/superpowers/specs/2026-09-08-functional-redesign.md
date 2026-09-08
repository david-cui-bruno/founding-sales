# FSS contact-first, playbook-driven outreach

Approved 2026-09-08 at 14:36 UTC. Authoritative strategy: [supplied playbook](2026-09-08-user-playbook.md). No further strategy research.

## Requirements

1. Today prioritizes actual warm introductions and due commitments. Active warm work idles discretionary hot/cold prospecting, not genuine callbacks or post-stage commitments. Do not invent the four PM firms.
2. Every active cycle has one authoritative dated action. Unreviewed gets an internal dated action, not founder homework. This supersedes migration 0010. Preserve history, settlement, lifecycle and opt-out guards. Reuse existing six cadence families with serial channel bundles.
3. RI manual calls weekdays 09:00–18:00, MA never after20:00. Person-wide opt-out wins. Never use Callie's own number/voice for prospecting. No implicit calls/texts/sends.
4. Compact contact list plus portfolio-first overview: identity, supported role/organization, known portfolio, specific supported reason. History, scores, diagnostics and contact evidence are secondary. No Next button. Cold: Call primary, Email secondary. Remove default prepare/refresh/discovery-question/judgment controls.
5. Aggregate deduplicated holdings across associated prospects. Separate evidence-backed owned/managed holdings from unexplained links. Unknown counts stay unknown, all totals scoped as known/partial. No PM role inferred from company spelling.
6. Email opens a durable editable draft for the selected person/contact. Model uses supplied playbook and bounded supported facts, never private local-only notes. Unconfigured model is honestly unconfigured, not a template sold as AI. Opening/generating/editing never changes lifecycle.
7. Only explicit Send dispatches. Main binds recipient/account/content/contact snapshot. Persist intent before exactly one provider call. Replay is locally idempotent. Unknown/crash never auto-retries, even under new command ID. Late opt-out is never undone. Accepted email is recorded once and only matching action advances. Acceptance is not delivery, reply or interview.
8. User-owned OpenAI key/model and Google Desktop OAuth setup in Settings. Main-only safeStorage encrypted secrets, no plaintext fallback, no borrowed Jcode credentials. Official Responses store:false structured output. Gmail send-only plus identity scopes, loopback PKCE/state, timeout/cleanup. Explicit connect/disconnect. Require sender identity/postal address and preview reply-opt-out footer before Send.
9. No live mail/model calls, account changes, real-profile access or app replacement during implementation/tests. Build separate package, never canonical out while real app runs. Fixture success is not live provider verification.

## Frozen provider interface

Provider worker owns `src/main/outreach/providers/providerTypes.ts` and `outreachProviders.ts`.

```ts
export type SetupState = 'unconfigured'|'ready'|'locked'|'reauthorize'|'error';
export type OutreachStatus = {model:SetupState;modelName:string;gmail:SetupState;accountEmail:string|null;senderName:string;postalAddress:string};
export type ConfigureOutreach = {apiKey?:string;model?:string;googleClientId?:string;googleClientSecret?:string;senderName?:string;postalAddress?:string};
export type GroundedDraftContext = {personName:string;organizationLabel:string|null;segment:'hot'|'cold'|'warm';stage:string;actionLabel:string|null;facts:{id:string;text:string}[];playbook:string};
export type GeneratedDraft = {subject:string;body:string;evidenceIds:string[];provider:'openai';model:string;responseId:string};
export type FrozenEmail = {commandId:string;from:string;to:string;subject:string;body:string};
export type EmailSendResult = {status:'accepted';messageId:string;threadId:string|null}|{status:'not_sent';reasonCode:string}|{status:'unknown';reasonCode:string};
export interface PreparedGmailSender {readonly accountEmail:string;sendOnce(email:FrozenEmail):Promise<EmailSendResult>}
export interface OutreachProviders {
 status():Promise<OutreachStatus>;
 configure(input:ConfigureOutreach):Promise<OutreachStatus>;
 connectGmail():Promise<OutreachStatus>;
 disconnectGmail():Promise<OutreachStatus>;
 generate(context:GroundedDraftContext,signal:AbortSignal):Promise<GeneratedDraft>;
 prepare(signal:AbortSignal):Promise<PreparedGmailSender>;
 invalidate?():void; // Required on the real factory; optional only for existing fixtures.
 dispose():void;
}
```

Factory: `createOutreachProviders({directory,safeStorage,openExternal,fetch?,now?})`. `safeStorage` is async-or-sync isEncryptionAvailable/encryptString/decryptString. `openExternal(url)` returns Promise<void>; fetch is typeof globalThis.fetch; now is () => number. Refresh token before reservation. Prepared sender account/configuration epoch bound. sendOnce invokes fixed Gmail endpoint immediately, no retries/redirects. No connection/background OAuth before explicit Connect.

## Frozen renderer API

Root owns `src/shared/contracts/outreachContract.ts`, exporting matching setup types plus strict schemas:

```ts
export interface EmailDraft {
 id:string;personId:string;salesCycleId:string;contactMethodId:string;
 recipient:string;subject:string;body:string;revision:number;
 status:'draft'|'sending'|'sent'|'unknown';generation:'none'|'model'|'edited';
 messageId:string|null;notice:string|null;updatedAt:string;
 senderEmail?:string|null;footer?:string; // Production always supplies the frozen preview.
}
export interface OutreachApi {
 status():Promise<OutreachStatus>;
 configure(input:ConfigureOutreach):Promise<OutreachStatus>;
 connectGmail():Promise<OutreachStatus>;
 disconnectGmail():Promise<OutreachStatus>;
 openDraft(input:{personId:string;contactMethodId:string}):Promise<EmailDraft>;
 saveDraft(input:{draftId:string;expectedRevision:number;subject:string;body:string}):Promise<EmailDraft>;
 generateDraft(input:{draftId:string;expectedRevision:number}):Promise<EmailDraft>;
 sendDraft(input:{draftId:string;expectedRevision:number;commandId:string}):Promise<EmailDraft>;
}
```

Exposed as `window.callie.outreach`. Open auto-generates only pristine new draft when configured. Save uses optimistic revision. Send flushes edits first. Recipient is read-only. Unknown locks resend and directs explicit Sent-folder checking, without broader read scopes. Never mix recipients on person switch or overwrite edits from late generation.

Editable body excludes the signature/postal/reply-opt-out footer. Render the persisted senderEmail/footer, not fresh settings. Explicit reopen may refresh that preview and revision. Send rejects any sender/footer change since preview. Lock, wake, configuration changes and shutdown invalidate pending provider work and async requests before external invocation or persistence. Replies stay in Gmail; opt-outs must be recorded in FSS manually.

## Portfolio contract

UI worker extends LeadDetail with optional portfolio/contactReason for fixture compatibility. Production always supplies both. Portfolio: `{role:'owner'|'manager'|'unknown',ownedCount:number,managedCount:number,linkedCount:number,knownUnits:number|null,locations:string[],summary:string,completeness:'partial',facts:{id:string,text:string}[]}`. ContactReason: `{text:string,evidenceIds:string[]}|null`. Linked property alone is not ownership. Draft context consumes supported portfolio.facts, not scores or noteText.

## Ownership and rulings

Cadence worker owns migration0018, migration registry/readiness and action/cadence/lifecycle/today domain/contracts/tests. FounderSalesDomain only Today projection/narrow lifecycle patches coordinated with root.
Provider worker owns providers/**, provider tests and setup docs only.
UI worker owns renderer Today/inspector/composer/settings, leadDetailContract portfolio extension, new domain/portfolio module, ONLY getLeadDetail portfolio projection in facade, UI/portfolio tests.
Root owns shared outreach contract, migration0019, durable email core/evidence, IPC/preload/runtime wiring, integration and package acceptance. Cadence worker registers0019 after file exists.
Supplemental pending historical rows are retained. Uniqueness is the single authoritative current-next-action pointer per operational cycle, not a new unique index over all historical pending rows. Supplemental rows must never enter Today work. Actual callback evidence, not legacy promised_follow_up labels, determines commitments. Warm Unreviewed contacts stay visible, but their internal action must not become founder review homework. New approved playbook overrides previous due-date choices. No additional approval poll for reversible code; stop at live authorization/send/handoff boundary.
