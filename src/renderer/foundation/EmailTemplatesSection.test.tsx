// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailTemplatesSection, REPLY_TEMPLATE_APPROVAL_STATEMENT, REPLY_TEMPLATE_PAUSE_STATEMENT } from './EmailTemplatesSection';
import { REPLY_TEMPLATE_SEEDS, REPLY_TEMPLATE_SEED_HASHES } from '../../main/outreach/templates/replyTemplateSeeds';
import { REPLY_TEMPLATE_SIGN_OFF, replyTemplateContentHash, type EditReplyTemplate, type ReplyTemplate,
  type ReplyTemplateRequest, type ReplyTemplateSnapshot, type ReplyTemplateStatus, type SendingLimitsRequest } from '../../shared/contracts/replyTemplateContract';
import { SENDER_RAMP_DEFAULT, senderCapForDay } from '../../shared/contracts/workerPolicyContract';

const NOW = '2026-09-18T14:00:00.000Z';
const EDITED_BODY = `Thanks for the time today. Callie is a 24/7 maintenance agent for property managers: it handles tenant requests and coordinates contractors, including calling them when needed.

Next step from our call: {next_step}.

${REPLY_TEMPLATE_SIGN_OFF}`;

/** An in-memory twin of the schema-30 store and the worker hop: five revisioned rows and one pause switch. */
function fixture(options: { applied?: boolean; limits?: boolean } = {}) {
  const rows = new Map<string, ReplyTemplate>(REPLY_TEMPLATE_SEEDS.map((seed): [string, ReplyTemplate] => [seed.id, {
    ...seed, variables: [...seed.variables], revision: 1,
    approval: { state: 'draft', approvedRevision: null, approvedAt: null, contentHash: null }, updatedAt: NOW,
  }]));
  let settings = { paused: false, revision: 1, updatedAt: NOW };
  const snapshot = (): ReplyTemplateSnapshot => ({ templates: [...rows.values()], settings });
  const status = (receipt: ReplyTemplateStatus['receipt'] = null): ReplyTemplateStatus => ({ snapshot: snapshot(), receipt });
  const applied = options.applied !== false;
  const receiptFor = (commandId: string): ReplyTemplateStatus['receipt'] =>
    ({ commandId, status: applied ? 'applied' : 'rejected', authorityGeneration: 0, aggregateVersion: 1, reason: applied ? null : 'template_not_approved' });
  const api = {
    read: vi.fn(async () => status()),
    edit: vi.fn(async (input: EditReplyTemplate) => {
      const row = rows.get(input.templateId)!;
      if (row.revision !== input.expectedRevision) throw new Error('STALE');
      rows.set(input.templateId, { ...row, subject: input.subject, body: input.body, revision: row.revision + 1,
        variables: row.variables, approval: { state: row.approval.state === 'draft' ? 'draft' : 'revoked', approvedRevision: null, approvedAt: null, contentHash: null }, updatedAt: NOW });
      return status();
    }),
    approve: vi.fn(async (input: Extract<ReplyTemplateRequest, { kind: 'approve' }>) => {
      const row = rows.get(input.templateId)!;
      if (applied) rows.set(input.templateId, { ...row, approval: { state: 'approved', approvedRevision: row.revision, approvedAt: NOW, contentHash: replyTemplateContentHash(row) } });
      return status(receiptFor(input.commandId));
    }),
    revoke: vi.fn(async (input: Extract<ReplyTemplateRequest, { kind: 'revoke' }>) => {
      const row = rows.get(input.templateId)!;
      if (applied) rows.set(input.templateId, { ...row, approval: { state: 'revoked', approvedRevision: null, approvedAt: null, contentHash: null } });
      return status(receiptFor(input.commandId));
    }),
    pause: vi.fn(async (input: Extract<ReplyTemplateRequest, { kind: 'pause' }>) => {
      if (applied) settings = { paused: input.paused, revision: settings.revision + 1, updatedAt: NOW };
      return status(receiptFor(input.commandId));
    }),
    ...(options.limits === false ? {} : {
      sendingLimits: vi.fn(async (input: SendingLimitsRequest) => ({ sender: 'callie@usecallie.com', dailyLimit: 40, ramp: SENDER_RAMP_DEFAULT,
        receipt: { requestId: input.requestId, kind: 'sender-caps' as const, status: 'applied' as const, revision: 1, fingerprint: 'c'.repeat(64) } })),
    }),
  };
  const grants = { status: vi.fn(async () => ({ state: 'ready' as const,
    grant: { provider: 'google' as const, subject: 'worker-subject', email: 'callie@usecallie.com',
      grantedScopes: ['https://www.googleapis.com/auth/gmail.send'], owner: 'remote' as const,
      purpose: 'permitted_correspondence' as const, capabilities: ['send' as const] },
    senderCap: senderCapForDay({ dailyLimit: 40, ramp: SENDER_RAMP_DEFAULT }, '2026-09-16T09:00:00.000Z', NOW) })),
    disclosure: vi.fn(), begin: vi.fn(), revoke: vi.fn() };
  return { api, grants, rows, snapshot };
}
const template = (id: string) => screen.getByRole('listitem', { name: `Template ${id}` });
const button = (id: string, label: string) => within(template(id)).getByRole('button', { name: label }) as HTMLButtonElement;

