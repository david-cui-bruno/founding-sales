-- ---------------------------------------------------------------------------
-- 0023_email_presentation.sql — the stop line goes; the word ban becomes a link ban
-- changes: hold_reason_codes, template_versions, outbound_messages
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
-- other phrases — `opt out`, `optout`, `remove me`, `stop receiving`, `stop these
-- emails|messages`, `no longer receive`, `list-manage`, `manage (your) preferences` —
-- were never refused, so they are the only way a row could fail, and only when a URL or
-- `mailto:` is on their line or on the line touching it:
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
-- The **one** class the argument above does not settle is a body whose copy mentions
-- opting out near an unrelated link ("You can opt out by replying. Our website is
-- https://firm.example"): that is a deliberate refusal of this rule, not an accident of
-- it, and it would be found by the count below rather than argued about.
--
-- Read-only and exact, before the release — the function is created above, so this runs
-- as written once (b) has been applied to a copy, or with the function alone applied to
-- production. Both counts must be 0, and `VALIDATE CONSTRAINT` below asks the same
-- question of the same rows:
--
--   SELECT count(*) AS refused FROM template_versions
--    WHERE email_has_optout_link(body) OR email_has_optout_link(subject);
--   SELECT count(*) AS refused FROM outbound_messages
--    WHERE email_has_optout_link(body) OR email_has_optout_link(subject);
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
-- (a) A hold reason of its own, so the operator can read why a send stopped
-- ---------------------------------------------------------------------------
-- The composition, the step and the fence all refuse final bytes carrying a visible
-- opt-out link, and each of those is a handled hold. Held under `template_unapproved`
-- the operator would see an approved template stop with no way to tell this from a
-- footer Callie could not account for, so it gets its own code (review of PR 311,
-- second round). Recoverable: the fix is to edit the template, the sign-off or the
-- firm's website and resume.
INSERT INTO hold_reason_codes (code, description, recoverable) VALUES
  ('optout_link', 'The bytes that would leave carry a visible opt-out link.', true);

-- ---------------------------------------------------------------------------
-- (b) The mandatory stop line
-- ---------------------------------------------------------------------------
-- Already dropped by 0019; stated here because this file is the decision.
ALTER TABLE template_versions DROP CONSTRAINT IF EXISTS template_versions_approved_has_stop_line;

-- ---------------------------------------------------------------------------
-- (c) The word ban becomes a link ban
-- ---------------------------------------------------------------------------
-- The rule, as David decided it on 29 September 2026 after the review of PR 311:
--
--   A visible opt-out link is a URL or `mailto:` on the **same line as, or on the line
--   immediately before or after**, an opt-out phrase.
--
-- Bodies are plain text and a subject is one line, so that is what "a link and its
-- label" means here: a label above its link, a link above its label, or both in one
-- sentence. The phrases are `unsubscribe`, `opt out` / `opt-out` / `optout`,
-- `remove me`, `stop receiving`, `stop these emails|messages`, `no longer receive`,
-- `list-manage`, `manage (your) preferences`. The bare word is allowed: "just reply
-- unsubscribe and I'll stop" is the sentence the old CHECK made unwritable, and it is
-- the sentence the product wants.
--
-- Before matching, the text is normalised, in this order: NFKC, then every named dash
-- to `-`, then every named space to ` `, then the 26 ASCII capitals to their lower-case
-- letters. The newline is never folded — the rule counts lines.
--
-- The case step is a `translate()` and **not** `lower()`, which is locale-dependent:
-- under a Turkish collation `lower()` and JavaScript's `toLowerCase()` disagree about
-- `I`, and the database and the Mac would be applying two different rules (review of
-- PR 311, second round). Every phrase is ASCII and NFKC has already folded a full-width
-- letter into an ASCII one, so 26 pairs are the whole of the case rule.
--
-- `normalize(…, NFKC)` requires a UTF8 database. That is asserted in
-- `packages/domain/db/migrationRunner.ts`, which reads `server_encoding` once and
-- refuses before it applies anything — not with a `RAISE` here, because the release
-- helper reads a `RAISE` in a migration as "this file needs a preflight of its own".
--
-- The *same four steps over the same code points* are
-- `normalizeForOptOutRule` in `packages/contracts/src/templates.ts`, and
-- `packages/domain/test/db/support/optOutLinkCases.ts` is one table of examples run
-- against this function and against `hasOptOutLink` in the same assertion
-- (`test/db/optOutLink.test.ts`), so the two spellings cannot drift.
--
-- What this rule cannot see, and we accept:
--
--   * **A bare shortener.** `https://short.example/a` with no phrase near it passes: the
--     stored bytes cannot say where it redirects. David writes the copy, and the
--     approval names the rule when it refuses.
--   * **A confusable letter.** NFKC folds a non-breaking hyphen and a full-width space;
--     it does not fold a Cyrillic `О` into a Latin `O`.
--   * **A false refusal, deliberately.** "You can opt out by replying. Our website is
--     https://firm.example" *is* refused, although the website is unrelated. A rule that
--     could tell those apart is not a rule a CHECK can apply. The fix for a false
--     refusal is a **blank line** between the unrelated URL and the opt-out phrase: a
--     line that merely touches the phrase is adjacent, and adjacency is the rule.
--
-- A function inside a CHECK has a precedent in this schema: `funnel_facts_detail_coded`
-- (0022) and `today_lane_of_kind` (0008), declared the same way — `LANGUAGE sql
-- IMMUTABLE STRICT`. IMMUTABLE is what makes it legal in a CHECK at all, and it is
-- honestly immutable: it reads nothing but its argument. One function rather than four
-- inline predicates is also the only way the two tables can be said to carry the *same*
-- rule rather than two copies of it.
CREATE FUNCTION email_has_optout_link(candidate text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT translate(
           translate(
             translate(
               normalize(candidate, NFKC),
               -- U+002D U+058A U+05BE U+1806 U+2010..U+2015 U+2212 U+2E3A U+2E3B
               -- U+301C U+3030 U+FE58 U+FE63 U+FF0D
               U&'\002D\058A\05BE\1806\2010\2011\2012\2013\2014\2015\2212\2E3A\2E3B\301C\3030\FE58\FE63\FF0D',
               '------------------'),
             -- U+0009 U+0020 U+00A0 U+1680 U+2000..U+200B U+202F U+205F U+3000
             U&'\0009\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\200B\202F\205F\3000',
             '                   '),
           'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') ~ ('(?:unsubscribe|opt[ -]?out|remove me|stop receiving|stop these (?:emails|messages)'
              || '|no longer receive|list-manage|manage (?:your )?preferences)'
              || '[^\n]*(?:\n[^\n]*)?(?:https?://|www\.|mailto:)'
              || '|(?:https?://|www\.|mailto:)[^\n]*(?:\n[^\n]*)?'
              || '(?:unsubscribe|opt[ -]?out|remove me|stop receiving|stop these (?:emails|messages)'
              || '|no longer receive|list-manage|manage (?:your )?preferences)')
$$;

COMMENT ON FUNCTION email_has_optout_link(text) IS
  'A visible opt-out link: a URL or mailto: on the same line as, or the line touching, an opt-out phrase. Mirrored by hasOptOutLink in @fss/contracts.';

ALTER TABLE template_versions DROP CONSTRAINT IF EXISTS template_versions_no_unsubscribe_link;
ALTER TABLE template_versions
  ADD CONSTRAINT template_versions_no_optout_link
    CHECK (NOT email_has_optout_link(body) AND NOT email_has_optout_link(subject)) NOT VALID;
ALTER TABLE template_versions VALIDATE CONSTRAINT template_versions_no_optout_link;

ALTER TABLE outbound_messages DROP CONSTRAINT IF EXISTS outbound_messages_no_unsubscribe_link;
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_no_optout_link
    CHECK (NOT email_has_optout_link(body) AND NOT email_has_optout_link(subject)) NOT VALID;
ALTER TABLE outbound_messages VALIDATE CONSTRAINT outbound_messages_no_optout_link;
