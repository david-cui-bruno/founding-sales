import { changeMeetingTaskCommandSchema, saveMeetingNotesCommandSchema, uuid } from '@fss/contracts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { lockAnalysisMeeting } from '@fss/domain/meetings/analysisRequests.ts';
import { readCurrentMeetingNotes, readMeetingOutcomes, readMeetingTask } from '@fss/domain/meetings/outcomes.ts';
import { saveMeetingOutcomeCorrections } from '@fss/domain/meetings/outcomeCorrections.ts';
import { changeMeetingTask } from '@fss/domain/meetings/tasks.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

export const MEETING_OUTCOMES_PATHS: readonly string[] = ['/meetings/outcomes', '/meetings/notes', '/meetings/tasks/change'];
export async function routeMeetingOutcomes(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!MEETING_OUTCOMES_PATHS.includes(request.path)) return null;
  const missing = { status: 404, body: { error: 'not_found' } };
  const auth = options.auth;
  if (auth === undefined) return missing;
  if (request.method !== (request.path === '/meetings/outcomes' ? 'GET' : 'POST')) return { status: 405, body: { error: 'method_not_allowed' } };
  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;
  if (request.path === '/meetings/outcomes') {
    const id = uuid.safeParse(request.query.get('meetingId'));
    if (!id.success) return { status: 400, body: { error: 'invalid_input' } };
    const value = await readMeetingOutcomes(scoped.context, { meetingId: id.data });
    return value === null ? missing : { status: 200, body: value };
  }
  const deps = { auth, request, principal: authenticated.principal };
  // Receipts retain identifiers only. Replays must pass current authorization, and
  // return current content rather than retaining private notes after deletion.
  type Receipt = { meetingId: string; taskId?: string; revision?: number; version?: number };
  const answer = request.path === '/meetings/notes'
    ? await runRouteCommand<typeof saveMeetingNotesCommandSchema, Receipt>(deps, saveMeetingNotesCommandSchema, 'meeting_notes_save', async (context, body) => {
      const { commandId: _command, clientVersion: _version, ...input } = body;
      const result = await saveMeetingOutcomeCorrections(context, input);
      return result.ok ? { ok: true, value: { meetingId: result.value.meetingId, revision: result.value.revision } } : result;
    })
    : await runRouteCommand<typeof changeMeetingTaskCommandSchema, Receipt>(deps, changeMeetingTaskCommandSchema, 'meeting_task_change', async (context, body) => {
      const { commandId: _command, clientVersion: _version, ...input } = body;
      const result = await changeMeetingTask(context, input);
      return result.ok ? { ok: true, value: { meetingId: result.value.meetingId, taskId: result.value.id, version: result.value.version } } : result;
    });
  if (answer.status !== 200) return answer;
  const envelope = answer.body as { status: string; replayed: boolean; result: Receipt };
  return await withTransaction(auth.db, async () => {
    const receipt = envelope.result;
    if (await lockAnalysisMeeting(scoped.context, receipt.meetingId) === null) return missing;
    const result = receipt.taskId === undefined ? await readCurrentMeetingNotes(scoped.context, receipt.meetingId) : await readMeetingTask(scoped.context, receipt.taskId);
    if (result === null) return missing;
    if (('revision' in result && result.revision !== receipt.revision) || ('version' in result && result.version !== receipt.version)) return { status: 409, body: { status: 'refused', reason: receipt.taskId === undefined ? 'notes_changed' : 'task_changed' } };
    return { status: 200, body: { ...envelope, result } };
  });
}