afterEach(cleanup);

describe('Email templates section', () => {
  it('lists the five templates with purpose, revision, variables and approval state', async () => {
    const f = fixture();
    render(<EmailTemplatesSection api={f.api} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    expect(within(template('T4')).getByText(/Purpose: short value note · revision 1 · Draft — never sent/)).toBeTruthy();
    expect(within(template('T4')).getByText('Variables: {firm}, {city}')).toBeTruthy();
    expect((within(template('T1')).getByLabelText('T1 subject') as HTMLInputElement).value).toBe('Following up on our call, {firm}');
    expect((within(template('T1')).getByLabelText('T1 body') as HTMLTextAreaElement).value).toBe(REPLY_TEMPLATE_SEEDS[0]!.body);
    expect(screen.getByText(REPLY_TEMPLATE_PAUSE_STATEMENT)).toBeTruthy();
  });

  it('shows the standing effect once before approving, and only then sends the approval', async () => {
    const f = fixture();
    render(<EmailTemplatesSection api={f.api} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    expect(screen.queryByText(REPLY_TEMPLATE_APPROVAL_STATEMENT)).toBeNull();
    fireEvent.click(button('T4', 'Approve T4'));
    expect(screen.getByText(REPLY_TEMPLATE_APPROVAL_STATEMENT)).toBeTruthy();
    expect(f.api.approve).not.toHaveBeenCalled();
    fireEvent.click(button('T4', 'Confirm: approve T4 for standing sends'));
    await waitFor(() => expect(f.api.approve).toHaveBeenCalledTimes(1));
    expect(f.api.approve.mock.calls[0]![0]).toMatchObject({ kind: 'approve', templateId: 'T4', expectedRevision: 1 });
    expect(f.api.approve.mock.calls[0]![0].commandId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(within(template('T4')).getByText(/Approved — standing/)).toBeTruthy());
    expect(f.rows.get('T4')!.approval.contentHash).toBe(REPLY_TEMPLATE_SEED_HASHES.T4);
    expect(button('T4', 'Revoke T4')).toBeTruthy();
  });

  it('cancels a pending approval without sending anything', async () => {
    const f = fixture();
    render(<EmailTemplatesSection api={f.api} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    fireEvent.click(button('T2', 'Approve T2'));
    fireEvent.click(button('T2', 'Cancel'));
    expect(screen.queryByText(REPLY_TEMPLATE_APPROVAL_STATEMENT)).toBeNull();
    expect(f.api.approve).not.toHaveBeenCalled();
  });

  it('saves an edit, revokes the approval it had, and refuses to approve unsaved text', async () => {
    const f = fixture();
    render(<EmailTemplatesSection api={f.api} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    fireEvent.click(button('T1', 'Approve T1'));
    fireEvent.click(button('T1', 'Confirm: approve T1 for standing sends'));
    await waitFor(() => expect(within(template('T1')).getByText(/Approved — standing/)).toBeTruthy());

    fireEvent.change(within(template('T1')).getByLabelText('T1 body'), { target: { value: EDITED_BODY } });
    expect(button('T1', 'Approve T1').disabled).toBe(true);
    expect(within(template('T1')).getByText(/Unsaved changes/)).toBeTruthy();
    fireEvent.click(button('T1', 'Save T1'));
    await waitFor(() => expect(f.api.edit).toHaveBeenCalledTimes(1));
    expect(f.api.edit.mock.calls[0]![0]).toEqual({ templateId: 'T1', expectedRevision: 1, subject: 'Following up on our call, {firm}', body: EDITED_BODY });
    await waitFor(() => expect(within(template('T1')).getByText(/revision 2 · Revoked — edited since you approved it/)).toBeTruthy());
    expect(f.api.approve).toHaveBeenCalledTimes(1);
  });

  it('refuses to send an edit that breaks a body rule and says so without calling the bridge', async () => {
    const f = fixture();
    render(<EmailTemplatesSection api={f.api} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    fireEvent.change(within(template('T2')).getByLabelText('T2 body'), { target: { value: '' } });
    fireEvent.click(button('T2', 'Save T2'));
    expect(screen.getByRole('status').textContent).toMatch(/not a shape a template may take/);
    expect(f.api.edit).not.toHaveBeenCalled();
  });

  it('pauses every send behind one confirmation and switches back on without one', async () => {
    const f = fixture();
    render(<EmailTemplatesSection api={f.api} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    expect(screen.getByText('Sends are currently on (revision 1).')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause all sends' }));
    expect(f.api.pause).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: pause all sends' }));
    await waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(1));
    expect(f.api.pause.mock.calls[0]![0]).toMatchObject({ kind: 'pause', paused: true });
    await waitFor(() => expect(screen.getByText('Sends are currently paused (revision 2).')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Switch sends back on' }));
    await waitFor(() => expect(f.api.pause).toHaveBeenCalledTimes(2));
    expect(f.api.pause.mock.calls[1]![0]).toMatchObject({ paused: false });
  });

  it('leaves everything unchanged and names the hold when the worker rejects the approval', async () => {
    const f = fixture({ applied: false });
    render(<EmailTemplatesSection api={f.api} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    fireEvent.click(button('T4', 'Approve T4'));
    fireEvent.click(button('T4', 'Confirm: approve T4 for standing sends'));
    await waitFor(() => expect(f.api.approve).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Approval of T4 recorded\./));
    expect(within(template('T4')).getByText(/Draft — never sent/)).toBeTruthy();
    expect(f.rows.get('T4')!.approval.state).toBe('draft');
  });

  it('writes one sending limit with the sender it read, and shows the receipt and today’s cap', async () => {
    const f = fixture();
    render(<EmailTemplatesSection api={f.api} grants={f.grants} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    expect(f.grants.status).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Write the sending limit' }));
    await waitFor(() => expect(f.api.sendingLimits).toHaveBeenCalledTimes(1));
    expect(f.api.sendingLimits!.mock.calls[0]![0]).toMatchObject({ expectedRevision: null });
    await waitFor(() => expect(screen.getByText(/Limit recorded for callie@usecallie\.com: 40 a day, ramp 10 plus 2 a day up to 40 \(revision 1\)/)).toBeTruthy());
    expect(f.grants.status).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Sender cap today: 14 of 40 \(day 3 of ramp\)/)).toBeTruthy();
  });

  it('holds honestly with no bridge, and names the missing worker connection for sending limits', async () => {
    render(<EmailTemplatesSection />);
    expect(screen.getByRole('status').textContent).toBe('Email templates are unavailable.');
    expect(screen.queryAllByRole('listitem')).toEqual([]);
    cleanup();
    const f = fixture({ limits: false });
    render(<EmailTemplatesSection api={f.api} />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
    expect(screen.getByText('HOLD: the worker connection is unavailable, so no sending limit can be written.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Write the sending limit' })).toBeNull();
  });
});
