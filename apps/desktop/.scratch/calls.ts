import { OPERATIONS } from '../src/shared/operations.ts';
for (const name of ['today.expand', 'replies.refresh', 'crm.openFirm', 'crm.state', 'sequences.state', 'settings.show', 'mailbox.state'] as const) {
  const op = (OPERATIONS as Record<string, { calls?: readonly { method: string; path: string }[] }>)[name];
  console.log(name, '=>', op?.calls?.map(c => `${c.method} ${c.path}`).join(' | ') ?? 'MISSING');
}
