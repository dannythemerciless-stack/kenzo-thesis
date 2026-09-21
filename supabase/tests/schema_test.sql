-- =============================================================================
-- schema_test.sql — invariant tests for the experiment schema.
--
-- Run against a THROWAWAY database after applying 0001-0003:
--   docker exec -i gp-pg psql -U postgres -d exp_test -v ON_ERROR_STOP=1 \
--     < supabase/tests/schema_test.sql
--
-- Every test that matters to the validity of the experiment is here. A failure
-- prints FAIL and aborts.
-- =============================================================================

\set QUIET on
\pset pager off
set client_min_messages = notice;

create or replace function pg_temp.ok(p_cond boolean, p_name text) returns void
language plpgsql as $$
begin
  if p_cond then raise notice 'PASS  %', p_name;
  else raise exception 'FAIL  %', p_name;
  end if;
end $$;

-- Asserts that `p_sql` raises. Used for every "the database must refuse this" case.
create or replace function pg_temp.raises(p_sql text, p_name text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'PASS  % (refused: %)', p_name, left(sqlerrm, 60);
    return;
  end;
  raise exception 'FAIL  % — statement was ACCEPTED but should have been refused', p_name;
end $$;

-- =============================================================================
-- Fixture: a 3-item pool, one control key and one treatment key.
-- =============================================================================

truncate exp.participant_keys, exp.import_batches, exp.questions cascade;
-- Reset EVERY config field the tests touch, so this file is safely re-runnable
-- against a database a previous run already mutated.
update exp.study_config set
  item_count        = 3,
  time_limit_sec    = 3600,
  pool_locked       = false,
  leaderboard_public= false,
  late_grace_ms     = 2000,
  focus_loss_limit  = 5,
  focus_debounce_ms = 1000;

insert into exp.import_batches (id, source_name, source_sha256, row_count)
values ('11111111-1111-1111-1111-111111111111', 'test.csv', '\x00', 3);

do $$
declare i int; qid uuid;
begin
  for i in 1..3 loop
    insert into exp.questions (item_code, stem, batch_id)
    values ('T-'||i, 'Question '||i||'?', '11111111-1111-1111-1111-111111111111')
    returning id into qid;
    -- Deliberately mirrors the real source bias: C is always the correct letter.
    insert into exp.question_options (question_id, content, is_correct, source_label, source_ordinal)
    values (qid, 'opt A '||i, false, 'A', 1),
           (qid, 'opt B '||i, false, 'B', 2),
           (qid, 'opt C '||i, true,  'C', 3),
           (qid, 'opt D '||i, false, 'D', 4);
  end loop;
end $$;

insert into exp.participant_keys (key_code, codename, arm, block, is_test) values
  ('KQ-TEST-CTRL', 'quiet-heron',  'control',   0, true),
  ('KQ-TEST-TRMT', 'brave-tarsier','treatment', 0, true);

-- =============================================================================
-- Pool integrity
-- =============================================================================

select pg_temp.raises($$
  insert into exp.question_options (question_id, content, is_correct, source_label, source_ordinal)
  select id, 'second correct', true, 'E', 5 from exp.questions limit 1;
$$, 'a question cannot have two correct options');

select pg_temp.raises($$
  insert into exp.question_options (question_id, content, is_correct, source_label, source_ordinal)
  select id, 'OPT a 1', false, 'E', 5 from exp.questions where item_code='T-1';
$$, 'duplicate option text within a question is refused (case/space-insensitive)');

-- =============================================================================
-- Key redemption
-- =============================================================================

do $$
declare r jsonb;
begin
  r := exp.redeem_key('NOPE-NOPE-NOPE', '\xaa'::bytea, 3600);
  perform pg_temp.ok(r->>'reason' = 'invalid', 'unknown key is rejected');

  -- Normalization: lowercase, no hyphens, stray spaces — all the same key.
  r := exp.redeem_key('  kqtestctrl ', '\x01'::bytea, 3600);
  perform pg_temp.ok((r->>'ok')::boolean, 'key lookup normalizes case, spaces and hyphens');
  perform pg_temp.ok(r->>'codename' = 'quiet-heron', 'redeem returns the codename');
  perform pg_temp.ok((r->>'hasAttempt')::boolean = false, 'redeem does not start an attempt');
end $$;

-- A real (non-test) key must not work until the pool is locked.
insert into exp.participant_keys (key_code, codename, arm, block, is_test)
values ('KQ-REAL-0001', 'amber-gecko', 'control', 1, false);

do $$
declare r jsonb;
begin
  r := exp.redeem_key('KQ-REAL-0001', '\x99'::bytea, 3600);
  perform pg_temp.ok(r->>'reason' = 'not_open',
    'a real key is refused while the item pool is unlocked');
end $$;

-- =============================================================================
-- Beginning an attempt — the clock starts here, not at key entry
-- =============================================================================

create or replace function pg_temp.mkplan() returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object(
           'position', pos, 'question_id', qid, 'option_order', opts) order by pos)
  from (
    select row_number() over (order by q.item_code) as pos,
           q.id as qid,
           -- Deliberately REVERSED, so the source-C answer lands in slot 2 and
           -- any scoring that secretly depends on the letter will fail loudly.
           (select array_agg(o.id order by o.source_ordinal desc)
              from exp.question_options o where o.question_id = q.id) as opts
    from exp.questions q where q.is_active
  ) t;
