-- Campaign tally schema.
--
-- Design notes worth keeping in view while reading:
--
-- * runs.id IS the run's ISO-8601 start timestamp. That is already the join key
--   in the scraper's own files, and ISO text sorts chronologically, so
--   "order by id desc" is "newest first" and re-import is a pure upsert.
--
-- * posts is keyed by (platform, hashtag, post_id) and NOT by (platform,
--   post_id). The same post legitimately carries several campaign hashtags —
--   in the first real run, 174 tallied records were only 159 distinct posts.
--   Deduping globally would silently under-count every hashtag after the first.
--
-- * campaign_day is computed in JS (Asia/Manila) and passed in. It is not a
--   generated column because Postgres requires IMMUTABLE expressions there and
--   "timestamptz at time zone text" is only STABLE.

create table if not exists schema_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists runs (
  id             text primary key,
  campaign       text        not null,
  started_at     timestamptz not null,
  campaign_day   date        not null,
  finished_at    timestamptz,
  heartbeat_at   timestamptz not null default now(),
  status         text        not null
                 check (status in ('running','complete','aborted','budget_stopped','stopped')),
  abort_reason   text,
  budget_minutes integer,
  targets        jsonb       not null default '[]'::jsonb,
  source         text        not null default 'web'
                 check (source in ('web','cli','import')),
  imported       boolean     not null default false
);

-- Single-flight at the database level: at most one run may be 'running'.
create unique index if not exists runs_one_running on runs (status) where status = 'running';
create index if not exists runs_day_desc on runs (campaign_day desc, id desc);

create table if not exists tallies (
  run_id            text    not null references runs(id) on delete cascade,
  platform          text    not null check (platform in ('instagram','facebook')),
  hashtag           text    not null,
  campaign_day      date    not null,
  visit_seq         integer,
  -- null means never counted (an error or abort). 0 means the page had none.
  posts_on_page     integer,
  new_posts         integer not null default 0,
  cumulative_unique integer not null default 0,
  status            text    not null check (status in ('ok','empty','error','aborted')),
  message           text,
  primary key (run_id, platform, hashtag)
);

create index if not exists tallies_series on tallies (platform, hashtag, campaign_day);
create index if not exists tallies_day on tallies (campaign_day desc);

create table if not exists posts (
  platform      text        not null check (platform in ('instagram','facebook')),
  hashtag       text        not null,
  post_id       text        not null,
  first_run_id  text        not null references runs(id) on delete cascade,
  first_seen_at timestamptz not null,
  url           text,   -- instagram only
  preview       text,   -- instagram only (image alt text, which holds the caption)
  author        text,   -- facebook only; may be the literal '<redacted>'
  body          text,   -- facebook only
  primary key (platform, hashtag, post_id)
);

-- The post_id tiebreaker is required, not cosmetic: every post in a run shares
-- one first_seen_at, so that column alone is not a stable paging cursor.
create index if not exists posts_by_tag on posts (platform, hashtag, first_seen_at desc, post_id desc);
create index if not exists posts_by_run on posts (first_run_id, platform, hashtag);

-- Scalar store; holds key='config_snapshot' so the hosted instance (which has
-- no config.json) can render safety settings and list configured hashtags.
-- Flow is strictly one-directional, file -> DB, so there is no divergence risk.
create table if not exists app_meta (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);
