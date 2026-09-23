-- =============================================================================
-- 0001_schema.sql — Goal-Proximity Experiment Platform
--
-- Everything lives in the `exp` schema, NOT `public`. Supabase's PostgREST only
-- exposes schemas listed in its db-schemas config (default: public), so the anon
-- key cannot even see these tables. That is the real security boundary; the
-- RLS block at the bottom is a second layer.
--
-- Design rule: every invariant that protects the experiment is enforced by the
-- DATABASE, not by application code. If a constraint here can be expressed as a
-- unique index or a trigger, it is, because "the app promises not to" is not an
-- answer a thesis panel should have to accept.
-- =============================================================================

-- Requires PostgreSQL 13+ (Supabase ships 15/17). gen_random_uuid() and
-- sha256() are both core pg_catalog functions there, so this schema has NO
-- extension dependency — which also means the hardened `search_path` on the
-- SECURITY DEFINER functions in 0002 never has to include a public or
-- extensions schema.
create schema if not exists exp;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type exp.arm as enum ('control', 'treatment');

create type exp.session_status as enum ('in_progress', 'completed', 'timed_out');

-- -----------------------------------------------------------------------------
-- Study configuration (singleton)
--
-- `id boolean primary key default true check (id)` is the standard singleton
-- trick: only one row can ever exist, because the only permitted value of the
-- primary key is `true`.
-- -----------------------------------------------------------------------------

create table exp.study_config (
  id                  boolean primary key default true check (id),
  -- Once true, the question pool is frozen. Prevents collecting data against an
  -- item pool that is still being edited.
  pool_locked         boolean     not null default false,
  pool_locked_at      timestamptz,
  -- Gates the public leaderboard. Stays false until the field window closes so
  -- early finishers cannot leak the competitive bar to later participants.
  leaderboard_public  boolean     not null default false,
  time_limit_sec      integer     not null default 3600 check (time_limit_sec > 0),
  item_count          smallint    not null default 100  check (item_count > 0),
  -- Grace period for an answer submitted at 59:59.6 whose request lands after
  -- the deadline. Disclosed in the methodology.
  late_grace_ms       integer     not null default 2000 check (late_grace_ms >= 0),
  focus_loss_limit    smallint    not null default 5    check (focus_loss_limit > 0),
  -- Ignore a second focus loss within this window. Some mobile browsers flap
  -- blur/focus on an incoming notification, and without a debounce an honest
  -- participant on a phone could be flagged within seconds. Configurable so
  -- tests can disable it.
  focus_debounce_ms   integer     not null default 1000 check (focus_debounce_ms >= 0),

  -- Provenance of the question pool. Which CSV produced it, and its hash.
  -- (These were a separate import_batches table; there is only ever one pool,
  -- so three columns on the single config row says the same thing.)
  pool_source_name    text,
  pool_source_sha256  bytea,
  pool_imported_at    timestamptz
);

insert into exp.study_config (id) values (true) on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Participant keys
--
-- Contains NO personally identifiable information. `key_code` is the join column
-- to the researcher's private Google Sheet, which holds email and demographics.
-- -----------------------------------------------------------------------------

create table exp.participant_keys (
  id            uuid primary key default gen_random_uuid(),
  key_code      text not null,

  -- Participants retype keys with stray case, spaces and hyphens. The unique
  -- index goes on the NORMALIZED form so that uniqueness is enforced under the
  -- same transformation the lookup uses. Without this, 'KQ-ABCD' and 'kqabcd'
  -- could both exist as distinct rows and a redeem would be ambiguous.
  key_code_norm text generated always as
                  (upper(regexp_replace(key_code, '[^A-Za-z0-9]', '', 'g'))) stored,

  codename      text        not null,
  arm           exp.arm     not null,
  -- Block-randomization block index. Persisted so it can serve as a fixed
  -- effect in the analysis.
  block         smallint    not null check (block >= 0),
  -- Pilot/debug keys. Filtered out of every export view. This flag is the only
  -- thing standing between development sessions and the thesis dataset.
  is_test       boolean     not null default false,
  created_at    timestamptz not null default now(),

  -- >= 8 alphanumeric characters. With a 30-character transcription-safe
  -- alphabet that is ~39 bits, which makes enumerating 300 valid keys
  -- infeasible. With no authentication, the key IS the credential.
  constraint pk_code_entropy
    check (char_length(regexp_replace(key_code, '[^A-Za-z0-9]', '', 'g')) >= 8)
);

