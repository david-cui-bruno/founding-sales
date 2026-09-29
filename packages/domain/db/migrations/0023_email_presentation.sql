-- ---------------------------------------------------------------------------
-- 0023_email_presentation.sql — the stop line goes; the word ban becomes a link ban
-- changes: template_versions, outbound_messages
--
-- David, 29 September 2026: "The presentation decisions are now settled: remove the
-- mandatory Reply-stop footer and remove the blanket database ban on the word
-- 'unsubscribe.' Inspect the constraints and their callers before migrating them. Keep
-- the no-visible-opt-out-link rule, automatic handling of stop requests in ordinary
-- language, and eligibility/suppression checks."
--
-- Why: the stop line was a product decision and it has been reversed; the word ban
-- banned "reply unsubscribe", which is the very thing Callie wants to be able to
-- write. `docs/greenfield/decisions/email-presentation-20260929.md`.
--
-- A contract migration, like 0015, 0018, 0019 and 0021: both service ranges move to
-- {23, 23} (`packages/domain/db/schemaRange.ts`) and the release is a stop-migrate-start
-- one. The brief asked for a provisional 0024; the runner refuses a gap
-- (`MIGRATION_VERSIONS_NOT_CONTIGUOUS`, `migrationRunner.ts`), and 0022 is the last file
-- on main, so this is 0023. The coordinator renumbers it at merge if another 0023 lands
-- first.
--
-- ## What the inspection found (at 043f84e4, before anything here was written)
--
-- Four constraints carry the two rules. Two of them are already gone:
--
--   * `template_versions_no_unsubscribe_link` (0009, line 592) — LIVE.
--     `CHECK (body !~* 'unsubscribe' AND subject !~* 'unsubscribe')`. The *word*, in any
--     case, anywhere. This is the one David is reversing.
--   * `outbound_messages_no_unsubscribe_link` (0010, line 404) — LIVE. The same
--     predicate over the bytes that actually leave.
--   * `template_versions_approved_has_stop_line` (0009, line 594) — ALREADY DROPPED by
--     0019 (line 336), in the same statement block that dropped the approved-version
--     immutability trigger, so an approved row can be edited in place. It is dropped
--     again below, `IF EXISTS`, so this file states the decision rather than relying on
--     a reader remembering 0019. No row is read or rewritten by that statement.
--   * `sequence_steps_no_unsubscribe_link` (0012, line 298) — ALREADY DROPPED by 0018
--     (line 345) together with `sequence_steps.linkedin_message`, the column it guarded
--     (`docs/archive/decisions/g8-linkedin-text-is-not-a-template.md`). There is nothing
--     left of it, so `sequence_steps` is **not** in this file's `changes:` line.
--
-- There is no approved-version immutability trigger left to work around (0019 dropped
-- `template_versions_approved_immutable` and `assert_approved_template_immutable()`).
-- This file rewrites no row of any table: it drops constraints and adds constraints.
--
-- The callers that name these constraints or the stop line, all of which move in the
-- same pull request: `packages/domain/src/rules/templates.ts` (the composition and
-- approval rule), `packages/domain/templates/templates.ts` (the save's own refusal,
-- `invalid_input`), `packages/contracts/src/templates.ts` (`SENDING_STOP_LINE`, now
-- legacy bytes recognised at the end of an older body so the composition can *replace*
-- them, and the new `NO_OPTOUT_LINK_RULE`/`hasOptOutLink`), the Mac
-- (`apps/desktop/src/renderer/sequenceView.ts`, `sequences/TemplateForm.tsx`,
-- `sequences/SequencesRoute.tsx`, `settingsView.ts`, `shared/operations.ts`), and the
-- tests: `apps/api/test/{sequences,wire/sequences}.test.ts`,
-- `apps/desktop/test/{founderGaps,sequences}.test.ts` and `test/support/sequenceAnswers.ts`,
-- `apps/worker/test/{enrollmentMetrics,schemaPreflight0020,sequenceAction,workerWiring}.test.ts`,
-- `packages/domain/test/db/support/{mailCases,outboundCases,sequenceCases}.ts`,
-- `packages/domain/test/domain/rules.test.ts`,
-- `packages/domain/test/sequences/{schema,workflow,footerAtSend}.test.ts` and
-- `test/sequences/support/sequenceFixtures.ts`, `packages/domain/test/outbound/footerAtSend.test.ts`.
--
-- ## What a production-shaped database could hold that the new CHECKs would refuse
--
-- Expected: **no rows at all**, and the reason is the constraint being replaced. Both
-- tables have refused the substring `unsubscribe`, case-insensitively, in body and
-- subject since the tables were created, so no stored row can carry it. The new rule's
-- other words — `opt out`, `optout`, `remove me`, `list-manage`, `mailto:` — were never
-- refused, so they are the only way a row could fail, and only when a URL shares the
-- same line with one of them:
--
--   * `template_versions`: bodies are written by hand in the Mac's template form by the
--     one operator, and a body with more than one link is already advised against
--     (a warning, `template_body_multiple_urls`). A line like "to opt out click
--     https://…" is precisely what nobody has written, because the footer said "reply
--     stop" instead.
--   * `outbound_messages`: every body is a render of an approved template plus the
--     footer composed at send. The footer is the workspace sign-off and, since 0020,
--     the `postal_address` setting — and that setting already refuses a link, markup
--     and the word `unsubscribe` (`packages/contracts/src/settings.ts`). So a fence can
--     only carry what its template carried.
--
-- Read-only, before the release, if the operator wants the count rather than the
-- argument (both should be 0):
--
--   SELECT count(*) FROM template_versions
--    WHERE body ~* '(https?://|www\.)[^\n]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)|(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)[^\n]*(https?://|www\.)|mailto:[^[:space:]]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me)'
--       OR subject ~* '…the same…';
--   -- and the same two columns of outbound_messages.
--
-- Approved template versions carrying the old stop line stay valid: the line is a
-- sentence, not a link, and nothing here refuses it. They lose it at the next send,
-- where `composeSendBody` recognises the pre-0023 block and replaces it — no row is
-- edited by this file.
--
-- ## The lock, and what NOT VALID does and does not buy here
--
-- `ADD CONSTRAINT … CHECK … NOT VALID` writes the catalogue row without scanning the
-- table; `VALIDATE CONSTRAINT` then does the scan under SHARE UPDATE EXCLUSIVE instead
-- of ACCESS EXCLUSIVE. `outbound_messages` is the table that grows, so that is the right
-- shape for it, and the validation still refuses this migration if a row violates the
-- rule — which is the point of running it now rather than leaving the constraint
-- `NOT VALID` for ever.
--
-- Said plainly, because it would be easy to claim more than is true: the runner applies
-- each file inside one transaction (`migrationRunner.ts`), so the ACCESS EXCLUSIVE lock
-- the `ADD` takes is held until this file commits, validation included. The two
-- statements are separate so the scan can be moved out of the exclusive path the day
-- that matters, and because this release stops both services first anyway
-- (`deploy.sh release --schema-change`), nothing is waiting on the lock while it runs.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- (a) The mandatory stop line
-- ---------------------------------------------------------------------------
-- Already dropped by 0019; stated here because this file is the decision.
ALTER TABLE template_versions DROP CONSTRAINT IF EXISTS template_versions_approved_has_stop_line;

