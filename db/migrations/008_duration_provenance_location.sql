-- How long each hashtag visit took, per tally row.
alter table tallies add column if not exists duration_seconds integer;

-- Per-field provenance on posts: for each nullable rich field, which passive
-- source supplied the value (capture / prop / dom / derived-* / enrichment),
-- or "missed:<sources tried>" when everything came up empty. Null on rows
-- recorded before this existed — honest "unknown".
alter table posts add column if not exists field_sources jsonb;

-- Campaign country (reporting metadata; default matches every existing
-- campaign) and an optional Facebook geo place id. When set, FB searches carry
-- FB's own tagged-location filter — city/metro granularity only; country-level
-- ids are not honored by that filter (verified live 2026-08-29).
alter table campaigns add column if not exists country text not null default 'Philippines';
alter table campaigns add column if not exists fb_location_id text;
