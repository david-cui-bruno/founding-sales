# G3b: trigram, not tsvector

**Date:** 20 September 2026 · **Lane:** G3b CRM surface · **Spec:** 7.2

Section 7.2 asks for search over "firms, contacts, domains, addresses, and phone
numbers" and leaves the mechanism open. The brief asked for the choice and a note.

## The choice

`pg_trgm` GIN indexes over the columns, and `ILIKE '%fragment%'` in the query.
Migration `0005_search.sql`.

## Why not full text

A `tsvector` index matches *lexemes*. Every question this search box is actually
asked is a fragment:

* half a firm name — "orthwind" for *Northwind Test Holdings*, because the person
  is not sure whether it is one word or two;
* a domain without its scheme — "northwind.example.test" against
  `https://northwind.example.test`, which `to_tsvector('english', …)` splits into
  a `host` token whose spelling depends on the parser's opinion about what a URL is;
* the last seven digits of a number — "5550187" against `+14015550187`, which the
  default parser keeps as one `uint` token and will not prefix-match from the middle;
* part of a street — "Sample" in "14 Sample Way", which full text does handle, and is
  the only one of the four that it does.

Prefix search (`fragment:*`) fixes none of them except the first, and only when the
fragment starts the word. A CRM search box that cannot find a firm from the middle of
its name is a search box people stop using, and the fallback they reach for is a
sequential `ILIKE` with no index at all.

Trigram indexes accelerate exactly the `ILIKE '%…%'` the code writes, over every one
of those columns, with no query rewriting and no stemming dictionary to configure per
language. Ranking is not needed: results are ordered by firm name, because a person
searching a CRM of a few thousand firms wants a stable alphabetical list rather than
a relevance guess.

## What it costs

* A trigram index is larger than a btree and slower to update. Firms, contacts and
  routes are written by a person or by a research provider a few times a minute at
  most; this is not a write-heavy path.
* A fragment shorter than three characters cannot use the index and degrades to a
  scan. Acceptable at this size, and the limit (`MAX_SEARCH_LIMIT`, 500) bounds the
  work.
* The extension has to exist. `pg_trgm` is *trusted* in PostgreSQL 13 and later, so
  the database owner creates it without superuser, and RDS lists it among the
  supported extensions. The migration creates it with `IF NOT EXISTS` rather than
  assuming it.

  **This is the first migration that needs more than table privileges, and it is a
  deployment prerequisite worth naming.** `CREATE EXTENSION` on a trusted extension
  requires `CREATE` on the database — the owner, or `rds_superuser`. Migration 0001
  creates `migration` as a `NOLOGIN` role and grants it table privileges; whoever the
  deployment actually connects as has to own the database, which on RDS the master
  user does. In the test harness migrations run as the database owner, so the local
  and CI gates prove the statement works but not that the production role may run it.
  If the infrastructure lane ever narrows the migration login below owner, this line
  is what breaks, and it breaks loudly at migrate time rather than quietly at query
  time.

## The schema range did not move

Migration 0005 adds no table, no column and no constraint — only indexes and the
extension. `searchFirms` is correct without them and merely slower, so
`API_SCHEMA_RANGE.minimum` stays at 4 and only the maxima move to 5. An old API
talking to a database that has had 0005 applied is fine, which is the case
Appendix G 22 cares about.

## If this stops being enough

The next step is a materialized `search_document` column per firm with a
`GIN (search_document gin_trgm_ops)` index, maintained by a trigger, so one index
answers a term instead of eight. That is a real migration with a backfill, and it is
not worth its cost until the eight-way `OR` shows up in a slow-query log.
