import {todayActionOpenV2RequestSchema,todayActionsV2ResponseSchema,todayActionOpenV2ResponseSchema} from '@fss/contracts';
import {readTodayActionsV2,openTodayActionV2} from '@fss/domain/today/actionsV2.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import { todayActionOpenRequestSchema } from '@fss/contracts';
import { readTodayActions, openTodayAction } from '@fss/domain/today/actions.ts';
import { TODAY_CARD_VERSION, completeCallTaskCommandSchema, todayFirmRequestSchema } from '@fss/contracts';
import { completeCallTask } from '@fss/domain/calls/callTasks.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { readCallsPlacedToday } from '@fss/domain/today/callsPlaced.ts';
import { readTodayFirm, readTodayList, todayFirmVersion1 } from '@fss/domain/today/dto.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { policyRouteDeps, runPolicyCommand } from './dialSupport.ts';
import { contextForPrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The Today list (specification 8.2, 14.1).
 *
 * The exact paths this module owns, for G5b's route registry. Exact rather than a
 * `/today` prefix, which is what every new endpoint should be: the registry refuses
 * two claims on one path, and that guarantee is only as sharp as the claim.
 *
 * `GET /today` is a GET and the expansion is a POST, which looks inconsistent and is
 * not. `docs/decisions/g3b-reads-are-posts.md` puts a read in a POST when the *request*
 * would otherwise carry a prospect's name, number or address through a load-balancer
 * access log. The list request carries nothing at all: the caller is the session and
 * the date is the server's. The expansion carries a firm id, which is not personal
 * data either — it is a POST for the reason G3b gave `/crm/firm-page`, that a rule
 * which applies to some of a family is a rule somebody gets wrong on the rest.
 *
 * `GET /today/calls-placed` is the third, added 29 September 2026: how many calls were
 * placed on the workspace's own business date, which is the number a person working a
 * call list wants in front of them and not the seven-day figure beside it. A GET for the
 * same reason as the list — the request carries nothing at all, because the caller is the
 * session and the date is the server's.
 *
 * No route here decides who may see what. `readTodayList` and `readCallsPlacedToday` do,
 * from the scope's own role, because 8.2's "Admins see all entries; salespeople see their
 * own" is a property of the read and not of the transport.
 */
export const TODAY_PATHS: readonly string[] = ['/today', '/today/firm', '/today/calls-placed', '/today/tasks/complete', '/today/actions', '/today/actions/open', '/today/actions/v2', '/today/actions/open/v2'];

/**
 * Slice 3a: `GET /today?include=tasks` (repeated or comma-separated; an unknown value is
 * ignored) asks for call tasks, kind `task`. Without it a task is in no card, count or
 * expansion, because an installed desktop's contract has no such kind. `POST /today/firm`
 * negotiates the same with `include: ['tasks']` in its body. `POST /today/tasks/complete
 * {taskId}` marks one done (`calls/callTasks.ts`), a command with a receipt.
 */
function includesTasks(query: URLSearchParams, capability = 'tasks'): boolean {
  return query.getAll('include').some(value => value.split(',').some(part => part.trim() === capability));
}

/*
 * `cardVersion: 2` (`todayFirmRequestSchema` in `@fss/contracts`) asks for the tasks
 * with their identities: the callback, the step execution, the call that needs a
 * callback time, and the pause. Without it the card is the first shape exactly,
 * because an older desktop parses the card with a strict schema and
 * would refuse a field it has never heard of.
 */

export async function routeToday(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!request.path.startsWith('/today')) return null;
  // `/today/snooze` and `/today/pause/release` are the snooze module's; the registry
  // routes them there and this guard keeps the direct caller honest.
  if (!TODAY_PATHS.includes(request.path)) return null;

  const prepared = await policyRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  const context = scoped.context;

  if(request.path==='/today/actions/v2'){
    if(request.method!=='GET')return {status:405,body:redactError('method_not_allowed')};
    const result=await withTransaction(deps.auth.db,async()=>readTodayActionsV2(context,{now:await databaseNow(context)}));
    return result===null?{status:404,body:redactError('not_found')}:{status:200,body:todayActionsV2ResponseSchema.parse(result)};
  }
  if(request.path==='/today/actions/open/v2'){
    if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
    const parsed=todayActionOpenV2RequestSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
    const result=await withTransaction(deps.auth.db,async()=>openTodayActionV2(context,{...parsed.data,now:await databaseNow(context)}));
    return result===null?{status:404,body:redactError('not_found')}:{status:200,body:todayActionOpenV2ResponseSchema.parse(result)};
  }
  if (request.path === '/today/actions') {
    if (request.method !== 'GET') return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    return { status: 200, body: await readTodayActions(context, { now: await databaseNow(context) }) };
  }
  if (request.path === '/today/actions/open') {
    if (request.method !== 'POST') return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    const parsed = todayActionOpenRequestSchema.safeParse(request.body);
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    return { status: 200, body: await openTodayAction(context, { ...parsed.data, now: await databaseNow(context) }) };
  }
  if (request.path === '/today') {
    if (request.method !== 'GET') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    // Database time, so the business date the Mac caches is the one the 05:00 job
    // built and not the one this task's clock believes in (Appendix D).
    return {
      status: 200,
      body: await readTodayList(context, { now: await databaseNow(context), includeTasks: includesTasks(request.query), includeMeetingTasks: includesTasks(request.query, 'meeting_tasks'), ...(request.query?.get('paged')==='true'?{paged:true,cursor:request.query.get('cursor')??''}:{}) }),
    };
  }

  if (request.path === '/today/calls-placed') {
    if (request.method !== 'GET') {
      return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
    }
    // Database time again: the boundary between one business date and the next is the
    // database's clock in the workspace's zone, not this task's.
    return { status: 200, body: await readCallsPlacedToday(context, { now: await databaseNow(context) }) };
  }

  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }
  if (request.path === '/today/tasks/complete') {
    return await runPolicyCommand(deps, completeCallTaskCommandSchema, 'today_task_complete', async (commandContext, body) =>
      await completeCallTask(commandContext, { taskId: body.taskId }),
    );
  }
  const parsed = todayFirmRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };

  const page = await readTodayFirm(context, {
    firmId: parsed.data.firmId,
    now: await databaseNow(context),
    includeTasks: parsed.data.include?.includes('tasks') === true,
    includeMeetingTasks: parsed.data.cardVersion === 2 && parsed.data.include?.includes('meeting_tasks') === true,
    // Lane PB (migration 0038): the prepared brief, negotiated like the tasks.
    includePreparedBrief: parsed.data.include?.includes('preparedBrief') === true,
  });
  // A firm with no card today and a colleague's firm are the same answer on purpose:
  // telling a salesperson that somebody else's firm has work on it is a read Appendix
  // F's first row does not grant.
  if (page === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  return { status: 200, body: parsed.data.cardVersion === TODAY_CARD_VERSION ? page : todayFirmVersion1(page) };
}