$$;

select pg_temp.raises(
  $$ select exp.begin_attempt('\x01'::bytea, pg_temp.mkplan(), '\xdeadbeef'::bytea) $$,
  'begin_attempt refuses a plan whose sha256 does not match');

do $$
declare p jsonb; r jsonb;
begin
  p := pg_temp.mkplan();
  r := exp.begin_attempt('\x01'::bytea, p, exp.plan_hash(p));
  perform pg_temp.ok((r->>'ok')::boolean, 'begin_attempt accepts a correctly hashed plan');
  perform pg_temp.ok((select count(*) = 3 from exp.session_questions),
    'the full randomization plan is materialized');

  -- Idempotent: a double-submitted consent form must not create a second attempt.
  r := exp.begin_attempt('\x01'::bytea, p, exp.plan_hash(p));
  perform pg_temp.ok((r->>'alreadyStarted')::boolean, 'begin_attempt is idempotent');
  perform pg_temp.ok((select count(*) = 1 from exp.sessions), 'still exactly one attempt');
end $$;

select pg_temp.raises($$
  insert into exp.sessions (key_id, arm, item_count, time_limit_sec, deadline_at, plan_sha256)
  select key_id, arm, item_count, time_limit_sec, now()+interval '1h', '\x00' from exp.sessions;
$$, 'a second attempt for the same key is impossible');

-- A plan whose option_order is not a permutation of the question's real options.
select pg_temp.raises($$
  insert into exp.session_questions (session_id, position, question_id, option_order)
  select s.id, 99, q.id, array[gen_random_uuid(), gen_random_uuid()]
  from exp.sessions s, exp.questions q where q.item_code='T-1';
$$, 'option_order must be a permutation of the real option set');

-- =============================================================================
-- Blinding: the control payload must contain no progress information
-- =============================================================================

do $$
declare item jsonb;
begin
  item := exp.get_current_item('\x01'::bytea);   -- control participant

  perform pg_temp.ok(item ? 'nonce' and item ? 'stem' and item ? 'options',
    'the served item carries nonce, stem and options');
  perform pg_temp.ok(not (item ? 'answeredCount') and not (item ? 'totalCount'),
    'CONTROL payload contains NO answeredCount and NO totalCount');
  perform pg_temp.ok(not (item ? 'position') and not (item ? 'index'),
    'CONTROL payload contains no position of any kind');
  perform pg_temp.ok(item::text not like '%is_correct%' and item::text not like '%source_label%',
    'the served item never leaks the answer key');
  perform pg_temp.ok(jsonb_array_length(item->'options') = 4, 'four options are served');
  perform pg_temp.ok(item ? 'deadlineAtMs' and item ? 'serverNowMs',
    'the payload carries both clocks so the client can correct for skew');
end $$;

-- Now the treatment participant, for contrast.
do $$
declare p jsonb; item jsonb;
begin
  perform exp.redeem_key('KQ-TEST-TRMT', '\x02'::bytea, 3600);
  p := pg_temp.mkplan();
  perform exp.begin_attempt('\x02'::bytea, p, exp.plan_hash(p));
  item := exp.get_current_item('\x02'::bytea);

  perform pg_temp.ok((item->>'totalCount')::int = 3 and (item->>'answeredCount')::int = 0,
    'TREATMENT payload DOES carry progress');
end $$;

-- =============================================================================
-- Answering: scoring by option identity, forward-only, immutable
-- =============================================================================

