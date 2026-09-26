# G9: Won and Lost cannot be renamed, reordered or retired

**Date:** 20 September 2026 · **Lane:** G9 · **Spec:** 8.1, 7.2

Section 8.1: "Admins may rename, reorder, add, or retire nonterminal stages. Won and
Lost are terminal."

The sentence is grammatically ambiguous about how far *nonterminal* reaches. It
plainly governs "retire". Whether it governs "rename" is arguable: renaming Won to
"Closed won" changes a label and nothing else, and an admin might reasonably want to.

All four verbs refuse a terminal stage.

## Why the strict reading

Three things find the terminal stages by `terminal_kind` rather than by key or
position: `changeStage` closes an opportunity when the target stage has one,
`reopenOpportunity` starts a reopened opportunity at the first *non*-terminal
unretired stage, and `pipeline_stages_one_per_terminal_kind` keeps exactly one of
each. None of those reads `display_name`, so a rename is genuinely harmless *today* —
and that is the whole argument for allowing it.

Against: the specification is silent, COMMON-G says choose the conservative option
under silence, and the cost of the strict reading is that an admin cannot change two
words. The cost of the permissive one is a pipeline whose terminal stages are called
something else, in a system where "Won and Lost are terminal" is a sentence other
code depends on being recognisable to a person reading a board.

`retirePipelineStage` additionally refuses the *last* unretired nonterminal stage,
which the specification does not mention at all. Without it, `reopenOpportunity`
refuses every reopen with `stage_unknown` — a refusal whose cause is three commands
and possibly three weeks away from its symptom.

## If this is wrong

It is one branch. `if (stage.terminal_kind !== null) return refuse('stage_terminal')`
in `renamePipelineStage`, and the reorder's rejection of a list containing a terminal
key. Both are named in `packages/domain/test/crm/pipelineAdmin.test.ts`, so changing
the decision changes an assertion rather than a behaviour nobody notices.
