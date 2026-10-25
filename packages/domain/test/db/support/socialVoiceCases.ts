import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';

type Fixture = { session: SessionQueryable; seeded: TwoWorkspaces };

const voiceRow = (fixture: Fixture) => ({
  workspace_id: fixture.seeded.alpha.workspaceId,
  owner_user_id: fixture.seeded.alpha.admin.userId,
  id: randomUUID(),
  revision: 1,
  entries: JSON.stringify([{ entryId: randomUUID(), dimension: 'tone', guidance: 'Use neutral language.' }]),
});

async function insertVoice(fixture: Fixture, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  return fixture.session.query(
    `INSERT INTO social_voice_preferences (${keys.join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
    Object.values(row),
  );
}

const invalid = (constraint: string, patch: Record<string, unknown>) => ({
  constraint,
  run: async (fixture: Fixture) => insertVoice(fixture, { ...voiceRow(fixture), ...patch }),
});

export const SOCIAL_VOICE_CONSTRAINT_CASES = [
  invalid('social_voice_content', { entries: '[]' }),
  invalid('social_voice_preferences_revision_check', { revision: 0 }),
  invalid('social_voice_preferences_workspace_id_fkey', { workspace_id: '00000000-0000-4000-8000-000000000136' }),
  {
    constraint: 'social_voice_preferences_workspace_id_owner_user_id_fkey',
    run: async (fixture: Fixture) => insertVoice(fixture, {
      ...voiceRow(fixture),
      owner_user_id: fixture.seeded.beta.admin.userId,
    }),
  },
  {
    constraint: 'social_voice_preferences_pkey',
    run: async (fixture: Fixture) => {
      const row = voiceRow(fixture);
      await insertVoice(fixture, row);
      return insertVoice(fixture, { ...row, id: randomUUID() });
    },
  },
  {
    constraint: 'social_voice_preferences_workspace_id_id_key',
    run: async (fixture: Fixture) => {
      const row = voiceRow(fixture);
      await insertVoice(fixture, row);
      return insertVoice(fixture, { ...row, owner_user_id: fixture.seeded.alpha.salesperson.userId });
    },
  },
];
