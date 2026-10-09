import {ManualWork,type ManualWorkPorts} from '../ask/ManualWork.tsx';
import {RecordProgress} from './RecordProgress.tsx';
import { SelectedImports, type SelectedImportPorts } from './SelectedImports.tsx';
import {ProcessingHealth,type ProcessingPorts} from './ProcessingHealth.tsx';
import type { ContextPorts } from "./SourceContexts.tsx";
import { EmailTimeline, type EmailTimelinePorts } from './EmailTimeline.tsx';
import {
  Endpoints,
  type EndpointPorts,
  type EndpointEditingPorts,
} from "./Endpoints.tsx";
import {
  Relationships,
  type RelationshipPorts,
  type RelationshipEditingPorts,
} from "./Relationships.tsx";
import { useEffect, useState, type JSX } from "react";
import type { PersonPage } from "@fss/contracts";
import { Button } from "../ui/button.tsx";
export interface PeoplePorts {
  list(
    afterId?: string,
  ): Promise<{ people: PersonPage["person"][]; nextAfterId: string | null }>;
  create(fullName: string): Promise<{ personId: string }>;
  read(personId: string, afterSourceId?: string): Promise<PersonPage>;
  add(input: {
    personId: string;
    sourceKey: string;
    excerpt: string;
    occurredAt: string;
  }): Promise<{ sourceId: string }>;
  remove(input: {
    personId: string;
    sourceId: string;
    expectedRevision: number;
  }): Promise<void>;
  recapture(input: {
    personId: string;
    sourceId: string;
    expectedRevision: number;
    excerpt: string;
    occurredAt: string;
  }): Promise<void>;
  restore(input: {
    personId: string;
    sourceId: string;
    expectedRevision: number;
  }): Promise<void>;
}
export function People({
  enabled,
  ports,
  relationships,
  relationshipEditing,
  contexts,
  endpoints,
  endpointEditing,
  imports,
  processing,
  workspaceId,
  mail,
  manual,
  privacyKey = 'people',
  mailFirms = [],
  sourceVersion,
  onSourceChange,
}: {
  enabled: boolean;
  workspaceId?:string | undefined;
  processing?:ProcessingPorts;
  ports: PeoplePorts;
  relationships?: RelationshipPorts;
  relationshipEditing?: RelationshipEditingPorts;
  contexts?: ContextPorts;
  endpoints?: EndpointPorts;
  endpointEditing?: EndpointEditingPorts;
  imports?: SelectedImportPorts;
  mail?: EmailTimelinePorts;
  manual?:Partial<ManualWorkPorts>;
  privacyKey?: string;
  mailFirms?: readonly {id:string;name:string}[];
  sourceVersion?: number | undefined;
  onSourceChange?: (() => void) | undefined;
}): JSX.Element {
  const [people, setPeople] = useState<PersonPage["person"][]>([]);
  const [page, setPage] = useState<PersonPage | null>(null);
  const [recapturing, setRecapturing] = useState<{
    sourceId: string;
    revision: number;
  } | null>(null);
  const [key, setKey] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [date, setDate] = useState("");
  const [nextPerson, setNextPerson] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void ports
      .list()
      .then((result) => {
        if (live) {
          setPeople(result.people);
          setNextPerson(result.nextAfterId);
        }
      })
      .catch(() => {
        if (live) setError("People could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, [ports]);
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch {
      setPage(null);
      setRecapturing(null);
      setExcerpt("");
      setKey("");
      setDate("");
      setError("That change could not be completed. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="People" className="space-y-4">
      <h2>People</h2>
      {error ? <p role="alert">{error}</p> : null}
      <label>
        Person name
        <input
          aria-label="Person name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={240}
        />
      </label>
      <Button
        disabled={!enabled || busy || !name.trim()}
        onClick={() =>
          void run(async () => {
            setRecapturing(null);
            setKey("");
            setExcerpt("");
            setDate("");
            setPage(null);
            const created = await ports.create(name.trim());
            setPage(await ports.read(created.personId));
            setPeople((await ports.list()).people);
            setName("");
          })
        }
      >
        Add person
      </Button>
      <ul>
        {people.map((person) => (
          <li key={person.personId}>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setRecapturing(null);
                  setKey("");
                  setExcerpt("");
                  setDate("");
                  setPage(null);
                  setPage(await ports.read(person.personId));
                })
              }
            >
              {person.fullName}
            </Button>
          </li>
        ))}
      </ul>
      {nextPerson ? (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const next = await ports.list(nextPerson);
              setPeople([...people, ...next.people]);
              setNextPerson(next.nextAfterId);
            })
          }
        >
          More people
        </Button>
      ) : null}
      {page ? (
        <section>
          <h3>{page.person.fullName}</h3>
          <ManualWork scope={{kind:"person",personId:page.person.personId}} enabled={enabled} privacyKey={`${privacyKey}:${String(sourceVersion??0)}:${page.sources.map(source=>`${source.kind}:${source.sourceId}:${source.revision}:${source.contentHash}:${source.availability}`).join("|")}`} {...(manual===undefined?{}:{ports:manual})}/>
          {imports ? <SelectedImports key={page.person.personId} privacyKey={privacyKey} enabled={enabled} personId={page.person.personId} ports={imports} sourceVersion={page.sources.map(source=>`${source.sourceId}:${source.revision}:${source.availability}`).join('|')} onChange={async(isCurrent)=>{ const next=await ports.read(page.person.personId); if(isCurrent?.() ?? true)setPage(next); }}/> : null}
          <RecordProgress personId={page.person.personId} enabled={enabled} privacyKey={privacyKey} sourceVersion={sourceVersion}/>
          {mail ? <EmailTimeline processing={processing} workspaceId={workspaceId} key={`email:${page.person.personId}`} enabled={enabled} ports={mail} personId={page.person.personId} privacyKey={privacyKey} sourceVersion={sourceVersion} onSourceChange={onSourceChange} people={people.map(person => ({id:person.personId,name:person.fullName}))} firms={mailFirms} /> : null}
          {relationships ? (
            <Relationships
              key={page.person.personId}
              personId={page.person.personId}
              ports={relationships}
              editing={relationshipEditing}
              contexts={contexts}
              sources={page.sources}
              enabled={enabled}
            />
          ) : null}
          {endpoints ? (
            <Endpoints
              key={page.person.personId}
              personId={page.person.personId}
              ports={endpoints}
              editing={endpointEditing}
              sources={page.sources}
              enabled={enabled}
            />
          ) : null}
          <p>
            {page.person.firm === null
              ? relationships
                ? "Operational contact association not recorded"
                : "Firm unknown"
              : `Operational contact association: ${page.person.firm.name}`}
          </p>
          {recapturing === null ? (
            <label>
              Note reference
              <input
                aria-label="Note reference"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                maxLength={200}
              />
            </label>
          ) : (
            <p>Recapturing selected note.</p>
          )}
          <label>
            Selected note
            <textarea
              aria-label="Selected note"
              value={excerpt}
              onChange={(event) => setExcerpt(event.target.value)}
              maxLength={20000}
            />
          </label>
          <label>
            Original date and time
            <input
              aria-label="Original date and time"
              type="datetime-local"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <Button
            disabled={
              !enabled ||
              busy ||
              (recapturing === null && !key.trim()) ||
              !excerpt.trim() ||
              !date
            }
            onClick={() =>
              void run(async () => {
                if (recapturing !== null) {
                  await ports.recapture({
                    personId: page.person.personId,
                    sourceId: recapturing.sourceId,
                    expectedRevision: recapturing.revision,
                    excerpt,
                    occurredAt: new Date(date).toISOString(),
                  });
                  setRecapturing(null);
                } else
                  await ports.add({
                    personId: page.person.personId,
                    sourceKey: key,
                    excerpt,
                    occurredAt: new Date(date).toISOString(),
                  });
                setPage(await ports.read(page.person.personId));
                setExcerpt("");
              })
            }
          >
            {recapturing === null
              ? "Save selected note"
              : "Save recaptured note"}
          </Button>
          <ul>
            {page.sources.map((source) => (
              <li key={source.sourceId}>
                {processing&&<ProcessingHealth source={source} comparisonSources={page.sources} ports={processing} enabled={enabled} recordId={page.person.personId} privacyKey={privacyKey} sourceVersion={String(sourceVersion ?? 0)}/>}
                {source.excerpt ? (
                  <>
                    <p>{source.excerpt}</p>
                    <p>Original date: {source.occurredAt}</p>
                    <Button
                      disabled={!enabled || busy}
                      onClick={() =>
                        void run(async () => {
                          await ports.remove({
                            personId: page.person.personId,
                            sourceId: source.sourceId,
                            expectedRevision: source.revision,
                          });
                          setPage(null);
                          setPage(await ports.read(page.person.personId));
                        })
                      }
                    >
                      Delete copied note
                    </Button>
                  </>
                ) : source.availability === "deleted" ? (
                  <>
                    <p>Copied note deleted.</p>
                    <Button
                      disabled={!enabled || busy}
                      onClick={() =>
                        void run(async () => {
                          await ports.restore({
                            personId: page.person.personId,
                            sourceId: source.sourceId,
                            expectedRevision: source.revision,
                          });
                          setPage(null);
                          setPage(await ports.read(page.person.personId));
                        })
                      }
                    >
                      Restore for recapture
                    </Button>
                  </>
                ) : (
                  <>
                    <p>Select the note again to recapture its content.</p>
                    <Button
                      disabled={!enabled || busy}
                      onClick={() => {
                        setRecapturing({
                          sourceId: source.sourceId,
                          revision: source.revision,
                        });
                        setExcerpt("");
                        setDate("");
                      }}
                    >
                      Recapture this note
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {page.nextAfterSourceId ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await ports.read(
                    page.person.personId,
                    page.nextAfterSourceId ?? undefined,
                  );
                  setPage(next);
                })
              }
            >
              More notes
            </Button>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
