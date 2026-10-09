import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import type { RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { addSelectedSource, bridgeLegacyContacts, changeSelectedSource, readPerson } from '@fss/domain/crm/people.ts';
import { readAsk } from '@fss/domain/crm/ask.ts';
import { requestAskAnswer, readAskAnswer } from '@fss/domain/crm/askAnswers.ts';
import { listAskHistory, changeAskHistory } from '@fss/domain/crm/askHistory.ts';
import { createAskAction, readAskActions, changeAskAction } from '@fss/domain/crm/askActions.ts';
import type { FixtureHandles } from './fixture.ts';

export const ASK_UPGRADE_WORKFLOW = 'crm.ask lifecycle (runtime domain)';

/**
 * A post-upgrade product flow using the base loader's surviving contact/firm.
 * These are domain commands as app_runtime, not authenticated HTTP or a worker.
 * No provider composition, processing purpose, grant or sending switch is enabled.
 */
export async function runAskUpgradeWorkflow(
  context: RepositoryContext & { db: SessionQueryable },
  handles: FixtureHandles,
): Promise<string> {
  const transact = <Value>(run: () => Promise<Value>): Promise<Value> => withTransaction(context.db, run);
  const bridged = await transact(() => bridgeLegacyContacts(context, [handles.primaryContactId]));
  assert(bridged.ok, 'the surviving base contact must support an explicit person bridge');
  const personId = bridged.value.people[0]?.personId;
  assert.equal(personId, handles.primaryContactId, 'the bridge must preserve the base contact identity');
  assert(personId !== undefined);
  const person = await transact(() => readPerson(context, personId, { limit: 50 }));
  assert.equal(person?.person.firm?.firmId, handles.primaryFirmId, 'the surviving legacy association must name its exact firm');
  assert(person !== null);
  const records = await transact(() => readAsk(context, { operation: 'records', query: person.person.fullName, kind: 'people', limit: 50 }));
  assert(records?.operation === 'records');
  assert(records.records.some(record => record.recordId === personId && record.firmId === handles.primaryFirmId), 'exact record search must return the surviving association');
  const opportunitiesBefore = await transact(() => readAsk(context, { operation: 'opportunities', scope: { firmId: handles.primaryFirmId }, status: 'all', limit: 50 }));
  assert(opportunitiesBefore?.operation === 'opportunities');
  assert(opportunitiesBefore.records.length > 0, 'the base fixture must retain meaningful opportunity data');

  const excerpt = 'Upgrade scheduling evidence requires explicit human review.';
  const added = await transact(() => addSelectedSource(context, {
    personId, sourceKey: `upgrade-ask:${randomUUID()}`, excerpt,
    // A declared synthetic selected-note date, never provider-authored or host time.
    occurredAt: '2000-01-02T12:00:00.000Z',
  }));
  assert(added.ok && added.value.sourceId !== undefined, 'explicit selected-note import must succeed');
  const sourceId = added.value.sourceId;
  const scope = { sources: [{ workspaceId: handles.workspaceId, sourceId, kind: 'selected_note' as const, revision: 1, contentHash: createHash('sha256').update(excerpt).digest('hex'), locator: null }] };
  const keyword = await transact(() => readAsk(context, { operation: 'passages', scope, query: 'scheduling', limit: 20 }));
  assert(keyword?.operation === 'passages');
  assert.equal(keyword.passages.length, 1);
  assert.equal(keyword.passages[0]?.text, excerpt);
  assert.equal(keyword.passages[0]?.sources[0]?.sourceId, sourceId);
  assert.equal(keyword.coverage.semantic, 'not_requested');

  const accepted = await transact(() => requestAskAnswer(context, { commandId: randomUUID(), clientVersion: '1.0.13', question: 'scheduling', scope }));
  assert(accepted.ok);
  assert.deepEqual(Object.keys(accepted.value).sort(), ['requestId', 'state', 'version'], 'request acceptance must be metadata only');
  assert.equal(accepted.value.state, 'unavailable', 'this fixture must not acquire answering authority');
  const requestId = accepted.value.requestId;
  const current = await transact(() => readAskAnswer(context, requestId));
  assert.equal(current?.reason, 'purpose_unavailable');
  assert.equal(current?.answer, null);
  assert.equal(current?.fallback?.passages[0]?.text, excerpt, 'disabled answering must retain current same-scope keyword evidence');
  const history = await listAskHistory(context, { limit: 50 });
  const investigation = history?.items.find(item => item.requestId === requestId);
  assert(investigation !== undefined, 'the same request must be autosaved without inference replay');
  assert.equal(investigation.question, 'scheduling');
  assert.equal(investigation.title, null, 'initial autosave must not invent a private title');

  const command = { requestId, expectedVersion: accepted.value.version, finding: { kind: 'keyword_passage' as const, index: 0 }, clientVersion: '1.0.13' };
  const note = await transact(() => createAskAction(context, { ...command, commandId: randomUUID(), action: { kind: 'note', text: 'Discuss the scheduling review.', target: { kind: 'person', personId } } }));
  assert(note.ok);
  const task = await transact(() => createAskAction(context, { ...command, commandId: randomUUID(), action: { kind: 'task', label: 'Review scheduling options', due: { kind: 'date', date: '2000-01-01', zone: 'UTC', expression: 'January 1, 2000' }, target: { kind: 'person', personId } } }));
  assert(task.ok);
  const tasks = await readAskActions(context, { scope: { kind: 'today' }, limit: 50 });
  assert(tasks?.items.some(item => item.actionId === task.value.actionId && item.label === 'Review scheduling options' && item.provenance === 'human'), 'dated human work must be visible independently of promises');
  const completed = await transact(() => changeAskAction(context, { commandId: randomUUID(), clientVersion: '1.0.13', actionId: task.value.actionId, expectedVersion: task.value.version, action: 'complete_task' }));
  assert(completed.ok && completed.value.completedAt !== null);
  assert.equal(completed.value.status, 'done');
  assert.equal(completed.value.version, 2);

  const deleted = await transact(() => changeAskHistory(context, { commandId: randomUUID(), clientVersion: '1.0.13', requestId, expectedRevision: investigation.historyRevision, action: { kind: 'delete' } }));
  assert(deleted.ok && deleted.value.state === 'deleted');
  const deletedRead = await transact(() => readAskAnswer(context, requestId));
  assert.equal(deletedRead?.question, null);
  assert.equal(deletedRead?.fallback, null);
  assert.equal(deletedRead?.answer, null);
  const retained = await readAskActions(context, { scope: { kind: 'person', personId }, limit: 50 });
  assert.equal(retained?.items.find(item => item.actionId === note.value.actionId)?.text, 'Discuss the scheduling review.');
  assert.equal(retained?.items.find(item => item.actionId === task.value.actionId)?.completedAt, completed.value.completedAt);

  const erased = await transact(() => changeSelectedSource(context, { personId, sourceId, expectedRevision: 1 }, 'delete'));
  assert(erased.ok && erased.value.revision === 2);
  const redacted = await readAskActions(context, { scope: { kind: 'history' }, limit: 50 });
  for (const id of [note.value.actionId, task.value.actionId]) {
    const item = redacted?.items.find(candidate => candidate.actionId === id);
    assert(item !== undefined);
    assert.equal(item.supportState, 'deleted');
    assert.deepEqual([item.text, item.label, item.due, item.target], [null, null, null, null]);
    assert.deepEqual(item.sources, []);
  }
  const completedFact = redacted?.items.find(item => item.actionId === task.value.actionId);
  assert.equal(completedFact?.status, 'done');
  assert.equal(completedFact?.completedAt, completed.value.completedAt, 'source-free completed history must preserve its actual recorded date');
  const opportunitiesAfter = await transact(() => readAsk(context, { operation: 'opportunities', scope: { firmId: handles.primaryFirmId }, status: 'all', limit: 50 }));
  assert.deepEqual(opportunitiesAfter, opportunitiesBefore, 'human Ask work must not create or advance commercial initiatives');
  return 'surviving legacy firm/person; exact and keyword reads; metadata-only disabled request; same-request private history; explicit human note/task; recorded completion survives history and source erasure; no provider or sending operation';
}
