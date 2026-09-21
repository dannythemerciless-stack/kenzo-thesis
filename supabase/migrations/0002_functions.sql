-- =============================================================================
-- 0002_functions.sql — the state machine
--
-- Every state-changing operation is ONE function call. supabase-js has no
-- transaction API, so "lock, read, decide, write" cannot be done safely across
-- multiple calls from Node. Doing it here makes the two-tab race, the
-- double-submit, and the late-answer case fall out for free.
--
-- Every mutating function begins with
--     select ... from exp.sessions where id = ... for update
-- That single row lock serializes all writes for one participant and leaves the
-- other 299 completely unaffected.
--
-- Client-facing functions are keyed by p_token_hash (the hashed cookie), never
-- by a session id supplied by the client. The server never trusts an identifier
-- that came from the browser.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Canonical serialization of a randomization plan.
--
-- Both Node and Postgres build this exact string, so the sha256 can be verified
-- on the server before the plan is committed. Published in the thesis appendix;
-- anyone can re-derive it from the exported plan and confirm nothing moved.
--
--   position:question_id:opt1,opt2,...   one line per item, ascending position
-- -----------------------------------------------------------------------------
create or replace function exp.canonical_plan_text(p_plan jsonb)
returns text
language sql
immutable
as $$
  select string_agg(
           p.position::text || ':' || p.question_id::text || ':' ||
             array_to_string(p.option_order, ','),
           E'\n' order by p.position)
  from jsonb_to_recordset(p_plan)
       as p(position smallint, question_id uuid, option_order uuid[]);
$$;

-- The hash Node must reproduce. sha256() and convert_to() are both core, so
-- this needs no extension and no schema on the search path.
create or replace function exp.plan_hash(p_plan jsonb)
returns bytea
language sql
immutable
as $$
  select sha256(convert_to(exp.canonical_plan_text(p_plan), 'UTF8'));
$$;

-- -----------------------------------------------------------------------------
-- exp.finalize_session — idempotent snapshot of the terminal state.
--
-- Finalization is deliberately COSMETIC, not load-bearing. A timeout requires
-- no action from anyone; it is simply now() >= deadline_at, and v_session_live
-- (0003) computes that truth on every read. This function only snapshots it, so
-- the sweep frequency is irrelevant to correctness.
--
-- Two things it must get right or DV2 is silently wrong:
--   * For a timeout, ended_at = deadline_at, NEVER now(). A session finalized
--     three days late must not record a three-day duration.
--   * effort_duration_sec derives from last_answer_at, NEVER from now().
-- -----------------------------------------------------------------------------
create or replace function exp.finalize_session(p_session_id uuid)
returns exp.sessions
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare
  s exp.sessions;
  v_completed boolean;
  v_ended timestamptz;
begin
  select * into s from exp.sessions where id = p_session_id for update;
  if not found then
    raise exception 'unknown session %', p_session_id using errcode = 'no_data_found';
  end if;

  -- Idempotent: a second call is a no-op returning the same row.
  if s.finalized_at is not null then
    return s;
  end if;

  -- Still live: nothing to do.
  if s.answered_count < s.item_count and now() < s.deadline_at then
    return s;
  end if;

  v_completed := (s.answered_count >= s.item_count);
  v_ended     := case when v_completed then s.last_answer_at else s.deadline_at end;

  update exp.sessions set
    status    = case when v_completed then 'completed'::exp.session_status
                     else 'timed_out'::exp.session_status end,
    completed = v_completed,
    ended_at  = v_ended,

    -- Time until they stopped answering. Always from last_answer_at.
    effort_duration_sec = least(time_limit_sec + 5, greatest(0, round(extract(epoch from
        (coalesce(last_answer_at, started_at) - started_at)))))::integer,

    -- The paper's stated DV. Right-censored at the time limit for timeouts.
    exposure_duration_sec = least(time_limit_sec, greatest(0, round(extract(epoch from
        (v_ended - started_at)))))::integer,

    -- Time until they stopped sitting there, from the visibility-gated heartbeat.
    engaged_duration_sec = least(time_limit_sec, greatest(0, round(extract(epoch from
        (greatest(coalesce(last_heartbeat_at, started_at),
                  coalesce(last_answer_at,    started_at),
                  started_at) - started_at)))))::integer,

    -- Without this indicator the three durations above are uninterpretable.
    duration_censored = not v_completed,
    finalized_at      = now()
  where id = p_session_id
  returning * into s;

  -- lag_sec records how long after the true end this ran. If it is ever large
  -- and the number is challenged, the event log shows the durations were
  -- computed from deadline_at and last_answer_at, not from the lag.
  insert into exp.session_events (session_id, seq, event_type, payload)
  values (p_session_id, exp.next_seq(p_session_id), 'finalized',
          jsonb_build_object(
            'status',   s.status,
            'answered', s.answered_count,
            'lag_sec',  round(extract(epoch from (now() - s.ended_at)))));

  return s;
