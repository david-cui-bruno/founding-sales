/**
 * The v1 funnel dictionary — documentation constants, not a database constraint.
 *
 * `funnel_facts.kind` is open by design (migration 0022): what the database enforces
 * is a *shape*, and the list below is what the slices of the CRM plan have agreed to
 * call things so two of them do not record the same event under two names. A lane
 * may add a kind here in the pull request that starts emitting it; nothing stops at
 * a schema release for a new one, which is the whole point of the open kind.
 *
 * Reading the dictionary as a constraint would be the mistake. `isFunnelFactKind`
 * answers "is this in the v1 dictionary", and `recordFunnelFact` does **not** call
 * it: a kind a slice invented is recorded, and it is the dashboard's business to
 * show a key it did not expect rather than to lose the fact.
 *
 * Every entry names the slice that emits it and what its dedupe key is built from.
 * The key is always the ids that identify the thing and never a timestamp, so a
 * replayed command or a re-run handler produces one fact
 * (`docs/greenfield/funnel.md`).
 */

export const FUNNEL_FACT_KINDS = [
  /** J-facts. A firm record was created. Key: the firm id. */
  'firm.created',
  /** R (research). A firm's research run completed. Key: the research run id. */
  'firm.researched',
  /** C (telephony). A call was dialled. Key: the call log id. */
  'call.placed',
  /** C. The call reached a person. Key: the call log id. */
  'call.connected',
  /** C. The call reached the person Callie wanted. Key: the call log id. */
  'call.engaged',
  /** M (calendar). A meeting was put in the calendar. Key: the calendar event id. */
  'meeting.booked',
  /** M. The meeting happened. Key: the calendar event id. */
  'meeting.held',
  /** W (warm mail). A warm message was sent. Key: the outbound message id. */
  'mail.warm_sent',
  /** W. A human reply arrived to one. Key: the inbound mail message id. */
  'mail.replied',
  /** O (offers). An offer went out. Key: the offer id. */
  'offer.sent',
  /** O. The offer was accepted. Key: the offer id. */
  'offer.accepted',
  /** O. Money arrived against it. Key: the provider's payment id. */
  'payment.received',
  /** D (demo). A visitor started the demo. Key: the demo session id. */
  'demo.started',
  /** D. The visitor reached the end of it. Key: the demo session id. */
  'demo.completed',
  /** L (LinkedIn publishing). A post was published. Key: the provider's post id. */
  'post.published',
] as const;

export type FunnelFactKind = (typeof FUNNEL_FACT_KINDS)[number];

/**
 * The shape migration 0022's `funnel_facts_kind_shape` CHECK enforces, written once
 * here so a refusal happens in the recorder rather than as a constraint violation
 * that aborts the caller's transaction.
 */
export const FUNNEL_KIND_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/u;

/** The shape of `funnel_facts.source`: the module that wrote the fact. */
export const FUNNEL_SOURCE_SHAPE = /^[a-z][a-z0-9_]*$/u;

/**
 * The shape migration 0022's `funnel_facts_dedupe_key_shape` CHECK enforces.
 *
 * Ids, colons, dots and dashes — enough for `<uuid>:<code>` and a provider's own
 * reference, and not enough for a name: there is no space in the alphabet.
 */
export const FUNNEL_DEDUPE_KEY_SHAPE = /^[0-9a-zA-Z_:.-]{1,200}$/u;

/**
 * What a `detail` key and a `detail` string value may look like.
 *
 * The database bounds the column and checks it is an object; these two keep it a
 * *count*. A firm-less fact has no firm for the deletion workflow to find it by, so
 * a `detail` that could hold a sentence would be a sentence with no deletion path.
 */
export const FUNNEL_KEY_SHAPE = /^[a-zA-Z][0-9a-zA-Z_]{0,63}$/u;
export const FUNNEL_DETAIL_VALUE_SHAPE = /^[0-9a-zA-Z_:.-]{1,64}$/u;

const DICTIONARY: ReadonlySet<string> = new Set<string>(FUNNEL_FACT_KINDS);

/** Is this one of the v1 dictionary's kinds? Not a gate on recording; a question. */
export function isFunnelFactKind(kind: string): boolean {
  return DICTIONARY.has(kind);
}
