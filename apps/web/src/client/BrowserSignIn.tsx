import { useId, type JSX } from 'react';
import './browserSignIn.css';

/** Presentation only: workspace and browser values remain owned by the auth-fenced app. */
export function BrowserSignIn({ workspaceId, deviceLabel, busy, onWorkspaceId, onDeviceLabel, onContinue, onRefresh }: {
  workspaceId: string; deviceLabel: string; busy: boolean;
  onWorkspaceId: (value: string) => void; onDeviceLabel: (value: string) => void;
  onContinue: () => void; onRefresh: () => void;
}): JSX.Element {
  const prefix = useId();
  return <section aria-label="Sign in" className="browser-signin">
    <div className="browser-brand"><span className="workspace-mark" aria-hidden="true">C</span><span>Callie</span></div>
    <div className="browser-signin-card">
      <h1>Sign in</h1>
      <p className="browser-signin-account">Use the <strong>Google account that is already a member of your Callie workspace.</strong> A connected sending mailbox is not necessarily your sign-in account.</p>
      <form onSubmit={event => { event.preventDefault(); onContinue(); }} aria-busy={busy}>
        <label htmlFor={`${prefix}-workspace`}>Workspace ID</label>
        <input id={`${prefix}-workspace`} name="workspace" autoComplete="off" autoCapitalize="none" spellCheck={false} value={workspaceId} disabled={busy} onChange={event => { onWorkspaceId(event.target.value); }} aria-describedby={`${prefix}-workspace-help`} required />
        <p id={`${prefix}-workspace-help`} className="browser-signin-hint">Your administrator can provide this ID and the Google account with access. This is a UUID, not an email address; sign-in cannot look up or create membership.</p>
        <label htmlFor={`${prefix}-browser`}>Browser label</label>
        <input id={`${prefix}-browser`} name="deviceLabel" autoComplete="off" value={deviceLabel} disabled={busy} onChange={event => { onDeviceLabel(event.target.value); }} aria-describedby={`${prefix}-browser-help`} required />
        <p id={`${prefix}-browser-help`} className="browser-signin-hint">A name to identify this browser. You can keep “Local browser”.</p>
        <button type="submit" className="workspace-primary browser-signin-continue" disabled={busy}>{busy ? 'Please wait…' : 'Continue with Google'}</button>
      </form>
      <div className="browser-signin-recovery"><p>Already signed in in this browser?</p><button type="button" className="workspace-quiet" disabled={busy} onClick={onRefresh}>Refresh access</button></div>
    </div>
  </section>;
}
