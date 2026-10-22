import { beforeEach, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../src/auth/sessions.ts';
import type { RoutingOptions } from '../src/routes/types.ts';
import { routeReplyComposer } from '../src/routes/replyComposer.ts';
import { routeReplies } from '../src/routes/replies.ts';
import { routeMeetings } from '../src/routes/meetings.ts';

const mocks = vi.hoisted(() => ({
  principal: vi.fn(), context: vi.fn(), firm: vi.fn(), composer: vi.fn(), preview: vi.fn(), generate: vi.fn(),
  card: vi.fn(), cards: vi.fn(), preparation: vi.fn(), brief: vi.fn(), meetings: vi.fn(), suggestion: vi.fn(),
}));
vi.mock('../src/routes/routeSupport.ts', () => ({
  requirePrincipal: mocks.principal, contextForPrincipal: mocks.context, runRouteCommand: vi.fn(),
}));
vi.mock('@fss/domain/crm/firms.ts', () => ({ readFirm: mocks.firm }));
vi.mock('@fss/domain/replies/composer.ts', () => ({ readReplyDraftContext: mocks.composer }));
vi.mock('@fss/domain/replies/composerGeneration.ts', () => ({ generateReplyDraft: mocks.generate }));
vi.mock('@fss/domain/replies/dispatch.ts', () => ({ previewHumanReply: mocks.preview, requestHumanReplySend: vi.fn(), readHumanReplySend: vi.fn() }));
vi.mock('@fss/domain/classification/cards.ts', () => ({ readReplyCard: mocks.card, listReplyCards: mocks.cards }));
vi.mock('@fss/domain/meetings/brief.ts', () => ({ readMeetingBrief: mocks.brief, readMeetingPreparation: mocks.preparation }));
vi.mock('@fss/domain/meetings/match.ts', () => ({ listFirmMeetings: mocks.meetings, readFirmStageSuggestion: mocks.suggestion, listUnmatchedMeetings: vi.fn(), matchMeetingToFirm: vi.fn() }));

const id = '10000000-0000-4000-8000-000000000001';
const principal: AuthenticatedPrincipal = { workspaceId: id, userId: id, sessionId: id, deviceId: id, role: 'salesperson', membershipStatus: 'active', deviceStatus: 'active' };
const options = { auth: { config: { supportedClientVersions: { minimum: '1.0.0', ceiling: '1.x', incompatible: [] } } } } as unknown as RoutingOptions;
const request = (path: string, body: unknown = { messageId: id }) => ({ method: 'POST', path, body, headers: {}, query: new URLSearchParams() });
const source = { ok: true, value: { firmId: id, sourceRevision: 'a'.repeat(64), messageText: 'Private original', priorContext: [] } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.principal.mockResolvedValue({ ok: true, principal });
  mocks.context.mockReturnValue({ ok: true, context: { scope: { workspaceId: id, actor: { kind: 'user', userId: id, role: 'salesperson' } } } });
  mocks.firm.mockResolvedValue({ id, status: 'active', assigned_user_id: id });
  mocks.composer.mockResolvedValue(source);
});

it('retains existing successful context and preview response shapes', async () => {
  expect(await routeReplyComposer(request('/replies/composer/context'), options)).toEqual({ status: 200, body: source });
  const preview = { ok: true, value: { sourceRevision: source.value.sourceRevision, body: 'Reviewed preview', draftRevision: 'b'.repeat(64) } };
  mocks.preview.mockResolvedValue(preview);
  expect(await routeReplyComposer(request('/replies/composer/preview', { messageId: id, text: 'Review this', factRefs: [], envelope: { to: ['person@example.test'], cc: [] } }), options)).toEqual({ status: 200, body: preview });
});

it('preserves desktop generation409 and replay metadata while refusing late identity loss', async () => {
  const input = { messageId: id, sourceRevision: 'a'.repeat(64), commandId: id, clientVersion: '1.0.0', factRefs: [], envelope: { to: ['person@example.test'], cc: [] } };
  mocks.generate.mockResolvedValue({ ok: false, reason: 'generation_already_attempted' });
  expect(await routeReplyComposer(request('/replies/composer/generate', input), options)).toEqual({ status: 409, body: { status: 'refused', replayed: true, reason: 'generation_already_attempted' } });
  mocks.generate.mockImplementation(async () => {
    mocks.principal.mockResolvedValue({ ok: true, principal: { ...principal, role: 'admin' } });
    return { ok: true, value: { text: 'Private suggestion' } };
  });
  expect(await routeReplyComposer(request('/replies/composer/generate', input), options)).toEqual({ status: 409, body: { status: 'refused', replayed: false, reason: 'session_changed' } });
});

it('preserves meeting v1/v2 response shapes while ignoring assembly timestamps in the source check', async () => {
  const section = { items: [], omitted: 0 };
  const brief = { meetingId: id, firmId: id, meeting: { title: null, attendeeName: null, state: 'booked', startsAt: '2026-10-22T20:00:00Z', endsAt: '2026-10-22T21:00:00Z', locationType: null }, sections: { whyThisDemo: section, firm: section, conversations: section, objections: section, commitments: section }, generatedAt: '2026-10-22T20:00:00Z' };
  for (const version of ['1', '2']) {
    const read = version === '1' ? mocks.brief : mocks.preparation;
    read.mockResolvedValueOnce(brief).mockResolvedValueOnce({ ...brief, generatedAt: '2026-10-22T20:00:01Z' });
    expect(await routeMeetings({ ...request('/meetings/brief'), method: 'GET', query: new URLSearchParams({ meetingId: id, version }) }, options)).toEqual({ status: 200, body: brief });
  }
});

