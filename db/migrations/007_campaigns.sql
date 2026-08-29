-- Rename the "business" concept to "campaign" throughout the schema.
-- A full pre-rename copy of every table lives in
-- backup_pre_campaign_rename_2026_08_29 should this need reverting.

-- runs.campaign currently holds the campaign's DISPLAY NAME; move it aside
-- first so the word is free to become the slug key everywhere.
alter table runs rename column campaign to campaign_name;

alter table businesses rename to campaigns;
alter table runs    rename column business to campaign;
alter table tallies rename column business to campaign;
alter table posts   rename column business to campaign;

alter index if exists runs_business_day       rename to runs_campaign_day;
alter index if exists tallies_business_series rename to tallies_campaign_series;
alter index if exists posts_business_tag      rename to posts_campaign_tag;
