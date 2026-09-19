import { useState, type FormEvent } from 'react';
import type { ClientStatus } from '../../shared/clientContract';

/**
 * One field, one button, honest text. The field takes the pairing code the operator tool minted or the
 * absolute path of the private file it wrote the code to; the worker's endpoint comes from configuration
 * and is shown, never typed here. The notice is the sentence the main process left when the worker
 * refused the previous token.
 */
const UNCONFIGURED =
  'No worker endpoint is configured. Put {"endpoint":"https://..."} in client/worker-endpoint.json under this '
  + "app's Application Support folder, or set CALLIE_WORKER_ENDPOINT while developing.";

export function PairPage({ status, onPaired }: { status: ClientStatus; onPaired: (status: ClientStatus) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unconfigured = status.endpoint === null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || unconfigured) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.callie.pair(code);
      if (result.outcome === 'paired') {
        onPaired(result.status);
      } else {
        setError(result.sentence);
      }
    } catch {
      setError('The client could not send the code to the worker.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell shell--pair">
      <section className="pair">
        <h1>Pair this Mac</h1>
        <p className="pair__worker">{unconfigured ? UNCONFIGURED : `Worker: ${status.endpoint}`}</p>
        {status.notice && <p role="status" className="notice">{status.notice}</p>}
        <form className="pair__form" onSubmit={(event) => { void submit(event); }}>
          <label className="pair__label" htmlFor="pair-code">Pairing code or the path of the code file</label>
          <input
            id="pair-code"
            className="pair__input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={busy || unconfigured}
          />
          <button type="submit" className="pair__button" disabled={busy || unconfigured || code.trim() === ''}>Pair</button>
        </form>
        {error && <p role="alert" className="error">{error}</p>}
        <p className="pair__hint">
          The code file is deleted after a successful pairing. The device token is kept in a safeStorage-encrypted file.
        </p>
      </section>
    </main>
  );
}
