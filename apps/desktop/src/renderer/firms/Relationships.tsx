import { SourceContexts, type ContextPorts } from "./SourceContexts.tsx";
import { useEffect, useState, type JSX } from "react";
import { type z } from "zod";
import type {
  relationshipListSchema,
  relationshipSaveSchema,
  relationshipCorrectSchema,
} from "@fss/contracts";
import { type PersonPage } from "@fss/contracts";
import { Button } from "../ui/button.tsx";
import { Select } from "../ui/select.tsx";
type RelationshipPage = z.infer<typeof relationshipListSchema>;
type Save = Omit<
  z.infer<typeof relationshipSaveSchema>,
  "commandId" | "clientVersion"
>;
type Correct = Omit<
  z.infer<typeof relationshipCorrectSchema>,
  "commandId" | "clientVersion"
>;
export interface RelationshipPorts {
  read(personId: string, afterId?: string): Promise<RelationshipPage>;
}
export interface RelationshipEditingPorts {
  firms(): Promise<{ firmId: string; name: string }[]>;
  save(input: Save): Promise<void>;
  correct(input: Correct): Promise<void>;
}
export function Relationships({
  personId,
  ports,
  editing,
  contexts,
  sources = [],
  enabled = false,
}: {
  personId: string;
  ports: RelationshipPorts;
  editing?: RelationshipEditingPorts | undefined;
  contexts?: ContextPorts | undefined;
  sources?: PersonPage["sources"];
  enabled?: boolean;
}): JSX.Element {
  const [page, setPage] = useState<RelationshipPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [firms, setFirms] = useState<{ firmId: string; name: string }[]>([]);
  const [firmId, setFirmId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [status, setStatus] = useState<Save["status"]>("unknown");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [correcting, setCorrecting] = useState<
    RelationshipPage["relationships"][number] | null
  >(null);
  const sourceVersion = sources
    .map(
      (source) =>
        `${source.sourceId}:${source.revision}:${source.availability}:${source.contentHash ?? ""}`,
    )
    .join("|");
  useEffect(() => {
    let active = true;
    setPage(null);
    setError("");
    setCorrecting(null);
    setFirmId("");
    setSourceId("");
    setStart("");
    setEnd("");
    setStatus("unknown");
    void ports
      .read(personId)
      .then((value) => {
        if (active) setPage(value);
      })
      .catch(() => {
        if (active) setError("Relationships could not be loaded.");
      });
    if (editing)
      void editing
        .firms()
        .then((value) => {
          if (active) setFirms(value);
        })
        .catch(() => {
          if (active) setError("Firm choices could not be loaded.");
        });
    return () => {
      active = false;
    };
  }, [personId, ports, editing, sourceVersion]);
  const supporting = sources.find(
    (item) =>
      item.sourceId === sourceId &&
      item.availability === "available" &&
      item.contentHash !== null,
  );
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch {
      setPage(null);
      setCorrecting(null);
      setSourceId("");
      setError(
        "The relationship could not be updated. Refresh its evidence and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Firm relationships">
      <h4>Firm relationships</h4>
      {error ? <p role="alert">{error}</p> : null}
      {page?.relationships.length === 0 ? (
        <p>No supported firm relationships recorded.</p>
      ) : null}
      <ul>
        {page?.relationships.map((item) => (
          <li key={item.relationshipId}>
            <h5>{item.firmName}</h5>
            <p>
              {item.status === "unknown"
                ? "Relationship status unknown"
                : item.status === "current"
                  ? "Current relationship"
                  : "Historical relationship"}
            </p>
            <p>
              {item.startDate === null
                ? "Start date unknown"
                : `Start date ${item.startDate}`}
            </p>
            <p>
              {item.endDate === null
                ? "End date unknown"
                : `End date ${item.endDate}`}
            </p>
            <p>
              {item.sourceState === "available"
                ? `Source revision ${item.evidence.sourceRevision}`
                : "Source unavailable"}
            </p>
            {item.contextReview === "required" ? (
              <p>Conversation context needs review</p>
            ) : null}
            {editing ? (
              <Button
                disabled={!enabled || busy}
                onClick={() => {
                  setCorrecting(item);
                  setFirmId(item.firmId);
                  setStatus(item.status);
                  setStart(item.startDate ?? "");
                  setEnd(item.endDate ?? "");
                  setSourceId(item.evidence.sourceId);
                }}
              >
                Correct relationship
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {page?.nextAfterId ? (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setPage(
                await ports.read(personId, page.nextAfterId ?? undefined),
              ),
            )
          }
        >
          More relationships
        </Button>
      ) : null}
      {editing ? (
        <section aria-label="Relationship editor">
          <label>
            Relationship firm
            <Select
              aria-label="Relationship firm"
              value={firmId}
              onChange={(event) => setFirmId(event.target.value)}
            >
              <option value="">Choose a firm</option>
              {firms.map((firm) => (
                <option key={firm.firmId} value={firm.firmId}>
                  {firm.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            Relationship status
            <Select
              aria-label="Relationship status"
              value={status}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === "current" ||
                  value === "historical" ||
                  value === "unknown"
                )
                  setStatus(value);
              }}
            >
              <option value="unknown">Unknown</option>
              <option value="current">Current</option>
              <option value="historical">Historical</option>
            </Select>
          </label>
          <label>
            Relationship start date
            <input
              aria-label="Relationship start date"
              type="date"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            Relationship end date
            <input
              aria-label="Relationship end date"
              type="date"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
          <p>Leave unsupported dates blank.</p>
          <label>
            Supporting note
            <Select
              aria-label="Supporting note"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              <option value="">Choose captured evidence</option>
              {sources
                .filter(
                  (item) =>
                    item.availability === "available" &&
                    item.contentHash !== null,
                )
                .map((source) => (
                  <option key={source.sourceId} value={source.sourceId}>
                    {source.excerpt?.slice(0, 100) ?? "Selected note"} —
                    revision {source.revision}
                  </option>
                ))}
            </Select>
          </label>
          <Button
            disabled={!enabled || busy || !firmId || supporting === undefined}
            onClick={() =>
              void run(async () => {
                if (
                  supporting?.contentHash === null ||
                  supporting === undefined
                )
                  return;
                const input: Save = {
                  personId,
                  firmId,
                  status,
                  startDate: start || null,
                  endDate: end || null,
                  evidence: {
                    sourceId: supporting.sourceId,
                    sourceRevision: supporting.revision,
                    contentHash: supporting.contentHash,
                  },
                };
                if (correcting === null) await editing.save(input);
                else
                  await editing.correct({
                    ...input,
                    relationshipId: correcting.relationshipId,
                    expectedRevision: correcting.revision,
                  });
                setPage(await ports.read(personId));
                setCorrecting(null);
                setSourceId("");
              })
            }
          >
            {correcting === null ? "Save relationship" : "Save correction"}
          </Button>
          {correcting ? (
            <Button
              disabled={busy}
              onClick={() => {
                setCorrecting(null);
                setSourceId("");
                setFirmId("");
                setStart("");
                setEnd("");
              }}
            >
              Cancel correction
            </Button>
          ) : null}
        </section>
      ) : null}
      {contexts && page ? (
        <SourceContexts
          personId={personId}
          ports={contexts}
          relationships={page.relationships}
          sources={sources}
          firms={firms}
          enabled={enabled}
        />
      ) : null}
    </section>
  );
}
