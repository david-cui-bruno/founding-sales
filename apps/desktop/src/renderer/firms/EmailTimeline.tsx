import {ProcessingHealth,type ProcessingPorts} from './ProcessingHealth.tsx';
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type {
  MailConversation,
  MailSourceList,
  MailSourceRead,
} from "@fss/contracts";
import type {
  mailCaptureControlsSchema,
  mailSourceStateSchema,
  mailSourceChangedSchema,
} from "@fss/contracts";
import type { z } from "zod";
import { Button } from "../ui/button.tsx";
import { Select } from "../ui/select.tsx";

export interface EmailTimelineFilter {
  mailboxId?: string;
  personId?: string;
  firmId?: string;
}
export interface EmailTimelinePorts {
  list(
    input: EmailTimelineFilter & { afterId?: string; limit: number },
  ): Promise<MailSourceList>;
  read(input: MailSourceRead): Promise<MailConversation>;
  remove?(input: {
    sourceId: string;
    expectedRevision: number;
  }): Promise<z.infer<typeof mailSourceChangedSchema>>;
  restore?(input: {
    sourceId: string;
    expectedRevision: number;
  }): Promise<z.infer<typeof mailSourceChangedSchema>>;
  recapture?(input: {
    sourceId: string;
    expectedRevision: number;
  }): Promise<{ sourceId: string; sourceRevision: number; status: "queued" }>;
  associate?(input: {
    sourceId: string;
    expectedRevision: number;
    personId?: string;
    firmId?: string;
  }): Promise<{ sourceId: string; sourceRevision: number }>;
  controls?(input: {
    mailboxId?: string;
  }): Promise<z.infer<typeof mailCaptureControlsSchema>>;
  state?(input: {
    sourceId: string;
  }): Promise<z.infer<typeof mailSourceStateSchema>>;
  choices?(): Promise<{
    people: readonly RecordChoice[];
    firms: readonly RecordChoice[];
  }>;
}
interface RecordChoice {
  id: string;
  name: string;
}
function textSegments(source: NonNullable<MailConversation["source"]>) {
  const passage = source.passage;
  const segments: {
    text: string;
    kind: (typeof source.ranges)[number]["kind"];
  }[] = [];
  if (passage === null) return segments;
  let cursor = 0;
  for (const range of source.ranges) {
    if (
      range.start < cursor ||
      range.end < range.start ||
      range.end > passage.length
    )
      return [{ text: passage, kind: "unknown" as const }];
    if (range.start > cursor)
      segments.push({
        text: passage.slice(cursor, range.start),
        kind: "unknown",
      });
    if (range.end > range.start)
      segments.push({
        text: passage.slice(range.start, range.end),
        kind: range.kind,
      });
    cursor = range.end;
  }
  if (cursor < passage.length)
    segments.push({ text: passage.slice(cursor), kind: "unknown" });
  return segments;
}
export function EmailTimeline({
  enabled,
  processing,
  workspaceId,
  ports,
  privacyKey,
  sourceVersion = 0,
  onSourceChange,
  mailboxId,
  personId,
  firmId,
  people = [],
  firms = [],
}: {
  enabled: boolean;
  processing?:ProcessingPorts | undefined;
  workspaceId?:string | undefined;
  ports: EmailTimelinePorts;
  privacyKey: string;
  sourceVersion?: number | undefined;
  onSourceChange?: (() => void) | undefined;
  mailboxId?: string;
  personId?: string;
  firmId?: string;
  people?: readonly RecordChoice[];
  firms?: readonly RecordChoice[];
}): JSX.Element | null {
  const scope = JSON.stringify([
    privacyKey,
    workspaceId,
    mailboxId,
    personId,
    firmId,
    sourceVersion,
  ]);
  const [displayScope, setDisplayScope] = useState(scope);
  const [page, setPage] = useState<MailSourceList | null>(null);
  const [detail, setDetail] = useState<MailConversation | null>(null);
  const [error, setError] = useState("");
  const [mutating, setMutating] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [queued, setQueued] = useState<Record<string, number>>({});
  const [reviewedPerson, setReviewedPerson] = useState("");
  const [reviewedFirm, setReviewedFirm] = useState("");
  const [controls, setControls] = useState<z.infer<
    typeof mailCaptureControlsSchema
  > | null>(null);
  const [choices, setChoices] = useState<{
    people: readonly RecordChoice[];
    firms: readonly RecordChoice[];
  }>({ people: [], firms: [] });
  const issuance = useRef(0);
  const invalidateReads = useCallback(() => ++issuance.current, []);
  useEffect(() => {
    let currentScope = true;
    const ticket = invalidateReads();
    setDisplayScope(scope);
    setPage(null);
    setDetail(null);
    setError("");
    setMutating(false);
    setLoadingMore(false);
    setQueued({});
    setReviewedPerson("");
    setReviewedFirm("");
    setControls(null);
    setChoices({ people: [], firms: [] });
    if (enabled && ports.choices)
      void ports
        .choices()
        .then((value) => {
          if (currentScope) setChoices(value);
        })
        .catch(() => {
          if (currentScope) setChoices({ people: [], firms: [] });
        });
    if (enabled && ports.controls)
      void ports
        .controls(mailboxId ? { mailboxId } : {})
        .then((value) => {
          if (ticket === issuance.current) setControls(value);
        })
        .catch(() => {
          if (ticket === issuance.current) setControls(null);
        });
    if (enabled)
      void ports
        .list({
          ...(mailboxId ? { mailboxId } : {}),
          ...(personId ? { personId } : {}),
          ...(firmId ? { firmId } : {}),
          limit: 50,
        })
        .then((value) => {
          if (ticket === issuance.current) setPage(value);
        })
        .catch(() => {
          if (ticket === issuance.current)
            setError("Email history could not be loaded.");
        });
    return () => {
      currentScope = false;
      invalidateReads();
    };
  }, [
    enabled,
    ports,
    privacyKey,
    mailboxId,
    personId,
    firmId,
    sourceVersion,
    scope,
    invalidateReads,
  ]);
  async function open(source: MailSourceList["sources"][number]) {
    const ticket = ++issuance.current;
    setDetail(null);
    setLoadingMore(false);
    setError("");
    setReviewedPerson("");
    setReviewedFirm("");
    try {
      const value = await ports.read({
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        contentHash: source.contentHash,
      });
      if (ticket === issuance.current) {
        if (value.state === "unavailable") setPage(null);
        setDetail(value);
      }
    } catch {
      if (ticket === issuance.current) {
        setPage(null);
        setError("This copied email is unavailable. Refresh the history.");
      }
    }
  }
  async function refresh() {
    if (mutating) return;
    const ticket = ++issuance.current;
    setPage(null);
    setDetail(null);
    setLoadingMore(false);
    setError("");
    try {
      const current = await ports.list({
        ...(mailboxId ? { mailboxId } : {}),
        ...(personId ? { personId } : {}),
        ...(firmId ? { firmId } : {}),
        limit: 50,
      });
      if (ticket === issuance.current) setPage(current);
    } catch {
      if (ticket === issuance.current)
        setError("Email history could not be loaded.");
    }
  }
  async function more() {
    if (page?.nextAfterId === null || page === null || loadingMore || mutating)
      return;
    const ticket = ++issuance.current;
    const base = page;
    setLoadingMore(true);
    try {
      const next = await ports.list({
        ...(mailboxId ? { mailboxId } : {}),
        ...(personId ? { personId } : {}),
        ...(firmId ? { firmId } : {}),
        ...(base.nextAfterId ? { afterId: base.nextAfterId } : {}),
        limit: 50,
      });
      if (ticket === issuance.current)
        setPage({
          ...next,
          sources: [
            ...new Map(
              [...base.sources, ...next.sources].map((row) => [
                row.sourceId,
                row,
              ]),
            ).values(),
          ],
        });
    } catch {
      if (ticket === issuance.current) {
        setPage(null);
        setDetail(null);
        setError("More copied emails could not be loaded.");
      }
    } finally {
      if (ticket === issuance.current) setLoadingMore(false);
    }
  }
  async function remove(source: NonNullable<MailConversation["source"]>) {
    if (!ports.remove || mutating) return;
    const ticket = ++issuance.current;
    setPage(null);
    setDetail(null);
    setMutating(true);
    setLoadingMore(false);
    setError("");
    try {
      await ports.remove({
        sourceId: source.sourceId,
        expectedRevision: source.sourceRevision,
      });
      if (ticket !== issuance.current) return;
      onSourceChange?.();
      const current = await ports.list({
        ...(mailboxId ? { mailboxId } : {}),
        ...(personId ? { personId } : {}),
        ...(firmId ? { firmId } : {}),
        limit: 50,
      });
      if (ticket === issuance.current) setPage(current);
    } catch {
      if (ticket === issuance.current)
        setError(
          "The copied email could not be updated. Refresh before trying again.",
        );
    } finally {
      if (ticket === issuance.current) setMutating(false);
    }
  }
  async function restore(row: MailSourceList["sources"][number]) {
    if (!ports.restore || mutating) return;
    const ticket = ++issuance.current;
    setPage(null);
    setDetail(null);
    setMutating(true);
    setLoadingMore(false);
    setError("");
    try {
      await ports.restore({
        sourceId: row.sourceId,
        expectedRevision: row.sourceRevision,
      });
      if (ticket !== issuance.current) return;
      onSourceChange?.();
      const current = await ports.list({
        ...(mailboxId ? { mailboxId } : {}),
        ...(personId ? { personId } : {}),
        ...(firmId ? { firmId } : {}),
        limit: 50,
      });
      if (ticket === issuance.current) setPage(current);
    } catch {
      if (ticket === issuance.current)
        setError(
          "The copied email could not be updated. Refresh before trying again.",
        );
    } finally {
      if (ticket === issuance.current) setMutating(false);
    }
  }
  async function recapture(row: MailSourceList["sources"][number]) {
    if (
      !ports.recapture ||
      mutating ||
      queued[row.sourceId] === row.sourceRevision
    )
      return;
    const ticket = ++issuance.current;
    setDetail(null);
    setMutating(true);
    setLoadingMore(false);
    setError("");
    try {
      const result = await ports.recapture({
        sourceId: row.sourceId,
        expectedRevision: row.sourceRevision,
      });
      if (ticket !== issuance.current) return;
      setQueued((current) => ({
        ...current,
        [result.sourceId]: result.sourceRevision,
      }));
      const current = await ports.list({
        ...(mailboxId ? { mailboxId } : {}),
        ...(personId ? { personId } : {}),
        ...(firmId ? { firmId } : {}),
        limit: 50,
      });
      if (ticket === issuance.current) setPage(current);
    } catch {
      if (ticket === issuance.current) {
        setPage(null);
        setError(
          "Recapture could not be requested. Current capture verification is required.",
        );
      }
    } finally {
      if (ticket === issuance.current) setMutating(false);
    }
  }
  async function associate(source: NonNullable<MailConversation["source"]>) {
    if (!ports.associate || mutating || (!reviewedPerson && !reviewedFirm))
      return;
    const ticket = ++issuance.current;
    setPage(null);
    setDetail(null);
    setMutating(true);
    setLoadingMore(false);
    setError("");
    try {
      await ports.associate({
        sourceId: source.sourceId,
        expectedRevision: source.sourceRevision,
        ...(reviewedPerson ? { personId: reviewedPerson } : {}),
        ...(reviewedFirm ? { firmId: reviewedFirm } : {}),
      });
      if (ticket !== issuance.current) return;
      onSourceChange?.();
      const current = await ports.list({
        ...(mailboxId ? { mailboxId } : {}),
        ...(personId ? { personId } : {}),
        ...(firmId ? { firmId } : {}),
        limit: 50,
      });
      if (ticket === issuance.current) setPage(current);
    } catch {
      if (ticket === issuance.current)
        setError(
          "The email context could not be updated. Refresh before trying again.",
        );
    } finally {
      if (ticket === issuance.current) setMutating(false);
    }
  }
  if (!enabled || displayScope !== scope) return null;
  const source = detail?.state === "available" ? detail.source : null;
  const personChoices = people.length > 0 ? people : choices.people;
  const firmChoices = firms.length > 0 ? firms : choices.firms;
  function contexts(rows: NonNullable<typeof source>["originalContexts"]) {
    return rows.length === 0 ? (
      <p>No firm or person context recorded.</p>
    ) : (
      <ul>
        {rows.map((context) => (
          <li key={context.contextId}>
            <p>
              {context.identityStatus === "observed_label"
                ? "Observed name; person unconfirmed"
                : context.personId === null
                  ? "Person unknown"
                  : (personChoices.find(
                      (person) => person.id === context.personId,
                    )?.name ?? `Person record: ${context.personId}`)}
            </p>
            <p>
              {context.firmId === null
                ? "Firm unknown"
                : `Firm: ${firmChoices.find((firm) => firm.id === context.firmId)?.name ?? context.firmId}`}
            </p>
            {context.review === "review_required" ? (
              <p>Context needs review; original context remains recorded.</p>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section aria-label="Email timeline" className="space-y-3">
      <h3>Email timeline</h3>
      {ports.controls ? (
        <p>
          {controls === null
            ? "Capture status unavailable."
            : controls.enabled
              ? "Broader capture remains subject to verification and release approval."
              : "Business email capture is off."}
        </p>
      ) : null}
      <Button
        variant="quiet"
        disabled={mutating}
        onClick={() => void refresh()}
      >
        Refresh copied emails
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {page?.sources.length === 0 ? <p>No copied emails available.</p> : null}
      <ul>
        {page?.sources.map((row, index) => (
          <li key={row.sourceId}>
            {processing&&workspaceId?<ProcessingHealth key={`${scope}:${row.sourceId}:${row.sourceRevision}:${row.contentHash}:${row.availability}`} ports={processing} source={{workspaceId,sourceId:row.sourceId,kind:'mail',revision:row.sourceRevision,contentHash:row.contentHash,locator:null,availability:row.availability}}/>:null}
            {row.availability === "available" ? (
              <>
                <Button
                  variant="quiet"
                  onClick={() => void open(row)}
                  disabled={mutating}
                >
                  Open email {index + 1}
                </Button>
                <span> · {row.occurredAt}</span>
              </>
            ) : (
              <>
                <p>
                  {row.availability === "deleted"
                    ? "Copied email deleted"
                    : "Awaiting explicit recapture"}
                </p>
                {row.availability === "deleted" && ports.restore ? (
                  <Button disabled={mutating} onClick={() => void restore(row)}>
                    Restore copy for recapture
                  </Button>
                ) : null}
                {row.availability === "awaiting_recapture" &&
                ports.recapture ? (
                  <>
                    <Button
                      disabled={
                        mutating || queued[row.sourceId] === row.sourceRevision
                      }
                      onClick={() => void recapture(row)}
                    >
                      Request recapture
                    </Button>
                    {queued[row.sourceId] === row.sourceRevision ? (
                      <p>
                        Recapture requested; copied content is not yet
                        available.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {page?.nextAfterId ? (
        <Button disabled={loadingMore || mutating} onClick={() => void more()}>
          More copied emails
        </Button>
      ) : null}
      {detail?.state === "unavailable" ? (
        <p>This copied email is unavailable.</p>
      ) : null}
      {source ? (
        <article className="space-y-2">
          <h4>{source.subject || "(No subject)"}</h4>
          <p>
            {source.direction === "incoming"
              ? "Incoming email"
              : "Outgoing email"}
          </p>
          {source.direction === "outgoing" ? (
            <p>
              {source.sentProof && source.completeness === "complete"
                ? "Provider-verified Sent message"
                : "Sent state unverified"}
            </p>
          ) : null}
          <p>
            {source.completeness === "complete"
              ? "Complete copied content"
              : source.completeness === "partial"
                ? "Partial copied content"
                : "Copied content unavailable"}
          </p>
          <p>Provider date: {source.occurredAt}</p>
          <p>
            {source.rawSenderDate === null
              ? "Sender date unknown"
              : `Sender date (as supplied): ${source.rawSenderDate}`}
          </p>
          <p>Observed in Callie: {source.observedAt}</p>
          <p>
            Observed participants: {source.participants.join(", ") || "Unknown"}
          </p>
          <p>
            Parser: {source.parserVersion} ·{" "}
            {source.representation === "html_flattened"
              ? "HTML flattened"
              : "Plain text"}{" "}
            · revision {source.sourceRevision}
          </p>
          <h5>Original context</h5>
          {contexts(source.originalContexts)}
          <h5>Reviewed context</h5>
          {contexts(source.reviewedContexts)}
          {source.passage === null ? (
            <p>Email body unavailable.</p>
          ) : (
            <ul aria-label="Email text attribution" className="space-y-2">
              {textSegments(source).map((segment, index) => (
                <li key={index}>
                  <p>
                    {segment.kind === "authored"
                      ? "Authored text"
                      : segment.kind === "quoted"
                        ? "Quoted text"
                        : segment.kind === "forwarded"
                          ? "Forwarded text"
                          : "Text attribution unknown"}
                  </p>
                  <pre className="whitespace-pre-wrap break-words font-sans">
                    {segment.text}
                  </pre>
                </li>
              ))}
            </ul>
          )}
          {ports.remove ? (
            <Button disabled={mutating} onClick={() => void remove(source)}>
              Delete copied email
            </Button>
          ) : null}
          {ports.associate &&
          (personChoices.length > 0 || firmChoices.length > 0) ? (
            <div className="space-y-2">
              {personChoices.length > 0 ? (
                <label>
                  Reviewed email person
                  <Select
                    aria-label="Reviewed email person"
                    value={reviewedPerson}
                    onChange={(event) => setReviewedPerson(event.target.value)}
                  >
                    <option value="">Choose a person</option>
                    {personChoices.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              {firmChoices.length > 0 ? (
                <label>
                  Reviewed email firm
                  <Select
                    aria-label="Reviewed email firm"
                    value={reviewedFirm}
                    onChange={(event) => setReviewedFirm(event.target.value)}
                  >
                    <option value="">Choose a firm</option>
                    {firmChoices.map((firm) => (
                      <option key={firm.id} value={firm.id}>
                        {firm.name}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <Button
                disabled={mutating || (!reviewedPerson && !reviewedFirm)}
                onClick={() => void associate(source)}
              >
                Record reviewed email context
              </Button>
            </div>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
