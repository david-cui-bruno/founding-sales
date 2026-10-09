import { useEffect, useState, type JSX } from "react";
import { type z } from "zod";
import type {
  sourceContextListSchema,
  sourceContextSaveSchema,
  relationshipListSchema,
} from "@fss/contracts";
import { type PersonPage } from "@fss/contracts";
import { Button } from "../ui/button.tsx";
import { Select } from "../ui/select.tsx";
type Page = z.infer<typeof sourceContextListSchema>;
export interface ContextPorts {
  read(personId: string, afterId?: string): Promise<Page>;
  save(
    input: Omit<
      z.infer<typeof sourceContextSaveSchema>,
      "commandId" | "clientVersion"
    >,
  ): Promise<void>;
}
export function SourceContexts({
  personId,
  ports,
  relationships,
  sources,
  firms,
  enabled,
}: {
  personId: string;
  ports: ContextPorts;
  relationships: z.infer<typeof relationshipListSchema>["relationships"];
  sources: PersonPage["sources"];
  firms: { firmId: string; name: string }[];
  enabled: boolean;
}): JSX.Element {
  const [sourceId, setSourceId] = useState("");
  const [relationshipId, setRelationshipId] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const sourceVersion = sources
    .map(
      (source) =>
        `${source.sourceId}:${source.revision}:${source.availability}:${source.contentHash ?? ""}`,
    )
    .join("|");
  useEffect(() => {
    let active = true;
    setPage(null);
    void ports
      .read(personId)
      .then((value) => {
        if (active) setPage(value);
      })
      .catch(() => {
        if (active) setError("Conversation contexts could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [personId, ports, relationships, sourceVersion]);
  const source = sources.find(
    (item) =>
      item.sourceId === sourceId &&
      item.availability === "available" &&
      item.contentHash !== null,
  );
  const relationship = relationships.find(
    (item) =>
      item.relationshipId === relationshipId &&
      item.sourceState === "available",
  );
  return (
    <section aria-label="Conversation context">
      <h4>Conversation context</h4>
      {error ? <p role="alert">{error}</p> : null}
      <ul>
        {page?.contexts.map((context) => (
          <li key={context.contextId}>
            <p>
              Recorded context:{" "}
              {firms.find((firm) => firm.firmId === context.firmId)?.name ??
                "Firm identity unavailable"}
            </p>
            {context.review === "required" ? (
              <p>Context needs review; the original firm remains recorded.</p>
            ) : (
              <p>Context current</p>
            )}
          </li>
        ))}
      </ul>
      {page?.nextAfterId ? (
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void ports
              .read(personId, page.nextAfterId ?? undefined)
              .then(setPage)
              .catch(() => {
                setPage(null);
                setError("Conversation contexts could not be loaded.");
              })
              .finally(() => setBusy(false));
          }}
        >
          More conversation contexts
        </Button>
      ) : null}
      <label>
        Conversation supporting note
        <Select
          aria-label="Conversation supporting note"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
        >
          <option value="">Choose captured evidence</option>
          {sources
            .filter(
              (item) =>
                item.availability === "available" && item.contentHash !== null,
            )
            .map((item) => (
              <option key={item.sourceId} value={item.sourceId}>
                {item.excerpt?.slice(0, 100) ?? "Selected note"}
              </option>
            ))}
        </Select>
      </label>
      <label>
        Conversation relationship
        <Select
          aria-label="Conversation relationship"
          value={relationshipId}
          onChange={(event) => setRelationshipId(event.target.value)}
        >
          <option value="">Choose a relationship</option>
          {relationships
            .filter((item) => item.sourceState === "available")
            .map((item) => (
              <option key={item.relationshipId} value={item.relationshipId}>
                {item.firmName} — revision {item.revision}
              </option>
            ))}
        </Select>
      </label>
      <Button
        disabled={
          !enabled || busy || source === undefined || relationship === undefined
        }
        onClick={() => {
          if (
            source === undefined ||
            source.contentHash === null ||
            relationship === undefined
          )
            return;
          setBusy(true);
          setError("");
          void ports
            .save({
              personId,
              relationshipId: relationship.relationshipId,
              relationshipRevision: relationship.revision,
              evidence: {
                sourceId: source.sourceId,
                sourceRevision: source.revision,
                contentHash: source.contentHash,
              },
            })
            .then(async () => {
              setPage(await ports.read(personId));
              setSourceId("");
              setRelationshipId("");
            })
            .catch(() => {
              setPage(null);
              setSourceId("");
              setRelationshipId("");
              setError(
                "Context could not be recorded. Refresh the relationship and source.",
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        Record conversation context
      </Button>
    </section>
  );
}
