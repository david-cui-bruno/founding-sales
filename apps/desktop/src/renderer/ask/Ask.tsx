import type {AskFollowOnPorts} from "./AskFollowOn.tsx";
import { useEffect, useRef, useState } from "react";
import { AskHistory, type AskHistoryPorts } from "./AskHistory.tsx";
import { AskAnswer, type AskAnswerPorts } from "./AskAnswer.tsx";
import type { z } from "zod";
import type { askReadSchema, askResponseSchema } from "@fss/contracts";
export type AskRead = z.infer<typeof askReadSchema>;
export type AskResponse = z.infer<typeof askResponseSchema>;
export interface AskPorts extends Partial<AskAnswerPorts>, Partial<AskHistoryPorts>, Partial<AskFollowOnPorts> {
  read(input: AskRead): Promise<AskResponse>;
}
const sourceKindLabels = {
  selected_note: "Selected note",
  call_transcript: "Call transcript",
  meeting_transcript: "Meeting transcript",
  mail: "Email",
};
export function Ask({
  ports,
  privacyKey,
  enabled,
}: {
  ports: AskPorts;
  privacyKey: string;
  enabled: boolean;
}) {
  const [selectedSources, setSelectedSources] = useState<
    Extract<AskResponse, { operation: "sources" }>["sources"]
  >([]);
  const [copyQuery, setCopyQuery] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const fromTime = fromDate === "" ? undefined : Date.parse(`${fromDate}Z`);
  const toTime = toDate === "" ? undefined : Date.parse(`${toDate}Z`);
  const validDates =
    (fromTime === undefined || Number.isFinite(fromTime)) &&
    (toTime === undefined || Number.isFinite(toTime)) &&
    (fromTime === undefined || toTime === undefined || fromTime < toTime);
  const dateScope = {
    ...(fromTime === undefined || !Number.isFinite(fromTime)
      ? {}
      : { from: new Date(fromTime).toISOString() }),
    ...(toTime === undefined || !Number.isFinite(toTime)
      ? {}
      : { to: new Date(toTime).toISOString() }),
  };
  const [selected, setSelected] = useState<
    Extract<AskResponse, { operation: "records" }>["records"][number] | null
  >(null);
  const [passageQuery, setPassageQuery] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"people" | "firms">("people");
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const key = `${privacyKey}:${enabled}`;
  const current = useRef(key);
  if (current.current !== key) {
    current.current = key;
    epoch.current++;
  }
  useEffect(() => {
    setResult(null);
    setSelected(null);
    setSelectedSources([]);
    setCopyQuery("");
    setQuery("");
    setFromDate("");
    setToDate("");
    setPassageQuery("");
    setError(null);
  }, [key]);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function searchCopies() {
    if (selectedSources.length === 0) return;
    const captured = ++epoch.current;
    setResult(null);
    setError(null);
    try {
      const next = await ports.read({
        operation: "passages",
        scope: {
          sources: selectedSources.map((source) => ({
            workspaceId: source.workspaceId,
            sourceId: source.sourceId,
            kind: source.kind,
            revision: source.revision,
            contentHash: source.contentHash,
            locator: null,
          })),
        },
        query: copyQuery,
        limit: 20,
      });
      if (captured === epoch.current) setResult(next);
    } catch {
      if (captured === epoch.current) {
        setSelectedSources([]);
        setCopyQuery("");
        setError(
          "Selected copies are unavailable. Read their current versions again.",
        );
      }
    }
  }
  async function sources(
    after?: Extract<AskRead, { operation: "sources" }>["after"],
  ) {
    if (selected === null) return;
    setSelectedSources([]);
    setCopyQuery("");
    const captured = ++epoch.current;
    setResult(null);
    setError(null);
    try {
      const next = await ports.read({
        operation: "sources",
        scope:
          selected.kind === "firm"
            ? { firmId: selected.recordId }
            : { personId: selected.recordId },
        limit: 20,
        ...(after === undefined ? {} : { after }),
      });
      if (captured === epoch.current) setResult(next);
    } catch {
      if (captured === epoch.current)
        setError("Copied sources are unavailable. Try reading again.");
    }
  }
  async function activity(before?: string) {
    if (selected?.kind !== "firm" || !validDates) return;
    const captured = ++epoch.current;
    setResult(null);
    setError(null);
    try {
      const next = await ports.read({
        operation: "activity",
        scope: { firmId: selected.recordId, ...dateScope },
        ...(before === undefined ? {} : { before }),
      });
      if (captured === epoch.current) setResult(next);
    } catch {
      if (captured === epoch.current)
        setError("Activity is unavailable. Try reading again.");
    }
  }
  async function replies() {
    if (selected?.kind !== "firm" || !validDates) return;
    const captured = ++epoch.current;
    setResult(null);
    setError(null);
    try {
      const next = await ports.read({
        operation: "reply_status",
        scope: { firmId: selected.recordId, ...dateScope },
      });
      if (captured === epoch.current) setResult(next);
    } catch {
      if (captured === epoch.current)
        setError("Reply evidence is unavailable. Try reading again.");
    }
  }
  async function tasks() {
    if (selected?.kind !== "firm" || !validDates) return;
    const captured = ++epoch.current;
    setResult(null);
    setError(null);
    try {
      const next = await ports.read({
        operation: "tasks",
        scope: { firmId: selected.recordId, ...dateScope },
        limit: 20,
      });
      if (captured === epoch.current) setResult(next);
    } catch {
      if (captured === epoch.current)
        setError("Current work is unavailable. Try reading again.");
    }
  }
  async function opportunities() {
    if (selected?.kind !== "firm" || !validDates) return;
    const captured = ++epoch.current;
    setResult(null);
    setError(null);
    try {
      const next = await ports.read({
        operation: "opportunities",
        scope: { firmId: selected.recordId, ...dateScope },
        status: "open",
        limit: 20,
      });
      if (captured === epoch.current) setResult(next);
    } catch {
      if (captured === epoch.current)
        setError("Current CRM state is unavailable. Try reading again.");
    }
  }
  async function passages(afterSourceId?: string) {
    if (selected?.kind !== "person") return;
    const captured = ++epoch.current;
    setResult(null);
    setError(null);
    try {
      const next = await ports.read({
        operation: "passages",
        scope: {
          personId: selected.recordId,
          ...(afterSourceId === undefined ? {} : { afterSourceId }),
        },
        query: passageQuery,
        limit: 20,
      });
      if (captured === epoch.current) setResult(next);
    } catch {
      if (captured === epoch.current)
        setError("Passages are unavailable. Try reading again.");
    }
  }
  async function find(afterId?: string) {
    const captured = ++epoch.current;
    setResult(null);
    setError(null);
    try {
      const next = await ports.read({
        operation: "records",
        query,
        kind,
        limit: 20,
        ...(afterId === undefined ? {} : { afterId }),
      });
      if (captured === epoch.current) setResult(next);
    } catch {
      if (captured === epoch.current)
        setError("Records are unavailable. Try reading again.");
    }
  }
  return (
    <section
      aria-label="Ask"
      className="max-w-5xl space-y-5 p-6 [&_button]:mr-2 [&_button]:mt-2 [&_button]:inline-flex [&_button]:items-center [&_button]:rounded-md [&_button]:border [&_button]:border-border [&_button]:bg-background [&_button]:px-3 [&_button]:py-2 [&_button]:text-sm [&_button:hover]:bg-muted [&_button:disabled]:opacity-50 [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-ring [&_p]:text-sm [&_p]:leading-6"
    >
      <h1 className="text-xl font-semibold">Ask</h1>
      <AskHistory key={key} ports={ports} enabled={enabled} />
      <p>
        Retrieve records and original evidence. Conversation coverage may be
        incomplete.
      </p>
      {selected === null && (
        <div className="flex flex-wrap items-end gap-4">
          <label className="block text-sm font-medium">
            Find a person or firm
            <input
              className="mt-1 block h-9 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
              aria-label="Find a person or firm"
              value={query}
              onChange={(event) => {
                epoch.current++;
                setResult(null);
                setSelected(null);
                setSelectedSources([]);
                setCopyQuery("");
                setPassageQuery("");
                setQuery(event.target.value);
              }}
            />
          </label>
          <label className="block text-sm font-medium">
            Record kind
            <select
              className="mt-1 block h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={kind}
              onChange={(event) => {
                epoch.current++;
                setResult(null);
                setSelected(null);
                setSelectedSources([]);
                setCopyQuery("");
                setPassageQuery("");
                setKind(event.target.value === "firms" ? "firms" : "people");
              }}
            >
              <option value="people">People</option>
              <option value="firms">Firms</option>
            </select>
          </label>
          <button
            disabled={!enabled || !query.trim()}
            onClick={() => {
              void find();
            }}
          >
            Find records
          </button>
        </div>
      )}
      {error !== null && <p role="alert">{error}</p>}
      {result?.operation === "records" && (
        <div>
          {result.selection === "ambiguous" && (
            <p>Choose a record; these names are not unique.</p>
          )}
          {!result.scanComplete && (
            <p>More records remain. Identity selection is unresolved.</p>
          )}
          {result.nextAfterId !== null && (
            <button
              disabled={!enabled}
              onClick={() => {
                void find(result.nextAfterId ?? undefined);
              }}
            >
              Next record page
            </button>
          )}
          {result.records.map((record) => (
            <div key={record.recordId}>
              <button
                onClick={() => {
                  epoch.current++;
                  setResult(null);
                  setSelectedSources([]);
                  setCopyQuery("");
                  setSelected(record);
                }}
              >
                Select {record.name}
              </button>
              <span>{record.kind === "person" ? "Person" : "Firm"}</span>
            </div>
          ))}
        </div>
      )}
      {selected !== null && (
        <button
          onClick={() => {
            epoch.current++;
            setSelected(null);
            setFromDate("");
            setToDate("");
            setSelectedSources([]);
            setCopyQuery("");
            setPassageQuery("");
            setResult(null);
            setQuery("");
            setError(null);
          }}
        >
          Change record
        </button>
      )}
      {selected?.kind === "firm" && (
        <fieldset className="flex flex-wrap gap-x-6 gap-y-3 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold">
            Date scope (UTC)
          </legend>
          <p className="w-full text-muted-foreground">
            Optional range: opportunity opening, work due, activity event or
            reply event dates.
          </p>
          <label className="block text-sm font-medium">
            From (UTC, inclusive)
            <input
              className="mt-1 block h-9 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
              type="datetime-local"
              aria-label="From (UTC, inclusive)"
              value={fromDate}
              onChange={(event) => {
                epoch.current++;
                setResult(null);
                setError(null);
                setFromDate(event.target.value);
              }}
            />
          </label>
          <label className="block text-sm font-medium">
            Until (UTC, exclusive)
            <input
              className="mt-1 block h-9 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
              type="datetime-local"
              aria-label="Until (UTC, exclusive)"
              value={toDate}
              onChange={(event) => {
                epoch.current++;
                setResult(null);
                setError(null);
                setToDate(event.target.value);
              }}
            />
          </label>
          {!validDates && (
            <p role="alert">
              Choose a valid range with From earlier than Until.
            </p>
          )}
        </fieldset>
      )}
      {selected !== null && (
        <button
          disabled={!enabled}
          onClick={() => {
            void sources();
          }}
        >
          Copied sources
        </button>
      )}
      {result?.operation === "sources" && (
        <div>
          <p>
            Bounded copied sources for this record. Acquisition coverage is
            unverified.
          </p>
          {!result.coverage.scanComplete && (
            <p>More copied sources may remain.</p>
          )}
          {result.coverage.sizeBoundReached && (
            <p>
              The source size limit was reached; this discovery page is partial.
            </p>
          )}
          {result.nextAfter !== null && (
            <button
              disabled={!enabled}
              onClick={() => {
                void sources(result.nextAfter ?? undefined);
              }}
            >
              Next source page
            </button>
          )}
          {result.sources.map((source) => (
            <label key={`${source.kind}:${source.sourceId}`}>
              <input
                className="mr-2 h-4 w-4 align-middle"
                type="checkbox"
                aria-label={`Include ${sourceKindLabels[source.kind]} version ${source.revision}`}
                disabled={
                  !enabled ||
                  source.availability !== "available" ||
                  (selectedSources.length >= 10 &&
                    !selectedSources.some(
                      (item) =>
                        item.kind === source.kind &&
                        item.sourceId === source.sourceId,
                    ))
                }
                checked={selectedSources.some(
                  (item) =>
                    item.kind === source.kind &&
                    item.sourceId === source.sourceId,
                )}
                onChange={(event) => {
                  epoch.current++;
                  setSelectedSources((current) =>
                    event.target.checked
                      ? [...current, source]
                      : current.filter(
                          (item) =>
                            item.kind !== source.kind ||
                            item.sourceId !== source.sourceId,
                        ),
                  );
                }}
              />
              {sourceKindLabels[source.kind]} · Version {source.revision} ·{" "}
              {source.occurredAt ?? "Date unknown"} · {source.availability}
            </label>
          ))}
        </div>
      )}
      {selected?.kind === "firm" && (
        <div>
          <h2 className="text-lg font-semibold">{selected.name}</h2>
          <button
            disabled={!enabled || !validDates}
            onClick={() => {
              void opportunities();
            }}
          >
            Open opportunities
          </button>
          <button
            disabled={!enabled || !validDates}
            onClick={() => {
              void tasks();
            }}
          >
            Open work
          </button>
          <button
            disabled={!enabled || !validDates}
            onClick={() => {
              void replies();
            }}
          >
            Reply evidence
          </button>
          <button
            disabled={!enabled || !validDates}
            onClick={() => {
              void activity();
            }}
          >
            Activity
          </button>
        </div>
      )}
      {result?.operation === "opportunities" && (
        <div>
          <p>{result.count} open opportunities</p>
          <p>Exact CRM state. Conversation coverage is unverified.</p>
          {result.truncated && (
            <p>Some opportunity records are not displayed.</p>
          )}
          {result.records.map((record) => (
            <p key={record.opportunityId}>
              {record.name ?? "Unnamed opportunity"} · {record.stageKey}
            </p>
          ))}
        </div>
      )}
      {result?.operation === "activity" && (
        <div>
          <p>Operational event dates. Conversation coverage is unverified.</p>
          {!result.scanComplete && <p>More operational events may remain.</p>}
          {result.nextBefore !== null && (
            <button
              disabled={!enabled}
              onClick={() => {
                void activity(result.nextBefore ?? undefined);
              }}
            >
              Older activity page
            </button>
          )}
          {result.events.map((event) => (
            <p key={event.key}>
              {event.at} · {event.kind} ·{" "}
              {event.detail ?? event.code ?? "Details unknown"}
            </p>
          ))}
        </div>
      )}
      {result?.operation === "reply_status" && (
        <div>
          <p>
            {result.withoutVerifiedReplyCount} verified outgoing messages lack a
            verified reply receipt.
          </p>
          <p>
            This does not establish unanswered mail; captured history is
            partial.
          </p>
          {result.truncated && (
            <p>More authorized progress receipts may remain.</p>
          )}
        </div>
      )}
      {result?.operation === "tasks" && (
        <div>
          <p>{result.count} open tasks</p>
          <p>Exact CRM state. Conversation coverage is unverified.</p>
          {result.truncated && <p>Some work records are not displayed.</p>}
          {result.records.map((record) => (
            <p key={record.key}>
              {record.label} · {record.dueAt} · {record.status}
            </p>
          ))}
        </div>
      )}
      {selected?.kind === "person" && selectedSources.length === 0 && (
        <div>
          <h2 className="text-lg font-semibold">{selected.name}</h2>
          <label className="block text-sm font-medium">
            Search original passages
            <input
              className="mt-1 block h-9 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
              aria-label="Search original passages"
              value={passageQuery}
              onChange={(event) => {
                epoch.current++;
                setResult(null);
                setPassageQuery(event.target.value);
              }}
            />
          </label>
          <button
            disabled={!enabled || !passageQuery.trim()}
            onClick={() => {
              void passages();
            }}
          >
            Find passages
          </button>
        </div>
      )}
      {selectedSources.length > 0 && (
        <div>
          <p>{selectedSources.length} selected copies (maximum 10)</p>
          <label className="block text-sm font-medium">
            Question or keywords for selected copies
            <input
              className="mt-1 block h-9 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
              aria-label="Search selected copies"
              maxLength={300}
              value={copyQuery}
              onChange={(event) => {
                epoch.current++;
                setResult(null);
                setCopyQuery(event.target.value);
              }}
            />
          </label>
          <button
            disabled={!enabled || !copyQuery.trim()}
            onClick={() => {
              void searchCopies();
            }}
          >
            Search selected copies
          </button>
          <AskAnswer key={`${key}:${selected?.recordId}:${copyQuery}:${JSON.stringify(selectedSources)}`} ports={ports} enabled={enabled} question={copyQuery} scope={{sources:selectedSources.map(({workspaceId,sourceId,kind,revision,contentHash})=>({workspaceId,sourceId,kind,revision,contentHash,locator:null}))}} />
        </div>
      )}
      {result?.operation === "passages" && (
        <div>
          <p>
            {result.coverage.scope === "explicit_copied_sources"
              ? "Explicit selected copies only. Acquisition coverage is unverified."
              : "Selected copies only. Inbox coverage is unverified."}
          </p>
          {(!result.coverage.scanComplete || result.truncated) && (
            <p>More copied evidence may remain.</p>
          )}
          {result.nextAfterSourceId !== null && (
            <button
              disabled={!enabled}
              onClick={() => {
                void passages(result.nextAfterSourceId ?? undefined);
              }}
            >
              Next copied-source page
            </button>
          )}
          {result.passages.map((passage, index) => (
            <article
              key={index}
              className="space-y-3 rounded-lg border border-border bg-card p-4"
            >
              <pre className="whitespace-pre-wrap break-words">
                {passage.text}
              </pre>
              {passage.sources.map((source, sourceIndex) => (
                <div key={sourceIndex}>
                  <p>
                    {source.occurredAt === null
                      ? "Date unknown"
                      : source.occurredAt}{" "}
                    ·{" "}
                    {source.speaker === null
                      ? "Speaker unknown"
                      : source.speaker}{" "}
                    · Version {source.revision}
                  </p>
                  <details>
                    <summary className="cursor-pointer text-sm text-muted-foreground">
                      Source details
                    </summary>
                    <p>
                      {sourceKindLabels[source.kind]} · Source {source.sourceId}{" "}
                      · {source.locator ?? "Location unknown"} ·{" "}
                      {source.completeness}
                    </p>
                  </details>
                </div>
              ))}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
