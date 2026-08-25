-- Mirrors each business's campaign window into Postgres (spec §2), so the
-- freshness window the UI shows matches what the config files define, without
-- the UI needing filesystem access.
alter table businesses
  add column if not exists campaign_start date,
  add column if not exists campaign_end   date;
