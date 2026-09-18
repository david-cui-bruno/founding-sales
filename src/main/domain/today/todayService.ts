import { z } from 'zod';
import { listDelegatedActualCallAccountIds } from './todayActualCallEvidence';

import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import { DomainRepositoryDatabaseMismatchError, PrioritizationInputCorruptionError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { OutboundPermissionService } from '../optOut/outboundPermissionService';
import type { PrioritizationService } from '../prioritization/prioritizationService';
import type { ChannelPolicySnapshots } from '../cadence/cadenceScheduler';
import type {
  EffectivePrioritySnapshot,
} from '../prioritization/prioritizationTypes';
import type { AccountEvidenceSnapshot } from '../../../shared/contracts/accountContract';
import { listActualCallAttempts } from '../accounts/accountOutreach';
import { rankAccount } from '../../../shared/accounts/accountRanking';
import type { WorkspaceSettingsRepository } from '../workspace/workspaceSettingsRepository';
import { isBusinessWindowOpen, morningEvidenceScore, orderMorningCalls, planDailyAccountCalls, planTodayQueue, resolveLocalDayInterval } from './todayOrdering';
import type { DailyAccountCallPlan, MorningCallCandidate } from './todayOrdering';
import { readRouteJurisdictionTimezones } from './routeJurisdiction';
import { PLAYBOOK_CHANNEL_POLICIES_V2 } from '../cadence/cadenceScheduler';
import type { TodayRepository } from './todayRepository';
import type {
  ParsedTodayCandidate,
  TodayCapacity,
  TodayDiagnostic,
  TodayQueue,
} from './todayTypes';

const utcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
);

/**
 * Read-only Today service. Reads its Clock once, executes one synchronous
 * deferred read transaction, and passes plain parsed data to planTodayQueue.
 * It never writes, consumes IDs, changes pragmas, or opens a nested/immediate
 * transaction.
 */
export class TodayService {
  private readonly database: AppDatabase;
  private readonly unitOfWork: DomainUnitOfWork;
  private readonly clock: Clock;
  private readonly repository: TodayRepository;
  private readonly priorities: PrioritizationService;
  private readonly outboundPermission: OutboundPermissionService;
  private readonly workspaceSettings: WorkspaceSettingsRepository | null;
  private readonly actualCalls: typeof listActualCallAttempts;
  private readonly routeTimezones: typeof readRouteJurisdictionTimezones;

  constructor(input: {
    database: AppDatabase;
    unitOfWork: DomainUnitOfWork;
    clock: Clock;
    repository: TodayRepository;
    priorities: PrioritizationService;
    outboundPermission: OutboundPermissionService;
    workspaceSettings?: WorkspaceSettingsRepository;
    actualCalls?: typeof listActualCallAttempts;
    routeTimezones?: typeof readRouteJurisdictionTimezones;
  }) {
    input.repository.assertBoundTo(input.database, input.unitOfWork);
    input.outboundPermission.assertBoundTo(input.database, input.unitOfWork);
    this.database = input.database;
    this.unitOfWork = input.unitOfWork;
    this.clock = input.clock;
    this.repository = input.repository;
    this.priorities = input.priorities;
    this.outboundPermission = input.outboundPermission;
    this.workspaceSettings = input.workspaceSettings ?? null;
    this.actualCalls = input.actualCalls ?? listActualCallAttempts;
    this.routeTimezones = input.routeTimezones ?? readRouteJurisdictionTimezones;
  }

  build(input: {
    timezone: string;
    capacity: TodayCapacity;
    channelPolicies: ChannelPolicySnapshots;
  }): TodayQueue {
    validateChannelPolicies(input.channelPolicies);
    if (this.database.raw.inTransaction) {
      throw new PrioritizationInputCorruptionError(
        'Today rejects an already-active raw transaction.',
      );
    }
    const generatedAt = utcTimestampSchema.parse(this.clock.now());
    resolveLocalDayInterval({ generatedAt, timezone: input.timezone });
    this.database.raw.exec('BEGIN');
    try {
      return this.buildInCurrentSnapshot({ ...input, generatedAt });
    } finally {
      this.database.raw.exec('ROLLBACK');
    }
  }