-- ---------------------------------------------------------------------------
-- (b) The word ban becomes a link ban
-- ---------------------------------------------------------------------------
-- Bodies and subjects are plain text, so a *visible opt-out link* is a URL. Refused,
-- case-insensitively: a URL whose own text carries one of the opt-out words, and any
-- single line carrying both a URL and one of those words, in either order. The bare
-- word is allowed: "just reply unsubscribe and I'll stop" is a sentence we want.
-- The same two shapes are spelled once in TypeScript as `OPT_OUT_LINK_PATTERN`
-- (`packages/contracts/src/templates.ts`), which is what the Mac and the save refuse
-- with, so no path offers an approval this database would answer with a 500.
ALTER TABLE template_versions DROP CONSTRAINT IF EXISTS template_versions_no_unsubscribe_link;
ALTER TABLE template_versions
  ADD CONSTRAINT template_versions_no_optout_link
    CHECK (
      body !~* '(https?://|www\.)[^\n]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)|(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)[^\n]*(https?://|www\.)|mailto:[^[:space:]]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)'
      AND subject !~* '(https?://|www\.)[^\n]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)|(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)[^\n]*(https?://|www\.)|mailto:[^[:space:]]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)'
    ) NOT VALID;
ALTER TABLE template_versions VALIDATE CONSTRAINT template_versions_no_optout_link;

ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_no_unsubscribe_link;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_no_optout_link
    CHECK (
      body !~* '(https?://|www\.)[^\n]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)|(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)[^\n]*(https?://|www\.)|mailto:[^[:space:]]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)'
      AND subject !~* '(https?://|www\.)[^\n]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)|(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)[^\n]*(https?://|www\.)|mailto:[^[:space:]]*(unsubscribe|opt[-_ ]?out|optout|remove[-_ ]?me|list-manage)'
    ) NOT VALID;
ALTER TABLE outbound_messages VALIDATE CONSTRAINT outbound_messages_no_optout_link;