end $$;

-- Sweep. FOR UPDATE SKIP LOCKED so the sweep can never block a live
-- participant's answer submission.
create or replace function exp.finalize_expired_sessions(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare r record; n integer := 0;
begin
  for r in
    select id from exp.sessions
    where finalized_at is null
      and (deadline_at <= now() or answered_count >= item_count)
    order by deadline_at
    limit p_limit
    for update skip locked
  loop
    perform exp.finalize_session(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- -----------------------------------------------------------------------------
-- Internal: build the client payload for the current item.
--
-- Returns {nonce, stem, options[]} and NOTHING ELSE. No position, no total, no
-- is_correct, no source_label. This is the single place item data becomes
-- client-visible, so it is the single place that needs to be right.
--
-- p_with_progress is true only for the treatment group and adds answered/total.
-- -----------------------------------------------------------------------------
create or replace function exp.serve_current_item(p_session_id uuid, p_with_progress boolean)
returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare
  s     exp.sessions;
  sq    exp.session_questions;
  v_nonce uuid;
  v_opts  jsonb;
  v_stem  text;
  v_out   jsonb;
begin
  select * into s from exp.sessions where id = p_session_id;

  select * into sq
  from exp.session_questions
  where session_id = p_session_id and answered_at is null
  order by position
  limit 1;

  if not found then
    return jsonb_build_object('terminal', 'completed');
  end if;

  v_nonce := gen_random_uuid();

  update exp.session_questions set
    -- COALESCE: first exposure is recorded once and never overwritten, so a
    -- re-render (resume, refresh, React re-invoke) cannot corrupt dwell_total.
    first_served_at = coalesce(first_served_at, now()),
    last_served_at  = now(),
    serve_count     = serve_count + 1,
    serve_nonce     = v_nonce
  where session_id = sq.session_id and position = sq.position;

  select q.stem into v_stem from exp.questions q where q.id = sq.question_id;

  -- Options in this participant's shuffled order. Note the join is on the
  -- ordinality of option_order, so render order is the stored plan's order.
  select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.content) order by u.ord)
    into v_opts
  from unnest(sq.option_order) with ordinality as u(opt_id, ord)
  join exp.question_options o on o.id = u.opt_id;

  insert into exp.session_events (session_id, seq, event_type, position)
  values (p_session_id, exp.next_seq(p_session_id), 'item_served', sq.position);

  v_out := jsonb_build_object(
    'nonce',        v_nonce,
    'stem',         v_stem,
    'options',      v_opts,
    'deadlineAtMs', (extract(epoch from s.deadline_at) * 1000)::bigint,
    'serverNowMs',  (extract(epoch from now()) * 1000)::bigint
  );

  -- The ONLY place progress information is ever added to a payload.
  if p_with_progress then
    v_out := v_out || jsonb_build_object(
      'answeredCount', s.answered_count,
      'totalCount',    s.item_count);
  end if;

  return v_out;
end $$;

-- -----------------------------------------------------------------------------
-- exp.redeem_key — key entry. Does NOT start the clock.
--
-- Mints a browser session bound to the key. The attempt (and the deadline) is
-- created later by begin_attempt, when the participant accepts consent.
-- -----------------------------------------------------------------------------
create or replace function exp.redeem_key(
  p_key_code   text,
  p_token_hash bytea,
  p_ttl_sec    integer,
  p_ip_hash    bytea default null
) returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare
  k    exp.participant_keys;
  s    exp.sessions;
  cfg  exp.study_config;
  v_norm text;
  v_fails integer;