-- Scoring must ignore the source letter entirely. The plan above reversed the
-- option order, so the correct answer (source label C) renders in slot 2.
do $$
declare item jsonb; nonce uuid; correct_id uuid; r jsonb;
begin
  item  := exp.get_current_item('\x01'::bytea);
  nonce := (item->>'nonce')::uuid;

  select o.id into correct_id
  from exp.session_questions sq
  join exp.question_options o on o.question_id = sq.question_id and o.is_correct
  where sq.serve_nonce = nonce;

  r := exp.submit_answer('\x01'::bytea, nonce, correct_id);
  perform pg_temp.ok((select correct_count = 1 from exp.sessions
                       where id = (select session_id from exp.browser_sessions
                                    where token_hash='\x01')),
    'a correct answer scores, identified by option id not letter');

  perform pg_temp.ok((select selected_slot = 2 from exp.session_questions
                       where serve_nonce = nonce),
    'the correct answer rendered in a shuffled slot, not the source letter C');

  perform pg_temp.ok(r ? 'nonce', 'the next item rides back in the submit response');
end $$;

-- Double-click on the same answer is idempotent, not a double count.
do $$
declare sid uuid; nonce uuid; oid uuid; before_n int;
begin
  select session_id into sid from exp.browser_sessions where token_hash = '\x01';

  select sq.serve_nonce, sq.selected_option_id into nonce, oid
    from exp.session_questions sq
   where sq.session_id = sid and sq.answered_at is not null
   limit 1;

  select answered_count into before_n from exp.sessions where id = sid;

  perform exp.submit_answer('\x01'::bytea, nonce, oid);

  perform pg_temp.ok((select answered_count from exp.sessions where id = sid) = before_n,
    'replaying the same answer is idempotent — no double count');
end $$;

-- A stale or forged nonce re-syncs the client rather than corrupting anything.
do $$
declare r jsonb;
begin
  r := exp.submit_answer('\x01'::bytea, gen_random_uuid(),
        (select id from exp.question_options limit 1));
  perform pg_temp.ok((r->>'resync')::boolean, 'an unknown nonce triggers a clean resync');
  perform pg_temp.ok(exists (select 1 from exp.session_events
                              where event_type='answer_rejected_stale'),
    'the stale submission is recorded in the audit trail');
end $$;

select pg_temp.raises($$
  update exp.session_questions set option_order = array[gen_random_uuid()]
   where position = 1 and session_id = (select session_id from exp.browser_sessions where token_hash='\x01');
$$, 'the randomization plan is immutable after insert');

select pg_temp.raises($$
  update exp.session_questions set selected_option_id = (select id from exp.question_options limit 1)
   where answered_at is not null;
$$, 'a committed answer cannot be changed');

-- Forward-only: cannot answer position 3 while position 2 is unanswered.
select pg_temp.raises($$
  update exp.session_questions sq set
    answered_at = now(),
    selected_option_id = (select o.id from exp.question_options o
                           where o.question_id = sq.question_id and o.is_correct),
    selected_slot = 1,
    is_correct = true
  where sq.position = 3
    and sq.session_id = (select session_id from exp.browser_sessions where token_hash='\x01');
$$, 'answering out of order is refused');

-- The caller cannot assert its own correctness.
select pg_temp.raises($$
  update exp.session_questions sq set
    answered_at = now(),
    selected_option_id = (select o.id from exp.question_options o
                           where o.question_id = sq.question_id and not o.is_correct limit 1),
    selected_slot = 1,
    is_correct = true
  where sq.position = 2
    and sq.session_id = (select session_id from exp.browser_sessions where token_hash='\x01');
$$, 'is_correct must match the database, not the caller');

-- =============================================================================
-- Focus loss: silent, debounced, tamper-proof
-- =============================================================================

-- The debounce is time-based and now() is frozen within a transaction, so
-- disable it for this test rather than sleeping. (The debounce itself is
-- exercised by the first two assertions below, which share a timestamp.)
do $$
declare r jsonb; sid uuid;
begin
  select session_id into sid from exp.browser_sessions where token_hash='\x01';

  r := exp.record_focus_loss('\x01'::bytea, '22222222-2222-2222-2222-222222222222');
  perform pg_temp.ok((r->>'counted')::boolean, 'first focus loss counts');

  -- Same timestamp, different dedupe key: the debounce must swallow it.
  r := exp.record_focus_loss('\x01'::bytea, gen_random_uuid());
  perform pg_temp.ok((r->>'counted')::boolean = false,
    'a second loss inside the debounce window is ignored (mobile blur flapping)');

  -- Same dedupe key: a retried sendBeacon must not double count.
  update exp.study_config set focus_debounce_ms = 0;
  r := exp.record_focus_loss('\x01'::bytea, '22222222-2222-2222-2222-222222222222');
  perform pg_temp.ok((r->>'counted')::boolean = false,
    'a retried beacon does not double count');
