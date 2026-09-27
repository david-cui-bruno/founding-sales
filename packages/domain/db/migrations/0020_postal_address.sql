-- ---------------------------------------------------------------------------
-- 0020_postal_address.sql — the postal address is a setting again (lane W3-F)
--
-- David decided on 22 September 2026 that an automated email carries no postal
-- address; migration 0015 dropped `template_versions.footer_postal_address` and
-- narrowed the settings CHECK. `docs/archive/decisions/g20-automated-email-carries-
-- no-postal-address.md` says how that is undone: "reversing it is a new migration,
-- not a revert". This is that migration, and it does exactly what the sentence
-- allows — it admits one new **settings key**. The dropped column does not come
-- back, no approved template gains a column, and no row is rewritten.
--
-- ## Additive only
--
-- One statement of substance: `workspace_settings_key_known` is replaced by the
-- same CHECK with `postal_address` added. Nothing is dropped, nothing is deleted,
-- no data moves. A row that satisfied the old CHECK satisfies this one, so the
-- replacement validates every existing row and cannot fail on data.
--
-- ## Why it is still a schema release
--
-- `packages/domain/db/schemaRange.ts` moves to {20, 20} in the same release, as
-- every release since 0006 has: an image only ever meets its own schema. The API
-- of schema 19 would refuse a `postal_address` write with `invalid_value` (the key
-- is not in its `SETTING_KEYS`), and the database of schema 19 would refuse one
-- from a schema-20 API with this very CHECK, so the two ranges must not overlap.
-- `infra/scripts/deploy.sh release --schema-change` stops both services, applies
-- this, and starts the new images.
--
-- ## What the release does *not* need
--
-- Nothing to backfill: a workspace with no `postal_address` row has none, and the
-- default (`DEFAULT_SETTING_VALUES`) is `{"address": null}` — no address, which
-- composes today's footer, the sign-off and the stop line. Sending does not stop
-- and no approval is invalidated: the footer is composed at send from system text,
-- so the words an approver approved are unchanged
-- (`packages/domain/src/rules/templates.ts`, `packages/domain/outbound/footer.ts`).
--
-- `fss admin schema-preflight 0020` counts what this release will meet — the
-- settings rows by key, the unsent fences whose footer will be recomposed, the
-- templates whose legacy block will be deduped — and refuses only if a body would
-- pass 4,000 characters once composed.
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_settings
  DROP CONSTRAINT workspace_settings_key_known,
  ADD CONSTRAINT workspace_settings_key_known
    CHECK (setting_key IN ('business_time_zone', 'postal_address', 'sending_enabled'));
