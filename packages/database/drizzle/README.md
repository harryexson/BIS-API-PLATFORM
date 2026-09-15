# Migration history — consolidated 2026-09-15

This migration history was reset to a single baseline
(`0000_baseline.sql`) because the previous one (13 files, `0000` through
`0012`) had diverged in a way `drizzle-kit` could not safely recover
from on its own. **The live database was not touched to make this
change** — only the migration *files* in this repo changed. See
"Reconciling the live database" below for the one follow-up step this
still requires, and why it's deliberately not done here.

## What was wrong

- `drizzle/meta/` only had snapshot files for migrations `0000` and
  `0001`, even though SQL files existed through `0012`. Snapshots are
  what `drizzle-kit generate` diffs the current schema against — past
  `0001`, it had no accurate picture of the schema, and would prompt
  with nonsensical rename suggestions for columns that already existed
  (confirmed live: it offered to satisfy `tenants.country_code` by
  *renaming* `tenants.application_id`, `tenants.domain`, or
  `tenants.settings` — none of which exist on that table). Accepting
  such a prompt would have generated a destructive, wrong migration.
- The live database's own `drizzle.__drizzle_migrations` tracking table
  had rows that don't line up with these files by timestamp — some
  migrations (`consent_records`, `messaging_profiles`, and others) were
  applied to the live database directly via raw SQL rather than through
  `drizzle-kit migrate`, so the bookkeeping table and the repo's files
  drifted apart independently of the missing-snapshot problem above.

Practical impact of both: a fresh deployment running `drizzle-kit
migrate` against an empty database could not be trusted to produce the
current schema, and `drizzle-kit generate` could not be trusted to
produce a correct next migration.

## What changed

- The old `0000`–`0012` SQL files and their (incomplete) `meta/`
  snapshots are preserved, unchanged, in
  `_archive_pre_baseline_2026-09-15/` — nothing was deleted, only moved.
  Kept for history/reference; not used by any tooling going forward.
- `0000_baseline.sql` (and its matching `meta/0000_snapshot.json`) is a
  single, fresh `drizzle-kit generate` output from the *current*
  `src/schema/index.ts` — i.e. it creates all 28 tables the application
  code actually reads and writes today, from nothing.
- **Verified against the live database before committing**, table by
  table (via direct schema introspection, not by assumption): the
  live database has exactly 30 tables in `public` — the 28 this
  baseline creates, plus the two orphaned ones described below. Spot-
  checked column-for-column (`tenants`, `applications`, `users`,
  `provider_configs`) — every column, type, nullability, default,
  index, and foreign key matched exactly; the only difference was
  column *order*, which Postgres doesn't attach meaning to.

## Two tables this baseline does not create

`checkout_sessions` (1 row) and `webhook_jobs` (0 rows) exist in the
live database but have no corresponding file under `src/schema/` and no
reader/writer anywhere in this codebase (confirmed by a full-repo
search). They predate current schema management and are not part of
`drizzle-kit`'s picture of the schema at all — this baseline neither
creates nor drops them. They're being left alone rather than deleted:
low-risk either way given they're nearly empty, but dropping a table
is the one direction that can't be undone, and confirming they're
truly dead (not, say, a payments-checkout feature paused mid-build)
deserves a human decision, not an inference from this pass.

## Reconciling the live database

A **fresh** deployment (`drizzle-kit migrate` against an empty
database) now works correctly against `0000_baseline.sql` — that part
of the original gap is closed.

The **existing live database** (already has all 28 tables, obviously)
still has the old, inconsistent set of rows in
`drizzle.__drizzle_migrations` (14 rows, not lining up cleanly with any
single set of local files). That table is Drizzle's own bookkeeping,
not application data — but updating it is still a live-database write,
and this pass deliberately stopped short of making it without a human
in the loop first. Once approved, reconciling it is a single, low-risk
statement: delete the existing rows and insert one row recording
`0000_baseline` as applied (using the hash `drizzle-kit` computed into
`meta/0000_snapshot.json`), so a future `drizzle-kit migrate` against
*this* database correctly sees "already up to date" instead of trying
to re-run (or erroring on) 14 stale entries.