  planMeetingFirstAccountCalls(input: {
    due: readonly AccountEvidenceSnapshot[];
    ranked: readonly AccountEvidenceSnapshot[];
    generatedAt?: string;
  }): DailyAccountCallPlan {
    if (this.workspaceSettings === null) {
      return planDailyAccountCalls({
        due: input.due.map(snapshot => snapshot.account.id),
        ranked: [],
        newCallSlots: 0,
        completedAccountIds: [],
        totalCallCapacity: null,
      });
    }
    const generatedAt = utcTimestampSchema.parse(input.generatedAt ?? this.clock.now());
    const workspaceTimezone = this.workspaceSettings.read().timezone;
    const interval = resolveLocalDayInterval({ generatedAt, timezone: workspaceTimezone });
    // Unconfigured settings mean the default allocation (30 new firms a morning), never zero.
    const allocation = this.workspaceSettings.readAccountCallAllocation();
    const everyAccount = [...input.due, ...input.ranked];
    const completedAccountIds = [...this.actualCalls(this.database, {
      from: interval.localDayStartAt,
      to: interval.localDayEndAt,
    }).map(attempt => attempt.accountId), ...listDelegatedActualCallAccountIds(this.database, {
      accountIds: [...new Set(everyAccount.map(snapshot => snapshot.account.id))],
      from: interval.localDayStartAt, to: interval.localDayEndAt, generatedAt,
    })];
    // Order inside each group (D2): local business window open now, then evidence richness, then name.
    // The firm's zone comes from its route policy receipt when the clearance lane wrote one; else the workspace zone.
    const zones = this.routeTimezones(this.database, everyAccount.map(snapshot => snapshot.account.id));
    const candidate = (snapshot: AccountEvidenceSnapshot): MorningCallCandidate => ({
      accountId: snapshot.account.id,
      windowOpen: isBusinessWindowOpen({ generatedAt, timezone: zones.get(snapshot.account.id) ?? workspaceTimezone, windows: PLAYBOOK_CHANNEL_POLICIES_V2.call.windows }),
      evidenceScore: morningEvidenceScore(snapshot),
      name: snapshot.account.name,
    });
    const nominated = new Set(input.ranked
      // New call nominations need a phone the firm publishes, confirms, or lists in a business directory.
      .filter(snapshot => snapshot.routes.some(route => route.channel === 'phone'
        && route.purpose === 'business'
        && (route.verification === 'published' || route.verification === 'confirmed' || route.verification === 'listed')))
      .map(snapshot => rankAccount(snapshot, generatedAt))
      // Places already selects property managers, so `uncertain` fit is listed; only an explicit not_target is excluded.
      .filter(rank => rank.fit !== 'not_target' && rank.contactable)
      .map(rank => rank.accountId));
    return planDailyAccountCalls({
      due: orderMorningCalls(input.due.map(candidate)),
      ranked: orderMorningCalls(input.ranked.filter(snapshot => nominated.has(snapshot.account.id)).map(candidate)),
      newCallSlots: allocation.newCallSlots,
      completedAccountIds,
      totalCallCapacity: allocation.totalCallCapacity,
    });
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork): void {
    if (this.database !== database || this.unitOfWork !== unitOfWork) throw new DomainRepositoryDatabaseMismatchError();
  }

  /** Caller owns the existing snapshot. No Clock read or transaction boundary. */
  buildInCurrentSnapshot(input: {
    timezone: string;
    capacity: TodayCapacity;
    channelPolicies: ChannelPolicySnapshots;
    generatedAt: string;
  }): TodayQueue {
    if (!this.database.raw.inTransaction) {
      throw new PrioritizationInputCorruptionError('Today requires an active read snapshot.');
    }
    validateChannelPolicies(input.channelPolicies);
    const generatedAt = utcTimestampSchema.parse(input.generatedAt);
    const interval = resolveLocalDayInterval({ generatedAt, timezone: input.timezone });
    const loadResults = this.repository.listOperationalCandidates();
    const usage = this.repository.loadCompletedDiscretionaryDialUsage({
      dayStartAt: interval.localDayStartAt,
      dayEndAt: interval.localDayEndAt,
      timezone: input.timezone,
      localDate: interval.localDate,
    });
    const diagnostics: TodayDiagnostic[] = usage.diagnostics.map((entry): TodayDiagnostic => ({
      cycleId: entry.cycleId,
      personId: null,
      kind: entry.kind,
      relatedIds: [entry.activityId],
    }));
    const candidates: ParsedTodayCandidate[] = [];
    let unreviewedBacklogCount = 0;
    for (const result of loadResults) {
      if (result.kind === 'diagnostic') {
        diagnostics.push(result.diagnostic);
        continue;
      }
      if (result.kind === 'unreviewed_backlog') {
        unreviewedBacklogCount += 1;
        continue;
      }
      if (result.candidate.stage === 'unreviewed') {
        unreviewedBacklogCount += 1;
        // Raw cold/hot discovery records are research backlog, not founder
        // review homework. Real warm introductions are contact-first work.
        if (result.candidate.segment !== 'warm') continue;
      }
      const enriched = this.enrichCandidate(result.candidate, generatedAt, interval);
      if (enriched.kind === 'diagnostic') {
        diagnostics.push(enriched.diagnostic);
        continue;
      }
      candidates.push(enriched.candidate);
    }
    return planTodayQueue({
      candidates,
      hasActiveWarm: this.repository.hasActiveWarm(),
      generatedAt,
      timezone: input.timezone,
      capacity: input.capacity,
      completedDiscretionaryDialCount: usage.count,
      unreviewedBacklogCount,
      extraDiagnostics: diagnostics,
    });
  }

