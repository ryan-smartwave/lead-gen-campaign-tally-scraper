-- Allow 'service' as a run source.
--
-- Runs used to be started either from a terminal ('cli'), from the web app
-- importing the scraper in-process ('web'), or backfilled from files ('import').
-- The scraper is now a service that starts runs itself, and the old check
-- constraint rejected that value — which meant the very first database write of
-- a service-driven run failed, and took the service down with it.
--
-- 'web' is kept so existing rows remain valid.

alter table runs drop constraint if exists runs_source_check;

alter table runs
  add constraint runs_source_check
  check (source in ('service', 'cli', 'import', 'web'));