begin
  select * into cfg from exp.study_config;

  -- Throttle enumeration. Keys are ~39 bits so brute force is infeasible
  -- anyway, but this makes it pointless to try. Counted per hashed IP.
  if p_ip_hash is not null then
    select count(*) into v_fails
      from exp.key_attempt_log
     where ip_hash = p_ip_hash
       and not success
       and attempted_at > now() - interval '10 minutes';

    if v_fails >= 10 then
      return jsonb_build_object('ok', false, 'reason', 'rate_limited');
    end if;
  end if;

  v_norm := upper(regexp_replace(coalesce(p_key_code, ''), '[^A-Za-z0-9]', '', 'g'));

  select * into k from exp.participant_keys where key_code_norm = v_norm;

  if not found then
    insert into exp.key_attempt_log (ip_hash, success)
    values (coalesce(p_ip_hash, '\x00'::bytea), false);
    -- Deliberately identical to every other failure. Never distinguish
    -- "unknown key" from "already used" — that is a probing oracle.
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- Refuse to collect real data against an unlocked (still editable) item pool.
  if not cfg.pool_locked and not k.is_test then
    return jsonb_build_object('ok', false, 'reason', 'not_open');
  end if;

  insert into exp.key_attempt_log (ip_hash, success)
  values (coalesce(p_ip_hash, '\x00'::bytea), true);

  select * into s from exp.sessions where key_id = k.id;

  -- Lazily finalize an attempt whose deadline passed while the tab was closed,
  -- so the participant is routed to the survey rather than back to item 74.
  if found and s.finalized_at is null then
    s := exp.finalize_session(s.id);
  end if;

  -- Exactly one live browser per key: minting a new browser session kills any
  -- other. The abandoned tab's next submit fails and bounces it to the landing
  -- page.
  delete from exp.browser_sessions where key_id = k.id;

  insert into exp.browser_sessions (token_hash, key_id, session_id, expires_at)
  values (p_token_hash, k.id, s.id, now() + make_interval(secs => p_ttl_sec));

  if s.id is not null then
    insert into exp.session_events (session_id, seq, event_type)
    values (s.id, exp.next_seq(s.id), 'session_resume');
  end if;

  return jsonb_build_object(
    'ok',        true,
    'codename',  k.codename,
    'hasAttempt', s.id is not null,
    'status',    coalesce(s.status::text, 'not_started'),
    'surveyed',  coalesce((select true from exp.surveys where session_id = s.id), false),
    'debriefed', s.debriefed_at is not null
  );
end $$;

-- -----------------------------------------------------------------------------
-- exp.begin_attempt — consent accepted. THE CLOCK STARTS HERE.
--
-- Creates the attempt and materializes the whole 100-row randomization plan in
-- one transaction. The deferred plan_complete constraint verifies the row count
-- at COMMIT.
-- -----------------------------------------------------------------------------
create or replace function exp.begin_attempt(
  p_token_hash  bytea,
  p_plan        jsonb,
  p_plan_sha256 bytea,
  p_ua_family   text default null
) returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare
  bs  exp.browser_sessions;
  k   exp.participant_keys;
  cfg exp.study_config;
  s   exp.sessions;
  v_expected bytea;
