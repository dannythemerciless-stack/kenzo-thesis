-- =============================================================================
-- 0005_demo.sql — synthetic participants, for looking at the UI only.
--
-- ⚠  EVERYTHING THIS CREATES IS FAKE. It exists so the leaderboard and the
--    export can be eyeballed before real fieldwork. Never analyse it, never
--    screenshot it into the thesis, and run exp.purge_demo_data() before the
--    study opens.
--
-- Demo rows are marked three ways so they cannot be mistaken for real data:
--   * block = 900        (real keys use blocks 0..29)
--   * codename 'demo-…'
--   * key_code 'DEMO-…'
--
-- They must have is_test = false, because every analysis view filters test
-- keys out — which is exactly the behaviour we want to look at.
--
-- Why this is a database function rather than a script: exp.sessions has a
-- DEFERRABLE constraint trigger requiring a session to have its full plan by
-- COMMIT, and PostgREST commits every statement separately. Building a
-- session therefore has to happen inside one transaction, i.e. in here.
--
-- NOTE: the rows it writes are deliberately NOT self-consistent — is_correct is
-- set to hit a target score rather than derived from the option chosen. That is
-- why `pnpm x audit` excludes synthetic rows from its scoring checks.
-- =============================================================================

create or replace function exp.make_demo_data(p_n integer default 40)
returns integer
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare
  cfg        exp.study_config;
  v_key      exp.participant_keys;
  v_session  uuid;
  i          integer;
  v_arm      exp.arm;
  v_completed boolean;
  v_answered integer;
  v_correct  integer;
  v_started  timestamptz;
  v_duration integer;
  v_made     integer := 0;
  adj        text[] := array['amber','brave','calm','clever','coral','eager','fair','gentle',
                             'golden','hardy','jolly','keen','lively','merry','noble','olive',
                             'plucky','quiet','rapid','silent','silver','steady','sunny','swift',
                             'tidy','true','vivid','warm','wise','witty'];
  ani        text[] := array['ayungin','badger','carabao','civet','crane','dolphin','dugong',
                             'eagle','egret','falcon','finch','gecko','heron','hornbill','ibis',
                             'kite','lemur','marlin','moth','myna','oriole','osprey','otter',
                             'pangolin','parrot','pitta','python','tarsier','tern','warbler'];
begin
  select * into cfg from exp.study_config;

  if (select count(*) from exp.questions where is_active) <> cfg.item_count then
    raise exception 'import the question pool first (expected % active items)', cfg.item_count;
  end if;

  for i in 1..p_n loop
    v_arm := case when i % 2 = 0 then 'treatment'::exp.arm else 'control'::exp.arm end;

    -- An arbitrary, illustrative difference. NOT a prediction, NOT a result:
    -- it exists only so the leaderboard has some spread to look at.
    v_completed := random() < (case when v_arm = 'treatment' then 0.62 else 0.44 end);

    if v_completed then
      v_answered := cfg.item_count;
      v_duration := 1500 + floor(random() * 2000)::int;      -- 25–58 min
    else
      v_answered := 25 + floor(random() * 60)::int;          -- gave up partway
      v_duration := 900 + floor(random() * 2400)::int;
    end if;

    -- Roughly 55–75% accuracy on what they attempted.
    v_correct := floor(v_answered * (0.55 + random() * 0.20))::int;
    v_started := now() - make_interval(secs => 3600 * (24 + random() * 96));

    insert into exp.participant_keys (key_code, codename, arm, block, is_test)
    values (
      'DEMO-' || upper(substr(md5(random()::text), 1, 4)) || '-' || lpad(i::text, 4, '0'),
      'demo-' || adj[1 + (i * 7) % array_length(adj, 1)] || '-'
               || ani[1 + (i * 13) % array_length(ani, 1)] || '-' || i,
      v_arm, 900, false)
    returning * into v_key;

    insert into exp.sessions (
      key_id, arm, item_count, time_limit_sec,
      started_at, deadline_at, plan_sha256,
      answered_count, correct_count,
      first_answer_at, last_answer_at, last_event_at,
      focus_loss_count, disqualified, disqualified_at, ua_family)
    values (
      v_key.id, v_arm, cfg.item_count, cfg.time_limit_sec,
      v_started, v_started + make_interval(secs => cfg.time_limit_sec),
      sha256(convert_to('demo', 'UTF8')),
      v_answered, v_correct,
      v_started + interval '20 seconds',
      v_started + make_interval(secs => v_duration),
      v_started + make_interval(secs => v_duration),
      floor(random() * 3)::int, false, null, 'demo')
    returning id into v_session;

    -- Insert the plan with the answered prefix ALREADY answered. Inserting
    -- (rather than updating) is deliberate: the forward-only and
    -- correctness-matching guards live on UPDATE, and the counters above are
    -- set explicitly, so nothing is bypassed that would otherwise be checked
    -- on a real answer.
    insert into exp.session_questions (
      session_id, position, question_id, option_order,
      first_served_at, last_served_at, serve_count,
      answered_at, selected_option_id, selected_slot, is_correct)
    select
      v_session,
      q.pos::smallint,
      q.id,
      q.opts,
      case when q.pos <= v_answered
           then v_started + make_interval(secs => v_duration * (q.pos - 1) / v_answered) end,
      case when q.pos <= v_answered
           then v_started + make_interval(secs => v_duration * (q.pos - 1) / v_answered) end,
      case when q.pos <= v_answered then 1 else 0 end,
      case when q.pos <= v_answered
           then v_started + make_interval(secs => v_duration * q.pos / v_answered) end,
      case when q.pos <= v_answered then q.opts[1 + (q.pos % 4)] end,
      case when q.pos <= v_answered then (1 + (q.pos % 4))::smallint end,
      case when q.pos <= v_answered then q.pos <= v_correct end
    from (
      select row_number() over (order by random()) as pos,
             qq.id,
             (select array_agg(o.id order by random())
                from exp.question_options o where o.question_id = qq.id) as opts
      from exp.questions qq where qq.is_active
    ) q;

    perform exp.finalize_session(v_session);
    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;

-- -----------------------------------------------------------------------------
-- Remove every trace. Run this before the study opens.
-- -----------------------------------------------------------------------------
create or replace function exp.purge_demo_data()
returns integer
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare n integer;
begin
  delete from exp.sessions s
   using exp.participant_keys k
   where k.id = s.key_id and k.block = 900;
  delete from exp.participant_keys where block = 900;
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare r text;
begin
  foreach r in array array['service_role', 'postgres'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on all functions in schema exp to %I', r);
    end if;
  end loop;
end $$;
