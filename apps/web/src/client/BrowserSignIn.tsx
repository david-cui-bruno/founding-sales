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
    <header className="browser-signin-welcome">
      <p className="workspace-eyebrow">Your private sales workspace</p>
      <p className="browser-signin-greeting">Welcome to Callie.</p>
      <h1>Sign in</h1>
      <p>Pick up where you left off, with your relationships and work in one place.</p>
    </header>
    <div className="browser-signin-card">
      <p className="browser-signin-account">Use the <strong>Google account that is already a member of your Callie workspace.</strong> A connected sending mailbox is not necessarily your sign-in account.</p>
      <form onSubmit={event => { event.preventDefault(); onContinue(); }} aria-busy={busy}>
        <label htmlFor={`${prefix}-workspace`}>Workspace ID</label>
        <input id={`${prefix}-workspace`} name="workspace" autoComplete="off" autoCapitalize="none" spellCheck={false} value={workspaceId} onChange={event => { onWorkspaceId(event.target.value); }} aria-describedby={`${prefix}-workspace-help`} required />
        <p id={`${prefix}-workspace-help`} className="browser-signin-hint">Paste the workspace ID provided by your workspace administrator. This is a UUID, not an email address or company name.</p>
        <details className="browser-signin-details">
          <summary>Where do I find my workspace ID?</summary>
          <p>Ask the person who set up your Callie workspace for its workspace ID and which Google account has access. This page cannot look up a workspace by email or create membership.</p>
        </details>
        <details className="browser-signin-details browser-signin-advanced" onInvalidCapture={event => { event.currentTarget.open = true; }}>
          <summary>Advanced · browser label</summary>
          <label htmlFor={`${prefix}-browser`}>Browser label</label>
          <input id={`${prefix}-browser`} name="deviceLabel" autoComplete="off" value={deviceLabel} onChange={event => { onDeviceLabel(event.target.value); }} aria-describedby={`${prefix}-browser-help`} required />
          <p id={`${prefix}-browser-help`} className="browser-signin-hint">A name to identify this browser in your workspace. You can keep “Local browser”.</p>
        </details>
        <button type="submit" className="workspace-primary browser-signin-continue" disabled={busy}>{busy ? 'Please wait…' : 'Continue with Google'}<span aria-hidden="true">→</span></button>
        <p className="browser-signin-hint browser-signin-next">You’ll choose your Google account next. Existing workspace access is required.</p>
      </form>
      <div className="browser-signin-recovery">
        <p>Already signed in in this browser?</p>
        <button type="button" className="workspace-quiet" disabled={busy} onClick={onRefresh}>Refresh access</button>
        <p className="browser-signin-hint">Checks your current session without starting a new sign-in.</p>
      </div>
    </div>
  </section>;
}
