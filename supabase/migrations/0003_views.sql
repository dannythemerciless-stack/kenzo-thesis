-- =============================================================================
-- 0003_views.sql — live truth, preflight checks, and the STATA export
-- =============================================================================

-- -----------------------------------------------------------------------------
-- v_session_live — the truth, computed on every read.
--
-- This is what makes finalization cosmetic. A session whose deadline passed
-- while nobody was looking reads as timed_out here whether or not the sweep has
-- run, so every read path is correct at all times and cron frequency is
-- irrelevant to correctness.
-- -----------------------------------------------------------------------------
create or replace view exp.v_session_live as
select
  s.*,
  case when s.finalized_at is not null           then s.status
       when s.answered_count >= s.item_count     then 'completed'::exp.session_status
       when now() >= s.deadline_at               then 'timed_out'::exp.session_status
       else 'in_progress'::exp.session_status
  end as live_status,

  coalesce(s.ended_at,
    case when s.answered_count >= s.item_count then s.last_answer_at
         when now() >= s.deadline_at           then s.deadline_at
    end) as live_ended_at,

  coalesce(s.effort_duration_sec,
    greatest(0, round(extract(epoch from
      (coalesce(s.last_answer_at, s.started_at) - s.started_at))))::integer
  ) as live_effort_sec,

  coalesce(s.exposure_duration_sec,
    case when s.answered_count >= s.item_count
           then greatest(0, round(extract(epoch from (s.last_answer_at - s.started_at))))::integer
         when now() >= s.deadline_at then s.time_limit_sec
    end) as live_exposure_sec
from exp.sessions s;

-- -----------------------------------------------------------------------------
-- v_preflight_failures — must return ZERO rows before the study goes live.
--
-- Run this, and lock the pool, before distributing a single key.
-- -----------------------------------------------------------------------------
create or replace view exp.v_preflight_failures as
  -- Group sizes must be equal and sum to the intended total.
  select 'arm_imbalance'::text as check_name,
         jsonb_object_agg(arm, n) as detail
  from (select arm, count(*) n from exp.participant_keys where not is_test group by arm) t
  having count(distinct n) <> 1

union all
  -- Every active item needs >= 4 options and exactly one correct.
  select 'question_bad_option_set',
         jsonb_build_object('item_code', q.item_code,
                            'options',   (select count(*) from exp.question_options o
                                           where o.question_id = q.id),
                            'correct',   (select count(*) from exp.question_options o
                                           where o.question_id = q.id and o.is_correct))
  from exp.questions q
  where q.is_active
    and ((select count(*) from exp.question_options o where o.question_id = q.id) < 4
      or (select count(*) from exp.question_options o
           where o.question_id = q.id and o.is_correct) <> 1)

union all
  -- The active pool must match the configured item count.
  select 'pool_size', jsonb_build_object('active', count(*),
                                         'expected', (select item_count from exp.study_config))
  from exp.questions where is_active
  having count(*) <> (select item_count from exp.study_config)

union all
  -- The pool must be locked before real keys are handed out.
  select 'pool_not_locked', '{}'::jsonb
  from exp.study_config where not pool_locked;

-- -----------------------------------------------------------------------------
-- v_source_key_bias — the defense exhibit.
--
-- Shows the source answer key was severely position-biased (C ~62%, A never)
-- and that the app never used those letters. Pair it with v_rendered_slot_dist
-- below, which should be ~uniform.
-- -----------------------------------------------------------------------------
create or replace view exp.v_source_key_bias as
select o.source_label,
       count(*) as n_correct,
       round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 1) as pct
from exp.question_options o
join exp.questions q on q.id = o.question_id
where o.is_correct and q.is_active
group by o.source_label
order by o.source_label;

-- Where the correct answer actually landed on participants' screens. Should be
-- ~25% per slot. This is the evidence that the all-C exploit is dead.
create or replace view exp.v_rendered_slot_dist as
select sq.selected_slot is not null as answered,
       u.ord as correct_slot,
       count(*) as n
from exp.session_questions sq
join exp.sessions s on s.id = sq.session_id
join exp.participant_keys k on k.id = s.key_id
cross join lateral (
  select ord from unnest(sq.option_order) with ordinality as x(opt_id, ord)
  join exp.question_options o on o.id = x.opt_id and o.is_correct
) u
where not k.is_test
group by 1, 2
order by 1, 2;

-- -----------------------------------------------------------------------------
-- v_prize_rank — deterministic, pre-specified tie-break.
--
-- Score desc, then faster effort, then earlier start. Disqualified participants
-- (silent focus-loss flag) are excluded from the prize pool ONLY; their data
-- remains in the export.
-- -----------------------------------------------------------------------------
create or replace view exp.v_prize_rank as
select s.id as session_id,
       rank() over (order by s.correct_count desc,
                             s.live_effort_sec asc,
                             s.started_at asc) as prize_rank
from exp.v_session_live s
join exp.participant_keys k on k.id = s.key_id
where s.live_status <> 'in_progress'
  and not s.disqualified
  and not k.is_test;

-- -----------------------------------------------------------------------------
-- v_leaderboard — public standings. The app must additionally check
-- study_config.leaderboard_public before rendering this.
-- -----------------------------------------------------------------------------
create or replace view exp.v_leaderboard as
select pr.prize_rank, k.codename, s.correct_count, s.live_effort_sec as effort_sec
from exp.v_prize_rank pr
join exp.v_session_live s on s.id = pr.session_id
join exp.participant_keys k on k.id = s.key_id
order by pr.prize_rank;

