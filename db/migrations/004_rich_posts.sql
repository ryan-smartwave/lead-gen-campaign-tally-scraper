-- Rich post fields (Instagram capture) + campaign-freshness tally column.
alter table posts
  add column if not exists username      text,
  add column if not exists caption       text,
  add column if not exists image_url     text,
  add column if not exists like_count    integer,
  add column if not exists comment_count integer,
  add column if not exists taken_at      timestamptz,
  add column if not exists enriched_at   timestamptz;

alter table tallies
  add column if not exists fresh_posts integer not null default 0;
