import { describe, expect, it } from 'vitest';
import {
  HandlerRegistry,
  HandlerRegistryError,
  JOB_CLASSES,
  JOB_KIND_CLASS,
  type JobHandler,
} from '../../jobs/handlerRegistry.ts';
import { JOB_KINDS, jobClassOf, kindsOfClass } from '../../jobs/jobKinds.ts';

/**
 * Every kind runs in a lane, and a kind that does not is a kind no runner slot ever
 * claims — a job that is enqueued, indexed, runnable, and invisible. The compiler
 * catches the omission where it can; these tests catch it where it cannot.
 */

function handlerFor(kind: string): JobHandler {
  return {
    kind,
    protection: 'business_uniqueness',
    maxAttempts: 4,
    leaseSeconds: 30,
    handle: async () => {},
  } as unknown as JobHandler;
}

describe('job kind classes', () => {
  it('classifies every kind of Appendix C', () => {
    for (const kind of JOB_KINDS) {
      expect(jobClassOf(kind), `${kind} has no job class`).toBeDefined();
      expect(JOB_CLASSES).toContain(JOB_KIND_CLASS[kind]);
    }
    expect([...kindsOfClass('urgent'), ...kindsOfClass('bulk')].sort()).toEqual([...JOB_KINDS].sort());
  });

  it('puts the work a person waits on in urgent and the rest in bulk', () => {
    expect(kindsOfClass('urgent')).toEqual([
      'mail.sync',
      'mail.reconcile',
      'mail.recover',
      'mail.watch_renew',
      'today.build',
      'suppression.finalize',
      'classify.reply',
      'outbound.close_send_day',
      'canary',
      // Call-to-booking: an abandoned session's reservation holds the day's budget.
      'telephony.sweep',
    ]);
    expect(kindsOfClass('bulk')).toEqual([
      'sequence.action',
      'sequence.terminal_stop',
      'retention.batch',
      'route.validate',
      // Lane R: a page fetch and a sweep. Nobody is watching the clock on either, and
      // an import of two hundred firms is two hundred of the first.
      'research.firm',
      'research.sweep',
      // Slice M1: the hourly repair of a lost Cal.com webhook.
      'calcom.reconcile',
      // Slice C2: a call's transcript, read later on the firm page.
      'call.transcribe',
      'meeting.transcribe',
      'meeting.analyze',
      // Slice C3b: its summary, read with it.
      'call.summarize',
      // Slice 3a: its analysis, which replaces the summary for a new call.
      'call.analyze',
      // And the sweep that resumes held analyses after a settings write.
      'call.analyze_sweep',
    ]);
  });

  it('refuses to register a handler whose kind has no class, and names the kind', () => {
    // The lane table with one row missing: the shape of a future kind somebody added to
    // `JOB_KINDS` and forgot to classify, arriving at a process that is starting up.
    const registry = new HandlerRegistry({ classOf: kind => (kind === 'canary' ? undefined : jobClassOf(kind)) });
    expect(() => registry.register(handlerFor('canary'))).toThrowError(
      expect.objectContaining({ name: 'HandlerRegistryError', message: expect.stringContaining('canary') }),
    );
    try {
      registry.register(handlerFor('canary'));
      expect.unreachable('an unclassified kind was registered');
    } catch (error) {
      expect(error).toBeInstanceOf(HandlerRegistryError);
      expect((error as HandlerRegistryError).code).toBe('CLASS_MISSING');
    }
    // And the classified kinds still register, so the refusal is the kind's, not the table's.
    expect(registry.register(handlerFor('mail.sync')).kinds()).toEqual(['mail.sync']);
  });

  it('reports the registered kinds of each lane', () => {
    const registry = new HandlerRegistry();
    registry.register(handlerFor('mail.sync')).register(handlerFor('retention.batch'));
    expect(registry.classOf('mail.sync')).toBe('urgent');
    expect(registry.classes()).toEqual({ urgent: ['mail.sync'], bulk: ['retention.batch'] });
  });
});
