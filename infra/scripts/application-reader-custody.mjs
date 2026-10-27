const runId = /^[1-9][0-9]{0,19}$/u;
const taskArn = /^arn:aws:ecs:us-east-1:326255650484:task\/fss-prod-cluster\/[0-9a-f]{32}$/u;
const definitionArn = /^arn:aws:ecs:us-east-1:326255650484:task-definition\/fss-prod-operations:([1-9][0-9]{0,9})$/u;
const owner = /^fss-app-([1-9][0-9]{0,19})-off-([1-9][0-9]{0,9})$/u;
const keys = ['readerDefinitionArn', 'sourceOperationsDefinitionArn', 'startedBy', 'taskArn'];
const invalid = () => { throw new Error('failed_reader_custody_invalid'); };

// Input identity is not cleanup authority. Live custody and terminal-state proof
// must succeed inside the protected application job before any recovery write.
export function parseFailedReaderCustody(value, currentRunId) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096 || !runId.test(currentRunId || '')) return invalid();
  let parsed;
  try { parsed = JSON.parse(value); } catch { return invalid(); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' ||
      Object.keys(parsed).sort().join(',') !== keys.join(',') ||
      Object.values(parsed).some(item => typeof item !== 'string')) return invalid();
  const reader = definitionArn.exec(parsed.readerDefinitionArn);
  const source = definitionArn.exec(parsed.sourceOperationsDefinitionArn);
  const prior = owner.exec(parsed.startedBy);
  if (!taskArn.test(parsed.taskArn) || !reader || !source || !prior ||
      prior[1] === currentRunId || Number(source[1]) >= Number(reader[1])) return invalid();
  return Object.freeze({ ...parsed, failedRunId: prior[1] });
}