begin
  select * into bs from exp.browser_sessions
   where token_hash = p_token_hash and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;

  select * into cfg from exp.study_config;
  select * into k from exp.participant_keys where id = bs.key_id for update;

  -- Already started (double-submitted consent, or a second tab): idempotent.
  select * into s from exp.sessions where key_id = k.id;
  if found then
    update exp.browser_sessions set session_id = s.id where token_hash = p_token_hash;
    return jsonb_build_object('ok', true, 'alreadyStarted', true,
                              'status', s.status::text);
  end if;

  -- Verify the plan hash server-side before anything is committed.
  v_expected := exp.plan_hash(p_plan);
  if v_expected is distinct from p_plan_sha256 then
    raise exception 'plan hash mismatch' using errcode = 'check_violation';
  end if;

  insert into exp.sessions (
    key_id, arm, item_count, time_limit_sec,
    started_at, deadline_at, plan_sha256, ua_family)
  values (
    k.id, k.arm, cfg.item_count, cfg.time_limit_sec,
    now(), now() + make_interval(secs => cfg.time_limit_sec),
    p_plan_sha256, p_ua_family)
  returning * into s;

  insert into exp.session_questions (session_id, position, question_id, option_order)
  select s.id, p.position, p.question_id, p.option_order
  from jsonb_to_recordset(p_plan)
       as p(position smallint, question_id uuid, option_order uuid[]);

  update exp.browser_sessions set session_id = s.id where token_hash = p_token_hash;

  insert into exp.session_events (session_id, seq, event_type, payload)
  values (s.id, exp.next_seq(s.id), 'session_start',
          jsonb_build_object('arm', s.arm, 'itemCount', s.item_count));

  return jsonb_build_object('ok', true, 'alreadyStarted', false, 'status', 'in_progress');
end $$;

-- -----------------------------------------------------------------------------
-- exp.resolve_session — what should this browser be looking at right now?
--
-- The single source of routing truth. Every gated page calls this.
-- -----------------------------------------------------------------------------
create or replace function exp.resolve_session(p_token_hash bytea)
returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare
  bs exp.browser_sessions;
  k  exp.participant_keys;
  s  exp.sessions;
begin
  select * into bs from exp.browser_sessions
   where token_hash = p_token_hash and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;

  select * into k from exp.participant_keys where id = bs.key_id;

  if bs.session_id is null then
    return jsonb_build_object('ok', true, 'state', 'consent', 'codename', k.codename);
  end if;

  select * into s from exp.sessions where id = bs.session_id;

  -- Lazily finalize if the deadline passed while nobody was looking.
  if s.finalized_at is null and (now() >= s.deadline_at or s.answered_count >= s.item_count) then
    s := exp.finalize_session(s.id);
  end if;

  return jsonb_build_object(
    'ok',        true,
    'state',     case when s.finalized_at is null then 'in_progress'
                      when exists (select 1 from exp.surveys where session_id = s.id)
                        then 'debrief'
                      else 'survey' end,
    'codename',  k.codename,
    'arm',       s.arm,
    'status',    s.status,
    'completed', s.completed,
    'correct',   case when s.finalized_at is not null then s.correct_count end,
    'answered',  s.answered_count,
    'deadlineAtMs', (extract(epoch from s.deadline_at) * 1000)::bigint,
    'serverNowMs',  (extract(epoch from now()) * 1000)::bigint
  );
end $$;

-- -----------------------------------------------------------------------------
-- exp.get_current_item — serve the current question.
-- -----------------------------------------------------------------------------
create or replace function exp.get_current_item(p_token_hash bytea)
returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare bs exp.browser_sessions; s exp.sessions;
begin
  select * into bs from exp.browser_sessions
   where token_hash = p_token_hash and expires_at > now();
  if not found or bs.session_id is null then
    return jsonb_build_object('terminal', 'no_session');
  end if;

  select * into s from exp.sessions where id = bs.session_id for update;

  if s.finalized_at is not null then
    return jsonb_build_object('terminal', s.status::text);
  end if;

  if now() >= s.deadline_at then
    perform exp.finalize_session(s.id);
    return jsonb_build_object('terminal', 'timed_out');
  end if;

  return exp.serve_current_item(s.id, s.arm = 'treatment');
end $$;

-- -----------------------------------------------------------------------------
-- exp.submit_answer — the hot path.
--
-- Validates the deadline, matches the serve nonce, scores by option IDENTITY
-- (never by letter), advances, and returns the NEXT item in the same response.
-- One round trip per question.
-- -----------------------------------------------------------------------------
create or replace function exp.submit_answer(
  p_token_hash bytea,
  p_nonce      uuid,
  p_option_id  uuid,
  p_client_at  timestamptz default null,
  p_hidden_ms  integer     default 0
) returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare
  bs  exp.browser_sessions;
  s   exp.sessions;
  sq  exp.session_questions;
  cfg exp.study_config;
  v_correct boolean;
  v_slot    smallint;
  v_late_ms bigint;
