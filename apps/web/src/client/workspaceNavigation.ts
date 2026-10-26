import type { BrowserClient } from './BrowserClient.ts';
import type { CallingSubject } from '@fss/contracts';

/** Presentation destinations only. Navigation never grants product authority. */
export type WorkspaceSection = 'today' | 'prospects' | 'calling' | 'email' | 'social' | 'settings';

/** Screens use the current session client, not cached principals or shared private projections. */
export interface WorkspaceScreenProps {
  client: BrowserClient;
  onNavigate?: (section: WorkspaceSection) => void;
}

/** Exact in-memory navigation, never a permission or retained private content cache. */
export interface CallingWorkspaceProps extends WorkspaceScreenProps {
  selection?: CallingSubject | null;
  onSelectionChange?: (selection: CallingSubject | null) => void;
  onAdvance?: () => void;
  onOpenEmailDraft?: (draftId: string) => void;
}
export interface EmailWorkspaceProps extends WorkspaceScreenProps {
  selectedFollowUpDraftId?: string | null;
  onFollowUpDraftSelectionChange?: (draftId: string | null) => void;
}

export const WORKSPACE_SECTIONS: ReadonlyArray<{ id: WorkspaceSection; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'prospects', label: 'Prospects' },
  { id: 'calling', label: 'Calling' },
  { id: 'email', label: 'Email' },
  { id: 'social', label: 'Social' },
];
