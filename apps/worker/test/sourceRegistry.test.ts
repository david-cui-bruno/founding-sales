import { describe, expect, it } from 'vitest';
import { JOB_KINDS, JOB_KIND_PROTECTION } from '@fss/domain/jobs/jobKinds.ts';
import { workerDueWorkSources } from '../src/bootstrap/main.ts';

describe('worker source and protection invariants', () => {

  it('registers every source under a distinct name, because the report is keyed by it', () => {
    const names = workerDueWorkSources().map(source => source.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('protects every job kind, so a kind cannot be added without saying how (13.2)', () => {
    // The registry refuses a handler whose declared protection disagrees with
    // `JOB_KIND_PROTECTION`, which only helps if the table has an entry at all.
    for (const kind of JOB_KINDS) expect(JOB_KIND_PROTECTION[kind], kind).toBeDefined();
    expect(Object.keys(JOB_KIND_PROTECTION).sort()).toEqual([...JOB_KINDS].sort());
  });
});
