import { SelectedImports, type SelectedImportPorts } from './SelectedImports.tsx';
import {ProcessingHealth,type ProcessingPorts} from './ProcessingHealth.tsx';
import { useEffect, useState, type JSX } from 'react';
import { type z } from 'zod';
import type { firmSourcePageSchema } from '@fss/contracts';
import {
  Endpoints,
  type EndpointPorts,
  type EndpointEditingPorts,
} from './Endpoints.tsx';
import { Button } from '../ui/button.tsx';
import { Select } from '../ui/select.tsx';
type Page = z.infer<typeof firmSourcePageSchema>;
export interface FirmAddressPorts {
  firms(): Promise<{ firmId: string; name: string }[]>;
  read(firmId: string, afterSourceId?: string): Promise<Page>;
  add(input: {
    firmId: string;
    sourceKey: string;
    excerpt: string;
    occurredAt: string;
  }): Promise<void>;
  remove(input: {
    firmId: string;
    sourceId: string;
    expectedRevision: number;
  }): Promise<void>;
  restore(input: {
    firmId: string;
    sourceId: string;
    expectedRevision: number;
  }): Promise<void>;
  recapture(input: {
    firmId: string;
    sourceId: string;
    expectedRevision: number;
    excerpt: string;
    occurredAt: string;
  }): Promise<void>;
}
export function FirmAddresses({
  enabled,
  ports,
  endpoints,
  editing,
  imports,
  processing,
}: {
  enabled: boolean;
  processing?:ProcessingPorts;
  ports: FirmAddressPorts;
  endpoints: EndpointPorts;
  editing?: EndpointEditingPorts | undefined;
  imports?: SelectedImportPorts;
}): JSX.Element {
  const [firms, setFirms] = useState<{ firmId: string; name: string }[]>([]);
  const [firmId, setFirmId] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [key, setKey] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [date, setDate] = useState('');
  const [recapturing, setRecapturing] = useState<{
    sourceId: string;
    revision: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void ports
      .firms()
      .then((value) => {
        if (active) setFirms(value);
      })
      .catch(() => {
        if (active) setError('Firms could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [ports]);
  useEffect(() => {
    let active = true;
    setPage(null);
    setKey('');
    setExcerpt('');
    setDate('');
    setRecapturing(null);
    setError('');
    if (firmId)
      void ports
        .read(firmId)
        .then((value) => {
          if (active) setPage(value);
        })
        .catch(() => {
          if (active) setError('Firm evidence could not be loaded.');
        });
    return () => {
      active = false;
    };
  }, [firmId, ports]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch {
      setPage(null);
      setExcerpt('');
      setRecapturing(null);
      setError(
        'The firm evidence could not be updated. Refresh and try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Shared firm addresses">
      <h3>Shared firm addresses</h3>
      <p>Shared addresses identify a firm; the human speaker stays unknown.</p>
      {error ? <p role="alert">{error}</p> : null}
      <label>
        Shared-address firm
        <Select
          aria-label="Shared-address firm"
          disabled={busy}
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
      {firmId && page ? (
        <>
          <label>
            Firm note reference
            <input
              aria-label="Firm note reference"
              value={key}
              disabled={recapturing !== null}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          <label>
            Firm selected note
            <textarea
              aria-label="Firm selected note"
              value={excerpt}
              onChange={(event) => setExcerpt(event.target.value)}
            />
          </label>
          <label>
            Firm note original date
            <input
              aria-label="Firm note original date"
              type="datetime-local"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <Button
            disabled={
              !enabled ||
              busy ||
              (!key.trim() && recapturing === null) ||
              !excerpt.trim() ||
              !date
            }
            onClick={() =>
              void run(async () => {
                if (recapturing === null)
                  await ports.add({
                    firmId,
                    sourceKey: key,
                    excerpt,
                    occurredAt: new Date(date).toISOString(),
                  });
                else
                  await ports.recapture({
                    firmId,
                    sourceId: recapturing.sourceId,
                    expectedRevision: recapturing.revision,
                    excerpt,
                    occurredAt: new Date(date).toISOString(),
                  });
                setPage(await ports.read(firmId));
                setExcerpt('');
                setRecapturing(null);
              })
            }
          >
            {recapturing === null
              ? 'Save firm evidence'
              : 'Save recaptured firm evidence'}
          </Button>
          <ul>
            {page.sources.map((source) => (
              <li key={source.sourceId}>
                {processing&&<ProcessingHealth source={source} ports={processing}/>}
                {source.excerpt ? (
                  <>
                    <p>{source.excerpt}</p>
                    <p>Original date: {source.occurredAt}</p>
                    <Button
                      disabled={!enabled || busy}
                      onClick={() =>
                        void run(async () => {
                          await ports.remove({
                            firmId,
                            sourceId: source.sourceId,
                            expectedRevision: source.revision,
                          });
                          setPage(await ports.read(firmId));
                        })
                      }
                    >
                      Delete copied firm note
                    </Button>
                  </>
                ) : source.availability === 'deleted' ? (
                  <Button
                    disabled={!enabled || busy}
                    onClick={() =>
                      void run(async () => {
                        await ports.restore({
                          firmId,
                          sourceId: source.sourceId,
                          expectedRevision: source.revision,
                        });
                        setPage(await ports.read(firmId));
                      })
                    }
                  >
                    Restore firm note for recapture
                  </Button>
                ) : (
                  <Button
                    disabled={!enabled || busy}
                    onClick={() => {
                      setRecapturing({
                        sourceId: source.sourceId,
                        revision: source.revision,
                      });
                      setExcerpt('');
                      setDate('');
                    }}
                  >
                    Recapture this firm note
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {page.nextAfterSourceId ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setPage(
                    await ports.read(
                      firmId,
                      page.nextAfterSourceId ?? undefined,
                    ),
                  ),
                )
              }
            >
              More firm notes
            </Button>
          ) : null}
          {imports ? <SelectedImports key={firmId} enabled={enabled} firmId={firmId} ports={imports} sourceVersion={page.sources.map(source=>`${source.sourceId}:${source.revision}:${source.availability}`).join('|')} onChange={async()=>setPage(await ports.read(firmId))}/> : null}
            <Endpoints
            key={firmId}
            firmId={firmId}
            ports={endpoints}
            editing={editing}
            sources={page.sources}
            enabled={enabled}
          />
        </>
      ) : null}
    </section>
  );
}
