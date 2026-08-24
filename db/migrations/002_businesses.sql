-- Multiple businesses per installation.
--
-- Each business has its own hashtag list, its own dedup memory on disk, and its
-- own run history. Scoping is by slug (the same id used for the business's file
-- and data directory), so the database and the filesystem agree by construction.
--
-- posts keeps its (business, platform, hashtag, post_id) grain: a post can carry
-- several campaign hashtags and two businesses can legitimately track the same
-- hashtag, so anything coarser would undercount.

create table if not exists businesses (
  slug       text primary key,
  name       text        not null,
  created_at timestamptz not null default now(),
  hashtags   jsonb       not null default '[]'::jsonb
);

-- Existing rows all belong to the single pre-existing business. Backfill from
-- the campaign name recorded on the runs themselves, then make it required.
insert into businesses (slug, name, created_at)
select distinct
       lower(regexp_replace(regexp_replace(campaign, '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g')),
       campaign,
       min(started_at)
from runs
group by campaign
on conflict (slug) do nothing;

alter table runs     add column if not exists business text;
alter table tallies  add column if not exists business text;
alter table posts    add column if not exists business text;

update runs set business =
  lower(regexp_replace(regexp_replace(campaign, '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'))
where business is null;

update tallies t set business = r.business from runs r where t.run_id = r.id and t.business is null;
update posts   p set business = r.business from runs r where p.first_run_id = r.id and p.business is null;

-- Drop rows that could not be attributed (there should be none) so the columns
-- can be made NOT NULL safely.
delete from tallies where business is null;
delete from posts   where business is null;
delete from runs    where business is null;

alter table runs    alter column business set not null;
alter table tallies alter column business set not null;
alter table posts   alter column business set not null;

-- Re-key tallies and posts so they are unique per business, not globally.
alter table tallies drop constraint if exists tallies_pkey;
alter table tallies add primary key (business, run_id, platform, hashtag);

alter table posts drop constraint if exists posts_pkey;
alter table posts add primary key (business, platform, hashtag, post_id);

-- Single-flight is per business: two businesses may run at different times, but
-- never simultaneously, because they share one Chrome session. The unique index
-- therefore stays global rather than per-business.
drop index if exists runs_one_running;
create unique index if not exists runs_one_running on runs ((status)) where status = 'running';

create index if not exists runs_business_day on runs (business, campaign_day desc, id desc);
create index if not exists tallies_business_series on tallies (business, platform, hashtag, campaign_day);
create index if not exists posts_business_tag on posts (business, platform, hashtag, first_seen_at desc, post_id desc);
