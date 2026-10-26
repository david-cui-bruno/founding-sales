# Callie founder sales

Callie is a browser-first founder sales workspace with a retained Electron desktop fallback. It reuses the React presentation, authenticated API, domain rules, worker and PostgreSQL rather than introducing a second product engine.

## Start here

- **[Canonical feature and journey map](docs/features/README.md):** user goals, actual navigation, source owners, existing verification harnesses, persisted-effect checks and explicit gaps. Start here for discovery, reproduction or acceptance.
- [Current operating state](docs/operations/current-state.md): dated production and activation status, not a second spec.
- [Browser PLAN](apps/web/PLAN.md): finite remaining outcomes and retained historical evidence. [GitHub issue conventions](docs/agents/issue-tracker.md) locate specifications/tickets.
- [Roadmap](docs/sourcing/roadmap-20261007.md): priorities and full scope, not a duplicate execution ledger.
- [Daily selling guide](docs/operations/how-to-sell.md), [domain](docs/agents/domain.md), [glossary](GLOSSARY.md) and [ADRs](docs/adr/).

## Product direction and honest limits

The approved direction is continuous prepared prospect/contact supply, browser-first calling and follow-through, eligible automatic outbound email with manual incoming replies, and founder-voice social generation with supported automatic publishing and public Conversations. Conversations are public threads, not DMs. Incremental releases do not narrow full-product acceptance or claim missing adapters are ready.

The current browser shell has Today, Prospects, Calling, Email and Social, with secondary Settings. Existing CRM records, plain keyword Ask, retained human work, meetings, sequences and owner controls remain supported through their existing surfaces where available, including desktop fallback. The map labels browser gaps instead of inventing menu items.

Historical removal of generated Ask answers/indexing, AI booking, older automatic-admission or recurring-posting modules is not a permanent ban on approved replacement email/social capability. Plain Ask does not generate answers. Automatic incoming replies, booking and coaching remain deferred. No implementation or documentation change grants outreach, capture, model, publishing or provider permission.

## Development and verification

Use Node24 and the root npm workspace. Existing commands:

```sh
npm ci
npm run typecheck
npm run lint
npm run test
```

Choose changed-path checks from the [verification guide](docs/features/verification.md), not a new full-product proof campaign. The [existing synthetic browser launcher](apps/web/scripts/localdemo.md) documents isolated setup, fictional data, finite lifetime and exact-owned cleanup. Retained acceptance is not fresh evidence or live-model/provider usefulness.

## Production and contribution

**[Lean release workflow](docs/operations/lean-release-workflow.md) is the sole supported production execution entrypoint.** [Release invariants](docs/greenfield/release.md) explain safety constraints, not an alternative local-write recipe. Stored owner OFF and newer stops survive releases. Source/deployment is not activation.

Follow [AGENTS](AGENTS.md) and the [review skill](.jcode/skills/fss-review/SKILL.md). Ordinary changes receive one combined correctness/simplicity review, specialists cover actual risks, and hard gates/in-flight reviews remain. Update affected map/drive links in the feature change. Keep one outcome per small reversible PR, reuse applicable evidence, and remove stale narrative without deleting legal/tool directives or non-obvious safety rationale.
