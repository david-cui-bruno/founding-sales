# Founder Workflow UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete founder-facing workflow UI—luxury adaptive shell, Leads grid, global right inspector, Today, Pipeline, Review, Friday scoreboard, manual jobs/fill rate, and atomic import—on top of the encrypted local founder-sales domain.

**Architecture:** The renderer is a typed projection client: feature routes receive narrow preload APIs, render strict DTOs, and never contain lifecycle, cadence, prioritization, or metric rules. Each feature owns its strict Zod contract, main-process provider/IPC registrar, preload API factory, renderer route, styles, and focused tests; one final composition task exclusively owns the central startup, preload, global declarations, root App, and CSS aggregation files. The plan begins only after the encrypted domain foundation exposes transactional use cases and a lazy `withDomain` runtime boundary.

**Tech Stack:** Electron 44, React 19, TypeScript 5.9, Vite 5, Zod 4 strict schemas, SQLite/SQLCipher domain foundation, TanStack Table, TanStack Virtual, Papa Parse, Lucide React, Vitest 2, React Testing Library, Playwright 1.62, axe-core Playwright.

**Spec:** `docs/superpowers/specs/2026-08-30-founder-sales-system-v1-design.md`

## Global Constraints

- Execution gate: begin only after the encrypted domain-foundation implementation exports `FounderSalesDomain` and `FoundationRuntime.withDomain<TResult>(operation: (domain: FounderSalesDomain) => TResult | Promise<TResult>): Promise<TResult>`; if either is absent, stop rather than bypassing the domain with renderer fixtures or direct SQL.
- Target macOS 26.4 or newer on Apple silicon; keep Electron `44.0.0` and Node `^22.13.0 || >=24.0.0`.
- Preserve `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, the `callie://` production renderer, sender validation, restrictive CSP, and narrow contextBridge APIs.
- Fit and Timing stay separate. No contract, column, sort key, label, variable, fixture, or test may introduce a single, 0–100, weighted, blended, or hidden equivalent lead score.
- The only allowed prioritization fields in renderer DTOs are `fitPoints` (0–30), `fitBand`, `timingValue` (0–40), `timingBand`, `priority` (P0–P3), `reachability`, `dataConfidence`, and explicit reason/tie-break fields.
- The lifecycle is fixed: `Unreviewed -> Ready -> Contacted -> Interviewed -> Offered -> Won`, with `Lost-Nurture`; do not add custom-stage UI or arbitrary drag-to-transition behavior.
- All feature contract objects use `z.object(...).strict()`. Preload validates requests before invoke and responses after invoke; main validates requests and responses again.
- Renderer feature components never import Electron, database modules, repositories, or `window.callie`; only route containers receive a typed API prop from the final composition owner.
- Every command goes through the encrypted domain use case and returns a `MutationReceipt`; renderer code refetches projections instead of recreating business rules.
- Use semantic HTML, visible focus, keyboard operation, reduced-motion support, AA contrast, and accessible names on icon-only controls.
- Ordinary table cells are neutral. Aurora is reserved for navigation, focus, selection, P0 urgency, active recording, and meaningful state changes.
- Existing health failure/retry behavior remains available; raw database paths or internal exceptions never enter workflow error screens.
- Feature tasks must not edit `src/main/startApplication.ts`, `src/preload.ts`, `src/shared/preload.d.ts`, `src/renderer/App.tsx`, `src/renderer/app.css`, `src/main/createWindow.ts`, `package.json`, or `package-lock.json`; Task 1 owns dependencies and Task 11 exclusively owns the other central files.
- Run tests against temporary profiles/databases only; never use the founder's normal `~/Library/Application Support/Callie Founder Sales System` data.

---

## File and ownership map

| Unit | Responsibility | Exclusive owner |
|---|---|---|
| `src/shared/contracts/*` | Strict renderer/main DTO schemas | Corresponding feature task |
| `src/main/ipc/registerValidatedIpc.ts` | Sender/request/response validation helper | Task 1 |
| `src/preload/ipcClient.ts` | Request/response-validating invoke helper | Task 1 |
| `src/renderer/design/*`, `src/renderer/components/*`, `src/renderer/app/*` | Tokens, primitives, route-independent shell | Task 2 |
| `src/main/<feature>/*`, `src/preload/apis/<feature>Api.ts`, `src/renderer/features/<feature>/*` | One complete workflow feature slice | Tasks 3–10 |
| `src/main/startApplication.ts`, `src/preload.ts`, `src/shared/preload.d.ts`, `src/renderer/App.tsx`, `src/renderer/app.css`, `src/main/createWindow.ts` | Central composition only | Task 11 |
| `tests/e2e/*`, packaged fixtures, accessibility scan | Cross-feature packaged verification | Task 12 |

Feature IPC providers use this shape and delegate to the encrypted prerequisite domain in Task 11:

```ts
export type MutationReceipt = {
  revision: number;
  affectedPersonIds: string[];
  affectedSalesCycleIds: string[];
};

export type LeadsProvider = {
  list(input: LeadsListRequest): Promise<LeadsListResponse>;
  updateField(input: LeadFieldUpdateRequest): Promise<MutationReceipt>;
};
```

The provider is deliberately an interface, not a repository. Main IPC registrars receive it through dependency injection; the final composition delegates each exact method through the runtime—for example, `list: (input) => runtime.withDomain((domain) => domain.listLeadRows(input))`.

Before Task 1 begins, the prerequisite `FounderSalesDomain` must expose these exact UI-facing transactional/query methods; their request/response types are the strict feature contracts defined in Tasks 3–9:

```ts
type FounderWorkflowUiDomain = Pick<FounderSalesDomain,
  | 'listLeadRows' | 'updateLeadField' | 'bulkUpdateLeads'
  | 'getLeadDetail' | 'beginOutbound' | 'confirmTransition'
  | 'getToday' | 'completePrimaryAction' | 'snoozePrimaryAction' | 'pinWithinLane' | 'logPastActivity'
  | 'getPipelineProjection'
  | 'listReviewItems' | 'resolveReviewItem'
  | 'getFridayReport' | 'getMetricDrilldown' | 'createJobRequest' | 'markJobFilled' | 'cancelJobRequest'
  | 'previewLeadImport' | 'remapLeadImport' | 'commitLeadImport' | 'getImportJob'
>;
```

If the encrypted foundation intentionally uses different names, align that foundation interface and its tests before executing this plan; do not add a second business-rule path in IPC or renderer code.

### Task 1: Shared validated IPC client and strict workflow primitives

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/shared/contracts/commonContract.ts`
- Create: `src/main/ipc/registerValidatedIpc.ts`
- Create: `src/preload/ipcClient.ts`
- Test: `tests/shared/commonContract.test.ts`
- Test: `tests/main/registerValidatedIpc.test.ts`
- Test: `tests/integration/ipcClient.test.ts`
- Create: `tests/fixtures/registeredIpcHandler.ts`

**Interfaces:**
- Consumes: existing `validateSender(event, isTrustedRendererUrl?)` from `src/main/ipc/validateSender.ts`.
- Produces: `personIdSchema`, `salesCycleIdSchema`, `lifecycleStageSchema`, `prioritySchema`, `fitBandSchema`, `timingBandSchema`, `reachabilitySchema`, `primaryActionSchema`, `mutationReceiptSchema`, `MutationReceipt`, `registerValidatedIpc()`, and `createIpcClient()`.

- [ ] **Step 1: Install the centrally owned UI/test dependencies**

Run:

```bash
npm install @tanstack/react-table@^8 @tanstack/react-virtual@^3 papaparse@^5 lucide-react@^0.468
npm install --save-dev @types/papaparse@^5 @axe-core/playwright@^4
```

Expected: `package.json` and `package-lock.json` change once; npm exits `0` without changing Electron, React, TypeScript, Vitest, or Playwright major versions.

- [ ] **Step 2: Write failing strict-contract and IPC tests**

```ts
// tests/shared/commonContract.test.ts
import { describe, expect, it } from 'vitest';
import { leadPriorityContextSchema, mutationReceiptSchema } from '../../src/shared/contracts/commonContract';