create unique index pk_key_norm_uq on exp.participant_keys (key_code_norm);
create unique index pk_codename_uq on exp.participant_keys (lower(codename));
create index        pk_arm_idx     on exp.participant_keys (arm) where not is_test;

-- -----------------------------------------------------------------------------
-- Question pool
-- -----------------------------------------------------------------------------

create table exp.questions (
  id          uuid primary key default gen_random_uuid(),
  item_code   text not null,          -- stable id from the source spreadsheet
  stem        text not null,
  topic       text,
  is_active   boolean not null default true,
  -- Post-hoc flag for an item found to be defective after collection started.
  -- This is the ONLY field that may change once the pool is locked.
  excluded_from_scoring boolean not null default false,
  exclusion_reason      text,
  created_at  timestamptz not null default now()
);

create unique index q_item_code_uq on exp.questions (item_code);
create index        q_active_idx   on exp.questions (id) where is_active;

create table exp.question_options (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references exp.questions(id) on delete cascade,
  content      text not null,
  is_correct   boolean not null default false,

  -- AUDIT ONLY. The letter this option had in the source spreadsheet.
  -- Retained so the thesis can show "the source key was C 62% of the time, and
  -- here is the empirical distribution of the rendered slot in our data
  -- (uniform)". It is NEVER read by scoring and never serialized to a client.
  source_label   char(1)  check (source_label in ('A','B','C','D','E')),
  source_ordinal smallint not null check (source_ordinal between 1 and 8),

  created_at   timestamptz not null default now()
);

-- At most one correct option per question. A partial unique index is the
-- idiomatic Postgres way to express "at most one true per group".
-- ("At least one" is a cross-row assertion and cannot be a table constraint,
-- so it lives in v_preflight_failures plus the pool_locked gate.)
create unique index qo_one_correct_uq on exp.question_options (question_id) where is_correct;
create unique index qo_ordinal_uq     on exp.question_options (question_id, source_ordinal);
create unique index qo_label_uq       on exp.question_options (question_id, source_label);

-- Two identical distractors on one item would let a participant pick a "wrong"
-- option whose text equals the right answer. That is a scoring bug that would
-- only ever surface as an unexplained wrong answer in the data. Make it
-- impossible to import.
create unique index qo_content_uq
  on exp.question_options (question_id, md5(lower(btrim(content))));

create index qo_by_question on exp.question_options (question_id);

-- -----------------------------------------------------------------------------
-- Sessions (one per key, forever)
-- -----------------------------------------------------------------------------

