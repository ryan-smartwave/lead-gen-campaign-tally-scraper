-- Other hashtags mentioned in a post's own caption/body, beyond the hashtag
-- that was searched. Derived text — populated by the scraper at record time
-- (src/utils/hashtags.js) and backfilled for existing rows by
-- scripts/backfill-derived.mjs, which shares the same extractor.
alter table posts add column if not exists other_hashtags text[];