describe('workflow common contracts', () => {
  it('accepts separate Fit and Timing fields', () => {
    expect(leadPriorityContextSchema.parse({
      priority: 'P0', fitPoints: 24, fitBand: 'high', timingValue: 31,
      timingBand: 'hot', reachability: 'direct', dataConfidence: 8,
    })).toMatchObject({ priority: 'P0', fitPoints: 24, timingValue: 31 });
  });

  it.each(['score', 'leadScore', 'weightedScore'])('rejects forbidden %s', (key) => {
    expect(() => leadPriorityContextSchema.parse({
      priority: 'P1', fitPoints: 18, fitBand: 'medium', timingValue: 24,
      timingBand: 'hot', reachability: 'direct', dataConfidence: 7, [key]: 88,
    })).toThrow();
  });

  it('requires nonnegative mutation revisions', () => {
    expect(() => mutationReceiptSchema.parse({
      revision: -1, affectedPersonIds: [], affectedSalesCycleIds: [],
    })).toThrow();
  });
});
```

```ts
// tests/main/registerValidatedIpc.test.ts
it('rejects an untrusted sender before parsing or invoking the provider', async () => {
  const provider = vi.fn();
  registerValidatedIpc({
    channel: 'workflow:test', requestSchema: z.object({ id: z.string() }).strict(),
    responseSchema: z.object({ ok: z.literal(true) }).strict(), handler: provider,
  });
  await expect(registeredHandler()({ senderFrame: { url: 'https://attacker.test' } }, { id: 'p1' }))
    .rejects.toThrow('trusted');
  expect(provider).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run RED tests**

Run:

```bash
npx vitest run tests/shared/commonContract.test.ts tests/main/registerValidatedIpc.test.ts tests/integration/ipcClient.test.ts
```

Expected: FAIL because `commonContract`, `registerValidatedIpc`, and `ipcClient` do not exist.

- [ ] **Step 4: Implement strict shared schemas**

```ts
// src/shared/contracts/commonContract.ts
import { z } from 'zod';

export const personIdSchema = z.string().min(1);
export const salesCycleIdSchema = z.string().min(1);
export const lifecycleStageSchema = z.enum([
  'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
]);
export const prioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export const fitBandSchema = z.enum(['low', 'medium', 'high']);
export const timingBandSchema = z.enum(['cold', 'warm', 'hot']);
export const reachabilitySchema = z.enum(['direct', 'indirect', 'none']);

export const leadPriorityContextSchema = z.object({
  priority: prioritySchema,
  fitPoints: z.number().int().min(0).max(30),
  fitBand: fitBandSchema,
  timingValue: z.number().min(0).max(40),
  timingBand: timingBandSchema,
  reachability: reachabilitySchema,
  dataConfidence: z.number().int().min(0).max(10),
}).strict();

export const primaryActionSchema = z.object({
  id: z.string().min(1), type: z.string().min(1), channel: z.enum(['call', 'text', 'email', 'review', 'onboarding']),
  dueAt: z.string().datetime({ offset: true }), label: z.string().min(1), overdue: z.boolean(),
}).strict();

export const mutationReceiptSchema = z.object({
  revision: z.number().int().nonnegative(),
  affectedPersonIds: z.array(personIdSchema),
  affectedSalesCycleIds: z.array(salesCycleIdSchema),
}).strict();

export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;
```

- [ ] **Step 5: Implement validated main and preload helpers**

```ts
// src/main/ipc/registerValidatedIpc.ts
export function registerValidatedIpc<Request, Response>(options: {
  channel: string;
  requestSchema: z.ZodType<Request> | null;
  responseSchema: z.ZodType<Response>;
  handler(request: Request): Response | Promise<Response>;
  isTrustedRendererUrl?: (url: string) => boolean;
}): () => void {
  ipcMain.handle(options.channel, async (event, ...args: unknown[]) => {
    validateSender(event, options.isTrustedRendererUrl);
    if (options.requestSchema === null && args.length !== 0) throw new Error(`${options.channel} accepts no arguments.`);
    if (options.requestSchema !== null && args.length !== 1) throw new Error(`${options.channel} requires one request.`);
    const request = options.requestSchema === null ? undefined : options.requestSchema.parse(args[0]);
    return options.responseSchema.parse(await options.handler(request as Request));
  });
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    ipcMain.removeHandler(options.channel);
  };
}
```

```ts
// src/preload/ipcClient.ts
export type IpcInvoker = { invoke(channel: string, ...args: unknown[]): Promise<unknown> };

export const createIpcClient = (invoker: IpcInvoker) => ({
  request: async <Request, Response>(channel: string, requestSchema: z.ZodType<Request>, responseSchema: z.ZodType<Response>, value: Request) =>
    responseSchema.parse(await invoker.invoke(channel, requestSchema.parse(value))),
  requestNoInput: async <Response>(channel: string, responseSchema: z.ZodType<Response>) =>
    responseSchema.parse(await invoker.invoke(channel)),
});
```

- [ ] **Step 6: Run GREEN tests**

Run:

```bash
npx vitest run tests/shared/commonContract.test.ts tests/main/registerValidatedIpc.test.ts tests/integration/ipcClient.test.ts
```

Expected: all tests PASS; malformed requests/responses and forbidden score fields are rejected.

- [ ] **Step 7: Refactor and verify the platform seam**

Refactor duplicated test helpers into `tests/fixtures/registeredIpcHandler.ts`, then run:

```bash
npm run typecheck && npm run lint && npx vitest run tests/shared/commonContract.test.ts tests/main/registerValidatedIpc.test.ts tests/integration/ipcClient.test.ts
```

Expected: all commands exit `0`; TypeScript reports no implicit `any` and ESLint reports no errors.

- [ ] **Step 8: Commit Task 1**

```bash
git add package.json package-lock.json src/shared/contracts/commonContract.ts src/main/ipc/registerValidatedIpc.ts src/preload/ipcClient.ts tests/shared/commonContract.test.ts tests/main/registerValidatedIpc.test.ts tests/integration/ipcClient.test.ts tests/fixtures/registeredIpcHandler.ts
git commit -m "feat: add validated workflow IPC platform"
```

### Task 2: Adaptive luxury shell and reusable renderer primitives

**Files:**
- Create: `src/renderer/design/tokens.css`
- Create: `src/renderer/design/themes.css`
- Create: `src/renderer/design/base.css`
- Create: `src/renderer/design/motion.css`
- Create: `src/renderer/app/routes.ts`
- Create: `src/renderer/app/useHashRoute.ts`
- Create: `src/renderer/app/useTheme.ts`
- Create: `src/renderer/app/useDensity.ts`
- Create: `src/renderer/app/AppShell.tsx`
- Create: `src/renderer/app/NavigationRail.tsx`
- Create: `src/renderer/app/WorkspaceHeader.tsx`
- Create: `src/renderer/app/shell.css`
- Create: `src/renderer/components/Button.tsx`
- Create: `src/renderer/components/IconButton.tsx`
- Create: `src/renderer/components/Avatar.tsx`
- Create: `src/renderer/components/StatusPill.tsx`
- Create: `src/renderer/components/Panel.tsx`
- Create: `src/renderer/components/EmptyState.tsx`
- Create: `src/renderer/components/LoadingState.tsx`
- Create: `src/renderer/components/ErrorState.tsx`
- Create: `src/renderer/foundation/DiagnosticsScreen.tsx`
- Test: `src/renderer/app/AppShell.test.tsx`
- Test: `src/renderer/app/preferences.test.tsx`
- Test: `src/renderer/components/primitives.test.tsx`

**Interfaces:**
- Consumes: React 19 and Lucide icons installed by Task 1; existing `AppHealth` type.
- Produces: `AppRoute`, `AppShell({route, onNavigate, reviewCount, children})`, `useHashRoute()`, `useTheme()`, `useDensity()`, and shared visual primitives used by Tasks 3–10.

- [ ] **Step 1: Write failing shell and preference tests**

```tsx
// src/renderer/app/AppShell.test.tsx
it('renders fixed navigation and marks Today current', () => {
  render(<AppShell route="today" onNavigate={vi.fn()} reviewCount={3}><p>Queue</p></AppShell>);
  expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByText('3')).toBeTruthy();
  expect(screen.queryByText(/custom stage/i)).toBeNull();
});

it('navigates without opening a new window', () => {
  const onNavigate = vi.fn();
  render(<AppShell route="today" onNavigate={onNavigate} reviewCount={0}><p>Queue</p></AppShell>);
  fireEvent.click(screen.getByRole('link', { name: 'Leads' }));
  expect(onNavigate).toHaveBeenCalledWith('leads');
});
```

- [ ] **Step 2: Run RED shell tests**

Run:

```bash
npx vitest run src/renderer/app/AppShell.test.tsx src/renderer/app/preferences.test.tsx src/renderer/components/primitives.test.tsx
```

Expected: FAIL because the shell, preferences, and primitives do not exist.

- [ ] **Step 3: Implement adaptive design tokens and theme/density hooks**

```css
/* src/renderer/design/tokens.css */
:root {
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px;
  --radius-sm: 8px; --radius-md: 14px; --radius-lg: 20px;
  --font-ui: Inter, -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;
  --grid-row-compact: 36px; --grid-row-comfortable: 46px;
  --focus-ring: 0 0 0 3px color-mix(in srgb, var(--aurora-cyan) 38%, transparent);
}
```

```css
/* src/renderer/design/themes.css */
:root, [data-theme="light"] {
  color-scheme: light; --canvas: #f5f2eb; --surface: #fffdf8; --surface-raised: #ffffff;
  --text: #17191f; --muted: #6b6f78; --line: #ddd9d0; --aurora-cyan: #3fd4d0;
  --aurora-violet: #7657ff; --danger: #b74552; --shadow: 10px 10px 28px #d8d4cb, -8px -8px 24px #ffffff;
}
[data-theme="dark"] {
  color-scheme: dark; --canvas: #090b10; --surface: #10131a; --surface-raised: #151923;
  --text: #f5f3ef; --muted: #9da4b2; --line: #262c38; --aurora-cyan: #57e3d9;
  --aurora-violet: #8b72ff; --danger: #ff7180; --shadow: 12px 12px 30px #05070a, -8px -8px 24px #171c26;
}
```

```ts
export type ThemePreference = 'system' | 'light' | 'dark';
export type DensityPreference = 'compact' | 'comfortable';
```

Hooks persist only these non-sensitive preferences in `localStorage`, resolve system theme with `matchMedia('(prefers-color-scheme: dark)')`, and set `document.documentElement.dataset.theme`/`density`.

- [ ] **Step 4: Implement the semantic shell and primitives**

```tsx
// src/renderer/app/routes.ts
export const appRoutes = ['today', 'leads', 'pipeline', 'conversations', 'learnings', 'friday', 'review', 'settings'] as const;
export type AppRoute = (typeof appRoutes)[number];
```

```tsx
// src/renderer/app/AppShell.tsx
export function AppShell(props: {
  route: AppRoute; onNavigate(route: AppRoute): void; reviewCount: number; children: ReactNode;
}) {
  return <div className="app-shell">
    <NavigationRail route={props.route} onNavigate={props.onNavigate} reviewCount={props.reviewCount} />
    <div className="app-shell__workspace"><WorkspaceHeader /><main id="main-content">{props.children}</main></div>
  </div>;
}
```

Navigation uses real hash-backed anchors, `aria-current`, tooltips/accessibility names, and a Review badge. `DiagnosticsScreen` is extracted from the current `App.tsx` without changing its safe failure copy or exposing raw errors.

- [ ] **Step 5: Run GREEN shell tests**

Run:

```bash
npx vitest run src/renderer/app/AppShell.test.tsx src/renderer/app/preferences.test.tsx src/renderer/components/primitives.test.tsx
```

Expected: all tests PASS in jsdom for system/light/dark theme, both densities, keyboard focus, fixed navigation, and primitive accessible names.

- [ ] **Step 6: Refactor and verify reduced motion and contrast tokens**

Consolidate repeated control focus rules into `base.css`; add `@media (prefers-reduced-motion: reduce)` in `motion.css`; then run:

```bash
npm run typecheck && npm run lint && npx vitest run src/renderer/app src/renderer/components
```

Expected: all commands exit `0`; no component uses inline hex colors outside the theme files.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/renderer/design src/renderer/app src/renderer/components src/renderer/foundation
git commit -m "feat: add adaptive luxury application shell"
```

### Task 3: Person-first Leads grid vertical slice

**Files:**
- Create: `src/shared/contracts/leadsContract.ts`
- Create: `src/main/leads/leadsService.ts`
- Create: `src/main/leads/registerLeadsIpc.ts`
- Create: `src/preload/apis/leadsApi.ts`
- Create: `src/renderer/features/leads/LeadsRoute.tsx`
- Create: `src/renderer/features/leads/LeadsPage.tsx`
- Create: `src/renderer/features/leads/LeadsToolbar.tsx`
- Create: `src/renderer/features/leads/LeadsGrid.tsx`
- Create: `src/renderer/features/leads/leadColumns.tsx`
- Create: `src/renderer/features/leads/useLeadGridState.ts`
- Create: `src/renderer/features/leads/leads.css`
- Test: `src/renderer/features/leads/LeadsGrid.test.tsx`
- Test: `src/renderer/features/leads/LeadsRoute.test.tsx`
- Test: `tests/main/registerLeadsIpc.test.ts`
- Test: `tests/integration/leadsService.test.ts`

**Interfaces:**
- Consumes: Task 1 common schemas/`MutationReceipt`, Task 2 primitives, prerequisite domain methods `listLeadRows`, `updateLeadField`, and `bulkUpdateLeads`.
- Produces: `LeadsApi`, `LeadsProvider`, `LeadsRoute({api, onOpenLead, onOpenImport})`, and the strict list/update contracts.

- [ ] **Step 1: Write failing contract, IPC, and grid tests**

```ts
// tests/main/registerLeadsIpc.test.ts
it('registers strict leads channels and validates provider output', async () => {
  const provider: LeadsProvider = { list: vi.fn(async () => validPage), updateField: vi.fn(), bulkUpdate: vi.fn() };
  registerLeadsIpc(provider);
  await expect(invokeRegistered('leads:list', trustedEvent, { limit: 50, cursor: null, query: '', stages: [], priorities: [], sort: 'due_at' }))
    .resolves.toEqual(validPage);
  expect(provider.list).toHaveBeenCalledTimes(1);
});
```

```tsx
// src/renderer/features/leads/LeadsGrid.test.tsx
it('renders people first and exposes separate Fit and Timing columns', () => {
  render(<LeadsGrid rows={[leadRow]} selectedPersonId={null} onSelect={vi.fn()} onUpdateField={vi.fn()} />);
  const headers = screen.getAllByRole('columnheader').map((node) => node.textContent);
  expect(headers.slice(0, 3)).toEqual(['Person', 'Context', 'Lifecycle']);
  expect(headers).toContain('Fit');
  expect(headers).toContain('Timing');
  expect(headers.join(' ')).not.toMatch(/lead score|weighted|blended/i);
});
```

- [ ] **Step 2: Run RED Leads tests**

Run:

```bash
npx vitest run tests/main/registerLeadsIpc.test.ts tests/integration/leadsService.test.ts src/renderer/features/leads
```

Expected: FAIL because Leads contracts, service, IPC, API, and components do not exist.

- [ ] **Step 3: Implement strict Leads contracts and provider**

```ts
// src/shared/contracts/leadsContract.ts
export const leadRowSchema = z.object({
  personId: personIdSchema, salesCycleId: salesCycleIdSchema, personName: z.string().min(1), initials: z.string().min(1).max(4),
  organization: z.string().nullable(), propertySummary: z.string().nullable(), stage: lifecycleStageSchema,
  source: z.enum(['frbo', 'registry', 'rireig', 'referral', 'inbound_demo', 'community', 'custom']),
  segment: z.enum(['hot_frbo', 'cold_registry', 'warm']), priorityContext: leadPriorityContextSchema,
  nextAction: primaryActionSchema, optedOut: z.boolean(), lastActivityAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const leadsListRequestSchema = z.object({
  query: z.string().max(200), stages: z.array(lifecycleStageSchema), priorities: z.array(prioritySchema),
  sort: z.enum(['priority', 'due_at', 'person_name', 'last_contact']), cursor: z.string().nullable(),
  limit: z.number().int().min(1).max(200),
}).strict();

export const leadsListResponseSchema = z.object({
  rows: z.array(leadRowSchema), nextCursor: z.string().nullable(), total: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
}).strict();

export const leadFieldUpdateRequestSchema = z.discriminatedUnion('field', [
  z.object({ personId: personIdSchema, field: z.literal('person_name'), value: z.string().min(1).max(200) }).strict(),
  z.object({ personId: personIdSchema, field: z.literal('organization_label'), value: z.string().max(200).nullable() }).strict(),
]);
```

`LeadsService` maps domain projections to these DTOs and exposes no general patch object:

```ts
export type LeadsProvider = {
  list(input: LeadsListRequest): Promise<LeadsListResponse>;
  updateField(input: LeadFieldUpdateRequest): Promise<MutationReceipt>;
  bulkUpdate(input: LeadBulkUpdateRequest): Promise<MutationReceipt>;
};
```

- [ ] **Step 4: Implement Leads IPC and preload API without touching central files**

```ts
// src/preload/apis/leadsApi.ts
export const createLeadsApi = (client: ReturnType<typeof createIpcClient>) => ({
  list: (input: LeadsListRequest) => client.request('leads:list', leadsListRequestSchema, leadsListResponseSchema, input),
  updateField: (input: LeadFieldUpdateRequest) => client.request('leads:update-field', leadFieldUpdateRequestSchema, mutationReceiptSchema, input),
  bulkUpdate: (input: LeadBulkUpdateRequest) => client.request('leads:bulk-update', leadBulkUpdateRequestSchema, mutationReceiptSchema, input),
});
export type LeadsApi = ReturnType<typeof createLeadsApi>;
```

`registerLeadsIpc()` registers exactly those three channels using `registerValidatedIpc()` and returns one idempotent unregister function that removes all three.

- [ ] **Step 5: Implement the virtualized spreadsheet-capable grid**

Use TanStack Table for column state/sorting/selection and TanStack Virtual for rows. `LeadsRoute` owns async/stale-request handling; `LeadsGrid` is controlled and calls `onSelect(personId)`.

```tsx
export function LeadsRoute({ api, onOpenLead, onOpenImport }: {
  api: LeadsApi; onOpenLead(personId: string): void; onOpenImport(): void;
}) {
  const state = useLeadGridState();
  const query = useLeadsQuery(api, state.queryRequest);
  return <LeadsPage {...query} state={state} onOpenLead={onOpenLead} onOpenImport={onOpenImport} />;
}
```

Person stays the first sticky column. Organization/property remain one muted Context column. Fit renders `High · 24/30`; Timing renders `Hot · 31/40`; neither is clickable as a combined rank.

- [ ] **Step 6: Run GREEN Leads tests**

Run:

```bash
npx vitest run tests/main/registerLeadsIpc.test.ts tests/integration/leadsService.test.ts src/renderer/features/leads
```

Expected: PASS for strict response rejection, stable cursor ordering, person-first columns, keyboard row selection, bulk selection, inline allowed-field editing, empty/loading/error states, and no combined score.

- [ ] **Step 7: Refactor and verify the Leads slice**

Move pure column formatters into `leadColumns.tsx`; ensure `LeadsRoute` ignores stale responses under React StrictMode; run:

```bash
npm run typecheck && npm run lint && npx vitest run src/renderer/features/leads tests/main/registerLeadsIpc.test.ts tests/integration/leadsService.test.ts
```

Expected: all commands exit `0`; no feature file imports `window.callie`, Electron, or database modules.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/shared/contracts/leadsContract.ts src/main/leads src/preload/apis/leadsApi.ts src/renderer/features/leads tests/main/registerLeadsIpc.test.ts tests/integration/leadsService.test.ts
git commit -m "feat: add person-first leads grid"
```

### Task 4: Global resizable right-side lead inspector

**Files:**
- Create: `src/shared/contracts/leadDetailContract.ts`
- Create: `src/main/leads/leadDetailService.ts`
- Create: `src/main/leads/registerLeadDetailIpc.ts`
- Create: `src/preload/apis/leadDetailApi.ts`
- Create: `src/renderer/features/leadInspector/LeadInspectorProvider.tsx`
- Create: `src/renderer/features/leadInspector/useLeadInspector.ts`
- Create: `src/renderer/features/leadInspector/useResizableInspector.ts`
- Create: `src/renderer/features/leadInspector/LeadInspector.tsx`
- Create: `src/renderer/features/leadInspector/InspectorHeader.tsx`
- Create: `src/renderer/features/leadInspector/InspectorOverview.tsx`
- Create: `src/renderer/features/leadInspector/InspectorActivity.tsx`
- Create: `src/renderer/features/leadInspector/InspectorConversation.tsx`
- Create: `src/renderer/features/leadInspector/InspectorProperties.tsx`
- Create: `src/renderer/features/leadInspector/InspectorHistory.tsx`
- Create: `src/renderer/features/leadInspector/LeadFullPage.tsx`
- Create: `src/renderer/features/leadInspector/leadInspector.css`
- Test: `src/renderer/features/leadInspector/LeadInspector.test.tsx`
- Test: `src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx`
- Test: `tests/main/registerLeadDetailIpc.test.ts`
- Test: `tests/integration/leadDetailService.test.ts`

**Interfaces:**
- Consumes: common contract, renderer primitives, prerequisite domain `getLeadDetail` and guarded outbound/transition commands.
- Produces: `LeadDetailApi`, `LeadInspectorProvider({api, children})`, `LeadFullPage`, and `useLeadInspector(): {openLead, openFullPage, closeLead, selectedPersonId}`.

- [ ] **Step 1: Write failing inspector behavior tests**

```tsx
it('opens one global complementary panel for a selected person', async () => {
  render(<LeadInspectorProvider api={api}><InspectorHarness /></LeadInspectorProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
  expect(await screen.findByRole('complementary', { name: 'Kevin Shin details' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
});

it('clamps persisted width and closes on Escape', async () => {
  localStorage.setItem('callie.inspector.width', '9999');
  renderInspector();
  expect(screen.getByRole('complementary').getAttribute('style')).toContain('640px');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('complementary')).toBeNull();
});
```

- [ ] **Step 2: Run RED inspector tests**

Run:

```bash
npx vitest run src/renderer/features/leadInspector tests/main/registerLeadDetailIpc.test.ts tests/integration/leadDetailService.test.ts
```

Expected: FAIL because the detail contract, API, provider, and inspector do not exist.

- [ ] **Step 3: Implement the evidence-rich detail contract**

```ts
const contactMethodSchema = z.object({
  id: z.string().min(1), kind: z.enum(['phone', 'email']), value: z.string().min(1), label: z.string().nullable(), valid: z.boolean(),
}).strict();
const cadenceSummarySchema = z.object({ name: z.string(), stepLabel: z.string(), touchIndex: z.number().int().positive(), touchLimit: z.number().int().positive() }).strict();
const activitySummarySchema = z.object({ id: z.string(), kind: z.enum(['call', 'voicemail', 'text', 'email', 'interview', 'offer', 'note', 'job', 'system']), occurredAt: z.string().datetime({ offset: true }), summary: z.string(), outcome: z.string().nullable() }).strict();
const conversationSummarySchema = z.object({ id: z.string(), occurredAt: z.string().datetime({ offset: true }), durationSeconds: z.number().int().nonnegative(), recordingAvailable: z.boolean(), transcriptAvailable: z.boolean(), reviewCount: z.number().int().nonnegative() }).strict();
const propertySummarySchema = z.object({ id: z.string(), address: z.string(), doors: z.number().int().nonnegative().nullable(), ownershipEvidence: z.string().nullable(), liveVacancy: z.boolean() }).strict();
const historyEventSchema = z.object({ id: z.string(), occurredAt: z.string().datetime({ offset: true }), label: z.string(), detail: z.string().nullable() }).strict();

export const leadDetailSchema = z.object({
  personId: personIdSchema, salesCycleId: salesCycleIdSchema, personName: z.string().min(1), phones: z.array(contactMethodSchema),
  emails: z.array(contactMethodSchema), organizationLabel: z.string().nullable(), propertySummaries: z.array(z.string()),
  stage: lifecycleStageSchema, workflowStatus: z.enum(['active', 'onboarding', 'closed']), sourceLabel: z.string().min(1),
  segment: z.enum(['hot_frbo', 'cold_registry', 'warm']), priorityContext: leadPriorityContextSchema,
  priorityReasons: z.array(z.string().min(1)), nextAction: primaryActionSchema.nullable(), optedOut: z.boolean(),
  cadence: cadenceSummarySchema.nullable(), activities: z.array(activitySummarySchema), conversations: z.array(conversationSummarySchema),
  properties: z.array(propertySummarySchema), history: z.array(historyEventSchema), revision: z.number().int().nonnegative(),
}).strict();
```

The contract carries evidence/reasons but never a synthesized lead score. Outbound command schemas are discriminated by `call`, `text`, and `email`; stage commands are discriminated by the exact guarded transition.

- [ ] **Step 4: Implement detail IPC/preload and global provider**

```ts
export type LeadDetailApi = {
  get(input: { personId: string }): Promise<LeadDetail>;
  beginOutbound(input: BeginOutboundRequest): Promise<MutationReceipt>;
  confirmTransition(input: ConfirmTransitionRequest): Promise<MutationReceipt>;
};
```

`LeadInspectorProvider` owns `selectedPersonId`, async detail state, and one mounted inspector. `openLead()` replaces the current selection instead of stacking panels.

- [ ] **Step 5: Implement inspector tabs, resize handle, and safety states**

The `aside` uses `role="complementary"`, an accessible resize separator, 380 px minimum, 640 px maximum, and a narrow-window overlay mode. Call/text/email controls are disabled with a visible reason when opted out. The Overview shows separate Fit and Timing explanations, reachability, triggers, cadence, and required next action. Its **Open full page** control calls `openFullPage(personId)`; `LeadFullPage` uses the same strict detail DTO and tab sections without duplicating fetch logic.

- [ ] **Step 6: Run GREEN inspector tests**

Run:

```bash
npx vitest run src/renderer/features/leadInspector tests/main/registerLeadDetailIpc.test.ts tests/integration/leadDetailService.test.ts
```

Expected: PASS for one global inspector, stale request cancellation, tab keyboard behavior, persisted/clamped resize, Escape close, opt-out hard-disable, and evidence rendering.

- [ ] **Step 7: Refactor and verify inspector isolation**

Extract repeated section loading/error layout into `Panel`; run:

```bash
npm run typecheck && npm run lint && npx vitest run src/renderer/features/leadInspector tests/main/registerLeadDetailIpc.test.ts tests/integration/leadDetailService.test.ts
```

Expected: all commands exit `0`; inspector commands call only its injected API.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/shared/contracts/leadDetailContract.ts src/main/leads/leadDetailService.ts src/main/leads/registerLeadDetailIpc.ts src/preload/apis/leadDetailApi.ts src/renderer/features/leadInspector tests/main/registerLeadDetailIpc.test.ts tests/integration/leadDetailService.test.ts
git commit -m "feat: add global lead inspector"
```

### Task 5: Promise-first Today queue

**Files:**
- Create: `src/shared/contracts/todayContract.ts`
- Create: `src/main/today/todayService.ts`
- Create: `src/main/today/registerTodayIpc.ts`
- Create: `src/preload/apis/todayApi.ts`
- Create: `src/renderer/features/today/TodayRoute.tsx`
- Create: `src/renderer/features/today/TodayPage.tsx`
- Create: `src/renderer/features/today/CapacitySummary.tsx`
- Create: `src/renderer/features/today/TodayLane.tsx`
- Create: `src/renderer/features/today/TodayQueueRow.tsx`
- Create: `src/renderer/features/today/TodayReason.tsx`
- Create: `src/renderer/features/today/today.css`
- Test: `src/renderer/features/today/TodayPage.test.tsx`
- Test: `src/renderer/features/today/TodayRoute.test.tsx`
- Test: `tests/main/registerTodayIpc.test.ts`
- Test: `tests/integration/todayService.test.ts`

**Interfaces:**
- Consumes: common contract, Task 2 shell/primitives, prerequisite domain `getToday`, `completePrimaryAction`, `snoozePrimaryAction`, `pinWithinLane`, and `logPastActivity`.
- Produces: `TodayApi`, `TodayProvider`, and `TodayRoute({api, onOpenLead})`.

- [ ] **Step 1: Write failing lane-order and command tests**

```tsx
it('renders the promise-first lanes in fixed order', () => {
  render(<TodayPage snapshot={snapshotWithAllLanes} onOpenLead={vi.fn()} onComplete={vi.fn()} onSnooze={vi.fn()} onPin={vi.fn()} />);
  expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual([
    'Onboard now', 'Fresh inbound', 'Overdue', 'Post-interview & offers', 'Due cadence', 'New P0', 'P1', 'Exploration', 'Later',
  ]);
});

it('does not let pin move a row across lanes', async () => {
  await api.pin({ salesCycleId: 'cycle-p1', reason: 'Founder context', expiresAt: tomorrow });
  expect(domain.pinWithinLane).toHaveBeenCalledWith(expect.objectContaining({ salesCycleId: 'cycle-p1' }));
});
```

- [ ] **Step 2: Run RED Today tests**

Run:

```bash
npx vitest run src/renderer/features/today tests/main/registerTodayIpc.test.ts tests/integration/todayService.test.ts
```

Expected: FAIL because Today contracts and slice do not exist.

- [ ] **Step 3: Implement strict Today contracts**

```ts
export const todayLaneIdSchema = z.enum([
  'onboarding', 'fresh_inbound', 'overdue', 'post_interview_offer', 'due_cadence', 'new_p0', 'p1', 'exploration', 'later',
]);
export const todayItemSchema = z.object({
  id: z.string().min(1), lane: todayLaneIdSchema, personId: personIdSchema, salesCycleId: salesCycleIdSchema,
  personName: z.string().min(1), contextLabel: z.string().nullable(), stage: lifecycleStageSchema,
  priorityContext: leadPriorityContextSchema, action: primaryActionSchema, reason: z.string().min(1),
  activeTriggers: z.array(z.object({ label: z.string(), expiresAt: z.string().datetime({ offset: true }).nullable() }).strict()),
  verifyFirst: z.boolean(), pinned: z.boolean(), consentRequirement: z.string().nullable(),
}).strict();
export const todaySnapshotSchema = z.object({
  lanes: z.array(z.object({ id: todayLaneIdSchema, items: z.array(todayItemSchema) }).strict()),
  dialBudget: z.number().int().nonnegative(), scheduledDials: z.number().int().nonnegative(),
  conversationTarget: z.number().int().nonnegative(), reviewErrorCount: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
}).strict();
```

- [ ] **Step 4: Implement Today provider, IPC, and preload API**

```ts
export type TodayApi = {
  get(): Promise<TodaySnapshot>;
  complete(input: CompleteActionRequest): Promise<MutationReceipt>;
  snooze(input: SnoozeActionRequest): Promise<MutationReceipt>;
  pin(input: PinActionRequest): Promise<MutationReceipt>;
  logPastActivity(input: LogPastActivityRequest): Promise<MutationReceipt>;
};
```

The main service delegates all ordering, capacity, opt-out checks, action replacement, and lane assignment to domain use cases. It rejects duplicate lane membership before returning a snapshot.

- [ ] **Step 5: Implement Today UI and refetch-after-command behavior**

Rows explain lane, matrix cell, separate bands, active triggers, cadence step, due time, Verify First, and consent state. Commands disable while pending; a successful `MutationReceipt` triggers a fresh `get()` and stale snapshots are ignored.

- [ ] **Step 6: Run GREEN Today tests**

Run:

```bash
npx vitest run src/renderer/features/today tests/main/registerTodayIpc.test.ts tests/integration/todayService.test.ts
```

Expected: PASS for fixed lane order, one-lane membership, non-suppressible promised work, lane-local pinning, capacity labels, command refetch, opt-out errors, and no client-side reordering.

- [ ] **Step 7: Refactor and verify Today**

Move lane metadata into one frozen map in `TodayLane.tsx`; run:

```bash
npm run typecheck && npm run lint && npx vitest run src/renderer/features/today tests/main/registerTodayIpc.test.ts tests/integration/todayService.test.ts
```

Expected: all commands exit `0`; only the main/domain response controls row order.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/shared/contracts/todayContract.ts src/main/today src/preload/apis/todayApi.ts src/renderer/features/today tests/main/registerTodayIpc.test.ts tests/integration/todayService.test.ts
git commit -m "feat: add promise-first Today queue"
```

### Task 6: Fixed-lifecycle Pipeline board and table

**Files:**
- Create: `src/shared/contracts/pipelineContract.ts`
- Create: `src/main/pipeline/pipelineService.ts`
- Create: `src/main/pipeline/registerPipelineIpc.ts`
- Create: `src/preload/apis/pipelineApi.ts`
- Create: `src/renderer/features/pipeline/PipelineRoute.tsx`
- Create: `src/renderer/features/pipeline/PipelinePage.tsx`
- Create: `src/renderer/features/pipeline/PipelineBoard.tsx`
- Create: `src/renderer/features/pipeline/PipelineTable.tsx`
- Create: `src/renderer/features/pipeline/PipelineStageColumn.tsx`
- Create: `src/renderer/features/pipeline/pipelineStageMeta.ts`
- Create: `src/renderer/features/pipeline/pipeline.css`
- Test: `src/renderer/features/pipeline/PipelinePage.test.tsx`
- Test: `tests/main/registerPipelineIpc.test.ts`
- Test: `tests/integration/pipelineService.test.ts`

**Interfaces:**
- Consumes: fixed lifecycle/common schemas and prerequisite domain `getPipelineProjection`.
- Produces: `PipelineApi`, `PipelineProvider`, and `PipelineRoute({api, onOpenLead})`.

- [ ] **Step 1: Write failing fixed-stage tests**

```tsx
it('renders only the approved lifecycle stages', () => {
  render(<PipelinePage snapshot={pipelineSnapshot} onOpenLead={vi.fn()} />);
  expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual([
    'Unreviewed', 'Ready', 'Contacted', 'Interviewed', 'Offered', 'Won', 'Lost-Nurture',
  ]);
  expect(screen.queryByRole('button', { name: /add stage/i })).toBeNull();
});

it('opens a person instead of mutating stage by drag', () => {
  const onOpenLead = vi.fn();
  render(<PipelineBoard snapshot={pipelineSnapshot} onOpenLead={onOpenLead} />);
  fireEvent.click(screen.getByRole('button', { name: /Kevin Shin/ }));
  expect(onOpenLead).toHaveBeenCalledWith('person-kevin');
});
```

- [ ] **Step 2: Run RED Pipeline tests**

Run:

```bash
npx vitest run src/renderer/features/pipeline tests/main/registerPipelineIpc.test.ts tests/integration/pipelineService.test.ts
```

Expected: FAIL because Pipeline files do not exist.

- [ ] **Step 3: Implement strict Pipeline projection contracts**

```ts
export const pipelineCardSchema = z.object({
  personId: personIdSchema, salesCycleId: salesCycleIdSchema, personName: z.string().min(1),
  contextLabel: z.string().nullable(), stage: lifecycleStageSchema, stageEnteredAt: z.string().datetime({ offset: true }),
  priorityContext: leadPriorityContextSchema, nextAction: primaryActionSchema.nullable(), lostReasonCode: z.string().nullable(),
}).strict();
export const pipelineSnapshotSchema = z.object({
  stages: z.array(z.object({ stage: lifecycleStageSchema, cards: z.array(pipelineCardSchema) }).strict()),
  revision: z.number().int().nonnegative(),
}).strict();
```

The service returns every approved stage in fixed order, including empty columns. Won/onboarding and Won/closed remain distinguishable through card metadata without adding a visible custom stage.

- [ ] **Step 4: Implement Pipeline IPC/API and responsive board/table**

`PipelineApi` exposes only `get()`. The board uses buttons/cards and horizontal scrolling; the table uses the same DTO and is selected via a local segmented control. Neither view implements HTML drag/drop or a stage command.

- [ ] **Step 5: Run GREEN Pipeline tests**

Run:

```bash
npx vitest run src/renderer/features/pipeline tests/main/registerPipelineIpc.test.ts tests/integration/pipelineService.test.ts
```

Expected: PASS for fixed stage order, empty stages, board/table parity, person opening, next-action display, and absence of stage customization/drag mutation.

- [ ] **Step 6: Refactor and verify Pipeline**

Keep stage display copy/color in `pipelineStageMeta.ts`; run:

```bash
npm run typecheck && npm run lint && npx vitest run src/renderer/features/pipeline tests/main/registerPipelineIpc.test.ts tests/integration/pipelineService.test.ts
```

Expected: all commands exit `0`; lifecycle strings are imported from `fixedLifecycle.ts` rather than duplicated.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/shared/contracts/pipelineContract.ts src/main/pipeline src/preload/apis/pipelineApi.ts src/renderer/features/pipeline tests/main/registerPipelineIpc.test.ts tests/integration/pipelineService.test.ts
git commit -m "feat: add fixed lifecycle pipeline views"
```

### Task 7: Typed Review queues and resolution flows

**Files:**
- Create: `src/shared/contracts/reviewContract.ts`
- Create: `src/main/review/reviewService.ts`
- Create: `src/main/review/registerReviewIpc.ts`
- Create: `src/preload/apis/reviewApi.ts`
- Create: `src/renderer/features/review/ReviewRoute.tsx`
- Create: `src/renderer/features/review/ReviewPage.tsx`
- Create: `src/renderer/features/review/ReviewTabs.tsx`
- Create: `src/renderer/features/review/ReviewQueue.tsx`
- Create: `src/renderer/features/review/ReviewItem.tsx`
- Create: `src/renderer/features/review/ReviewDetailPanel.tsx`
- Create: `src/renderer/features/review/review.css`
- Test: `src/renderer/features/review/ReviewPage.test.tsx`
- Test: `src/renderer/features/review/ReviewRoute.test.tsx`
- Test: `tests/main/registerReviewIpc.test.ts`
- Test: `tests/integration/reviewService.test.ts`

**Interfaces:**
- Consumes: common contract and prerequisite domain review query plus kind-specific resolution commands.
- Produces: `ReviewApi`, `ReviewProvider`, `ReviewRoute({api, onOpenLead})`, and a count callback used by the shell.

- [ ] **Step 1: Write failing discriminated-review tests**

```ts
it('rejects a resolution payload for the wrong review kind', () => {
  expect(() => resolveReviewRequestSchema.parse({
    kind: 'transcript_suggestion', reviewId: 'review-1', action: 'mark_personal', normalizedHandle: '+14015550100',
  })).toThrow();
});
```

```tsx
it('shows safety/system queues separately and never hides invariant errors', () => {
  render(<ReviewPage snapshot={reviewSnapshot} selectedKind="system_error" onSelectKind={vi.fn()} onResolve={vi.fn()} />);
  expect(screen.getByRole('tab', { name: /System errors 1/ })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Missing primary next action');
});
```

- [ ] **Step 2: Run RED Review tests**

Run:

```bash
npx vitest run src/renderer/features/review tests/main/registerReviewIpc.test.ts tests/integration/reviewService.test.ts
```

Expected: FAIL because Review contracts and slice do not exist.

- [ ] **Step 3: Implement strict discriminated Review contracts**

```ts
export const reviewItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unmatched_communication'), reviewId: z.string(), channel: z.enum(['call', 'text', 'email']), handle: z.string(), occurredAt: z.string().datetime({ offset: true }), summary: z.string() }).strict(),
  z.object({ kind: z.literal('ambiguous_identity'), reviewId: z.string(), candidatePersonIds: z.array(personIdSchema).min(2), summary: z.string() }).strict(),
  z.object({ kind: z.literal('transcript_suggestion'), reviewId: z.string(), personId: personIdSchema, suggestionType: z.enum(['pain', 'objection', 'authority', 'commitment', 'close_readiness', 'offered', 'identity']), evidence: z.array(z.string()).min(1), proposedValue: z.string() }).strict(),
  z.object({ kind: z.literal('import_problem'), reviewId: z.string(), rowNumber: z.number().int().positive(), summary: z.string() }).strict(),
  z.object({ kind: z.literal('adapter_failure'), reviewId: z.string(), adapter: z.string(), summary: z.string(), blocking: z.boolean() }).strict(),
  z.object({ kind: z.literal('system_error'), reviewId: z.string(), invariant: z.string(), summary: z.string(), personId: personIdSchema.nullable() }).strict(),
]);
```

Resolution is another discriminated union with only valid actions for each kind: promote/link/mark-personal, choose identity, accept/edit/dismiss suggestion, retry/dismiss import, retry adapter, and explicit invariant repair commands.

- [ ] **Step 4: Implement Review IPC/API and asynchronous UI**

```ts
export type ReviewApi = {
  list(input: ReviewListRequest): Promise<ReviewSnapshot>;
  resolve(input: ResolveReviewRequest): Promise<MutationReceipt>;
};
```

The route refetches counts after resolution. System errors use `role="alert"`; ambiguous opt-out language remains visibly outbound-blocking until resolved. Batch acceptance is allowed only for compatible transcript suggestions.

- [ ] **Step 5: Run GREEN Review tests**

Run:

```bash
npx vitest run src/renderer/features/review tests/main/registerReviewIpc.test.ts tests/integration/reviewService.test.ts
```

Expected: PASS for each review discriminator/action, invalid cross-kind rejection, shell count derivation, batch-compatible suggestions, identity linking, personal Never Record flow, and system-error prominence.

- [ ] **Step 6: Refactor and verify Review**

Extract kind-to-copy/action metadata into one exhaustive `switch`; make TypeScript's `never` check fail when a new kind lacks UI; run:

```bash
npm run typecheck && npm run lint && npx vitest run src/renderer/features/review tests/main/registerReviewIpc.test.ts tests/integration/reviewService.test.ts
```

Expected: all commands exit `0` and every discriminated kind is exhaustively rendered.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/shared/contracts/reviewContract.ts src/main/review src/preload/apis/reviewApi.ts src/renderer/features/review tests/main/registerReviewIpc.test.ts tests/integration/reviewService.test.ts
git commit -m "feat: add typed Review workflows"
```

### Task 8: Friday scoreboard, job requests, and fill rate

**Files:**
- Create: `src/shared/contracts/fridayContract.ts`
- Create: `src/main/friday/fridayService.ts`
- Create: `src/main/friday/registerFridayIpc.ts`
- Create: `src/preload/apis/fridayApi.ts`
- Create: `src/renderer/features/friday/FridayRoute.tsx`
- Create: `src/renderer/features/friday/FridayPage.tsx`
- Create: `src/renderer/features/friday/ScoreboardHeader.tsx`
- Create: `src/renderer/features/friday/MetricCard.tsx`
- Create: `src/renderer/features/friday/MetricDrilldown.tsx`
- Create: `src/renderer/features/friday/SourceFunnelTable.tsx`
- Create: `src/renderer/features/friday/JobRequestForm.tsx`
- Create: `src/renderer/features/friday/friday.css`
- Test: `src/renderer/features/friday/FridayPage.test.tsx`
- Test: `src/renderer/features/friday/FridayRoute.test.tsx`
- Test: `tests/main/registerFridayIpc.test.ts`
- Test: `tests/integration/fridayService.test.ts`

**Interfaces:**
- Consumes: common contracts and prerequisite domain scoreboard queries plus `createJobRequest`, `markJobFilled`, and `cancelJobRequest` commands.
- Produces: `FridayApi`, `FridayProvider`, and `FridayRoute({api, onOpenLead})`.

- [ ] **Step 1: Write failing scoreboard and fill-rate tests**

```tsx
it('renders actual, target, prior change, and exact fill-rate evidence', () => {
  render(<FridayPage report={report} onOpenMetric={vi.fn()} onCreateJob={vi.fn()} onFillJob={vi.fn()} onCancelJob={vi.fn()} />);
  expect(screen.getByRole('heading', { name: 'Friday scoreboard' })).toBeTruthy();
  expect(screen.getByText('3 / 4')).toBeTruthy();
  expect(screen.getByText('75%')).toBeTruthy();
  expect(screen.getByText(/contractor accepted/i)).toBeTruthy();
});

it('renders an em dash for a zero denominator', () => {
  renderMetric({ id: 'fill_rate', value: null, numerator: 0, denominator: 0 });
  expect(screen.getByText('—')).toBeTruthy();
});
```

- [ ] **Step 2: Run RED Friday tests**

Run:

```bash
npx vitest run src/renderer/features/friday tests/main/registerFridayIpc.test.ts tests/integration/fridayService.test.ts
```

Expected: FAIL because Friday contracts and slice do not exist.

- [ ] **Step 3: Implement strict report, drilldown, and job contracts**

```ts
export const metricIdSchema = z.enum([
  'interviews', 'offers', 'wins', 'offer_rate', 'win_rate', 'jobs_requested', 'jobs_filled', 'fill_rate',
  'new_mrr', 'founding_customers', 'design_partner_fitness', 'overdue_actions', 'invalid_action_cycles',
]);
export const metricSchema = z.object({
  id: metricIdSchema, label: z.string(), displayValue: z.string(), numericValue: z.number().nullable(),
  target: z.number().nullable(), priorDelta: z.number().nullable(), numerator: z.number().int().nonnegative().nullable(),
  denominator: z.number().int().nonnegative().nullable(), drilldownCount: z.number().int().nonnegative(),
}).strict();
export const jobRequestSchema = z.object({
  id: z.string(), salesCycleId: salesCycleIdSchema.nullable(), requestedAt: z.string().datetime({ offset: true }),
  status: z.enum(['requested', 'filled', 'cancelled']), contractorAcceptedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export const fridayReportSchema = z.object({
  periodStartsAt: z.string().datetime({ offset: true }), periodEndsAt: z.string().datetime({ offset: true }),
  asOf: z.string().datetime({ offset: true }), metrics: z.array(metricSchema),
  sourceRows: z.array(z.object({ source: z.string(), interviews: z.number().int().nonnegative(), offers: z.number().int().nonnegative(), wins: z.number().int().nonnegative() }).strict()),
  jobs: z.array(jobRequestSchema), revision: z.number().int().nonnegative(),
}).strict();
```

Friday reports include Monday/Friday bounds, as-of time, targets, metrics, source funnel rows, jobs, and revision. The renderer receives calculated metrics and never computes funnel rates or MRR.

- [ ] **Step 4: Implement Friday provider, IPC, and preload API**

```ts
export type FridayApi = {
  getCurrent(): Promise<FridayReport>;
  getDrilldown(input: MetricDrilldownRequest): Promise<MetricDrilldown>;
  createJob(input: CreateJobRequest): Promise<MutationReceipt>;
  fillJob(input: FillJobRequest): Promise<MutationReceipt>;
  cancelJob(input: CancelJobRequest): Promise<MutationReceipt>;
};
```

Main rejects `filled` without `contractorAcceptedAt`; cancelled jobs stay visible but are excluded from the denominator by the domain report.

- [ ] **Step 5: Implement metric cards, source funnel, drilldown, and jobs UI**

Metric cards are buttons only when `drilldownCount > 0`. Drilldown rows open the global inspector through `onOpenLead`. `JobRequestForm` accepts requested timestamp and optional Won cycle; Fill requires a contractor-accepted timestamp and confirmation copy stating that acceptance is the fill event.

- [ ] **Step 6: Run GREEN Friday tests**

Run:

```bash
npx vitest run src/renderer/features/friday tests/main/registerFridayIpc.test.ts tests/integration/fridayService.test.ts
```

Expected: PASS for all approved metrics, zero denominator, current-week bounds, target/prior display, source funnel, job create/fill/cancel commands, idempotent fill, and drilldown provenance.

- [ ] **Step 7: Refactor and verify Friday**

Move all display formatting into pure functions covered by tests; use `Intl.NumberFormat` for USD MRR; run:

```bash
npm run typecheck && npm run lint && npx vitest run src/renderer/features/friday tests/main/registerFridayIpc.test.ts tests/integration/fridayService.test.ts
```

Expected: all commands exit `0`; no renderer function divides jobs, interviews, offers, or wins.

- [ ] **Step 8: Commit Task 8**

```bash
git add src/shared/contracts/fridayContract.ts src/main/friday src/preload/apis/fridayApi.ts src/renderer/features/friday tests/main/registerFridayIpc.test.ts tests/integration/fridayService.test.ts
git commit -m "feat: add Friday scoreboard and job tracking"
```

### Task 9: Atomic import parser, preview, mapping, and commit service

**Files:**
- Create: `src/shared/contracts/importContract.ts`
- Create: `src/main/imports/csvParser.ts`
- Create: `src/main/imports/importService.ts`
- Create: `src/main/imports/registerImportIpc.ts`
- Create: `src/preload/apis/importApi.ts`
- Create: `tests/fixtures/import/leads-valid.csv`
- Create: `tests/fixtures/import/leads-invalid.csv`
- Create: `tests/fixtures/import/leads-duplicates.csv`
- Test: `tests/main/csvParser.test.ts`
- Test: `tests/main/registerImportIpc.test.ts`
- Test: `tests/integration/importService.test.ts`

**Interfaces:**
- Consumes: Task 1 IPC/common contracts, Papa Parse, prerequisite domain `previewLeadImport`, `commitLeadImport`, and `getImportJob` use cases.
- Produces: `ImportApi`, `ImportProvider`, `parseCsvSource()`, strict preview/remap/commit/status contracts consumed by Task 10.

- [ ] **Step 1: Create representative CSV fixtures and failing parser/service tests**

```csv
# tests/fixtures/import/leads-valid.csv
Name,Phone,Email,Source,Doors,Organization
Kevin Shin,+14015550101,kevin@example.com,frbo,12,Shin Holdings LLC
Maya Ortiz,+14015550102,maya@example.com,referral,8,Ortiz Property Group
```

```ts
it('parses quoted commas and preserves exact source row numbers', () => {
  expect(parseCsvSource('Name,Organization\n"Kevin Shin","Shin, LLC"\n')).toEqual({
    columns: ['Name', 'Organization'], rows: [{ rowNumber: 2, values: ['Kevin Shin', 'Shin, LLC'] }], errors: [],
  });
});

it('commits all valid rows atomically or none', async () => {
  const preview = await service.preview({ kind: 'csv', sourceName: 'leads.csv', content: invalidCsv });
  await expect(service.commit({ previewId: preview.previewId, mapping: validMapping, source: { channel: 'registry' } }))
    .rejects.toMatchObject({ code: 'IMPORT_VALIDATION_FAILED' });
  expect(domain.countPeople()).toBe(0);
});
```

- [ ] **Step 2: Run RED import-service tests**

Run:

```bash
npx vitest run tests/main/csvParser.test.ts tests/main/registerImportIpc.test.ts tests/integration/importService.test.ts
```

Expected: FAIL because import contracts, parser, service, IPC, and API do not exist.

- [ ] **Step 3: Implement strict import contracts**

```ts
export const importSourceSchema = z.object({
  kind: z.enum(['csv', 'spreadsheet_paste']), sourceName: z.string().min(1).max(255), content: z.string().min(1).max(10_000_000),
}).strict();
export const importFieldSchema = z.enum([
  'ignore', 'person_name', 'phone', 'email', 'organization', 'property_address', 'doors', 'source', 'segment', 'notes',
]);
export const importMappingSchema = z.record(z.string(), importFieldSchema).refine(
  (mapping) => Object.values(mapping).filter((field) => field === 'person_name').length === 1,
  'Exactly one person-name column is required.',
);
export const importPreviewSchema = z.object({
  previewId: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/), columns: z.array(z.string()),
  sampleRows: z.array(z.object({ rowNumber: z.number().int().positive(), cells: z.array(z.string()) }).strict()),
  suggestedMapping: importMappingSchema, rowCount: z.number().int().nonnegative(), validCount: z.number().int().nonnegative(),
  errors: z.array(z.object({ rowNumber: z.number().int().positive(), field: z.string().nullable(), code: z.string(), message: z.string() }).strict()),
  duplicateCandidates: z.array(z.object({ rowNumber: z.number().int().positive(), personIds: z.array(personIdSchema), reason: z.string() }).strict()),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export const importCommitReceiptSchema = z.object({
  jobId: z.string().min(1), importedPersonIds: z.array(personIdSchema), importedRowCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
}).strict();
export const importStatusSchema = z.object({
  jobId: z.string().min(1), state: z.enum(['queued', 'running', 'succeeded', 'failed']),
  progressCurrent: z.number().int().nonnegative(), progressTotal: z.number().int().nonnegative().nullable(),
  safeErrorCode: z.string().nullable(),
}).strict();
```

`ImportCommitRequest` carries `previewId`, `contentHash`, final mapping, source channel, optional referrer resolution, and explicit duplicate decisions. It does not resend trusted normalized rows from the renderer.

- [ ] **Step 4: Implement Papa Parse adapter and preview cache semantics**

`parseCsvSource()` calls Papa Parse with `skipEmptyLines: 'greedy'`, rejects duplicate/blank headers, preserves source row numbers, and returns bounded safe errors. `ImportService.preview()` hashes the original content with SHA-256, passes raw rows/mapping to the domain preview use case, and stores an expiring in-memory preview keyed by an opaque UUID. Restart invalidates previews by design; no plaintext import is persisted outside the encrypted domain/job store.

```ts
export type ImportProvider = {
  preview(input: ImportSource): Promise<ImportPreview>;
  remap(input: ImportRemapRequest): Promise<ImportPreview>;
  commit(input: ImportCommitRequest): Promise<ImportCommitReceipt>;
  status(input: ImportStatusRequest): Promise<ImportStatus>;
};
```

- [ ] **Step 5: Implement import IPC and preload API**

Register exactly `imports:preview`, `imports:remap`, `imports:commit`, and `imports:status`. Commit rechecks preview ID, hash, expiry, mapping, duplicate decisions, opt-out tombstones, and current domain revision before the single transaction; a successful commit invalidates the preview so a repeated commit cannot duplicate rows.

- [ ] **Step 6: Run GREEN import-service tests**

Run:

```bash
npx vitest run tests/main/csvParser.test.ts tests/main/registerImportIpc.test.ts tests/integration/importService.test.ts
```

Expected: PASS for quoted CSV, BOM, CRLF, blank/duplicate headers, maximum content, spreadsheet paste, normalization preview, duplicate candidates, expired/hash-mismatched previews, tombstone preservation, all-or-nothing commit, and repeated-commit rejection.

- [ ] **Step 7: Refactor and verify import-service boundaries**

Keep Papa-specific output inside `csvParser.ts`; return only strict contract types from `ImportService`; run:

```bash
npm run typecheck && npm run lint && npx vitest run tests/main/csvParser.test.ts tests/main/registerImportIpc.test.ts tests/integration/importService.test.ts
```

Expected: all commands exit `0`; parser errors contain no raw stack or filesystem path.

- [ ] **Step 8: Commit Task 9**

```bash
git add src/shared/contracts/importContract.ts src/main/imports src/preload/apis/importApi.ts tests/fixtures/import tests/main/csvParser.test.ts tests/main/registerImportIpc.test.ts tests/integration/importService.test.ts
git commit -m "feat: add atomic lead import service"
```

### Task 10: CSV/paste/manual import workflow UI

**Files:**
- Create: `src/renderer/features/import/ImportDialog.tsx`
- Create: `src/renderer/features/import/ImportSourceStep.tsx`
- Create: `src/renderer/features/import/ImportMappingStep.tsx`
- Create: `src/renderer/features/import/ImportValidationStep.tsx`
- Create: `src/renderer/features/import/ImportCommitStep.tsx`
- Create: `src/renderer/features/import/ManualQuickAdd.tsx`
- Create: `src/renderer/features/import/useImportWorkflow.ts`
- Create: `src/renderer/features/import/import.css`
- Test: `src/renderer/features/import/ImportDialog.test.tsx`
- Test: `src/renderer/features/import/useImportWorkflow.test.tsx`
- Test: `src/renderer/features/import/ManualQuickAdd.test.tsx`

**Interfaces:**
- Consumes: Task 9 `ImportApi`/contracts and Task 2 dialog/control primitives.
- Produces: `ImportDialog({api, open, onClose, onCommitted})` and `ManualQuickAdd({api, onCommitted})` for Task 11.

- [ ] **Step 1: Write failing import-workflow UI tests**

```tsx
it('walks source, mapping, validation, and atomic commit without writing during preview', async () => {
  render(<ImportDialog api={api} open onClose={vi.fn()} onCommitted={onCommitted} />);
  fireEvent.change(screen.getByLabelText('Paste spreadsheet rows'), { target: { value: 'Name\tPhone\nKevin\t4015550101' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview rows' }));
  expect(await screen.findByText('1 row ready')).toBeTruthy();
  expect(api.commit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Import 1 row' }));
  await waitFor(() => expect(onCommitted).toHaveBeenCalled());
});

it('keeps commit disabled while any blocking row error remains', async () => {
  renderDialogWithPreview({ ...preview, errors: [{ rowNumber: 2, field: 'phone', code: 'INVALID_PHONE', message: 'Invalid phone' }] });
  expect(screen.getByRole('button', { name: /Import/ }).hasAttribute('disabled')).toBe(true);
});
```

- [ ] **Step 2: Run RED import UI tests**

Run:

```bash
npx vitest run src/renderer/features/import
```

Expected: FAIL because import workflow components do not exist.

- [ ] **Step 3: Implement explicit workflow state and stale-response protection**

```ts
export type ImportWorkflowState =
  | { step: 'source'; sourceKind: 'csv' | 'spreadsheet_paste'; content: string; sourceName: string }
  | { step: 'previewing'; requestId: number }
  | { step: 'mapping'; preview: ImportPreview; mapping: ImportMapping }
  | { step: 'validating'; requestId: number; preview: ImportPreview }
  | { step: 'ready'; preview: ImportPreview; mapping: ImportMapping }
  | { step: 'committing'; preview: ImportPreview }
  | { step: 'complete'; receipt: ImportCommitReceipt }
  | { step: 'failed'; safeCode: string; message: string };
```

`useImportWorkflow()` increments request IDs, ignores stale preview/remap results, and calls commit only from the explicit final button handler.

- [ ] **Step 4: Implement accessible dialog steps and manual quick-add**

The dialog uses a labelled native file input for CSV and a textarea for spreadsheet paste. Mapping uses one labelled select per source column. Validation shows row/field/code without exposing stack traces. Duplicate rows require an explicit merge/create/skip selection. `ManualQuickAdd` submits one synthetic row through the same preview/commit API, so normalization and invariants are identical.

- [ ] **Step 5: Run GREEN import UI tests**

Run:

```bash
npx vitest run src/renderer/features/import
```

Expected: PASS for file/paste/manual paths, no preview writes, mapping remap, blocking errors, duplicate decisions, stale response suppression, expired preview restart, commit progress, Escape close before commit, and post-commit callback.

- [ ] **Step 6: Refactor and verify import UI**

Extract shared field/error tables without merging state transitions into view components; run:

```bash
npm run typecheck && npm run lint && npx vitest run src/renderer/features/import
```

Expected: all commands exit `0`; all buttons and fields have accessible names and the commit handler is the only call site for `api.commit`.

- [ ] **Step 7: Commit Task 10**

```bash
git add src/renderer/features/import
git commit -m "feat: add lead import workflow UI"
```

### Task 11: Central main/preload/renderer composition

**Files:**
- Create: `src/main/ipc/registerApplicationIpc.ts`
- Create: `src/preload/createCallieApi.ts`
- Create: `src/renderer/app/FounderApp.tsx`
- Create: `src/renderer/app/routeRegistry.tsx`
- Create: `src/renderer/foundation/useFoundationHealth.ts`
- Modify: `src/main/startApplication.ts`
- Modify: `src/main/createWindow.ts`
- Modify: `src/preload.ts`
- Modify: `src/shared/preload.d.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/app.css`
- Modify: `src/renderer/App.test.tsx`
- Modify: `src/renderer/App.lifecycle.test.tsx`
- Modify: `tests/integration/preload.test.ts`
- Modify: `tests/main/startApplication.test.ts`
- Test: `tests/main/registerApplicationIpc.test.ts`
- Test: `src/renderer/app/FounderApp.test.tsx`

**Interfaces:**
- Consumes: prerequisite `FounderSalesDomain`/`FoundationRuntime.withDomain`, every registrar/API/route from Tasks 1–10, existing health service, and existing startup lifecycle.
- Produces: complete `window.callie` type/API, one aggregate IPC unregister function, healthy-app composition, failure/retry bootstrap, default Today route, global inspector, and global import dialog.

- [ ] **Step 1: Write failing aggregate-composition tests**

```ts
// tests/main/registerApplicationIpc.test.ts
it('registers all feature slices and unregisters each exactly once', () => {
  const unregisters = Array.from({ length: 8 }, () => vi.fn());
  const unregister = registerApplicationIpc(runtime, trust, fakeRegistrars(unregisters));
  unregister();
  unregister();
  expect(unregisters.every((fn) => fn.mock.calls.length === 1)).toBe(true);
});
```

```tsx
// src/renderer/app/FounderApp.test.tsx
it('opens the same global inspector from Leads, Today, and Pipeline routes', async () => {
  render(<FounderApp api={fakeCallieApi} initialRoute="leads" />);
  fireEvent.click(await screen.findByRole('button', { name: /Kevin Shin/ }));
  expect(await screen.findByRole('complementary', { name: 'Kevin Shin details' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  fireEvent.click(screen.getByRole('link', { name: 'Today' }));
  fireEvent.click(await screen.findByRole('button', { name: /Kevin Shin/ }));
  expect(await screen.findByRole('complementary', { name: 'Kevin Shin details' })).toBeTruthy();
});
```

- [ ] **Step 2: Run RED composition tests**

Run:

```bash
npx vitest run tests/main/registerApplicationIpc.test.ts tests/main/startApplication.test.ts tests/integration/preload.test.ts src/renderer/App.test.tsx src/renderer/App.lifecycle.test.tsx src/renderer/app/FounderApp.test.tsx
```

Expected: FAIL because aggregate registration/API/root composition do not exist and old App still renders only diagnostics.

- [ ] **Step 3: Implement aggregate main registration with encrypted-domain adapters**

```ts
// src/main/ipc/registerApplicationIpc.ts
export function registerApplicationIpc(runtime: FoundationRuntime, trust?: (url: string) => boolean): () => void {
  const throughDomain = <Input, Output>(run: (domain: FounderSalesDomain, input: Input) => Output | Promise<Output>) =>
    (input: Input) => runtime.withDomain((domain) => run(domain, input));

  const unregisters = [
    registerHealthIpc(runtime, trust),
    registerLeadsIpc({
      list: throughDomain((domain, input) => domain.listLeadRows(input)),
      updateField: throughDomain((domain, input) => domain.updateLeadField(input)),
      bulkUpdate: throughDomain((domain, input) => domain.bulkUpdateLeads(input)),
    }, trust),
    registerLeadDetailIpc({
      get: throughDomain((domain, input) => domain.getLeadDetail(input)),
      beginOutbound: throughDomain((domain, input) => domain.beginOutbound(input)),
      confirmTransition: throughDomain((domain, input) => domain.confirmTransition(input)),
    }, trust),
    registerTodayIpc(createTodayProvider(runtime), trust),
    registerPipelineIpc(createPipelineProvider(runtime), trust),
    registerReviewIpc(createReviewProvider(runtime), trust),
    registerFridayIpc(createFridayProvider(runtime), trust),
    registerImportIpc(createImportProvider(runtime), trust),
  ];
  let active = true;
  return () => { if (!active) return; active = false; for (const unregister of unregisters.reverse()) unregister(); };
}
```

`createTodayProvider`, `createPipelineProvider`, `createReviewProvider`, `createFridayProvider`, and `createImportProvider` are focused functions in the same file that map each already-defined provider method to one exact domain use case. They contain no SQL or business calculations.

- [ ] **Step 4: Replace startup's health-only registration with aggregate registration**

Modify `ApplicationStartupDependencies` to expose `registerApplicationIpc(runtime, trust)` instead of `registerHealthIpc(health, trust)`. Preserve registration-before-window, lazy domain initialization, cancellation, aggregate cleanup, retry after initialization failure, and idempotent shutdown. Existing startup tests must keep their event-order assertions with `ipc` replacing no database open.

- [ ] **Step 5: Compose one narrow preload API and global type**

```ts
// src/preload/createCallieApi.ts
export const createCallieApi = (invoker: IpcInvoker) => {
  const client = createIpcClient(invoker);
  return {
    health: { get: () => client.requestNoInput('health:get', appHealthSchema) },
    leads: createLeadsApi(client), leadDetail: createLeadDetailApi(client),
    today: createTodayApi(client), pipeline: createPipelineApi(client), review: createReviewApi(client),
    friday: createFridayApi(client), imports: createImportApi(client),
  } as const;
};
export type CallieApi = ReturnType<typeof createCallieApi>;
```

```ts
// src/preload.ts
contextBridge.exposeInMainWorld('callie', createCallieApi(ipcRenderer));

// src/shared/preload.d.ts
declare global { interface Window { callie: CallieApi } }
```

The preload test asserts exact top-level keys and representative channel names; it also verifies malformed main responses are rejected before renderer exposure.

- [ ] **Step 6: Compose bootstrap, routes, inspector, and import dialog**

```tsx
// src/renderer/App.tsx
export function App() {
  const health = useFoundationHealth(window.callie.health);
  if (health.status !== 'ready') return <DiagnosticsScreen state={health} onRetry={health.retry} />;
  return <FounderApp api={window.callie} />;
}
```

```tsx
// src/renderer/app/FounderApp.tsx
export function FounderApp({ api, initialRoute }: { api: CallieApi; initialRoute?: AppRoute }) {
  return <LeadInspectorProvider api={api.leadDetail}>
    <FounderWorkspace api={api} initialRoute={initialRoute} />
  </LeadInspectorProvider>;
}

function FounderWorkspace({ api, initialRoute }: { api: CallieApi; initialRoute?: AppRoute }) {
  const routing = useHashRoute(initialRoute ?? 'today');
  const inspector = useLeadInspector();
  const [importOpen, setImportOpen] = useState(false);
  return <>
    <AppShell route={routing.route} onNavigate={routing.navigate} reviewCount={routing.reviewCount}>
      {renderRoute(routing.route, { api, openLead: inspector.openLead, openImport: () => setImportOpen(true) })}
    </AppShell>
    <ImportDialog api={api.imports} open={importOpen} onClose={() => setImportOpen(false)} onCommitted={routing.refreshCurrentRoute} />
  </>;
}
```

`routeRegistry.tsx` covers Today, Leads, Pipeline, Friday, Review, Settings/Diagnostics, and the full-page lead-detail query state emitted by `openFullPage(personId)`. Conversations and Learnings remain disabled navigation entries with `aria-disabled="true"` in this workflow plan because their analysis UIs require their own approved implementation plan; they must not route to blank or misleading screens.

- [ ] **Step 7: Apply shell CSS imports and Mac window dimensions**

```css
/* src/renderer/app.css */
@import "./design/tokens.css";
@import "./design/themes.css";
@import "./design/base.css";
@import "./design/motion.css";
@import "./app/shell.css";
```

Feature TSX entry components import their colocated feature CSS. Update `createWindow.ts` to default to `1440x900`, enforce `minWidth: 1050`, `minHeight: 700`, use `titleBarStyle: 'hiddenInset'` on macOS, retain existing secure web preferences, and set a neutral `backgroundColor` to avoid a white flash.

- [ ] **Step 8: Run GREEN composition tests**

Run:

```bash
npx vitest run tests/main/registerApplicationIpc.test.ts tests/main/startApplication.test.ts tests/integration/preload.test.ts src/renderer/App.test.tsx src/renderer/App.lifecycle.test.tsx src/renderer/app/FounderApp.test.tsx
```

Expected: PASS for aggregate register/unregister, startup cancellation/retry, exact preload API, healthy default Today route, safe failure screen, global inspector, import dialog, and route navigation.

- [ ] **Step 9: Refactor and run the complete non-packaged suite**

Remove obsolete health-only composition code and duplicate diagnostics markup; run:

```bash
npm run typecheck && npm run lint && npm run test
```

Expected: typecheck and lint exit `0`; Vitest reports all suites PASS with no tests discovered under `.worktrees` or `tests/e2e`.

- [ ] **Step 10: Commit Task 11**

```bash
git add src/main/ipc/registerApplicationIpc.ts src/preload/createCallieApi.ts src/renderer/app/FounderApp.tsx src/renderer/app/routeRegistry.tsx src/renderer/foundation/useFoundationHealth.ts src/main/startApplication.ts src/main/createWindow.ts src/preload.ts src/shared/preload.d.ts src/renderer/App.tsx src/renderer/app.css src/renderer/App.test.tsx src/renderer/App.lifecycle.test.tsx tests/integration/preload.test.ts tests/main/startApplication.test.ts tests/main/registerApplicationIpc.test.ts src/renderer/app/FounderApp.test.tsx
git commit -m "feat: compose founder workflow application"
```

### Task 12: Packaged workflow E2E, accessibility, and final verification

**Files:**
- Create: `tests/fixtures/founderWorkflow/first-week-leads.csv`
- Create: `tests/support/founderWorkspace.ts`
- Create: `tests/e2e/founderWorkflow.spec.ts`
- Create: `tests/e2e/importWorkflow.spec.ts`
- Create: `tests/e2e/fridayScoreboard.spec.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `tests/shared/noBlendedScoreContract.test.ts`
- Create: `tests/support/sourceFiles.ts`
- Modify: `tests/e2e/foundation.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the completely composed packaged app, current CDP packaged-process helper pattern, isolated `--user-data-dir`, and all strict contracts.
- Produces: reproducible packaged user-flow proof, axe accessibility gate, explicit no-blended-score regression, and updated development verification documentation.

- [ ] **Step 1: Write failing packaged workflow and accessibility tests**

```ts
// tests/e2e/founderWorkflow.spec.ts
test('imports leads and opens the same person from Leads, Today, and Pipeline', async () => {
  const workspace = await launchFounderWorkspace();
  await workspace.page.getByRole('link', { name: 'Leads' }).click();
  await workspace.page.getByRole('button', { name: 'Import leads' }).click();
  await workspace.page.getByLabel('CSV file').setInputFiles(fixture('first-week-leads.csv'));
  await workspace.page.getByRole('button', { name: 'Preview rows' }).click();
  await workspace.page.getByRole('button', { name: 'Import 3 rows' }).click();
  await expect(workspace.page.getByRole('row', { name: /Kevin Shin/ })).toBeVisible();
  await workspace.page.getByRole('row', { name: /Kevin Shin/ }).click();
  await expect(workspace.page.getByRole('complementary', { name: 'Kevin Shin details' })).toBeVisible();
  await workspace.close();
});
```

```ts
// tests/e2e/accessibility.spec.ts
for (const route of ['today', 'leads', 'pipeline', 'review', 'friday']) {
  test(`${route} has no serious or critical axe violations`, async () => {
    const workspace = await launchSeededFounderWorkspace();
    await workspace.page.getByRole('link', { name: new RegExp(route, 'i') }).click();
    const results = await new AxeBuilder({ page: workspace.page }).analyze();
    expect(results.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
    await workspace.close();
  });
}
```

- [ ] **Step 2: Run RED packaged tests**

Run:

```bash
npm run package && npx playwright test tests/e2e/founderWorkflow.spec.ts tests/e2e/importWorkflow.spec.ts tests/e2e/fridayScoreboard.spec.ts tests/e2e/accessibility.spec.ts
```

Expected: FAIL because packaged workflow helpers, fixtures, and updated foundation expectations do not yet exist.

- [ ] **Step 3: Implement isolated packaged-workspace helpers and fixtures**

`launchFounderWorkspace()` follows the existing real packaged-process/CDP approach, always creates a `mkdtemp()` user-data directory, returns `{page, userDataPath, close}`, and removes only that exact temporary directory after terminating the app. `launchSeededFounderWorkspace()` uses the UI import flow; it does not copy a database or write directly to SQLite.

The CSV fixture contains one FRBO, one referral with referrer resolution, and one registry lead, with enough fields to exercise separate Fit/Timing bands, source context, and cadence assignment without containing any combined score column.

- [ ] **Step 4: Implement complete packaged flows**

Add tests for:

```text
1. Empty healthy app opens Today and health remains callable through preload.
2. CSV preview performs no writes; commit imports exactly once; relaunch preserves rows.
3. Leads row opens/resizes/closes inspector; Today and Pipeline open the same global inspector.
4. Today command refetches and keeps promised lanes above discretionary prospecting.
5. Review renders its truthful empty state and zero badge in a clean workspace; typed resolution behavior remains covered by Task 7 integration tests without a production-only fixture injection path.
6. Friday creates four job requests, fills three by contractor acceptance, displays 3 / 4 and 75%, and opens drilldown.
7. Light/dark and compact/comfortable preferences survive renderer reload.
8. Database-open failure still shows LOCAL_DATABASE_UNAVAILABLE and Retry recovers the same isolated path.
```

Update `foundation.spec.ts` to assert workflow shell visibility after health succeeds while retaining direct `window.callie.health.get()` schema/path checks.

- [ ] **Step 5: Add the no-blended-score static contract regression**

```ts
// tests/shared/noBlendedScoreContract.test.ts
const forbidden = /(^|[^a-z])(lead_?score|weighted_?score|blended_?score|fit.*timing.*sum)([^a-z]|$)/i;
const guardedFiles = await workflowSourceFiles([
  'src/shared/contracts', 'src/renderer/features/leads', 'src/renderer/features/today',
  'src/renderer/features/pipeline', 'src/renderer/features/friday',
]);
for (const file of guardedFiles) {
  expect({ file, match: forbidden.exec(await readFile(file, 'utf8')) }).toEqual({ file, match: null });
}
```

`tests/support/sourceFiles.ts` implements `workflowSourceFiles(roots)` with recursive `readdir({ withFileTypes: true })`, returns sorted `.ts`/`.tsx` paths, and ignores test files. This complements strict schema tests; it excludes the approved design/spec text and the regression test itself.

- [ ] **Step 6: Run GREEN packaged and accessibility tests**

Run:

```bash
npm run package && npx playwright test tests/e2e/foundation.spec.ts tests/e2e/founderWorkflow.spec.ts tests/e2e/importWorkflow.spec.ts tests/e2e/fridayScoreboard.spec.ts tests/e2e/accessibility.spec.ts
```

Expected: all packaged tests PASS against temporary profiles; axe reports zero serious/critical violations; relaunch persistence and database retry are proven.

- [ ] **Step 7: Update verification documentation**

Add the exact clean workflow to `README.md`:

```bash
npm ci
npm run rebuild
npm run verify
npm run verify:e2e
npm run verify:package
npm run start
```

Document that production data is never used by tests, zero-click Apple recording is not exercised by fixture E2E, and Conversations/Learnings have separate implementation plans.

- [ ] **Step 8: Run final refactor/verification gate**

Run:

```bash
npm run verify
npm run verify:e2e
npm run verify:package
git status --short
```

Expected: typecheck, lint, every Vitest suite, packaged E2E, and package verification PASS; `git status --short` lists only the intended plan/execution changes and no `out/`, temporary profile, screenshot, or trace artifact.

- [ ] **Step 9: Commit Task 12**

```bash
git add tests/fixtures/founderWorkflow tests/support/founderWorkspace.ts tests/support/sourceFiles.ts tests/e2e/founderWorkflow.spec.ts tests/e2e/importWorkflow.spec.ts tests/e2e/fridayScoreboard.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/foundation.spec.ts tests/shared/noBlendedScoreContract.test.ts README.md
git commit -m "test: verify packaged founder workflow"
```

## Completion criteria

- Every central file is changed only in Task 11, preventing parallel feature tasks from racing on startup, preload, globals, root composition, or CSS aggregation.
- Every feature has RED/GREEN unit, IPC, and integration coverage before composition.
- The packaged app supports import -> Leads -> inspector -> Today/Pipeline -> Review -> Friday/jobs -> relaunch on an isolated profile.
- Fit and Timing are always separately visible and ordered by domain-provided priority/reasons; no single or blended score exists in code, contracts, fixtures, UI, or tests.
- The encrypted domain remains the only write authority for opt-out, lifecycle, next actions, cadence, import commit, Review resolution, and job state.
- The workflow routes pass serious/critical accessibility scanning in both the component suite and packaged renderer.
