-- AI Swarm-Match — KROK C: orkiestracja Abacus.ai (outbox, runy, push, bundle kandydatów)
-- Zasada integracji: Abacus NIGDY nie dostaje service_role ani dostępu do bazy.
-- Dostaje zdarzenie (sam swarm_uid) i woła zwężony endpoint Supabase po bundle kandydatów.

-- ============================================================ outbox zdarzeń roju
-- Webhook bez outboxa = zgubione dopasowania. Każde zdarzenie jest zapisywane
-- w tej samej transakcji co zmiana wektora/PoS i wysyłane przez dispatchera z retry.
create table public.swarm_events_outbox (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique,
  event_type       text not null check (event_type in (
                     'VECTOR_READY','VECTOR_UPDATED','POS_PASSED','PROFILE_READY')),
  swarm_uid        uuid not null references public.identity_vault(swarm_uid) on delete cascade,
  vector_version   text not null default 'vec-v1',
  payload          jsonb not null default '{}'::jsonb,   -- wyłącznie metadane; NIGDY wektor ani PII
  status           text not null default 'pending' check (status in (
                     'pending','claimed','acked','failed','dead','superseded')),
  attempts         integer not null default 0 check (attempts >= 0),
  next_attempt_at  timestamptz not null default now(),
  locked_at        timestamptz,
  locked_by        text,
  last_error_code  text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  acked_at         timestamptz
);
create index idx_outbox_dispatch on public.swarm_events_outbox(next_attempt_at)
  where status in ('pending','failed');

create table public.abacus_runs (
  id                bigint generated always as identity primary key,
  event_id          uuid references public.swarm_events_outbox(id) on delete set null,
  external_run_ref  text,                                  -- referencja wykonania po stronie Abacus (jeśli dostępna)
  source_swarm_uid  uuid not null references public.identity_vault(swarm_uid) on delete cascade,
  master_version    text not null,
  status            text not null check (status in (
                      'running','matched','no_match','ineligible','failed')),
  candidates_seen   integer not null default 0,
  candidates_scored integer not null default 0,
  best_similarity   double precision,
  result_match_id   uuid references public.Matches(id) on delete set null,
  error_code        text,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);
create index idx_abacus_runs_source on public.abacus_runs(source_swarm_uid, started_at desc);
create unique index uq_abacus_runs_external_ref on public.abacus_runs(external_run_ref)
  where external_run_ref is not null;

