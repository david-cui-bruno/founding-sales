-- 0005_search
--
-- Indexes for CRM search (specification revision 3, section 7.2: "Search covers
-- firms, contacts, domains, addresses, and phone numbers. Filters cover owner,
-- stage, sequence status, hold reason, route eligibility, and activity date.").
--
-- Additive, and unusually so: no table, no column, no constraint and no privilege
-- change. Every index below is over a column migration 0004 already created, so this
-- file can be applied to a database an older binary is talking to without that binary
-- noticing, and `API_SCHEMA_RANGE` keeps its minimum of 4 — the search code is correct
-- without these indexes and only slow.
--
-- `pg_trgm` rather than `tsvector`. A CRM search box is asked for fragments — half a
-- firm name, a domain without its scheme, the last seven digits of a number, a street
-- without its city — and a full-text vector answers none of those: it matches whole
-- lexemes, tokenizes `+14015550187` and `north-wind.example.test` in ways nobody
-- predicts, and its prefix search still cannot find a fragment in the middle of a
-- word. A GIN trigram index accelerates the `ILIKE '%fragment%'` the search actually
-- runs. See docs/decisions/g3b-search-index.md.
--
-- `pg_trgm` is a trusted extension in PostgreSQL 13 and later, so the database owner
-- creates it without superuser; RDS lists it among the supported extensions. It is
-- created here rather than assumed, and `IF NOT EXISTS` so a database that already
-- has it is not a failure.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- The fields every active member may match on (Appendix F row 1)
-- ---------------------------------------------------------------------------
CREATE INDEX firms_name_trgm ON firms USING gin (name gin_trgm_ops);
CREATE INDEX firms_website_trgm ON firms USING gin (website gin_trgm_ops);
CREATE INDEX firms_locality_trgm ON firms USING gin (locality gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- The fields only the assignee and an admin may match on (Appendix F row 2)
-- ---------------------------------------------------------------------------
CREATE INDEX firms_address_line_trgm ON firms USING gin (address_line gin_trgm_ops);
CREATE INDEX firms_postal_code_trgm ON firms USING gin (postal_code gin_trgm_ops);
CREATE INDEX contacts_full_name_trgm ON contacts USING gin (full_name gin_trgm_ops);
CREATE INDEX email_addresses_address_trgm ON email_addresses USING gin (address gin_trgm_ops);
CREATE INDEX phone_routes_e164_trgm ON phone_routes USING gin (e164 gin_trgm_ops);

-- Aliases carry the spellings and identifiers a merge preserved, so a search that
-- did not read them would stop finding a firm the moment somebody merged it.
CREATE INDEX record_aliases_alias_value_trgm ON record_aliases USING gin (alias_value gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- The filters
--
-- Stage, owner and route eligibility are served by keys migration 0004 already has
-- (`opportunities_one_open_per_firm`, `phone_routes_usable_by_firm`, the firm primary
-- key). The hold-reason filter had nothing: `active_holds` is keyed by id, and the
-- question search asks it is "which firms in this workspace are held, and why",
-- restricted to the holds that have not been released.
-- ---------------------------------------------------------------------------
CREATE INDEX active_holds_open_by_firm
  ON active_holds (workspace_id, scope_key, reason_code)
  WHERE scope_kind = 'firm' AND released_at IS NULL;

-- Activity date reads the two history tables a firm accumulates today. Migration
-- 0004 already keys evidence by (workspace_id, firm_id, retrieved_at DESC); stage
-- events are keyed by opportunity, and the activity window asks about the firm.
CREATE INDEX opportunity_stage_events_by_firm
  ON opportunity_stage_events (workspace_id, firm_id, occurred_at DESC);