create table exp.sessions (
  id              uuid primary key default gen_random_uuid(),

  -- UNIQUE is what makes "one attempt per key" structural. A second attempt is
  -- not rejected by app logic; it is impossible.
  key_id          uuid not null unique references exp.participant_keys(id),

  -- Frozen copy of the group the participant was ACTUALLY shown. If the key
  -- table is ever touched, this is the ground truth for the manipulation.
  arm             exp.arm  not null,
  item_count      smallint not null check (item_count > 0),
  time_limit_sec  integer  not null check (time_limit_sec > 0),

  started_at      timestamptz not null default now(),
  -- NOTE: this cannot be a GENERATED ... STORED column. `timestamptz + interval`
  -- is STABLE, not IMMUTABLE (it consults TimeZone for day/month components),
  -- and Postgres rejects non-immutable expressions in stored generated columns
  -- and CHECK constraints. Set explicitly in redeem_key(), guarded below.
  deadline_at     timestamptz not null,

  -- Live counters. Maintained by trigger, never by application code, so they
  -- cannot drift from session_questions.
  answered_count    smallint    not null default 0,
  correct_count     smallint    not null default 0,
  first_answer_at   timestamptz,
  last_answer_at    timestamptz,
  last_event_at     timestamptz not null default now(),
  last_heartbeat_at timestamptz,
  hidden_ms_total   integer     not null default 0 check (hidden_ms_total >= 0),

  focus_loss_count  smallint not null default 0 check (focus_loss_count >= 0),
  disqualified      boolean  not null default false,
  disqualified_at   timestamptz,
  -- Enough state to debounce flapping focus events and to ignore a retried
  -- beacon, without keeping a row per event.
  last_focus_loss_at    timestamptz,
  last_focus_dedupe_key uuid,

  -- Randomization provenance. plan_sha256 is published in the thesis appendix;
  -- anyone can re-derive it from the exported plan and confirm nothing moved.
  rng_algo    text  not null default 'fisher-yates:node-crypto.randomInt',
  plan_sha256 bytea not null,

  -- Finalization snapshot. All null until finalized.
  status                exp.session_status not null default 'in_progress',
  completed             boolean,
  ended_at              timestamptz,
  effort_duration_sec   integer,
  exposure_duration_sec integer,
  engaged_duration_sec  integer,
  duration_censored     boolean,
  finalized_at          timestamptz,

  debriefed_at timestamptz,
  ua_family    text,

  constraint s_deadline_sane check (deadline_at > started_at),
  constraint s_counts        check (answered_count between 0 and item_count
                                and correct_count  between 0 and answered_count),
  constraint s_dq_consistent check (disqualified = (disqualified_at is not null)),
  constraint s_answer_order  check (last_answer_at is null
                                 or first_answer_at is null
                                 or last_answer_at >= first_answer_at),
  constraint s_exposure_cap  check (exposure_duration_sec is null
                                 or exposure_duration_sec between 0 and time_limit_sec),
  constraint s_effort_cap    check (effort_duration_sec is null
                                 or effort_duration_sec between 0 and time_limit_sec + 5),

  -- Makes partial finalization impossible. There is no state where `completed`
  -- is set but `effort_duration_sec` is not. Any future bug in finalize_session()
  -- that forgets a column becomes a loud transaction abort instead of a silent
  -- NULL in the STATA file.
  constraint s_final_shape check (
      (finalized_at is null
        and status = 'in_progress'
        and completed is null and ended_at is null
        and effort_duration_sec is null and exposure_duration_sec is null
        and engaged_duration_sec is null and duration_censored is null)
   or (finalized_at is not null
        and status <> 'in_progress'
        and completed is not null and ended_at is not null
        and effort_duration_sec is not null and exposure_duration_sec is not null
        and engaged_duration_sec is not null and duration_censored is not null))
);

-- Makes the expiry sweep an index-only scan over a handful of rows.
create index s_open_idx on exp.sessions (deadline_at) where finalized_at is null;
create index s_key_idx  on exp.sessions (key_id);

-- -----------------------------------------------------------------------------
-- Browser sessions (the cookie table)
--
-- Separate from exp.sessions (the attempt). One attempt may be resumed in a
-- different browser; minting a new row here and deleting the old one is what
-- guarantees exactly one live browser per key.
-- -----------------------------------------------------------------------------