-- ============================================================ urządzenia push i skrzynka powiadomień
create table public.push_devices (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.app_users(id) on delete cascade,
  expo_push_token       text not null unique,
  platform              text not null default 'unknown' check (platform in ('ios','android','web','unknown')),
  notifications_enabled boolean not null default true,
  last_seen_at          timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger trg_push_devices_updated before update on public.push_devices
  for each row execute function public.fn_set_updated_at();
create index idx_push_devices_user on public.push_devices(user_id) where notifications_enabled;

-- Skrzynka in-app: powiadomienie istnieje w bazie niezależnie od tego,
-- czy push APNs/FCM dotrze. Aplikacja odbiera je przez Realtime/polling.
create table public.match_notifications (
  id             bigint generated always as identity primary key,
  match_id       uuid not null references public.Matches(id) on delete cascade,
  recipient_user_id uuid not null references public.app_users(id) on delete cascade,
  status         text not null default 'pending' check (status in ('pending','push_sent','seen','push_failed')),
  created_at     timestamptz not null default now(),
  pushed_at      timestamptz,
  seen_at        timestamptz,
  unique (match_id, recipient_user_id)
);
create index idx_match_notifications_recipient
  on public.match_notifications(recipient_user_id, created_at desc) where status <> 'seen';

-- ============================================================ enqueue + triggery
create or replace function public.fn_enqueue_swarm_event(
  p_swarm_uid uuid, p_event_type text, p_idempotency_key text, p_vector_version text default 'vec-v1')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.swarm_events_outbox (idempotency_key, event_type, swarm_uid, vector_version)
  values (p_idempotency_key, p_event_type, p_swarm_uid, p_vector_version)
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.swarm_events_outbox where idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end;
$$;
revoke all on function public.fn_enqueue_swarm_event(uuid, text, text, text) from public;

create or replace function public.fn_trg_swarm_vector_event()
returns trigger language plpgsql as $$
begin
  if new.embedding is not null and new.coverage >= 0.75 then
    perform public.fn_enqueue_swarm_event(
      new.swarm_uid,
      case when tg_op = 'INSERT' then 'VECTOR_READY' else 'VECTOR_UPDATED' end,
      'vector:' || new.swarm_uid::text || ':' || new.vector_version || ':'
        || extract(epoch from new.updated_at)::bigint::text,
      new.vector_version);
  end if;
  return new;
end;
$$;
create trigger trg_swarm_vector_event
  after insert or update of embedding, coverage, vector_version on public.swarm_vectors
  for each row execute function public.fn_trg_swarm_vector_event();

create or replace function public.fn_trg_pos_passed_event()
returns trigger language plpgsql as $$
declare v_swarm uuid;
begin
  if new.pos_status = 'passed' and (tg_op = 'INSERT' or old.pos_status is distinct from 'passed') then
    select swarm_uid into v_swarm from public.identity_vault where user_id = new.user_id;
    if v_swarm is not null then
      perform public.fn_enqueue_swarm_event(
        v_swarm, 'POS_PASSED',
        'pos:' || v_swarm::text || ':' || extract(epoch from coalesce(new.assessed_at, now()))::bigint::text);
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_pos_passed_event
  after insert or update of pos_status on public.safety_assessments
  for each row execute function public.fn_trg_pos_passed_event();

-- ============================================================ claim/finish (wyłącznie dispatcher: service_role)
create or replace function public.fn_claim_swarm_events(p_limit integer default 25, p_worker text default 'dispatcher')
returns table (id uuid, idempotency_key text, event_type text, swarm_uid uuid, vector_version text, attempts integer, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  -- Starsze oczekujące zdarzenia tego samego UID są zastępowane najnowszym stanem wektora.
  update public.swarm_events_outbox o
     set status = 'superseded'
   where o.status = 'pending'
     and exists (select 1 from public.swarm_events_outbox newer
                  where newer.swarm_uid = o.swarm_uid
                    and newer.status = 'pending'
                    and newer.created_at > o.created_at);

  return query
  with claimable as (
    select e.id
      from public.swarm_events_outbox e
     where ((e.status in ('pending','failed') and e.next_attempt_at <= now())
         or (e.status = 'claimed' and e.locked_at < now() - interval '10 minutes'))
       and e.attempts < 8
     order by e.created_at
     for update skip locked
     limit greatest(1, least(p_limit, 100))
  )
  update public.swarm_events_outbox e
     set status = 'claimed', attempts = e.attempts + 1,
         locked_at = now(), locked_by = p_worker, sent_at = now()
    from claimable c
   where e.id = c.id
  returning e.id, e.idempotency_key, e.event_type, e.swarm_uid, e.vector_version, e.attempts, e.created_at;
end;
$$;
revoke all on function public.fn_claim_swarm_events(integer, text) from public;

create or replace function public.fn_finish_swarm_event(p_event_id uuid, p_success boolean, p_error_code text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_success then
    update public.swarm_events_outbox
       set status = 'acked', acked_at = now(), locked_at = null, locked_by = null, last_error_code = null
     where id = p_event_id;
  else
    update public.swarm_events_outbox
       set status = case when attempts >= 8 then 'dead' else 'failed' end,
           next_attempt_at = now() + make_interval(
             secs => least(3600, 30 * (2 ^ least(attempts, 6)))),
           locked_at = null, locked_by = null, last_error_code = left(coalesce(p_error_code, 'UNKNOWN'), 64)
     where id = p_event_id;
  end if;
end;
$$;
revoke all on function public.fn_finish_swarm_event(uuid, boolean, text) from public;

-- ============================================================ bundle kandydatów dla Abacus (wyłącznie service_role)
-- Jedno wywołanie zwraca: wektor źródła + maks. N kandydatów po ANN (pgvector),
-- wyłącznie profile z PoS=passed, coverage>=0.75, bez blokad w żadną stronę.
-- Abacus dostaje liczby i grube pola eligibilności; zero user_id, zero PII.
create or replace function public.fn_swarm_candidate_bundle(p_source_swarm_uid uuid, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_source jsonb;
  v_candidates jsonb;
  v_source_user uuid;
  v_eligible boolean;
begin
  select iv.user_id into v_source_user
    from public.identity_vault iv where iv.swarm_uid = p_source_swarm_uid;
  if v_source_user is null then
    return jsonb_build_object('schema','candidate-bundle-v1','error','SOURCE_NOT_FOUND','candidates','[]'::jsonb);
  end if;

  select (au.status = 'ready_for_swarm'
          and sa.pos_status = 'passed'
          and (sa.expires_at is null or sa.expires_at > now())
          and sv.embedding is not null and sv.coverage >= 0.75)
    into v_eligible
    from public.app_users au
    join public.safety_assessments sa on sa.user_id = au.id
    join public.swarm_vectors sv on sv.swarm_uid = p_source_swarm_uid
   where au.id = v_source_user;

  select jsonb_build_object(
           'swarm_uid', sv.swarm_uid,
           'vector_version', sv.vector_version,
           'embedding', (sv.embedding::text)::jsonb,
           'coverage_mask', sv.coverage_mask::text,
           'coverage', sv.coverage,
           'confidence', sv.overall_confidence,
           'region_code', au.region_code,
           'age_band', au.age_band,
           'constraints', jsonb_build_object(
             'languages', coalesce(umc.languages, array['pl']),
             'desired_age_bands', coalesce(umc.desired_age_bands, '{}'),
             'max_region_scope', coalesce(umc.max_region_scope, 'same_voivodeship'),
             'dealbreakers', coalesce(umc.dealbreakers, '{}'::jsonb)))
    into v_source
    from public.swarm_vectors sv
    join public.app_users au on au.id = v_source_user
    left join public.user_match_constraints umc on umc.user_id = v_source_user
   where sv.swarm_uid = p_source_swarm_uid;

  select coalesce(jsonb_agg(candidate order by raw_similarity desc), '[]'::jsonb)
    into v_candidates
    from (
      select c.raw_similarity,
             jsonb_build_object(
               'swarm_uid', sv.swarm_uid,
               'embedding', (sv.embedding::text)::jsonb,
               'coverage_mask', sv.coverage_mask::text,
               'coverage', sv.coverage,
               'confidence', sv.overall_confidence,
               'raw_similarity_ann', c.raw_similarity,
               'overlap_dimensions', c.overlap_dimensions,
               'region_code', au.region_code,
               'age_band', au.age_band,
               'constraints', jsonb_build_object(
                 'languages', coalesce(umc.languages, array['pl']),
                 'desired_age_bands', coalesce(umc.desired_age_bands, '{}'),
                 'max_region_scope', coalesce(umc.max_region_scope, 'same_voivodeship'),
                 'dealbreakers', coalesce(umc.dealbreakers, '{}'::jsonb))) as candidate
        from public.fn_find_candidates(p_source_swarm_uid, p_limit) c
        join public.swarm_vectors sv on sv.swarm_uid = c.candidate_swarm_uid
        join public.identity_vault iv on iv.swarm_uid = sv.swarm_uid
        join public.app_users au on au.id = iv.user_id
        left join public.user_match_constraints umc on umc.user_id = iv.user_id
       where not exists (select 1 from public.blocks_reports br
                          where br.reporter_user_id = v_source_user
                            and br.reported_swarm_uid = sv.swarm_uid
                            and br.kind = 'block')
         and not exists (select 1 from public.Matches m
                          where m.status in ('proposed','accepted_a','accepted_b','mutual','declined','blocked')
                            and ((m.swarm_a = p_source_swarm_uid and m.swarm_b = sv.swarm_uid)
                              or (m.swarm_b = p_source_swarm_uid and m.swarm_a = sv.swarm_uid)))
    ) ranked;

  return jsonb_build_object(
    'schema', 'candidate-bundle-v1',
    'source_eligible', coalesce(v_eligible, false),
    'source', v_source,
    'candidates', coalesce(v_candidates, '[]'::jsonb),
    'generated_at', now());
end;
$$;
revoke all on function public.fn_swarm_candidate_bundle(uuid, integer) from public;

-- ============================================================ RLS nowych tabel
alter table public.swarm_events_outbox enable row level security;
alter table public.abacus_runs         enable row level security;
alter table public.push_devices        enable row level security;
alter table public.match_notifications enable row level security;

create policy push_devices_self_select on public.push_devices
  for select to authenticated using (user_id = auth.uid());
create policy push_devices_self_insert on public.push_devices
  for insert to authenticated with check (user_id = auth.uid());
create policy push_devices_self_update on public.push_devices
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_devices_self_delete on public.push_devices
  for delete to authenticated using (user_id = auth.uid());

revoke all on public.push_devices from anon, authenticated;
grant select, delete on public.push_devices to authenticated;
grant insert (user_id, expo_push_token, platform, notifications_enabled) on public.push_devices to authenticated;
grant update (expo_push_token, platform, notifications_enabled, last_seen_at) on public.push_devices to authenticated;

create policy match_notifications_self_select on public.match_notifications
  for select to authenticated using (recipient_user_id = auth.uid());
create policy match_notifications_self_seen on public.match_notifications
  for update to authenticated using (recipient_user_id = auth.uid()) with check (recipient_user_id = auth.uid());

revoke all on public.match_notifications from anon, authenticated;
grant select on public.match_notifications to authenticated;
grant update (status, seen_at) on public.match_notifications to authenticated;

-- swarm_events_outbox i abacus_runs: brak polityk = wyłącznie service_role.

-- Realtime dla skrzynki powiadomień (kanał aktywnej aplikacji mobilnej).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.match_notifications;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;
