-- 本部タスク: Google（ToDo リスト・カレンダー）への反映（docs/calendar.md 2章）
-- - 一人ずつ（個人のアカウントで）自分の Google アカウントをつなぐ。こちら → Google の一方向
-- - タスク: 担当のタスクを、その人の Google ToDo リスト「本部タスク」に出す
-- - 予定: 自分のカレンダーの予定と、ゲストに呼ばれた予定を、その人の Google カレンダーに出す
-- - Google とのやりとりは Edge Function「google」が行う。合言葉（トークン）は画面から読めない表にだけ置く
-- - 1分ごとに pg_cron が「変わったものがあれば反映して」と Edge Function を呼ぶ

/* ---------------- 表（どれも画面からは読めない） ---------------- */

create table public.google_links (
  member_id text primary key references public.members (id),
  google_email text not null default '',
  refresh_token text,
  access_token text,
  access_expires_at timestamptz,
  scopes text not null default '',
  tasks_enabled boolean not null default true,
  calendar_enabled boolean not null default true,
  tasklist_id text not null default '',
  status text not null default 'off' check (status in ('active', 'error', 'off')),
  last_error text not null default '',
  synced_rev bigint not null default 0,
  sync_lock_until timestamptz,
  last_synced_at timestamptz,
  connected_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Google の許可画面に送り出すときの合言葉（ハッシュだけ残す。15分・1回だけ）
create table public.google_oauth_states (
  state_hash text primary key,
  member_id text not null references public.members (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- こちらのタスク・予定と、Google 側のもの（人ごと）の対応
create table public.google_map (
  kind text not null check (kind in ('task', 'event')),
  local_id text not null,
  member_id text not null references public.members (id),
  google_id text not null,
  synced_at timestamptz not null default now(),
  primary key (kind, local_id, member_id)
);

alter table public.google_links enable row level security;
alter table public.google_oauth_states enable row level security;
alter table public.google_map enable row level security;
revoke all on public.google_links, public.google_oauth_states, public.google_map from anon, authenticated;

-- Edge Function を呼ぶときの合言葉（値はデータベースの中だけにある）
insert into public.app_state (key, value) values ('sync_token', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

/* ---------------- 画面から（api_call を通す） ---------------- */

-- 自分の連携の状態（Google 連携は個人のアカウントだけ）
create function public.api_google_status(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.app_access := public._account(); l public.google_links;
begin
  perform public._guard(false);
  if a.member_id is null then
    return jsonb_build_object('available', false, 'reason', 'shared');
  end if;
  select * into l from public.google_links where member_id = a.member_id;
  return jsonb_build_object('available', true,
    'link', case when not found or l.status = 'off' then null else jsonb_build_object(
      'email', l.google_email, 'status', l.status, 'tasksEnabled', l.tasks_enabled, 'calendarEnabled', l.calendar_enabled,
      'canTasks', l.scopes like '%/auth/tasks%', 'canCalendar', l.scopes like '%/auth/calendar%',
      'lastSyncedAt', l.last_synced_at, 'lastError', l.last_error, 'connectedAt', l.connected_at,
      'pending', l.status = 'active' and l.synced_rev < coalesce(nullif(public._state('rev'), '')::bigint, 0)) end);
end $$;

-- 何を反映するか（オンにしたときは、最初から反映し直す）
create function public.api_google_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.app_access := public._account(); l public.google_links; v_tasks boolean; v_cal boolean;
begin
  perform public._guard(true);
  if a.member_id is null then raise exception 'Google 連携は、一人ずつのアカウントで使えます'; end if;
  select * into l from public.google_links where member_id = a.member_id for update;
  if not found or l.status = 'off' then raise exception 'まだ Google とつながっていません'; end if;
  v_tasks := coalesce((p ->> 'tasksEnabled')::boolean, l.tasks_enabled);
  v_cal := coalesce((p ->> 'calendarEnabled')::boolean, l.calendar_enabled);
  update public.google_links set
    tasks_enabled = v_tasks, calendar_enabled = v_cal,
    synced_rev = case when (v_tasks and not l.tasks_enabled) or (v_cal and not l.calendar_enabled) then 0 else synced_rev end,
    updated_at = now()
  where member_id = a.member_id;
  return public.api_google_status('{}'::jsonb);
end $$;

-- 管理画面: みんなの連携の状態
create function public.api_admin_google(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._guard(false);
  return jsonb_build_object('members', coalesce((
    select jsonb_agg(jsonb_build_object(
      'memberId', m.id, 'name', m.name, 'hasAccount', a.email is not null,
      'status', coalesce(l.status, 'off'), 'email', coalesce(l.google_email, ''),
      'tasksEnabled', l.tasks_enabled, 'calendarEnabled', l.calendar_enabled,
      'lastSyncedAt', l.last_synced_at, 'lastError', coalesce(l.last_error, '')) order by m.sort_order)
    from public.members m
    left join public.app_access a on a.member_id = m.id and a.status <> 'cancelled'
    left join public.google_links l on l.member_id = m.id
    where m.active), '[]'::jsonb));
end $$;

/* ---------------- 1分ごとに、変わったものがあれば Edge Function を呼ぶ ---------------- */

create function public._google_kick() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text := coalesce(public._state('functions_url'), '');
  v_token text := coalesce(public._state('sync_token'), '');
  v_rev bigint := coalesce(nullif(public._state('rev'), '')::bigint, 0);
begin
  if v_url = '' or v_token = '' then return; end if;
  if not exists (select 1 from public.google_links where status = 'active' and synced_rev < v_rev) then return; end if;
  perform net.http_post(
    url := v_url || '/google',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-token', v_token),
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 5000);
end $$;

create extension if not exists pg_cron;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('honbu-google-sync', '* * * * *', 'select public._google_kick()')$q$;
  end if;
end $$;

/* ---------------- 権限 ---------------- */

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.has_access() to authenticated;
grant execute on function public.api_call(text, jsonb) to authenticated;
grant execute on function public._invite_lookup(text), public._invite_complete(text) to service_role;
