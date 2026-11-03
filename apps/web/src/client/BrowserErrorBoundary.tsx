import { Component, type ReactNode } from 'react';
import { captureTechnicalError } from '@fss/telemetry/browser';

/** Only React's thrown render failures enter this boundary, never command refusals. */
export class BrowserErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    captureTechnicalError(error, 'browser_render');
  }

  override render(): ReactNode {
    return this.state.failed
      ? <main role="alert">This view is unavailable. Reload the page to try again.</main>
      : this.props.children;
  }
}
