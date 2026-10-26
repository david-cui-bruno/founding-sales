import type { BrowserClient } from './BrowserClient.ts';

/** Presentation destinations only. Navigation never grants product authority. */
export type WorkspaceSection = 'today' | 'prospects' | 'calling' | 'email' | 'social' | 'settings';

/** Screens use the current session client, not cached principals or shared private projections. */
export interface WorkspaceScreenProps {
  client: BrowserClient;
  onNavigate?: (section: WorkspaceSection) => void;
}

export const WORKSPACE_SECTIONS: ReadonlyArray<{ id: WorkspaceSection; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'prospects', label: 'Prospects' },
  { id: 'calling', label: 'Calling' },
  { id: 'email', label: 'Email' },
  { id: 'social', label: 'Social' },
];