begin
  select * into bs from exp.browser_sessions
   where token_hash = p_token_hash and expires_at > now();
  if not found or bs.session_id is null then
    return jsonb_build_object('terminal', 'no_session');
  end if;

  select * into cfg from exp.study_config;

  -- The row lock. Everything below is serialized for this participant.
  select * into s from exp.sessions where id = bs.session_id for update;

  if s.finalized_at is not null then
    return jsonb_build_object('terminal', s.status::text);
  end if;

  -- Deadline enforcement, with a small grace for a click at 59:59.6 whose
  -- request lands just after. late_ms is recorded so the analyst can exclude.
  v_late_ms := round(extract(epoch from (now() - s.deadline_at)) * 1000);
  if v_late_ms > cfg.late_grace_ms then
    insert into exp.session_events (session_id, seq, event_type, payload)
    values (s.id, exp.next_seq(s.id), 'answer_rejected_late',
            jsonb_build_object('late_ms', v_late_ms));
    perform exp.finalize_session(s.id);
    return jsonb_build_object('terminal', 'timed_out');
  end if;

  select * into sq from exp.session_questions
   where session_id = s.id and serve_nonce = p_nonce;

  if not found then
    -- Replayed or forged nonce. Log it and just re-sync the client.
    insert into exp.session_events (session_id, seq, event_type, payload)
    values (s.id, exp.next_seq(s.id), 'answer_rejected_stale',
            jsonb_build_object('nonce', p_nonce));
    return exp.serve_current_item(s.id, s.arm = 'treatment')
           || jsonb_build_object('resync', true);
  end if;

  -- Double-click / retry of the SAME answer: idempotent success.
  if sq.answered_at is not null then
    if sq.selected_option_id = p_option_id then
      return exp.serve_current_item(s.id, s.arm = 'treatment');
    end if;
    -- Same nonce, different option: an attempt to change a committed answer.
    -- (The trigger would refuse anyway; this returns a clean resync instead.)
    insert into exp.session_events (session_id, seq, event_type, position, payload)
    values (s.id, exp.next_seq(s.id), 'answer_rejected_stale', sq.position,
            jsonb_build_object('reason', 'answer_change'));
    return exp.serve_current_item(s.id, s.arm = 'treatment')
           || jsonb_build_object('resync', true);
  end if;

  -- The submitted option must be one of the options actually shown for THIS
  -- item. (sq_selected_in_plan enforces it too; this gives a clean message.)
  if not (p_option_id = any(sq.option_order)) then
    raise exception 'option % is not among the options served for this item', p_option_id
      using errcode = 'check_violation';
  end if;

  -- SCORING. By option identity, from the database. The caller's opinion about
  -- correctness is never consulted, and no letter is involved anywhere.
  select o.is_correct into v_correct
    from exp.question_options o where o.id = p_option_id;

  select u.ord::smallint into v_slot
    from unnest(sq.option_order) with ordinality as u(opt_id, ord)
   where u.opt_id = p_option_id;

  update exp.session_questions set
    answered_at        = now(),
    selected_option_id = p_option_id,
    selected_slot      = v_slot,
    is_correct         = v_correct,
    client_answered_at = p_client_at,
    clock_skew_ms      = case when p_client_at is null then null
                              else round(extract(epoch from (now() - p_client_at)) * 1000)
                         end,
    hidden_ms          = hidden_ms + greatest(0, coalesce(p_hidden_ms, 0))
  where session_id = sq.session_id and position = sq.position;

  update exp.sessions set hidden_ms_total = hidden_ms_total + greatest(0, coalesce(p_hidden_ms, 0))
   where id = s.id;

  insert into exp.session_events (session_id, seq, event_type, position, client_at)
  values (s.id, exp.next_seq(s.id), 'item_answered', sq.position, p_client_at);

  -- Re-read: the after-answer trigger has updated the counters.
  select * into s from exp.sessions where id = s.id;

  if s.answered_count >= s.item_count then
    perform exp.finalize_session(s.id);
    return jsonb_build_object('terminal', 'completed');
  end if;

  -- The next item rides back in this response. This is a safe prefetch: the
  -- payload only arrives after the previous answer is committed, so no
  -- unanswered question is ever sitting in the client ahead of time.
  return exp.serve_current_item(s.id, s.arm = 'treatment');
