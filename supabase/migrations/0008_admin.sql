-- =============================================================================
-- 0008_admin.sql — two changes, both needed by the web dashboard.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. email_hash — so keys can be issued from the browser.
--
-- The CLI knows who already has a key by reading out/issued.csv on the
-- researcher's laptop. A web dashboard has no such file: Vercel's filesystem is
-- read-only and ephemeral. Without a marker in the database, re-uploading the
-- form export would issue everyone a SECOND key.
--
-- So each key carries an HMAC of the email that requested it. Keyed with the
-- server-side SESSION_PEPPER, so:
--   * the same email always produces the same value → reliable de-duplication
--   * the value cannot be turned back into an email by anyone without the
--     pepper, and even with it you would have to guess the address first
--
-- This is NOT the email, and the claim in the consent form still holds: no name,
-- email address or student number is stored. What is stored is a one-way token
-- that is useless to anyone who obtains the database.
--
-- Nullable, because keys issued by the CLI before this migration have none.
-- -----------------------------------------------------------------------------
alter table exp.participant_keys
  add column if not exists email_hash bytea;

create unique index if not exists pk_email_hash_uq
  on exp.participant_keys (email_hash)
  where email_hash is not null;


-- -----------------------------------------------------------------------------
-- 2. Flagged participants stay on the leaderboard.
--
-- Previously anyone with 5+ tab switches was filtered out of v_prize_rank, so
-- they vanished and everyone below them silently moved up a place. That made
-- the published order disagree with the actual scores, and gave the researcher
-- no way to see who had been flagged without querying the database directly.
--
-- Now everyone who finished is ranked on their score, and the flag travels with
-- them as a column. Whether a flagged participant keeps a prize is a judgement
-- call for the researcher, not something a view should decide silently.
-- -----------------------------------------------------------------------------
create or replace view exp.v_prize_rank as
select s.id as session_id,
       rank() over (order by s.correct_count desc,
                             s.live_effort_sec asc,
                             s.started_at asc) as prize_rank
from exp.v_session_live s
join exp.participant_keys k on k.id = s.key_id
where s.live_status <> 'in_progress'
  and not k.is_test;

create or replace view exp.v_leaderboard as
select pr.prize_rank,
       k.codename,
       s.correct_count,
       s.live_effort_sec as effort_sec,
       s.disqualified,
       s.focus_loss_count
from exp.v_prize_rank pr
join exp.v_session_live s   on s.id = pr.session_id
join exp.participant_keys k on k.id = s.key_id
order by pr.prize_rank;


-- -----------------------------------------------------------------------------
-- 3. A live monitoring view for the dashboard.
--
-- One row per issued key with its current state, so the dashboard can render
-- the whole study in a single query instead of assembling it in the app.
-- -----------------------------------------------------------------------------
create or replace view exp.v_admin_participants as
select k.key_code,
       k.codename,
       k.arm,
       k.block,
       k.is_test,
       (k.arm = 'treatment')          as is_treatment,
       s.id is not null               as started,
       coalesce(s.live_status::text, 'not_started') as status,
       s.answered_count,
       s.correct_count,
       s.item_count,
       s.live_effort_sec              as effort_sec,
       s.live_exposure_sec            as exposure_sec,
       s.focus_loss_count,
       s.disqualified,
       s.started_at,
       s.deadline_at,
       s.live_ended_at                as ended_at,
       (sv.session_id is not null)    as surveyed
from exp.participant_keys k
left join exp.v_session_live s on s.key_id = k.id
left join exp.surveys sv       on sv.session_id = s.id
order by s.started_at desc nulls last, k.codename;