create table exp.browser_sessions (
  -- sha256 of the opaque token in the cookie. The raw token is never stored, so
  -- a database leak does not hand over live browser sessions.
  token_hash  bytea primary key,
  key_id      uuid not null references exp.participant_keys(id) on delete cascade,
  -- Null between key entry and consent. The attempt (and therefore the clock)
  -- does not exist until the participant accepts the consent form.
  session_id  uuid references exp.sessions(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index bs_key_idx     on exp.browser_sessions (key_id);
create index bs_session_idx on exp.browser_sessions (session_id);
create index bs_expiry_idx  on exp.browser_sessions (expires_at);

-- -----------------------------------------------------------------------------
-- The randomization plan AND the per-item timing log, in one table.
--
-- Materialized rows rather than a JSONB blob on the session. The decisive
-- argument is auditability: with rows plus the immutability trigger below, the
-- answer to "how do I know you didn't reshuffle after seeing the data?" is
-- "the database physically rejects it", not "trust my application code".
-- -----------------------------------------------------------------------------

create table exp.session_questions (
  session_id   uuid     not null references exp.sessions(id) on delete cascade,
  position     smallint not null check (position between 1 and 200),
  question_id  uuid     not null references exp.questions(id),

  -- The shuffled option ids for THIS participant, in render order.
  option_order uuid[]   not null check (array_length(option_order, 1) between 2 and 8),

  -- Serving
  first_served_at timestamptz,   -- COALESCEd on write; never overwritten
  last_served_at  timestamptz,   -- rewritten on every re-render
  serve_count     smallint not null default 0 check (serve_count >= 0),
  -- Rotates on every serve. The client submits THIS, never a position, so a
  -- control participant reading the Network tab learns nothing about where they
  -- are. Doubles as stale-replay rejection.
  serve_nonce     uuid,
  hidden_ms       integer not null default 0 check (hidden_ms >= 0),

  -- Answering
  answered_at        timestamptz,
  selected_option_id uuid references exp.question_options(id),
  selected_slot      smallint,      -- 1-based index into option_order
  is_correct         boolean,
  client_answered_at timestamptz,   -- UNTRUSTED. Diagnostics only.
  clock_skew_ms      integer,       -- server_at - client_at. Diagnostics only.

  -- Three dwell measures, computed once at write and free at query time.
  -- (timestamptz - timestamptz -> interval IS immutable, so these are legal as
  -- stored generated columns, unlike deadline_at above.)
  dwell_total_ms integer generated always as (
    case when answered_at is not null and first_served_at is not null
         then (extract(epoch from (answered_at - first_served_at)) * 1000)::integer
    end) stored,
  dwell_active_ms integer generated always as (
    case when answered_at is not null and last_served_at is not null
         then (extract(epoch from (answered_at - last_served_at)) * 1000)::integer
    end) stored,
  dwell_focused_ms integer generated always as (
    case when answered_at is not null and first_served_at is not null
         then greatest(0, (extract(epoch from (answered_at - first_served_at)) * 1000)::integer
                          - hidden_ms)
    end) stored,

  primary key (session_id, position),

  -- An answer is all-or-nothing. No half-written answers.
  constraint sq_answer_atomic check (
      (answered_at is null and selected_option_id is null
       and selected_slot is null and is_correct is null)
   or (answered_at is not null and selected_option_id is not null
       and selected_slot is not null and is_correct is not null)),
  -- The selected option must be one of the options actually shown.
  constraint sq_selected_in_plan check (
      selected_option_id is null or selected_option_id = any(option_order)),
  constraint sq_slot_range check (
      selected_slot is null or selected_slot between 1 and array_length(option_order, 1)),
  constraint sq_served_first check (
      answered_at is null
   or (first_served_at is not null and answered_at >= first_served_at)),
  constraint sq_serve_order check (
      last_served_at is null or first_served_at is null
   or last_served_at >= first_served_at)
);

-- No question may appear twice in one participant's plan.
create unique index sq_session_question_uq on exp.session_questions (session_id, question_id);
create unique index sq_nonce_uq            on exp.session_questions (serve_nonce)
                                           where serve_nonce is not null;
-- Makes "the next unanswered item" an index lookup.
create index sq_next_unanswered on exp.session_questions (session_id, position)
                                where answered_at is null;
create index sq_answered_idx    on exp.session_questions (session_id, answered_at);

-- -----------------------------------------------------------------------------
-- -----------------------------------------------------------------------------
-- Post-quiz survey (Appendix A, Section C)
--
-- session_id as the PRIMARY KEY enforces one survey per session for free.
-- Five separate boolean columns rather than an array or JSONB: STATA wants a
-- rectangle, and five booleans export as five 0/1 variables with no parsing.
-- -----------------------------------------------------------------------------

create table exp.surveys (
  session_id   uuid primary key references exp.sessions(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  version      smallint    not null default 1,

  likert_mental_exhaustion    smallint not null check (likert_mental_exhaustion    between 1 and 5),
  likert_perceived_difficulty smallint not null check (likert_perceived_difficulty between 1 and 5),
  likert_focus_drain          smallint not null check (likert_focus_drain          between 1 and 5),
  likert_timer_stress         smallint not null check (likert_timer_stress         between 1 and 5),
  likert_overall_difficulty   smallint not null check (likert_overall_difficulty   between 1 and 5),

  consider_forfeit boolean not null default false,
  consider_slow    boolean not null default false,
  consider_rush    boolean not null default false,
  consider_random  boolean not null default false,
  consider_none    boolean not null default false,

  -- Contamination check: did anyone describe this quiz to them beforehand?
  -- Lets the analysis exclude contaminated cases.
  heard_beforehand boolean not null default false
);

-- -----------------------------------------------------------------------------
-- Key-entry rate limiting
--
-- ip_hash is HMAC-SHA256(ip, pepper), never a bare hash: a bare SHA-256 of an
-- IPv4 address is trivially reversible by brute force, which would put
-- recoverable network identifiers in a database that claims to hold no PII.
-- Rows are purged after an hour; they exist only to throttle enumeration.
-- -----------------------------------------------------------------------------

create table exp.key_attempt_log (
  id           bigint generated always as identity primary key,
  ip_hash      bytea       not null,
  attempted_at timestamptz not null default now(),
  success      boolean     not null
);

create index kal_ip_time on exp.key_attempt_log (ip_hash, attempted_at desc);

-- =============================================================================
-- TRIGGERS — the invariants
-- =============================================================================

-- Group assignment is immutable once the participant has been shown something.
-- An "arm typo" fixed after a session started would silently corrupt the
-- assignment record.
create or replace function exp.tg_freeze_arm() returns trigger
language plpgsql as $$
begin
  if new.arm is distinct from old.arm
     and exists (select 1 from exp.sessions s where s.key_id = old.id) then
    raise exception 'arm is immutable once a session exists for key %', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger freeze_arm before update on exp.participant_keys
  for each row execute function exp.tg_freeze_arm();

-- Once collection starts, the item pool is frozen except for the post-hoc
-- scoring-exclusion flags.
create or replace function exp.tg_pool_frozen() returns trigger
language plpgsql as $$
begin
  if (select pool_locked from exp.study_config) then
    if tg_table_name = 'questions' and tg_op = 'UPDATE'
       and to_jsonb(new) - 'excluded_from_scoring' - 'exclusion_reason'
         = to_jsonb(old) - 'excluded_from_scoring' - 'exclusion_reason' then
      return new;
    end if;
    raise exception 'item pool is locked; only scoring-exclusion flags may change'
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end $$;

create trigger pool_frozen before insert or update or delete on exp.questions
  for each row execute function exp.tg_pool_frozen();
create trigger pool_frozen before insert or update or delete on exp.question_options
  for each row execute function exp.tg_pool_frozen();

-- option_order must be exactly the option set of question_id — no more, no less.
-- Catches a plan generated against a stale copy of the pool.
create or replace function exp.tg_sq_validate_plan() returns trigger
language plpgsql as $$
declare v_expected uuid[];
begin
  select array_agg(o.id order by o.id) into v_expected
    from exp.question_options o where o.question_id = new.question_id;

  if (select array_agg(x order by x) from unnest(new.option_order) x)
     is distinct from v_expected then
    raise exception 'option_order is not a permutation of the options of question %',
      new.question_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger sq_validate_plan before insert on exp.session_questions
  for each row execute function exp.tg_sq_validate_plan();

-- The plan is write-once. Answers are append-once. Progress is forward-only.
-- Correctness is decided by the database, never asserted by the caller.
create or replace function exp.tg_sq_guard_update() returns trigger
language plpgsql as $$
begin
  if new.position <> old.position
     or new.question_id <> old.question_id
     or new.option_order is distinct from old.option_order then
    raise exception 'randomization plan is immutable (session %, position %)',
      old.session_id, old.position using errcode = 'restrict_violation';
  end if;

  if old.answered_at is not null
     and (new.answered_at        is distinct from old.answered_at
       or new.selected_option_id is distinct from old.selected_option_id
       or new.is_correct         is distinct from old.is_correct) then
    raise exception 'answers are immutable (session %, position %)',
      old.session_id, old.position using errcode = 'restrict_violation';
  end if;

  if old.answered_at is null and new.answered_at is not null then
    -- Forward-only: cannot answer position p while any q < p is unanswered.
    if exists (select 1 from exp.session_questions q
               where q.session_id = new.session_id
                 and q.position   < new.position
                 and q.answered_at is null) then
      raise exception 'forward-only violation: an earlier position is unanswered'
        using errcode = 'restrict_violation';
    end if;

    -- is_correct must match the database, never whatever the caller passed.
    if new.is_correct is distinct from
       (select o.is_correct from exp.question_options o where o.id = new.selected_option_id) then
      raise exception 'is_correct does not match option truth'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

create trigger sq_guard_update before update on exp.session_questions
  for each row execute function exp.tg_sq_guard_update();

-- Session counters are trigger-maintained so they cannot drift from the rows.
create or replace function exp.tg_sq_after_answer() returns trigger
language plpgsql as $$
begin
  if old.answered_at is null and new.answered_at is not null then
    update exp.sessions s set
      answered_count  = s.answered_count + 1,
      correct_count   = s.correct_count + (case when new.is_correct then 1 else 0 end),
      first_answer_at = coalesce(s.first_answer_at, new.answered_at),
      last_answer_at  = greatest(coalesce(s.last_answer_at, new.answered_at), new.answered_at),
      last_event_at   = greatest(s.last_event_at, new.answered_at)
    where s.id = new.session_id;
  end if;
  return null;
end $$;

create trigger sq_after_answer after update on exp.session_questions
  for each row execute function exp.tg_sq_after_answer();

-- A session's plan must be exactly item_count rows with no duplicate questions,
-- checked at COMMIT of the creating transaction. DEFERRABLE so the 100 plan
-- inserts may happen in any order after the session row.
create or replace function exp.tg_plan_complete() returns trigger
language plpgsql as $$
declare n integer;
begin
  select count(*) into n from exp.session_questions where session_id = new.id;
  if n <> new.item_count then
    raise exception 'session % has % plan rows, expected %', new.id, n, new.item_count;
  end if;
  return null;
end $$;

create constraint trigger plan_complete after insert on exp.sessions
  deferrable initially deferred
  for each row execute function exp.tg_plan_complete();

-- Disqualification is a trigger, not caller logic, so it cannot be forgotten.
-- NOTE: this sets a flag only. It is deliberately SILENT — nothing is shown to
-- the participant, because telling someone mid-task that they can no longer win
-- would remove the tournament incentive for the rest of the hour, and effort
-- duration over that hour is the dependent variable.
create or replace function exp.tg_focus_dq() returns trigger
language plpgsql as $$
begin
  if new.focus_loss_count >= (select focus_loss_limit from exp.study_config)
     and not old.disqualified then
    new.disqualified    := true;
    new.disqualified_at := now();
  end if;
  return new;
end $$;

create trigger focus_dq before update of focus_loss_count on exp.sessions
  for each row execute function exp.tg_focus_dq();

-- The survey may only exist AFTER the attempt has terminated.
create or replace function exp.tg_survey_gate() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from exp.sessions s
                 where s.id = new.session_id and s.finalized_at is not null) then
    raise exception 'survey may only be submitted after the session is finalized'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger survey_gate before insert on exp.surveys
  for each row execute function exp.tg_survey_gate();

-- =============================================================================
-- SECURITY
--
-- Layer 1 (the real one): the `exp` schema is not in PostgREST's db-schemas, so
--   the anon key cannot see these tables at all.
-- Layer 2: RLS enabled with FORCE and zero policies. FORCE matters — without it
--   RLS does not apply to the table owner, and a migration run as `postgres`
--   would bypass it. service_role has BYPASSRLS, so server code is unaffected,
--   which is precisely why RLS alone is not the boundary.
-- Layer 3: revoke grants, including for tables added later.
-- =============================================================================

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'exp'
  loop
    execute format('alter table exp.%I enable row level security', t);
    execute format('alter table exp.%I force  row level security', t);
  end loop;
end $$;

-- Revoke first, from PUBLIC as well as the two API roles. Revoking from PUBLIC
-- matters because every role inherits PUBLIC's privileges.
do $$
declare r text;
begin
  execute 'revoke all on schema exp from public';
  execute 'revoke all on all tables    in schema exp from public';
  execute 'revoke all on all functions in schema exp from public';
  execute 'revoke all on all sequences in schema exp from public';

  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema exp from %I', r);
      execute format('revoke all on all tables    in schema exp from %I', r);
      execute format('revoke all on all functions in schema exp from %I', r);
      execute format('revoke all on all sequences in schema exp from %I', r);
      -- Covers tables added by a future migration, so a table created in month
      -- three is not silently exposed.
      execute format('alter default privileges in schema exp revoke all on tables    from %I', r);
      execute format('alter default privileges in schema exp revoke all on functions from %I', r);
      execute format('alter default privileges in schema exp revoke all on sequences from %I', r);
    end if;
  end loop;
end $$;

-- Then grant to service_role, which is what the Next.js server authenticates
-- as. Supabase grants service_role on `public` automatically but NOT on a
-- custom schema, so without this block every query fails with "permission
-- denied for schema exp". service_role also has BYPASSRLS, which is why the
-- RLS above never impedes server code — and why the REVOKE, not the RLS, is
-- the actual security boundary.
do $$
declare r text;
begin
  foreach r in array array['service_role', 'postgres'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant usage on schema exp to %I', r);
      execute format('grant all on all tables    in schema exp to %I', r);
      execute format('grant all on all functions in schema exp to %I', r);
      execute format('grant all on all sequences in schema exp to %I', r);
      execute format('alter default privileges in schema exp grant all on tables    to %I', r);
      execute format('alter default privileges in schema exp grant all on functions to %I', r);
      execute format('alter default privileges in schema exp grant all on sequences to %I', r);
    end if;
  end loop;
end $$;