end $$;

-- -----------------------------------------------------------------------------
-- exp.record_focus_loss — SILENT. Nothing is ever shown to the participant.
--
-- The client sends an EVENT with a client-generated dedupe key, never a count.
-- The count is the server's alone, so it cannot be tampered with, and beacon
-- retries are free.
-- -----------------------------------------------------------------------------
create or replace function exp.record_focus_loss(
  p_token_hash bytea,
  p_dedupe_key uuid,
  p_client_at  timestamptz default null,
  p_hidden_ms  integer     default 0
) returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare bs exp.browser_sessions; s exp.sessions; v_last timestamptz; v_rows integer;
begin
  select * into bs from exp.browser_sessions
   where token_hash = p_token_hash and expires_at > now();
  if not found or bs.session_id is null then
    return jsonb_build_object('ok', false);
  end if;

  select * into s from exp.sessions where id = bs.session_id for update;
  if s.finalized_at is not null then
    return jsonb_build_object('ok', true, 'counted', false);
  end if;

  -- Debounce BEFORE recording. Some mobile browsers flap blur/focus on an
  -- incoming notification; without this an honest participant on a phone could
  -- be flagged within seconds.
  select max(server_at) into v_last
    from exp.session_events
   where session_id = s.id and event_type = 'focus_lost';

  if v_last is not null
     and now() - v_last < make_interval(secs =>
           (select focus_debounce_ms from exp.study_config) / 1000.0) then
    return jsonb_build_object('ok', true, 'counted', false);
  end if;

  insert into exp.session_events (session_id, seq, event_type, client_at, dedupe_key)
  values (s.id, exp.next_seq(s.id), 'focus_lost', p_client_at, p_dedupe_key)
  on conflict (session_id, dedupe_key) where dedupe_key is not null do nothing;

  -- Zero rows means this exact beacon already landed (sendBeacon retried).
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('ok', true, 'counted', false);
  end if;

  -- The DQ trigger fires on this update. It sets a flag; it shows nothing.
  update exp.sessions set
    focus_loss_count = focus_loss_count + 1,
    hidden_ms_total  = hidden_ms_total + greatest(0, coalesce(p_hidden_ms, 0)),
    last_event_at    = now()
  where id = s.id;

  return jsonb_build_object('ok', true, 'counted', true);
end $$;

