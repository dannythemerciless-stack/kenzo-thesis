-- =============================================================================
-- 0004_purge.sql — make deletion possible, without giving up the audit trail.
--
-- THE BUG THIS FIXES
--
-- exp.session_events has an append-only trigger that refuses UPDATE and
-- DELETE. But session_events references sessions ON DELETE CASCADE, so the
-- cascade fired the trigger and *any* attempt to delete a session failed with
-- "session_events is append-only".
--
-- That made exp.sessions effectively undeletable, which is a problem twice
-- over:
--
--   1. ETHICS. The debriefing page tells participants they may contact the
--      researcher to have their data removed. That was unimplementable.
--   2. OPERATIONS. Pilot/test sessions could never be cleaned up.
--
-- THE FIX
--
-- The trigger still refuses every casual DELETE. It makes one exception: a
-- transaction that has deliberately set the `exp.allow_purge` flag, which only
-- the documented purge functions below do. So an accidental or ad-hoc delete
-- is still impossible, while a deliberate, auditable withdrawal works.
-- =============================================================================

create or replace function exp.tg_append_only() returns trigger
language plpgsql as $$
begin
  -- The escape hatch: set transaction-locally by exp.purge_session().
  if tg_op = 'DELETE'
     and coalesce(current_setting('exp.allow_purge', true), 'off') = 'on' then
    return old;
  end if;

  raise exception
    'session_events is append-only (use exp.purge_session() to remove a participant''s data)'
    using errcode = 'restrict_violation';
end $$;

-- -----------------------------------------------------------------------------
-- exp.purge_session — the right-to-withdraw path.
--
-- Removes the attempt and everything hanging off it (plan rows, per-item
-- timing, event log, survey, browser sessions) by cascade. The participant_keys
-- row is deliberately KEPT: it holds no PII, and retaining it preserves the
-- denominator for the CONSORT flow diagram — you can still report "300 keys
-- issued, n redeemed, 1 withdrawn" rather than silently losing a row.
-- -----------------------------------------------------------------------------
create or replace function exp.purge_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = exp, pg_catalog
as $$
declare v_found boolean;
begin
  perform set_config('exp.allow_purge', 'on', true);  -- true => transaction-local
  delete from exp.sessions where id = p_session_id;
  get diagnostics v_found = row_count;
  perform set_config('exp.allow_purge', 'off', true);
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
  perform set_config('exp.allow_purge', 'on', true);
  with doomed as (
    delete from exp.sessions s
    using exp.participant_keys k
    where k.id = s.key_id and k.is_test
    returning s.id
  )
  select count(*) into n from doomed;
  perform set_config('exp.allow_purge', 'off', true);
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
