# Domain Docs

This repo uses a single shared domain context across its API, worker, desktop app and packages. Domain terms belong in root `GLOSSARY.md`; architecture decisions belong in root `docs/adr/`.

## Before exploring

- Read root `GLOSSARY.md` for shared domain vocabulary.
- Read the ADRs in `docs/adr/` that touch the area being explored.

If either is absent, proceed silently. The domain-modeling skill creates these documents as terms or decisions are resolved; setup does not create placeholder glossaries or ADRs.

## File structure

```text
/
├── GLOSSARY.md
├── docs/adr/
├── apps/
└── packages/
```

## Use the glossary's vocabulary

Use terms defined in `GLOSSARY.md` when naming domain concepts in issues, proposals, hypotheses and tests. If a needed term is missing, check existing project usage and note a real gap for domain-modeling.

## Flag ADR conflicts

When a proposal contradicts an existing ADR, name the ADR and explain why its decision should be reconsidered. Keep the original decision visible rather than silently overriding it.