  private enrichCandidate(
    candidate: ParsedTodayCandidate,
    generatedAt: string,
    interval: { localDate: string; localDayStartAt: string; localDayEndAt: string },
  ):
    | { kind: 'candidate'; candidate: ParsedTodayCandidate }
    | { kind: 'diagnostic'; diagnostic: TodayDiagnostic } {
    // Task 10 permission first; a blocked person yields only a sanitized diagnostic.
    const permission = this.outboundPermission.inspectPerson(candidate.personId);
    if (permission.kind === 'blocked') {
      return {
        kind: 'diagnostic',
        diagnostic: {
          cycleId: candidate.cycleId,
          personId: candidate.personId,
          kind: 'outbound_permission_blocked',
          relatedIds: [...permission.tombstoneIds],
        },
      };
    }
    if (candidate.segment === 'warm' && candidate.action.workIntent === 'internal_review') {
      // Warm membership/ordering never consumes a priority projection. Keep
      // the permission gate, but do not collect expensive unused inputs.
      return { kind: 'candidate', candidate };
    }
    let snapshot: EffectivePrioritySnapshot | null = null;
    let priorityState: ParsedTodayCandidate['priorityState'] = 'missing';
    const inlineDiagnostics: ParsedTodayCandidate['inlineDiagnostics'][number][] = [];
    try {
      snapshot = this.priorities.getEffectivePrioritySnapshot({
        prospectId: candidate.prospectId,
        asOf: generatedAt,
      });
      if (snapshot.prospectId !== candidate.prospectId
        || (snapshot.lastContactActivityId === null) !== (snapshot.lastContactAt === null)) {
        snapshot = null;
        priorityState = 'corrupt';
      } else {
        // A discretionary projection must be evaluated in the same founder-local day.
        const evaluatedInDay = snapshot.evaluatedAt >= interval.localDayStartAt
          && snapshot.evaluatedAt < interval.localDayEndAt;
        priorityState = evaluatedInDay ? 'current' : 'stale';
        if (!evaluatedInDay) inlineDiagnostics.push('stale_priority_projection');
      }
    } catch {
      snapshot = null;
      priorityState = 'missing';
      inlineDiagnostics.push('missing_priority_projection');
    }
    const selectedTriggerReasons = snapshot === null
      ? []
      : snapshot.explanation.filter(
        (reason) => reason.kind === 'trigger' && reason.selected,
      );
    return {
      kind: 'candidate',
      candidate: {
        ...candidate,
        priority: snapshot,
        priorityState: priorityState === 'stale' && snapshot !== null
          ? 'stale'
          : snapshot === null ? priorityState : 'current',
        selectedTriggerReasons,
        verifyFirst: snapshot?.verifyFirst ?? null,
        inlineDiagnostics,
      },
    };
  }
}

function validateChannelPolicies(policies: ChannelPolicySnapshots): void {
  for (const channel of ['call', 'text', 'email'] as const) {
    const policy = policies[channel];
    if (typeof policy?.id !== 'string' || policy.id.trim().length === 0
      || !Array.isArray(policy.windows) || policy.windows.length === 0) {
      throw new PrioritizationInputCorruptionError(
        `Channel policy snapshot for ${channel} is malformed.`,
      );
    }
  }
}
