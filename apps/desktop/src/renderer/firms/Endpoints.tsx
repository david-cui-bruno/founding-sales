import { useEffect, useMemo, useState, type JSX } from "react";
import { type z } from "zod";
import type {
  endpointListSchema,
  endpointMatchSchema,
  endpointClaimSchema,
  endpointCorrectSchema,
} from "@fss/contracts";
import { type PersonPage } from "@fss/contracts";
import { Button } from "../ui/button.tsx";
import { Select } from "../ui/select.tsx";
type Page = z.infer<typeof endpointListSchema>;
type Match = z.infer<typeof endpointMatchSchema>;
export interface EndpointPorts {
  list(input: {
    personId?: string;
    firmId?: string;
    afterId?: string;
  }): Promise<Page>;
  match(input: { kind: "email" | "phone"; value: string }): Promise<Match>;
}
type Claim = Omit<
  z.infer<typeof endpointClaimSchema>,
  "commandId" | "clientVersion"
>;
type Correct = Omit<
  z.infer<typeof endpointCorrectSchema>,
  "commandId" | "clientVersion"
>;
type EndpointOwner = { kind: "person" | "firm"; id: string; name: string };
export interface EndpointEditingPorts {
  owners?(): Promise<EndpointOwner[]>;
  claim(input: Claim): Promise<void>;
  correct(input: Correct): Promise<void>;
}
export function Endpoints({
  personId,
  firmId,
  ports,
  editing,
  sources = [],
  enabled = false,
}: {
  personId?: string;
  firmId?: string;
  ports: EndpointPorts;
  editing?: EndpointEditingPorts | undefined;
  sources?: PersonPage["sources"];
  enabled?: boolean;
}): JSX.Element {
  const [sourceId, setSourceId] = useState("");
  const [owners, setOwners] = useState<EndpointOwner[]>([]);
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState<Claim["status"]>("unknown");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [correcting, setCorrecting] = useState<Page["claims"][number] | null>(
    null,
  );
  const [page, setPage] = useState<Page | null>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const [kind, setKind] = useState<"email" | "phone">("email");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scope = useMemo(
    () => ({
      ...(personId === undefined ? {} : { personId }),
      ...(firmId === undefined ? {} : { firmId }),
    }),
    [personId, firmId],
  );
  const sourceVersion = sources
    .map(
      (source) =>
        `${source.sourceId}:${source.revision}:${source.availability}:${source.contentHash ?? ""}`,
    )
    .join("|");
  useEffect(() => {
    let active = true;
    setPage(null);
    setMatch(null);
    setValue("");
    setError("");
    setSourceId("");
    setCorrecting(null);
    setOwner("");
    setOwners([]);
    if (editing?.owners)
      void editing
        .owners()
        .then((choices) => {
          if (active) setOwners(choices);
        })
        .catch(() => {
          if (active) setError("Owner choices could not be loaded.");
        });
    setStatus("unknown");
    setStart("");
    setEnd("");
    void ports
      .list(scope)
      .then((result) => {
        if (active) setPage(result);
      })
      .catch(() => {
        if (active) setError("Addresses could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [scope, ports, editing, sourceVersion]);
  const source = sources.find(
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
      setMatch(null);
      setError("The identity check could not be completed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Observed addresses">
      <h4>Observed addresses</h4>
      {error ? <p role="alert">{error}</p> : null}
      <ul>
        {page?.claims.map((claim) => (
          <li key={claim.claimId}>
            <p>{claim.value}</p>
            <p>
              {claim.shared
                ? "Shared firm address"
                : claim.kind === "email"
                  ? "Email address"
                  : "Phone number"}
            </p>
            <p>{claim.personName ?? "Unknown human speaker"}</p>
            {claim.firmName ? <p>{claim.firmName}</p> : null}
            <p>
              {claim.startDate ?? "Start date unknown"} —{" "}
              {claim.endDate ?? "End date unknown"}
            </p>
            <p>
              {claim.sourceState === "available"
                ? `Source revision ${claim.evidence.sourceRevision}`
                : "Source unavailable"}
            </p>
            {editing ? (
              <Button
                disabled={!enabled || busy}
                onClick={() => {
                  setCorrecting(claim);
                  setOwner(
                    claim.personId === null
                      ? `firm:${claim.firmId}`
                      : `person:${claim.personId}`,
                  );
                  setValue(claim.value);
                  setKind(claim.kind);
                  setStatus(claim.status);
                  setStart(claim.startDate ?? "");
                  setEnd(claim.endDate ?? "");
                  setSourceId(claim.evidence.sourceId);
                  setMatch(null);
                }}
              >
                Correct address association
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
                await ports.list({
                  ...scope,
                  ...(page.nextAfterId === null
                    ? {}
                    : { afterId: page.nextAfterId }),
                }),
              ),
            )
          }
        >
          More addresses
        </Button>
      ) : null}
      <label>
        Address type
        <Select
          aria-label="Address type"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value === "phone" ? "phone" : "email");
            setMatch(null);
          }}
        >
          <option value="email">Email</option>
          <option value="phone">Phone</option>
        </Select>
      </label>
      <label>
        Address or number
        <input
          aria-label="Address or number"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setMatch(null);
          }}
          maxLength={320}
        />
      </label>
      <Button
        disabled={busy || !value.trim()}
        onClick={() =>
          void run(async () => setMatch(await ports.match({ kind, value })))
        }
      >
        Check existing identity
      </Button>
      {match ? (
        <section aria-label="Identity match">
          <p>
            {match.outcome === "needs_review"
              ? "Identity needs review; no automatic merge."
              : match.outcome === "no_supported_match"
                ? "No supported identity found."
                : match.outcome === "firm_endpoint_match"
                  ? "Known shared firm endpoint."
                  : "Supported person match."}
          </p>
          <ul>
            {match.candidates.map((candidate) => (
              <li key={candidate.claimId}>
                {candidate.personName ??
                  candidate.firmName ??
                  "Unknown correspondent"}{" "}
                — {candidate.value}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {editing ? (
        <section aria-label="Endpoint editor">
          {correcting && editing.owners ? (
            <label>
              Correct endpoint owner
              <Select
                aria-label="Correct endpoint owner"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
              >
                <option value="">Choose a supported owner</option>
                <option
                  value={
                    correcting.personId === null
                      ? `firm:${correcting.firmId}`
                      : `person:${correcting.personId}`
                  }
                >
                  Current recorded association
                </option>
                {owners.map((choice) => (
                  <option
                    key={`${choice.kind}:${choice.id}`}
                    value={`${choice.kind}:${choice.id}`}
                  >
                    {choice.name} —{" "}
                    {choice.kind === "firm"
                      ? "shared firm endpoint; unknown speaker"
                      : "person"}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <label>
            Endpoint status
            <Select
              aria-label="Endpoint status"
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
            Endpoint start date
            <input
              aria-label="Endpoint start date"
              type="date"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            Endpoint end date
            <input
              aria-label="Endpoint end date"
              type="date"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
          <label>
            Endpoint supporting note
            <Select
              aria-label="Endpoint supporting note"
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
                .map((item) => (
                  <option key={item.sourceId} value={item.sourceId}>
                    {item.excerpt?.slice(0, 100) ?? "Selected note"} — revision{" "}
                    {item.revision}
                  </option>
                ))}
            </Select>
          </label>
          <Button
            disabled={
              !enabled || busy || match === null || source === undefined || (correcting !== null && editing.owners !== undefined && owner === "")
            }
            onClick={() =>
              void run(async () => {
                if (source === undefined || source.contentHash === null) return;
                const selectedOwner =
                  correcting && editing.owners
                    ? owners.find(
                        (choice) => `${choice.kind}:${choice.id}` === owner,
                      )
                    : undefined;
                const targetPerson = selectedOwner
                  ? selectedOwner.kind === "person"
                    ? selectedOwner.id
                    : null
                  : correcting !== null ? correcting.personId : personId ?? null;
                const targetFirm = selectedOwner
                  ? selectedOwner.kind === "firm"
                    ? selectedOwner.id
                    : null
                  : correcting !== null ? correcting.firmId : firmId ?? null;
                const input: Claim = {
                  kind,
                  value,
                  personId: targetPerson,
                  firmId: targetFirm,
                  shared: targetPerson === null,
                  status,
                  startDate: start || null,
                  endDate: end || null,
                  evidence: {
                    sourceId: source.sourceId,
                    sourceRevision: source.revision,
                    contentHash: source.contentHash,
                  },
                };
                if (correcting === null) await editing.claim(input);
                else
                  await editing.correct({
                    ...input,
                    claimId: correcting.claimId,
                    expectedRevision: correcting.revision,
                  });
                setPage(await ports.list(scope));
                setCorrecting(null);
                setMatch(null);
                setSourceId("");
              })
            }
          >
            {correcting === null
              ? "Record supported address"
              : "Save address correction"}
          </Button>
          {correcting ? (
            <Button
              disabled={busy}
              onClick={() => {
                setCorrecting(null);
                setMatch(null);
                setSourceId("");
                setValue("");
              }}
            >
              Cancel address correction
            </Button>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