end $$;

do $$
declare i int; sid uuid;
begin
  select session_id into sid from exp.browser_sessions where token_hash='\x01';

  for i in 1..5 loop
    perform exp.record_focus_loss('\x01'::bytea, gen_random_uuid());
  end loop;

  perform pg_temp.ok((select focus_loss_count >= 5 from exp.sessions where id=sid),
    'focus losses accumulate server-side');
  perform pg_temp.ok((select disqualified from exp.sessions where id=sid),
    'crossing the limit sets the disqualified flag');
  perform pg_temp.ok((select status = 'in_progress' from exp.sessions where id=sid),
    'disqualification is SILENT — the attempt continues normally');
  perform pg_temp.ok((select count(*) = 0 from exp.session_events
                       where session_id = sid and event_type = 'disqualified'),
    'nothing is surfaced to the participant on disqualification');
end $$;

-- =============================================================================
-- Finalization and the duration measures
-- =============================================================================

select pg_temp.raises($$
  insert into exp.surveys (session_id, likert_mental_exhaustion, likert_perceived_difficulty,
    likert_focus_drain, likert_timer_stress, likert_overall_difficulty)
  select id, 3,3,3,3,3 from exp.sessions
   where id = (select session_id from exp.browser_sessions where token_hash='\x01');
$$, 'the survey cannot be submitted before the attempt is finalized');

-- A session that expired days ago, finalized late. The recorded duration must
-- reflect the DEADLINE, not the moment of finalization.
do $$
declare sid uuid; s exp.sessions; s2 exp.sessions;
begin
  select session_id into sid from exp.browser_sessions where token_hash='\x01';
  update exp.sessions
     set started_at      = now() - interval '3 days',
         deadline_at     = now() - interval '3 days' + interval '3600 seconds',
         first_answer_at = now() - interval '3 days' + interval '60 seconds',
         last_answer_at  = now() - interval '3 days' + interval '600 seconds'
   where id = sid;

  s := exp.finalize_session(sid);

  perform pg_temp.ok(s.status = 'timed_out',        'an expired attempt finalizes as timed_out');
  perform pg_temp.ok(s.completed = false,           'DV1 completed = 0');
  perform pg_temp.ok(s.duration_censored,           'the censoring indicator is set');
  perform pg_temp.ok(s.exposure_duration_sec = 3600,
    'exposure duration is the time LIMIT, not the 3-day finalization lag');
  perform pg_temp.ok(s.effort_duration_sec = 600,
    'effort duration is measured to last_answer_at, not to now()');
  perform pg_temp.ok(s.ended_at = s.deadline_at,
    'ended_at is the deadline, not the moment of finalization');

  s2 := exp.finalize_session(sid);
  perform pg_temp.ok(s2.finalized_at = s.finalized_at, 'finalize_session is idempotent');
end $$;

-- v_session_live must report the truth even when nothing has been finalized.
do $$
declare sid uuid;
begin
  select session_id into sid from exp.browser_sessions where token_hash='\x02';
  update exp.sessions set started_at = now() - interval '2 hours',
                          deadline_at = now() - interval '1 hour'
   where id = sid;
  perform pg_temp.ok((select live_status = 'timed_out' from exp.v_session_live where id = sid),
    'v_session_live reports timed_out before any sweep has run');
end $$;

-- Survey is accepted once finalized, and only once.
do $$
begin
  perform exp.submit_survey('\x01'::bytea, array[4,5,3,4,5]::smallint[],
                            array[true,false,true,false,false], false);
  perform pg_temp.ok((select count(*) = 1 from exp.surveys), 'the survey is accepted after finalization');
  perform exp.submit_survey('\x01'::bytea, array[1,1,1,1,1]::smallint[],
                            array[false,false,false,false,true], false);
  perform pg_temp.ok((select likert_mental_exhaustion = 4 from exp.surveys),
    'a resubmitted survey does not overwrite the first response');
