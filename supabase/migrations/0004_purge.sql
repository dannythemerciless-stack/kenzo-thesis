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
