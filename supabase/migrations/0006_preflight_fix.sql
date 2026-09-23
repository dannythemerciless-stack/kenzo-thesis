-- =============================================================================
-- 0006_preflight_fix.sql — stop the preflight view crying wolf.
--
-- Two bugs in v_preflight_failures:
--
--   1. With ZERO real keys issued, the grouped subquery returned no rows, so
--      `count(distinct n) <> 1` evaluated over an empty set and emitted an
--      "arm_imbalance" row with a null detail. Before any keys exist there is
--      nothing to be imbalanced, and a red ✖ that always shows trains you to
--      ignore the one that matters.
--
--   2. It excluded pilot keys but not synthetic demo rows (block 900), so a
--      demo batch could mask or fake a balance problem.
--
-- Also flags the case where one group is missing entirely, which the old
-- `count(distinct n)` test silently passed.
-- =============================================================================

create or replace view exp.v_preflight_failures as
  -- Group sizes must be equal, and both groups must actually exist.
  select 'arm_imbalance'::text as check_name,
         jsonb_object_agg(arm, n) as detail
  from (
    select arm, count(*) n
    from exp.participant_keys
    where not is_test and block < 900          -- real participants only
    group by arm
  ) t
  having count(*) > 0                          -- nothing issued yet is not a failure
     and (count(*) <> 2 or count(distinct n) <> 1)

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
  from exp.study_config where not pool_locked

union all
  -- Synthetic rows must be gone before fieldwork: they are flagged as REAL
  -- (that is the only way they appear on the leaderboard), so they would land
  -- in the export beside genuine participants.
  select 'demo_rows_present',
         jsonb_build_object('count', count(*))
  from exp.participant_keys where block >= 900
  having count(*) > 0;