end $$;

-- =============================================================================
-- Export
-- =============================================================================

do $$
declare n int;
begin
  -- Test keys are excluded; only the one real key should appear.
  select count(*) into n from exp.v_export_wide;
  perform pg_temp.ok(n = 1, 'pilot keys are excluded from the export');
  perform pg_temp.ok((select redeemed = 0 from exp.v_export_wide),
    'an unredeemed key still appears, with redeemed = 0');

  -- And the timing view must be queryable.
  perform count(*) from exp.v_item_timing;
  perform count(*) from exp.v_leaderboard;
  perform count(*) from exp.v_source_key_bias;
  perform count(*) from exp.v_rendered_slot_dist;
  perform pg_temp.ok(true, 'all analysis views are queryable');
end $$;

-- Preflight must complain while the pool is unlocked and the groups unbalanced.
do $$
begin
  perform pg_temp.ok(exists (select 1 from exp.v_preflight_failures where check_name='pool_not_locked'),
    'preflight catches an unlocked pool');
end $$;

\echo ''
\echo '================  ALL SCHEMA TESTS PASSED  ================'

-- =============================================================================
-- Grant posture: the anon role must be able to do nothing at all.
--
-- The `exp` schema IS exposed to PostgREST (otherwise our own RPCs would not
-- route), so routing is not the boundary — these grants are.
-- =============================================================================

do $$
declare n int;
begin
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'exp' and grantee in ('anon','authenticated');
  perform pg_temp.ok(n = 0, 'anon and authenticated hold ZERO table grants in exp');

  select count(*) into n
    from pg_tables t
    join pg_class c on c.relname = t.tablename
    join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'exp'
   where t.schemaname = 'exp' and not (c.relrowsecurity and c.relforcerowsecurity);
  perform pg_temp.ok(n = 0, 'every exp table has RLS enabled AND forced');

  perform pg_temp.ok(
    not has_schema_privilege('anon', 'exp', 'USAGE'),
    'anon cannot even USE the exp schema');
end $$;

-- =============================================================================
-- Rate limiting on key entry
-- =============================================================================

do $$
declare r jsonb; i int;
begin
  for i in 1..10 loop
    perform exp.redeem_key('BAD-KEY-' || i, '\xbb'::bytea, 3600, '\xcafe'::bytea);
  end loop;

  r := exp.redeem_key('ALSO-BAD-KEY', '\xbb'::bytea, 3600, '\xcafe'::bytea);
  perform pg_temp.ok(r->>'reason' = 'rate_limited',
    'key entry is throttled after 10 failures from one IP');

  -- A different IP is unaffected.
  r := exp.redeem_key('STILL-BAD-KEY', '\xbb'::bytea, 3600, '\xbeef'::bytea);
  perform pg_temp.ok(r->>'reason' = 'invalid',
    'throttling is per-IP, not global');
end $$;

-- =============================================================================
-- Deletion: refused casually, permitted deliberately
-- =============================================================================

select pg_temp.raises($$
  delete from exp.session_events where session_id is not null;
$$, 'the event log still cannot be deleted directly');

select pg_temp.raises($$
  delete from exp.sessions where id is not null;
$$, 'a session cannot be deleted casually (the cascade hits the audit trail)');

do $$
declare sid uuid; n int;
begin
  select session_id into sid from exp.browser_sessions where token_hash = '\x02';

  perform pg_temp.ok(exp.purge_session(sid),
    'exp.purge_session() CAN remove a session — the right-to-withdraw path works');

  perform pg_temp.ok((select count(*) = 0 from exp.sessions where id = sid),
    'the session row is gone');
  perform pg_temp.ok((select count(*) = 0 from exp.session_questions where session_id = sid),
    'its plan and per-item timing cascaded away');
  perform pg_temp.ok((select count(*) = 0 from exp.session_events where session_id = sid),
    'its event log cascaded away');
  perform pg_temp.ok((select count(*) = 1 from exp.participant_keys where codename = 'brave-tarsier'),
    'the key row is KEPT, so the CONSORT denominator survives a withdrawal');

  -- And the flag must not leak past the purge.
  perform pg_temp.ok(coalesce(current_setting('exp.allow_purge', true), 'off') = 'off',
    'the purge escape hatch is closed again afterwards');
end $$;

select pg_temp.raises($$
  delete from exp.sessions where id is not null;
$$, 'deletion is refused again once the purge has finished');