-- -----------------------------------------------------------------------------
-- exp.record_heartbeat — sent every 15s, ONLY while the tab is visible.
-- Feeds engaged_duration_sec. Sending while hidden would defeat the point.
-- -----------------------------------------------------------------------------
create or replace function exp.record_heartbeat(
  p_token_hash     bytea,
  p_hidden_ms_delta integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare bs exp.browser_sessions; s exp.sessions;
begin
  select * into bs from exp.browser_sessions
   where token_hash = p_token_hash and expires_at > now();
  if not found or bs.session_id is null then
    return jsonb_build_object('ok', false, 'terminal', 'no_session');
  end if;

  select * into s from exp.sessions where id = bs.session_id;

  if s.finalized_at is not null then
    return jsonb_build_object('ok', true, 'terminal', s.status::text);
  end if;

  if now() >= s.deadline_at then
    perform exp.finalize_session(s.id);
    return jsonb_build_object('ok', true, 'terminal', 'timed_out');
  end if;

  update exp.sessions set
    last_heartbeat_at = now(),
    hidden_ms_total   = hidden_ms_total + greatest(0, coalesce(p_hidden_ms_delta, 0)),
    last_event_at     = now()
  where id = s.id;

  return jsonb_build_object(
    'ok', true,
    'deadlineAtMs', (extract(epoch from s.deadline_at) * 1000)::bigint,
    'serverNowMs',  (extract(epoch from now()) * 1000)::bigint);
end $$;

-- -----------------------------------------------------------------------------
-- exp.finalize_attempt_now — the client's clock hit zero.
--
-- The client NEVER decides termination. If the server disagrees (the client's
-- clock ran fast), this returns corrected timestamps and the client unlocks and
-- keeps working. Nobody loses time to a bad clock.
-- -----------------------------------------------------------------------------
create or replace function exp.finalize_attempt_now(p_token_hash bytea)
returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare bs exp.browser_sessions; s exp.sessions;
begin
  select * into bs from exp.browser_sessions
   where token_hash = p_token_hash and expires_at > now();
  if not found or bs.session_id is null then
    return jsonb_build_object('terminal', 'no_session');
  end if;

  select * into s from exp.sessions where id = bs.session_id for update;

  if s.finalized_at is not null then
    return jsonb_build_object('terminal', s.status::text);
  end if;

  if now() < s.deadline_at then
    -- The client was early. Hand back the truth and let them continue.
    return jsonb_build_object(
      'terminal', null,
      'deadlineAtMs', (extract(epoch from s.deadline_at) * 1000)::bigint,
      'serverNowMs',  (extract(epoch from now()) * 1000)::bigint);
  end if;

  s := exp.finalize_session(s.id);
  return jsonb_build_object('terminal', s.status::text);
end $$;

-- -----------------------------------------------------------------------------
-- exp.submit_survey — post-quiz, on BOTH completion and timeout.
-- -----------------------------------------------------------------------------
create or replace function exp.submit_survey(
  p_token_hash bytea,
  p_likert     smallint[],   -- exhaustion, difficulty, focus drain, stress, overall
  p_considers  boolean[],    -- forfeit, slow, rush, random, none
  p_heard      boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare bs exp.browser_sessions;
begin
  select * into bs from exp.browser_sessions
   where token_hash = p_token_hash and expires_at > now();
  if not found or bs.session_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;

  if array_length(p_likert, 1) <> 5 or array_length(p_considers, 1) <> 5 then
    raise exception 'survey payload must have 5 likert items and 5 checkboxes'
      using errcode = 'check_violation';
  end if;

  insert into exp.surveys (
    session_id,
    likert_mental_exhaustion, likert_perceived_difficulty, likert_focus_drain,
    likert_timer_stress, likert_overall_difficulty,
    consider_forfeit, consider_slow, consider_rush, consider_random, consider_none,
    heard_beforehand)
  values (
    bs.session_id,
    p_likert[1], p_likert[2], p_likert[3], p_likert[4], p_likert[5],
    p_considers[1], p_considers[2], p_considers[3], p_considers[4], p_considers[5],
    p_heard)
  on conflict (session_id) do nothing;

  insert into exp.session_events (session_id, seq, event_type)
  values (bs.session_id, exp.next_seq(bs.session_id), 'survey_submitted');

  return jsonb_build_object('ok', true);
end $$;

create or replace function exp.mark_debriefed(p_token_hash bytea)
returns jsonb
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare bs exp.browser_sessions;
begin
  select * into bs from exp.browser_sessions
   where token_hash = p_token_hash and expires_at > now();
  if not found or bs.session_id is null then
    return jsonb_build_object('ok', false);
  end if;

  update exp.sessions set debriefed_at = coalesce(debriefed_at, now())
   where id = bs.session_id;

  insert into exp.session_events (session_id, seq, event_type)
  values (bs.session_id, exp.next_seq(bs.session_id), 'debrief_viewed');

  return jsonb_build_object('ok', true);
end $$;

-- -----------------------------------------------------------------------------
-- Housekeeping: purge expired browser sessions and stale rate-limit rows.
-- -----------------------------------------------------------------------------
create or replace function exp.housekeeping()
returns void
language sql
security definer
set search_path = exp, pg_catalog
as $$
  delete from exp.browser_sessions where expires_at < now() - interval '1 day';
  delete from exp.key_attempt_log  where attempted_at < now() - interval '1 hour';
$$;
