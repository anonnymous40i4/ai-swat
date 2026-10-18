-- AI Swarm-Match — schemat v0.1 (KROK A)
-- Supabase / Postgres 15+. Zasada 99/1: baza NIE przechowuje nazwisk, zdjęć, bio,
-- transkryptów, dokładnej lokalizacji ani danych o ciele/ubraniu/zarobkach.
-- Identyfikatorem w roju jest wyłącznie pseudonimowy swarm_uid.
--
-- URUCHOMIENIE: supabase db push  (wymaga roli właściciela schematu oraz auth.users)

create extension if not exists pgcrypto;
create extension if not exists vector;

-- ============================================================ pomocnicze
create or replace function public.fn_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ============================================================ użytkownicy (bez tożsamości cywilnej)
create table public.app_users (
  id            uuid primary key references auth.users(id) on delete cascade,
  status        text not null default 'onboarding'
                check (status in ('onboarding','profiling','ready_for_swarm','paused','quarantined','suspended','deleted')),
  locale        text not null default 'pl-PL',
  region_code   text,                                   -- wyłącznie gruba siatka, np. 'PL-MAZ-WAW'; nigdy GPS
  age_band      text check (age_band in ('18_24','25_34','35_44','45_54','55_plus')),
  age_verified  boolean not null default false,         -- wynik weryfikacji zewnętrznej; dokumenty NIE są przechowywane
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_app_users_updated before update on public.app_users
  for each row execute function public.fn_set_updated_at();

-- JEDYNE mapowanie auth.id <-. swarm_uid. Brak polityk => brak dostępu dla anon/authenticated.
create table public.identity_vault (
  user_id     uuid primary key references public.app_users(id) on delete cascade,
  swarm_uid   uuid not null unique default gen_random_uuid(),
  rotated_at  timestamptz,
  created_at  timestamptz not null default now()
);

create or replace function public.current_swarm_uid()
returns uuid language sql stable security definer set search_path = public as $$
  select swarm_uid from public.identity_vault where user_id = auth.uid();
$$;
revoke all on function public.current_swarm_uid() from public;
grant execute on function public.current_swarm_uid() to authenticated;

-- Zgody: rejestr dowodowy append-only (RODO art. 7; kategorie szczególne wymagają osobnego scope).
create table public.consent_log (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.app_users(id) on delete cascade,
  scope       text not null check (scope in (
                'profiling','matching','special_category_matching_pools',
                'spirituality_dimension','match_feedback_learning','pilot_validation')),
  granted     boolean not null,
  terms_version text not null,
  created_at  timestamptz not null default now()
);
create index idx_consent_log_user on public.consent_log(user_id, scope, created_at desc);

-- Klucze urządzeń: podpisywanie evidence on-device (anty-podrabianie punktacji z klienta).
create table public.device_keys (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.app_users(id) on delete cascade,
  public_key     text not null unique,
  algorithm      text not null default 'Ed25519',
  attestation    text,                                  -- dostawca atestacji (Play Integrity / App Attest), referencja, nie surowe dane
  is_active      boolean not null default false,        -- aktywację po atestacji wykonuje wyłącznie Edge Function
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz
);
create index idx_device_keys_user on public.device_keys(user_id) where is_active;

-- Ograniczenia dopasowania deklarowane jawnie przez użytkownika.
-- own_pool_code / seeking_pool_codes: kategoria szczególna (RODO art. 9) — zapis tylko przy zgodzie
-- 'special_category_matching_pools'; kolumny celowo puste domyślnie.
create table public.user_match_constraints (
  user_id           uuid primary key references public.app_users(id) on delete cascade,
  own_pool_code     text,
  seeking_pool_codes text[] not null default '{}',
  desired_age_bands text[] not null default '{}',
  max_region_scope  text not null default 'same_voivodeship'
                    check (max_region_scope in ('same_city','same_voivodeship','same_country','anywhere')),
  languages         text[] not null default '{pl}',
  dealbreakers      jsonb not null default '{}'::jsonb,  -- walidowane po stronie aplikacji (zamknięty słownik kluczy)
  updated_at        timestamptz not null default now()
);
create trigger trg_umc_updated before update on public.user_match_constraints
  for each row execute function public.fn_set_updated_at();

-- ============================================================ sesje i katalogi
create table public.agent_sessions (
  id              uuid primary key,                      -- UUID generowany na urządzeniu i podpisywany w payloadzie
  user_id         uuid not null references public.app_users(id) on delete cascade,
  model_id        text not null,
  prompt_version  text not null,
  fsm_state       text not null,
  turns_count     integer not null default 0 check (turns_count >= 0),
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz not null default now()
  -- BRAK kolumny z treścią rozmowy: transkrypty zostają on-device (SQLCipher, auto-kasowanie 14 dni).
);
create index idx_agent_sessions_user on public.agent_sessions(user_id, created_at desc);

create table public.trait_dictionary (
  trait_key        text primary key,
  dimension_index  integer unique check (dimension_index between 0 and 31),
  category         text not null check (category in ('intent','values','communication','lifestyle','interests','practical','safety_gate','safety_support')),
  polarity_note    text not null,
  default_weight   numeric not null default 1.0 check (default_weight > 0),
  min_probes       integer not null default 3 check (min_probes >= 1),
  is_safety_gate   boolean not null default false,
  is_optional      boolean not null default false,
  required_consent_scope text not null default 'profiling',
  vector_version   text not null default 'vec-v1',
  active           boolean not null default true
);

create table public.probe_catalog (
  probe_id       text primary key,
  title_internal text not null,
  trait_keys     text[] not null,
  fsm_stages     text[] not null default '{}',
  template_hash  text not null,                          -- treść próby żyje tylko w podpisanym bundlu on-device
  rubric_version text not null default 'rubric-v1',
  cooldown_days  integer not null default 14 check (cooldown_days >= 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

create table public.prompt_versions (
  version     text primary key,
  kind        text not null check (kind in ('personal_agent_system','evaluator','master_agent')),
  model_family text,
  content_sha256 text not null,
  active      boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ============================================================ dowody -> wyniki -> wektor
create table public.trait_evidence (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.app_users(id) on delete cascade,
  session_id      uuid references public.agent_sessions(id) on delete set null,
  probe_id        text not null references public.probe_catalog(probe_id),
  trait_key       text not null references public.trait_dictionary(trait_key),
  score           double precision not null check (score between -1 and 1),
  confidence      double precision not null check (confidence between 0 and 1),
  evidence_class  text not null check (evidence_class in ('self_declared','sjt_response','consistency','user_correction')),
  evidence_hash   text check (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),  -- hash fragmentu ON-DEVICE; czyszczony po 90 dniach
  rationale_code  text not null,
  prompt_version  text not null,
  created_at      timestamptz not null default now()
);
create index idx_trait_evidence_user_trait on public.trait_evidence(user_id, trait_key, created_at desc);

create table public.trait_scores (
  user_id          uuid not null references public.app_users(id) on delete cascade,
  trait_key        text not null references public.trait_dictionary(trait_key),
  vector_version   text not null default 'vec-v1',
  score            double precision not null check (score between -1 and 1),
  confidence       double precision not null check (confidence between 0 and 1),
  evidence_count   integer not null default 0,
  distinct_probes  integer not null default 0,
  distinct_days    integer not null default 0,
  score_stddev     double precision,
  is_hard_point    boolean not null default false,
  updated_at       timestamptz not null default now(),
  primary key (user_id, trait_key, vector_version)
);
create trigger trg_trait_scores_updated before update on public.trait_scores
  for each row execute function public.fn_set_updated_at();

create table public.swarm_vectors (
  swarm_uid       uuid primary key references public.identity_vault(swarm_uid) on delete cascade,
  vector_version  text not null default 'vec-v1',
  embedding       vector(32),
  coverage_mask   bit(32) not null default B'0'::bit(32),   -- bity wymiarów będących hard-pointami
  coverage        double precision not null default 0 check (coverage between 0 and 1),
  overall_confidence double precision not null default 0 check (overall_confidence between 0 and 1),
  updated_at      timestamptz not null default now()
);
create trigger trg_swarm_vectors_updated before update on public.swarm_vectors
  for each row execute function public.fn_set_updated_at();
create index idx_swarm_vectors_hnsw on public.swarm_vectors
  using hnsw (embedding vector_cosine_ops);

-- ============================================================ Proof of Safety
create table public.safety_assessments (
  user_id        uuid primary key references public.app_users(id) on delete cascade,
  pos_status     text not null default 'provisional'
                 check (pos_status in ('provisional','passed','watch','quarantined','failed_confirmed')),
  pos_score      integer check (pos_score between 0 and 100),
  gate_non_aggression    double precision check (gate_non_aggression between 0 and 1),
  gate_boundary_respect  double precision check (gate_boundary_respect between 0 and 1),
  gate_consent_respect   double precision check (gate_consent_respect between 0 and 1),
  gate_non_coercion      double precision check (gate_non_coercion between 0 and 1),
  gate_accountability    double precision check (gate_accountability between 0 and 1),
  assessed_at    timestamptz,
  expires_at     timestamptz,                               -- passed: +90 dni, potem re-probe
  human_review_status text not null default 'none'
                 check (human_review_status in ('none','pending','upheld','overturned')),
  updated_at     timestamptz not null default now()
);
create trigger trg_safety_updated before update on public.safety_assessments
  for each row execute function public.fn_set_updated_at();

create table public.red_flag_events (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.app_users(id) on delete cascade,
  session_id    uuid references public.agent_sessions(id) on delete set null,
  flag_code     text not null check (flag_code in (
                  'THREAT_TO_IDENTIFIABLE_PERSON','AGGRESSION_ENDORSEMENT','CONSENT_DISREGARD',
                  'COERCION_ENDORSEMENT','DECEPTION_ENDORSEMENT','MINOR_SAFETY','SELF_HARM_RISK')),
  severity      integer not null check (severity between 1 and 5),
  confidence    double precision not null check (confidence between 0 and 1),
  evidence_hash text check (evidence_hash ~ '^sha256:[a-f0-9]{64}$'),
  resolved      boolean not null default false,
  created_at    timestamptz not null default now()
);
create index idx_red_flags_user on public.red_flag_events(user_id, created_at desc) where not resolved;

-- ============================================================ dopasowania
create table public.match_runs (
  id             bigint generated always as identity primary key,
  master_version text not null,
  params         jsonb not null default '{}'::jsonb,
  candidates_seen integer not null default 0,
  Matches_created integer not null default 0,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);

create table public.Matches (
  id               uuid primary key default gen_random_uuid(),
  run_id           bigint references public.match_runs(id) on delete set null,
  swarm_a          uuid not null references public.identity_vault(swarm_uid) on delete cascade,
  swarm_b          uuid not null references public.identity_vault(swarm_uid) on delete cascade,
  raw_similarity   double precision not null check (raw_similarity between -1 and 1),
  display_score    integer not null check (display_score between 80 and 99),
  component_scores jsonb not null default '{}'::jsonb,     -- sim per kategoria: wyjaśnialność bez ujawniania wektorów
  status           text not null default 'proposed'
                   check (status in ('proposed','accepted_a','accepted_b','mutual','declined','expired','blocked','ended')),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '72 hours'),
  check (swarm_a < swarm_b),                               -- porządek kanoniczny: brak duplikatu AB/BA
  unique (swarm_a, swarm_b)
);
create index idx_Matches_a on public.Matches(swarm_a, status);
create index idx_Matches_b on public.Matches(swarm_b, status);

-- Sygnał uczący: wyłącznie strukturalne enumy, zero wolnego tekstu, zero treści czatów.
create table public.match_feedback (
  id               bigint generated always as identity primary key,
  match_id         uuid not null references public.Matches(id) on delete cascade,
  from_user_id     uuid not null references public.app_users(id) on delete cascade,
  outcome          text not null check (outcome in (
                     'chatted','met_in_person','continuing','values_mismatch','intent_mismatch',
                     'ghosted_me','i_lost_interest','felt_unsafe','other_structured')),
  accuracy_rating  integer check (accuracy_rating between 1 and 5),
  would_meet_again boolean,
  safety_concern   boolean not null default false,          -- true -> PoS drugiej strony: kwarantanna do przeglądu człowieka
  created_at       timestamptz not null default now(),
  unique (match_id, from_user_id)
);

create table public.reveal_consents (
  match_id     uuid not null references public.Matches(id) on delete cascade,
  user_id      uuid not null references public.app_users(id) on delete cascade,
  stage        integer not null check (stage in (1,2,3)),  -- 1 karta wartości, 2 imię/notatka głosowa, 3 kontakt poza aplikację
  consented_at timestamptz not null default now(),
  revoked_at   timestamptz,
  primary key (match_id, user_id, stage)
);

create table public.blocks_reports (
  id               bigint generated always as identity primary key,
  reporter_user_id uuid not null references public.app_users(id) on delete cascade,
  reported_swarm_uid uuid not null references public.identity_vault(swarm_uid) on delete cascade,
  match_id         uuid references public.Matches(id) on delete set null,
  kind             text not null check (kind in ('block','report')),
  reason_code      text not null check (reason_code in (
                     'felt_unsafe','pressure_after_no','intent_deception','aggressive_messages',
                     'suspected_minor','spam','just_block_no_reason')),
  human_action     text not null default 'none'
                   check (human_action in ('none','pending_review','warned','suspended','dismissed')),
  created_at       timestamptz not null default now()
);
create index idx_blocks_reporter on public.blocks_reports(reporter_user_id, reported_swarm_uid);

create table public.audit_log (
  id            bigint generated always as identity primary key,
  actor_type    text not null check (actor_type in ('personal_agent','master_agent','edge_function','human_moderator','user')),
  action        text not null,
  subject_swarm_uid uuid,
  payload_hash  text,
  created_at    timestamptz not null default now()
);

-- ============================================================ funkcje Mastera
-- Wynik wyświetlany: S in [0.78, 1] -> [80, 99]; 100 celowo nieosiągalne.
create or replace function public.fn_display_score(p_similarity double precision)
returns integer language sql immutable as $$
  select case when p_similarity < 0.78 then null
              else least(99, round(80 + 20.0 * (p_similarity - 0.78) / 0.22)::int)
         end;
$$;

-- Kandydaci etapu ANN. Dalszy reranking (maski, kategorie, dealbreakery) robi Master Agent poza SQL.
-- Wyłącznie service_role; brak granta dla ról klienckich.
create or replace function public.fn_find_candidates(p_swarm_uid uuid, p_limit integer default 200)
returns table (candidate_swarm_uid uuid, raw_similarity double precision, overlap_dimensions integer)
language sql stable security definer set search_path = public as $$
  with me as (select embedding, coverage_mask from public.swarm_vectors where swarm_uid = p_swarm_uid)
  select sv.swarm_uid,
         (1 - (sv.embedding <=> me.embedding))::double precision,
         bit_count(sv.coverage_mask & me.coverage_mask)::integer
    from me
    cross join public.swarm_vectors sv
    join public.identity_vault iv on iv.swarm_uid = sv.swarm_uid
    join public.safety_assessments sa on sa.user_id = iv.user_id
    join public.app_users au on au.id = iv.user_id
   where sv.swarm_uid <> p_swarm_uid
     and sv.embedding is not null
     and sv.coverage >= 0.75
     and sa.pos_status = 'passed'
     and (sa.expires_at is null or sa.expires_at > now())
     and au.status = 'ready_for_swarm'
     and not exists (select 1 from public.blocks_reports br
                      where br.reporter_user_id = iv.user_id and br.reported_swarm_uid = p_swarm_uid and br.kind = 'block')
   order by sv.embedding <=> me.embedding
   limit greatest(1, least(p_limit, 500));
$$;
revoke all on function public.fn_find_candidates(uuid, integer) from public;

-- ============================================================ RLS
alter table public.app_users              enable row level security;
alter table public.identity_vault         enable row level security;
alter table public.consent_log            enable row level security;
alter table public.device_keys            enable row level security;
alter table public.user_match_constraints enable row level security;
alter table public.agent_sessions         enable row level security;
alter table public.trait_dictionary       enable row level security;
alter table public.probe_catalog          enable row level security;
alter table public.prompt_versions        enable row level security;
alter table public.trait_evidence         enable row level security;
alter table public.trait_scores           enable row level security;
alter table public.swarm_vectors          enable row level security;
alter table public.safety_assessments     enable row level security;
alter table public.red_flag_events        enable row level security;
alter table public.match_runs             enable row level security;
alter table public.Matches                enable row level security;
alter table public.match_feedback         enable row level security;
alter table public.reveal_consents        enable row level security;
alter table public.blocks_reports         enable row level security;
alter table public.audit_log              enable row level security;

-- Własny profil i deklaracje. RLS ogranicza WIERSZE, granty kolumnowe poniżej ograniczają POLA:
-- klient nigdy nie zmieni sobie statusu, age_verified, aktywacji klucza ani statusu przeglądu człowieka.
create policy app_users_self_select on public.app_users
  for select to authenticated using (id = auth.uid());
create policy app_users_self_insert on public.app_users
  for insert to authenticated with check (id = auth.uid());
create policy app_users_self_update on public.app_users
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy consent_self_read on public.consent_log
  for select to authenticated using (user_id = auth.uid());
create policy consent_self_insert on public.consent_log
  for insert to authenticated with check (user_id = auth.uid());
create policy umc_self on public.user_match_constraints
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy device_keys_self_read on public.device_keys
  for select to authenticated using (user_id = auth.uid());
create policy device_keys_self_insert_inactive on public.device_keys
  for insert to authenticated
  with check (user_id = auth.uid() and is_active = false and revoked_at is null);
create policy sessions_self_read on public.agent_sessions
  for select to authenticated using (user_id = auth.uid());

-- Kategorie szczególne w ograniczeniach wymagają aktualnie udzielonej, osobnej zgody.
create or replace function public.fn_guard_special_category_constraints()
returns trigger language plpgsql as $$
declare v_granted boolean;
begin
  if new.own_pool_code is not null or coalesce(cardinality(new.seeking_pool_codes), 0) > 0 then
    select granted into v_granted
      from public.consent_log
     where user_id = new.user_id and scope = 'special_category_matching_pools'
     order by created_at desc
     limit 1;
    if coalesce(v_granted, false) = false then
      raise exception 'special-category matching pools require explicit consent' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_umc_special_category_consent
  before insert or update on public.user_match_constraints
  for each row execute function public.fn_guard_special_category_constraints();

-- Dopasowania: widoczne tylko dla stron pary. Feedback i zgody etapowe wymagają uczestnictwa w tej parze.
create policy Matches_participant_read on public.Matches
  for select to authenticated
  using (swarm_a = public.current_swarm_uid() or swarm_b = public.current_swarm_uid());
create policy feedback_self_read on public.match_feedback
  for select to authenticated using (from_user_id = auth.uid());
create policy feedback_participant_insert on public.match_feedback
  for insert to authenticated
  with check (
    from_user_id = auth.uid()
    and exists (select 1 from public.Matches m
                 where m.id = match_id
                   and (m.swarm_a = public.current_swarm_uid() or m.swarm_b = public.current_swarm_uid()))
  );
create policy reveal_self_read on public.reveal_consents
  for select to authenticated using (user_id = auth.uid());
create policy reveal_participant_insert on public.reveal_consents
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.Matches m
                 where m.id = match_id
                   and (m.swarm_a = public.current_swarm_uid() or m.swarm_b = public.current_swarm_uid()))
  );
create policy reveal_self_revoke on public.reveal_consents
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy blocks_self_read on public.blocks_reports
  for select to authenticated using (reporter_user_id = auth.uid());
create policy blocks_self_insert on public.blocks_reports
  for insert to authenticated
  with check (
    reporter_user_id = auth.uid()
    and reported_swarm_uid <> public.current_swarm_uid()
    and (match_id is null or exists (
      select 1 from public.Matches m
       where m.id = match_id
         and (m.swarm_a = public.current_swarm_uid() or m.swarm_b = public.current_swarm_uid())))
  );

-- Granty kolumnowe (defense in depth ponad RLS).
revoke all on public.app_users from anon, authenticated;
grant select on public.app_users to authenticated;
grant insert (id, locale, region_code, age_band) on public.app_users to authenticated;
grant update (locale, region_code, age_band) on public.app_users to authenticated;

revoke all on public.consent_log from anon, authenticated;
grant select on public.consent_log to authenticated;
grant insert (user_id, scope, granted, terms_version) on public.consent_log to authenticated;

revoke all on public.device_keys from anon, authenticated;
grant select on public.device_keys to authenticated;
grant insert (user_id, public_key, algorithm, attestation) on public.device_keys to authenticated;

revoke all on public.match_feedback from anon, authenticated;
grant select on public.match_feedback to authenticated;
grant insert (match_id, from_user_id, outcome, accuracy_rating, would_meet_again, safety_concern)
  on public.match_feedback to authenticated;

revoke all on public.reveal_consents from anon, authenticated;
grant select on public.reveal_consents to authenticated;
grant insert (match_id, user_id, stage) on public.reveal_consents to authenticated;
grant update (revoked_at) on public.reveal_consents to authenticated;

revoke all on public.blocks_reports from anon, authenticated;
grant select on public.blocks_reports to authenticated;
grant insert (reporter_user_id, reported_swarm_uid, match_id, kind, reason_code)
  on public.blocks_reports to authenticated;

-- Jedyne klienckie widoki na profilowanie: preferencje bez cech safety oraz sam STATUS PoS.
create or replace function public.fn_my_preference_summary()
returns table (trait_key text, category text, score double precision, confidence double precision, is_hard_point boolean)
language sql stable security definer set search_path = public as $$
  select ts.trait_key, td.category, ts.score, ts.confidence, ts.is_hard_point
    from public.trait_scores ts
    join public.trait_dictionary td on td.trait_key = ts.trait_key
   where ts.user_id = auth.uid()
     and td.category not in ('safety_gate','safety_support')
     and td.active;
$$;
revoke all on function public.fn_my_preference_summary() from public;
grant execute on function public.fn_my_preference_summary() to authenticated;

create or replace function public.fn_my_pos_status()
returns table (pos_status text, assessed_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select pos_status, assessed_at, expires_at
    from public.safety_assessments
   where user_id = auth.uid();
$$;
revoke all on function public.fn_my_pos_status() from public;
grant execute on function public.fn_my_pos_status() to authenticated;

-- Przejścia statusów wyłącznie przez kontrolowane RPC (nie dowolny UPDATE z klienta).
create or replace function public.fn_set_my_pause(p_paused boolean)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text; v_pos text;
begin
  select status into v_status from public.app_users where id = auth.uid() for update;
  if v_status is null or v_status in ('quarantined','suspended','deleted') then
    raise exception 'pause transition not allowed from current status' using errcode = '42501';
  end if;

  if p_paused then
    v_status := 'paused';
  else
    select pos_status into v_pos from public.safety_assessments where user_id = auth.uid();
    v_status := case when v_pos = 'passed' then 'ready_for_swarm' else 'profiling' end;
  end if;

  update public.app_users set status = v_status where id = auth.uid();
  return v_status;
end;
$$;
revoke all on function public.fn_set_my_pause(boolean) from public;
grant execute on function public.fn_set_my_pause(boolean) to authenticated;

create or replace function public.fn_revoke_my_device_key(p_key_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.device_keys
     set is_active = false, revoked_at = now()
   where id = p_key_id and user_id = auth.uid();
$$;
revoke all on function public.fn_revoke_my_device_key(uuid) from public;
grant execute on function public.fn_revoke_my_device_key(uuid) to authenticated;

create or replace function public.fn_respond_to_match(p_match_id uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := public.current_swarm_uid();
  v_match public.Matches%rowtype;
  v_status text;
begin
  select * into v_match from public.Matches where id = p_match_id for update;
  if not found or (v_match.swarm_a <> v_me and v_match.swarm_b <> v_me) then
    raise exception 'match not available' using errcode = '42501';
  end if;

  if v_match.expires_at <= now() and v_match.status in ('proposed','accepted_a','accepted_b') then
    v_status := 'expired';
  elsif p_accept = false then
    v_status := case when v_match.status in ('proposed','accepted_a','accepted_b','mutual') then 'declined' else v_match.status end;
  elsif v_match.status = 'proposed' then
    v_status := case when v_match.swarm_a = v_me then 'accepted_a' else 'accepted_b' end;
  elsif v_match.status = 'accepted_a' and v_match.swarm_b = v_me then
    v_status := 'mutual';
  elsif v_match.status = 'accepted_b' and v_match.swarm_a = v_me then
    v_status := 'mutual';
  else
    v_status := v_match.status;
  end if;

  update public.Matches set status = v_status where id = p_match_id;
  return v_status;
end;
$$;
revoke all on function public.fn_respond_to_match(uuid, boolean) from public;
grant execute on function public.fn_respond_to_match(uuid, boolean) to authenticated;

-- Tabele bez polityk (identity_vault, swarm_vectors, trait_evidence, trait_scores,
-- safety_assessments, red_flag_events, match_runs, audit_log, katalogi) są niedostępne
-- dla anon/authenticated; pisze/czyta je wyłącznie service_role
-- (Edge Function ingest-evidence + Master Agent).

-- ============================================================ seedy: słownik cech (vec-v1)
insert into public.trait_dictionary (trait_key, dimension_index, category, polarity_note, is_optional, required_consent_scope) values
  ('intent_seriousness',              0,  'intent',        '+1 poważny związek; -1 wyłącznie niezobowiązująco (wartość neutralna moralnie)', false, 'profiling'),
  ('exclusivity_pref',                1,  'intent',        '+1 wyłączność/monogamia', false, 'profiling'),
  ('pace_fast',                       2,  'intent',        '+1 szybkie tempo relacji; -1 powolne', false, 'profiling'),
  ('longterm_plan_openness',          3,  'intent',        '+1 otwartość na wspólne plany życiowe; prefer_not_say = brak bitu maski', true,  'profiling'),
  ('intent_clarity',                  4,  'intent',        '+1 jasno deklaruje, czego szuka', false, 'profiling'),
  ('honesty_transparency',            5,  'values',        '+1 wysoka transparentność w sprawach relacji', false, 'profiling'),
  ('autonomy_need',                   6,  'values',        '+1 silna potrzeba niezależności', false, 'profiling'),
  ('togetherness_need',               7,  'values',        '+1 dużo wspólnego czasu', false, 'profiling'),
  ('family_importance',               8,  'values',        '+1 rodzina wysoko w priorytetach', false, 'profiling'),
  ('ambition_career',                 9,  'values',        '+1 ambicja/kariera wysoko', false, 'profiling'),
  ('generosity',                      10, 'values',        '+1 hojność; -1 oszczędność', false, 'profiling'),
  ('emotional_expressiveness',        11, 'communication', '+1 otwarcie mówi o uczuciach', false, 'profiling'),
  ('conflict_directness',             12, 'communication', '+1 konfrontuje wprost; -1 potrzebuje czasu', false, 'profiling'),
  ('repair_after_conflict',           13, 'communication', '+1 aktywnie naprawia po konflikcie', false, 'profiling'),
  ('attachment_security_proxy',       14, 'communication', '+1 stabilny pod niepewnością (wskaźnik behawioralny, nie diagnoza)', false, 'profiling'),
  ('reassurance_need',                15, 'communication', '+1 często potrzebuje zapewnień', false, 'profiling'),
  ('playfulness_humor',               16, 'communication', '+1 humor jako spoiwo', false, 'profiling'),
  ('sociability',                     17, 'lifestyle',     '+1 dużo ludzi i wyjść', false, 'profiling'),
  ('outdoor_activity',                18, 'lifestyle',     '+1 ruch/outdoor ważny', false, 'profiling'),
  ('homebody',                        19, 'lifestyle',     '+1 preferencja domowych wieczorów', false, 'profiling'),
  ('spontaneity',                     20, 'lifestyle',     '+1 spontaniczność; -1 planowanie', false, 'profiling'),
  ('travel_importance',               21, 'lifestyle',     '+1 podróże ważne', false, 'profiling'),
  ('alcohol_social_comfort',          22, 'lifestyle',     '+1 komfort z alkoholem towarzysko; -1 preferencja trzeźwości', false, 'profiling'),
  ('intellectual_curiosity',          23, 'interests',     '+1 ciekawość intelektualna', false, 'profiling'),
  ('culture_art_interest',            24, 'interests',     '+1 kultura/sztuka ważna', false, 'profiling'),
  ('orderliness',                     25, 'interests',     '+1 porządek i struktury', false, 'profiling'),
  ('risk_tolerance',                  26, 'interests',     '+1 wysoka tolerancja ryzyka/novum', false, 'profiling'),
  ('spirituality_openness',           27, 'interests',     '+1 otwartość duchowa (osobna zgoda)', true,  'spirituality_dimension'),
  ('pets_comfort',                    28, 'practical',     '+1 komfort ze zwierzętami', false, 'profiling'),
  ('urban_preference',                29, 'practical',     '+1 miasto; -1 poza miastem', false, 'profiling'),
  ('night_owl',                       30, 'practical',     '+1 sowa; -1 skowronek', false, 'profiling'),
  ('physical_affection_importance',   31, 'practical',     '+1 czułość fizyczna ważna (deklaracja, nie dane o ciele)', false, 'profiling'),
  ('safety_non_aggression',           null,'safety_gate',  '0..1 wyżej = bezpieczniej: odrzucenie agresji pod stresem', false, 'profiling'),
  ('safety_boundary_respect',         null,'safety_gate',  '0..1 respektowanie granic', false, 'profiling'),
  ('safety_consent_respect',          null,'safety_gate',  '0..1 respektowanie zgody i odmowy', false, 'profiling'),
  ('safety_non_coercion',             null,'safety_gate',  '0..1 odrzucenie przymusu/presji', false, 'profiling'),
  ('safety_accountability',           null,'safety_gate',  '0..1 branie odpowiedzialności', false, 'profiling'),
  ('honesty_consistency',             null,'safety_support','0..1 spójność deklaracji w czasie (wsparcie bramek)', false, 'profiling')
on conflict (trait_key) do nothing;

update public.trait_dictionary set is_safety_gate = true
 where trait_key in ('safety_non_aggression','safety_boundary_respect','safety_consent_respect','safety_non_coercion','safety_accountability');

insert into public.probe_catalog (probe_id, title_internal, trait_keys, fsm_stages, template_hash) values
  ('SJT-AGG-01',  'Wylany drink',
     array['safety_non_aggression','safety_accountability','repair_after_conflict','conflict_directness'],
     array['STRESS_CONFLICT','CONSISTENCY'],
     'sha256:bb435f17ff63daf90533eed34c526a05c53bffbf66cb80bc28049c236d4d1b3f'),
  ('SJT-CONS-01', 'Strategia kolegi',
     array['safety_consent_respect','safety_boundary_respect','safety_non_coercion','honesty_transparency','intent_seriousness'],
     array['BOUNDARIES_CONSENT','CONSISTENCY'],
     'sha256:5e4df4fd0acc32475320ad052edff909e586b3029ad6b134e727e8d04e7a3ff7')
on conflict (probe_id) do nothing;

insert into public.prompt_versions (version, kind, model_family, content_sha256, active) values
  ('pers-agent-v1.0', 'personal_agent_system', 'llama-3.1-8b-instruct',
   'sha256:528ce1f13ef093b554ea8036b662acb2057161825a5699cad68bd4ea7c33466d', true)
on conflict (version) do nothing;
