-- =============================================================================
-- Goal-Proximity Experiment — full schema (regenerated).
-- =============================================================================

drop schema if exists exp cascade;

-- ///////////////////// 0001_schema.sql /////////////////////
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

-- ///////////////////// 0002_functions.sql /////////////////////
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
    perform exp.finalize_session(s.id);
    return jsonb_build_object('terminal', 'timed_out');
  end if;

  select * into sq from exp.session_questions
   where session_id = s.id and serve_nonce = p_nonce;

  if not found then
    -- Replayed or forged nonce. Just re-sync the client.
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
declare bs exp.browser_sessions; s exp.sessions;
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

  -- A retried beacon carries the SAME dedupe key. sendBeacon can fall back to
  -- fetch, so the identical body may arrive twice; count it once.
  if p_dedupe_key is not null and s.last_focus_dedupe_key = p_dedupe_key then
    return jsonb_build_object('ok', true, 'counted', false);
  end if;

  -- Debounce. Some mobile browsers flap blur/focus on an incoming
  -- notification; without this an honest participant on a phone could be
  -- flagged within seconds.
  if s.last_focus_loss_at is not null
     and now() - s.last_focus_loss_at < make_interval(secs =>
           (select focus_debounce_ms from exp.study_config) / 1000.0) then
    return jsonb_build_object('ok', true, 'counted', false);
  end if;

  -- The DQ trigger fires on this update. It sets a flag; it shows nothing.
  update exp.sessions set
    focus_loss_count      = focus_loss_count + 1,
    hidden_ms_total       = hidden_ms_total + greatest(0, coalesce(p_hidden_ms, 0)),
    last_focus_loss_at    = now(),
    last_focus_dedupe_key = p_dedupe_key,
    last_event_at         = now()
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

-- ///////////////////// 0003_views.sql /////////////////////
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

-- ///////////////////// 0004_purge.sql /////////////////////
-- =============================================================================
-- 0004_purge.sql — deleting a participant's data.
--
-- Needed for two reasons:
--   1. ETHICS. The debriefing page tells participants they may contact the
--      researcher to have their data removed.
--   2. OPERATIONS. Pilot sessions have to be cleanable.
--
-- A delete on exp.sessions cascades to its plan rows and its survey, so these
-- are thin wrappers. They exist so the operator has a named, obvious action
-- rather than hand-writing a DELETE against the live database.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- exp.purge_session — the right-to-withdraw path.
--
-- The participant_keys row is deliberately KEPT: it holds no PII, and
-- retaining it preserves the denominator for the CONSORT flow diagram — you
-- can still report "300 keys issued, n redeemed, 1 withdrawn" rather than
-- silently losing a row.
-- -----------------------------------------------------------------------------
create or replace function exp.purge_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare v_found boolean;
begin
  delete from exp.sessions where id = p_session_id;
  get diagnostics v_found = row_count;
  return v_found;
end $$;

/** Withdraw by access key, which is what a participant will quote. */
create or replace function exp.purge_by_key(p_key_code text)
returns boolean
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare v_id uuid;
begin
  select s.id into v_id
  from exp.sessions s
  join exp.participant_keys k on k.id = s.key_id
  where k.key_code_norm = upper(regexp_replace(coalesce(p_key_code,''), '[^A-Za-z0-9]', '', 'g'));

  if v_id is null then
    return false;
  end if;
  return exp.purge_session(v_id);
end $$;

/** Wipe every pilot session. Never touches real participants. */
create or replace function exp.purge_test_sessions()
returns integer
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare n integer;
begin
  with doomed as (
    delete from exp.sessions s
    using exp.participant_keys k
    where k.id = s.key_id and k.is_test
    returning s.id
  )
  select count(*) into n from doomed;
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

-- ///////////////////// 0005_demo.sql /////////////////////
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

-- ///////////////////// 0006_preflight_fix.sql /////////////////////
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

