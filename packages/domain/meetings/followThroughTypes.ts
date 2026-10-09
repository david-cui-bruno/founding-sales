import type { AnswerBlock, MeetingFollowThroughScope, MeetingFollowThroughView } from '@fss/contracts';
export interface FollowThroughRow {
  readonly [column: string]: unknown;
  workspace_id: string; id: string; meeting_id: string; firm_id: string; contact_id: string | null; owner_user_id: string | null;
  source_hash: string; notes_revision: number; analysis_id: string | null; sequence_version_id: string | null;
  permission_id: string | null; enrollment_id: string | null; version: number; current_draft_version: number;
  status: MeetingFollowThroughView['status']; scope: MeetingFollowThroughScope | null; blockers: string[]; editing: boolean;
  approval_mode: 'legacy_template' | 'human'; approval: {sourceHash:string;sequenceVersionId:string;templates:{id:string;hash:string}[];draftHashes:Record<string,string>;facts:AnswerBlock[];at:string} | null; fact_refs: AnswerBlock[];
  reviewed_at: Date | null; reviewed_draft_version: number; pause_observed_at: Date | null; next_wake_at: Date; wake_revision: number; created_at: Date; updated_at: Date;
}
export interface FollowThroughDraftRow {
  readonly [column: string]: unknown;
  id: string; plan_id: string; version: number; ordinal: number; subject: string; body: string; rendered_hash: string;
  template_version_id: string; template_content_hash: string; outbound_message_id: string | null; manual_message_id: string | null; material_task_ids: string[]; source_hash: string; material_references: string[]; created_at: Date; not_before: Date;
  state: 'ready' | 'held' | 'editing' | 'cancelled' | 'superseded' | 'submitted' | 'sent';
}