it.each(['workspaceId', 'userId', 'sessionId', 'deviceId', 'role'] as const)('withholds original context after %s changes while assembling', async key => {
  mocks.composer.mockImplementation(async () => {
    mocks.principal.mockResolvedValue({ ok: true, principal: { ...principal, [key]: key === 'role' ? 'admin' : '20000000-0000-4000-8000-000000000002' } });
    return source;
  });
  const result = await routeReplyComposer(request('/replies/composer/context'), options);
  expect(result).toMatchObject({ status: 401 });
  expect(JSON.stringify(result)).not.toContain('Private original');
});

it.each(['not_assigned', 'owner_changed'])('treats current %s as authority loss, not content uncertainty', async reason => {
  mocks.composer.mockResolvedValueOnce(source).mockResolvedValue({ ok: false, reason });
  expect(await routeReplyComposer(request('/replies/composer/context'), options)).toMatchObject({ status: 401 });
});

it('keeps authenticated source loss content-local, without an authority409', async () => {
  mocks.composer.mockResolvedValueOnce(source).mockResolvedValue({ ok: false, reason: 'message_unavailable' });
  expect(await routeReplyComposer(request('/replies/composer/context'), options)).toEqual({ status: 200, body: { ok: false, reason: 'source_changed' } });
});

it('checks the actual current Firm after a stable context was assembled', async () => {
  mocks.firm.mockResolvedValue({ id, status: 'active', assigned_user_id: 'another-owner' });
  expect(await routeReplyComposer(request('/replies/composer/context'), options)).toMatchObject({ status: 401 });
});

it('withholds a preview when its source revision changes after the footer wait', async () => {
  mocks.preview.mockResolvedValue({ ok: true, value: { sourceRevision: 'b'.repeat(64), body: 'Private preview' } });
  const result = await routeReplyComposer(request('/replies/composer/preview', { messageId: id, text: 'Review this', factRefs: [], envelope: { to: ['person@example.test'], cc: [] } }), options);
  expect(result).toEqual({ status: 200, body: { ok: false, reason: 'source_changed' } });
});

it('does not turn preview source deletion into global authentication loss', async () => {
  mocks.preview.mockResolvedValue({ ok: true, value: { sourceRevision: 'a'.repeat(64), body: 'Private preview' } });
  mocks.composer.mockResolvedValue({ ok: false, reason: 'message_unavailable' });
  expect(await routeReplyComposer(request('/replies/composer/preview', { messageId: id, text: 'Review this', factRefs: [], envelope: { to: ['person@example.test'], cc: [] } }), options)).toEqual({ status: 200, body: { ok: false, reason: 'source_changed' } });
});

it('withholds cards and lists when membership disappears during domain reads', async () => {
  const card = { messageId: id, firmId: id, visibility: 'assigned_or_admin', body: { text: 'Private card' } };
  mocks.card.mockImplementation(async () => { mocks.principal.mockResolvedValue({ ok: false, result: { status: 401 } }); return card; });
  expect(await routeReplies(request('/replies/card'), options)).toMatchObject({ status: 401 });
  mocks.principal.mockResolvedValue({ ok: true, principal });
  mocks.cards.mockImplementation(async () => { mocks.principal.mockResolvedValue({ ok: false, result: { status: 401 } }); return [card]; });
  expect(await routeReplies(request('/replies', { businessDate: '2026-10-22' }), options)).toMatchObject({ status: 401 });
});

it('does not expose a card after its source disappears during assembly', async () => {
  mocks.card.mockResolvedValueOnce({ messageId: id, firmId: id, visibility: 'assigned_or_admin', body: { text: 'Private card' } }).mockResolvedValue(null);
  expect(await routeReplies(request('/replies/card'), options)).toMatchObject({ status: 404 });
});

it('withholds a sourced brief after actual Firm reassignment', async () => {
  mocks.preparation.mockResolvedValue({ firmId: id, meetingId: id, generatedAt: '2026-10-22T20:00:00Z', sections: { private: 'Private brief' } });
  mocks.firm.mockResolvedValue({ id, status: 'active', assigned_user_id: 'another-owner' });
  const req = { ...request('/meetings/brief'), method: 'GET', query: new URLSearchParams({ meetingId: id, version: '2', include: 'meeting_tasks' }) };
  const result = await routeMeetings(req, options);
  expect(result).toMatchObject({ status: 401 });
  expect(JSON.stringify(result)).not.toContain('Private brief');
});

it('withholds a brief after its current source projection changes', async () => {
  mocks.preparation.mockResolvedValueOnce({ firmId: id, sections: { text: 'Removed source' } }).mockResolvedValue({ firmId: id, sections: { text: 'Unknown' } });
  expect(await routeMeetings({ ...request('/meetings/brief'), method: 'GET', query: new URLSearchParams({ meetingId: id, version: '2' }) }, options)).toMatchObject({ status: 404 });
});

it('rechecks session identity after meeting-list and suggestion waits', async () => {
  mocks.meetings.mockResolvedValue([]);
  mocks.suggestion.mockImplementation(async () => { mocks.principal.mockResolvedValue({ ok: true, principal: { ...principal, role: 'admin' } }); return null; });
  expect(await routeMeetings({ ...request('/meetings/firm'), method: 'GET', query: new URLSearchParams({ firmId: id }) }, options)).toMatchObject({ status: 401 });
});