-- -----------------------------------------------------------------------------
-- v_export_wide — ONE ROW PER PARTICIPANT, analysis-ready for STATA.
--
-- Three deliberate choices:
--  1. participant_keys LEFT JOIN sessions, not FROM sessions. All keys appear,
--     including those never redeemed — needed for the CONSORT flow diagram and
--     to test differential take-up. An export containing only the people who
--     showed up cannot detect the most common threat to an RCT's validity.
--  2. Reads v_session_live, not sessions, so it is correct even if the
--     finalization sweep has not run.
--  3. Booleans cast to int: 't'/'f' imports badly into STATA, 0/1 imports as
--     numeric.
-- -----------------------------------------------------------------------------
create or replace view exp.v_export_wide as
select
  -- Identity. The join column to the researcher's private sheet. No PII here.
  k.key_code,
  k.codename,

  -- Assignment
  (k.arm = 'treatment')::int                      as treatment,
  k.block,
  (s.arm is not null and s.arm <> k.arm)::int     as arm_mismatch_flag,

  -- Participation / attrition
  (s.id is not null)::int                         as redeemed,

  -- DV1: binary completion within the time limit
  case when s.id is null then null
       else (s.live_status = 'completed')::int end as completed,

  -- DV2 and its variants. Report exposure_duration_sec as primary (it is what
  -- the paper specifies) but ALWAYS with duration_censored, because for a
  -- timeout 3600 is a censoring bound, not a measurement.
  s.live_exposure_sec                             as exposure_duration_sec,
  s.live_effort_sec                               as effort_duration_sec,
  s.engaged_duration_sec,
  case when s.id is null then null
       else (s.live_status = 'timed_out')::int end as duration_censored,

  -- Performance
  s.answered_count                                as questions_attempted,
  s.correct_count                                 as correct_score,
  (select count(*) from exp.session_questions sq
     join exp.questions q on q.id = sq.question_id
    where sq.session_id = s.id and sq.is_correct and not q.excluded_from_scoring
  )                                               as correct_score_adj,

  -- Attention. Call this "tab-visibility loss count", never "cheating
  -- detection": visibilitychange misses second monitors and second devices, and
  -- fires spuriously on mobile notifications.
  s.focus_loss_count,
  s.hidden_ms_total,
  s.disqualified::int                             as disqualified,
  pr.prize_rank,

  -- Post-quiz survey
  (sv.session_id is not null)::int                as survey_completed,
  sv.likert_mental_exhaustion,
  sv.likert_perceived_difficulty,
  sv.likert_focus_drain,
  sv.likert_timer_stress,
  sv.likert_overall_difficulty,
  sv.consider_forfeit::int                        as consider_forfeit,
  sv.consider_slow::int                           as consider_slow,
  sv.consider_rush::int                           as consider_rush,
  sv.consider_random::int                         as consider_random,
  sv.consider_none::int                           as consider_none,
  sv.heard_beforehand::int                        as heard_beforehand,

  -- Timing and provenance
  s.started_at,
  s.live_ended_at                                 as ended_at,
  s.deadline_at,
  s.finalized_at,
  s.last_answer_at,
  s.last_heartbeat_at,
  encode(s.plan_sha256, 'hex')                    as plan_sha256,
  s.ua_family

from exp.participant_keys k
left join exp.v_session_live s on s.key_id     = k.id
left join exp.surveys      sv  on sv.session_id = s.id
left join exp.v_prize_rank pr  on pr.session_id = s.id
where not k.is_test
order by k.codename;

-- -----------------------------------------------------------------------------
-- v_item_timing — LONG format, one row per item per participant.
--
-- This is the dataset that tests the goal-gradient signature directly: does
-- per-item pace ACCELERATE near the end, and does it accelerate more for the
-- group that can see the bar?
-- -----------------------------------------------------------------------------
create or replace view exp.v_item_timing as
select
  k.key_code,
  k.codename,
  (k.arm = 'treatment')::int as treatment,
  sq.position,
  q.item_code,
  q.topic,
  sq.first_served_at,
  sq.last_served_at,
  sq.answered_at,
  sq.serve_count,
  sq.dwell_total_ms,
  sq.dwell_active_ms,
  sq.dwell_focused_ms,
  sq.hidden_ms,
  sq.selected_slot,
  sq.is_correct::int as is_correct,
  sq.clock_skew_ms,
  -- Elapsed seconds into the attempt at the moment this item was answered.
  case when sq.answered_at is not null
       then round(extract(epoch from (sq.answered_at - s.started_at)))::integer
  end as answered_at_elapsed_sec
from exp.session_questions sq
join exp.sessions s          on s.id = sq.session_id
join exp.participant_keys k  on k.id = s.key_id
join exp.questions q         on q.id = sq.question_id
where not k.is_test
order by k.codename, sq.position;

-- -----------------------------------------------------------------------------
-- Scheduled jobs (Supabase pg_cron).
--
-- pg_cron rather than Vercel Cron: it runs inside Postgres, has no Hobby-tier
-- once-per-day frequency cap, and needs no HTTP endpoint to protect.
--
-- Enable the extension in the Supabase dashboard (Database -> Extensions ->
-- pg_cron) before running these two statements.
-- -----------------------------------------------------------------------------
-- select cron.schedule('finalize-expired', '*/5 * * * *',
--   $$select exp.finalize_expired_sessions(500)$$);
-- select cron.schedule('housekeeping', '17 * * * *',
--   $$select exp.housekeeping()$$);
