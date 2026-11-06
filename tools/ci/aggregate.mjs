// The required `greenfield` check. NEEDS_JSON is the workflow's `needs` context. Success needs every
// prerequisite to have succeeded: failed, cancelled and skipped (including a matrix that never
// started) all refuse, and the plan the machines were built from must itself be valid.
import { pathToFileURL } from 'node:url';
import { parsePlan } from './plan.mjs';

const required = ['plan', 'validate', 'suites'];

/** The reasons this run is not green; empty only when every prerequisite succeeded. */
export function refusals(needsText) {
  let needs;
  try { needs = JSON.parse(needsText ?? ''); } catch { return ['the prerequisite results are unreadable']; }
  if (needs === null || typeof needs !== 'object') return ['the prerequisite results are unreadable'];
  const reasons = required.filter(job => needs[job]?.result !== 'success').map(job => `${job}: ${needs[job]?.result ?? 'missing'}`);
  if (reasons.length === 0) {
    try { parsePlan(needs.plan.outputs?.plan); } catch (error) { reasons.push(`plan: ${error.message}`); }
  }
  return reasons;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reasons = refusals(process.env.NEEDS_JSON);
  if (reasons.length > 0) {
    console.error(`Greenfield gate is not green:\n${reasons.map(reason => `- ${reason}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log('Greenfield gate: plan, validation and every selected suite succeeded');
}
