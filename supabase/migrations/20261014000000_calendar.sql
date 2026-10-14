-- 本部タスク: カレンダー（Google カレンダーと同じ考え方。Meet はなし）
-- - カレンダー: メンバーごとの「自分のカレンダー」（owner あり・自動で作る）と、共有のカレンダー（owner なし）
-- - 予定: 終日／時刻つき、繰り返し（タスクと同じ RRULE）、場所・説明・色・予定あり／空き・公開設定・通知・ゲストと出欠
-- - 繰り返しの1回だけを変えた・消したときは、その回だけの行（recurring_id ＋ original_start）を作る（Google と同じ形）
-- - 書き込みはタスクと同じく api_* 関数を通し、1件ずつ順番に行う。同期番号（rev）で画面に届ける

create table public.calendars (
  id text primary key,
  name text not null check (length(btrim(name)) > 0),
  description text not null default '',
  color text not null default '#039be5' check (color ~ '^#[0-9a-fA-F]{6}$'),
  owner text references public.members (id),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  deleted_at timestamptz,
  rev bigint not null default 0
);
create unique index calendars_owner_idx on public.calendars (owner) where owner is not null;
create index calendars_rev_idx on public.calendars (rev);

create table public.events (
  id text primary key,
  calendar_id text not null references public.calendars (id),
  title text not null default '',
  description text not null default '',
  location text not null default '',
  all_day boolean not null default false,
  start_at timestamptz not null,
  end_at timestamptz not null,
  rrule text not null default '',
  recurring_id text references public.events (id),
  original_start timestamptz,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  color text not null default '' check (color = '' or color ~ '^#[0-9a-fA-F]{6}$'),
  busy boolean not null default true,
  visibility text not null default 'default' check (visibility in ('default', 'public', 'private')),
  reminders jsonb not null default '[{"method":"popup","minutes":10}]'::jsonb,
  attendees jsonb not null default '[]'::jsonb,
  guests_can_modify boolean not null default false,
  guests_can_invite boolean not null default true,
  guests_can_see boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  deleted_at timestamptz,
  deleted_by text not null default '',
  version integer not null default 1,
  rev bigint not null default 0,
  constraint events_time_order check (end_at > start_at),
  constraint events_exception_shape check ((recurring_id is null) = (original_start is null)),
  constraint events_exception_no_rule check (recurring_id is null or rrule = '')
);
create index events_rev_idx on public.events (rev);
create index events_range_idx on public.events (start_at, end_at) where deleted_at is null;
create index events_recurring_idx on public.events (recurring_id) where recurring_id is not null;
create index events_calendar_idx on public.events (calendar_id) where deleted_at is null;
create unique index events_exception_unique on public.events (recurring_id, original_start) where recurring_id is not null;

create trigger calendars_rev before insert or update on public.calendars for each row execute function public._bump_rev();
create trigger events_rev before insert or update on public.events for each row execute function public._bump_rev();

alter table public.calendars enable row level security;
alter table public.events enable row level security;
create policy calendars_read on public.calendars for select to authenticated using ((select public.has_access()));
create policy events_read on public.events for select to authenticated using ((select public.has_access()));
revoke insert, update, delete, truncate on public.calendars, public.events from anon, authenticated;

alter publication supabase_realtime add table public.calendars, public.events;

/* ---------------- 小さな道具 ---------------- */

-- メンバーのカレンダーの色（Google カレンダーの色から選ぶ）
create function public._calendar_color(p text) returns text
language sql immutable set search_path = public as $$
  select (array['#039be5', '#7986cb', '#33b679', '#8e24aa', '#e67c73', '#f6bf26', '#f4511e', '#0b8043', '#3f51b5', '#d50000', '#616161', '#ad1457'])
    [abs(hashtext(coalesce(p, ''))) % 12 + 1]
$$;

create function public._check_ts(p text, p_label text) returns timestamptz
language plpgsql stable set search_path = public as $$
begin
  if coalesce(p, '') = '' then raise exception '%を入れてください', p_label; end if;
  begin
    return p::timestamptz;
  exception when others then
    raise exception '%の日時が正しくありません', p_label;
  end;
end $$;

create function public._active_calendar(p text) returns public.calendars
language plpgsql stable security definer set search_path = public as $$
declare c public.calendars;
begin
  select * into c from public.calendars where id = p and deleted_at is null;
  if not found then raise exception 'カレンダーが見つかりません。画面を読み込み直してください'; end if;
  return c;
end $$;

-- 繰り返しの決まりの終わり（終了日・回数）を外す
create function public._rr_strip_end(p_rule text) returns text
language sql immutable set search_path = public as $$
  select regexp_replace(coalesce(p_rule, ''), ';(UNTIL|COUNT)=[^;]*', '', 'g')
$$;

-- p_from の日から p_before の日の前までに、何回あるか（最初の日も1回と数える）
create function public._rr_count_before(p_rule text, p_from date, p_before date) returns int
language plpgsql immutable set search_path = public as $$
declare d date := p_from; n int := 0;
begin
  for guard in 1 .. 20000 loop
    exit when d is null or d >= p_before;
    n := n + 1;
    d := public._repeat_step(p_rule, d);
  end loop;
  return n;
end $$;

-- 新しい予定の行（最初の値）
create function public._event_new(p_id text, p_actor text) returns public.events
language plpgsql stable set search_path = public as $$
declare e public.events;
begin
  e.id := p_id;
  e.title := ''; e.description := ''; e.location := ''; e.all_day := false; e.rrule := '';
  e.status := 'confirmed'; e.color := ''; e.busy := true; e.visibility := 'default';
  e.reminders := '[{"method":"popup","minutes":10}]'::jsonb; e.attendees := '[]'::jsonb;
  e.guests_can_modify := false; e.guests_can_invite := true; e.guests_can_see := true;
  e.created_at := now(); e.created_by := coalesce(p_actor, ''); e.updated_at := now(); e.updated_by := coalesce(p_actor, '');
  e.deleted_by := ''; e.version := 1; e.rev := 0;
  return e;
end $$;

-- 画面から来た項目（list の形は camelCase）を予定に重ねて、確かめる
create function public._event_apply(e public.events, p jsonb) returns public.events
language plpgsql stable security definer set search_path = public as $$
declare
  c public.calendars; a jsonb; r jsonb; v_new jsonb; v_mid text; v_resp text; v_end_local timestamp; v_min int; v_method text;
begin
  if p ? 'calendarId' then e.calendar_id := (public._active_calendar(p ->> 'calendarId')).id; end if;
  if e.calendar_id is null then raise exception 'カレンダーを選んでください'; end if;
  c := public._active_calendar(e.calendar_id);
  if p ? 'title' then e.title := left(btrim(coalesce(p ->> 'title', '')), 500); end if;
  if p ? 'description' then e.description := left(coalesce(p ->> 'description', ''), 8000); end if;
  if p ? 'location' then e.location := left(btrim(coalesce(p ->> 'location', '')), 500); end if;
  if p ? 'allDay' then e.all_day := coalesce((p ->> 'allDay')::boolean, false); end if;
  if p ? 'start' then e.start_at := public._check_ts(p ->> 'start', '開始'); end if;
  if p ? 'end' then e.end_at := public._check_ts(p ->> 'end', '終了'); end if;
  if e.start_at is null or e.end_at is null then raise exception '開始と終了を入れてください'; end if;
  if e.all_day then
    -- 終日は日本時間の0時から0時まで
    e.start_at := ((e.start_at at time zone 'Asia/Tokyo')::date)::timestamp at time zone 'Asia/Tokyo';
    v_end_local := e.end_at at time zone 'Asia/Tokyo';
    e.end_at := (case when v_end_local::time = '00:00' then v_end_local::date else v_end_local::date + 1 end)::timestamp at time zone 'Asia/Tokyo';
    if e.end_at <= e.start_at then e.end_at := e.start_at + interval '1 day'; end if;
  end if;
  if e.end_at <= e.start_at then raise exception '終了は開始より後にしてください'; end if;
  if e.end_at - e.start_at > interval '400 days' then raise exception '予定の長さは400日までです'; end if;
  if p ? 'rrule' then
    e.rrule := case when e.recurring_id is null
      then public._repeat_fill(public._check_repeat(p ->> 'rrule'), (e.start_at at time zone 'Asia/Tokyo')::date) else '' end;
  end if;
  if p ? 'color' then
    if coalesce(p ->> 'color', '') <> '' and p ->> 'color' !~ '^#[0-9a-fA-F]{6}$' then raise exception '色の指定が正しくありません'; end if;
    e.color := lower(coalesce(p ->> 'color', ''));
  end if;
  if p ? 'busy' then e.busy := coalesce((p ->> 'busy')::boolean, true); end if;
  if p ? 'visibility' then
    if coalesce(p ->> 'visibility', '') not in ('default', 'public', 'private') then raise exception '公開設定が正しくありません'; end if;
    e.visibility := p ->> 'visibility';
  end if;
  if p ? 'reminders' then
    if jsonb_typeof(p -> 'reminders') <> 'array' or jsonb_array_length(p -> 'reminders') > 5 then raise exception '通知は5つまでです'; end if;
    v_new := '[]'::jsonb;
    for r in select value from jsonb_array_elements(p -> 'reminders') loop
      v_method := coalesce(r ->> 'method', 'popup');
      if v_method not in ('popup', 'email') then raise exception '通知の方法が正しくありません'; end if;
      if coalesce(r ->> 'minutes', '') !~ '^[0-9]{1,5}$' or (r ->> 'minutes')::int > 40320 then raise exception '通知の時間は4週間前までです'; end if;
      v_min := (r ->> 'minutes')::int;
      if not v_new @> jsonb_build_array(jsonb_build_object('method', v_method, 'minutes', v_min)) then
        v_new := v_new || jsonb_build_array(jsonb_build_object('method', v_method, 'minutes', v_min));
      end if;
    end loop;
    e.reminders := v_new;
  end if;
  if p ? 'attendees' then
    if jsonb_typeof(p -> 'attendees') <> 'array' then raise exception 'ゲストの指定が正しくありません'; end if;
    v_new := '[]'::jsonb;
    for a in select value from jsonb_array_elements(p -> 'attendees') loop
      v_mid := coalesce(a ->> 'id', '');
      perform public._check_member(v_mid);
      continue when v_new @> jsonb_build_array(jsonb_build_object('id', v_mid));
      v_resp := coalesce(
        (select x ->> 'response' from jsonb_array_elements(e.attendees) x where x ->> 'id' = v_mid limit 1),
        case when v_mid = c.owner then 'accepted' else 'needsAction' end);
      v_new := v_new || jsonb_build_array(jsonb_build_object('id', v_mid, 'response', v_resp, 'optional', coalesce((a ->> 'optional')::boolean, false)));
    end loop;
    if jsonb_array_length(v_new) > 100 then raise exception 'ゲストは100人までです'; end if;
    e.attendees := v_new;
  end if;
  if p ? 'guestsCanModify' then e.guests_can_modify := coalesce((p ->> 'guestsCanModify')::boolean, false); end if;
  if p ? 'guestsCanInvite' then e.guests_can_invite := coalesce((p ->> 'guestsCanInvite')::boolean, true); end if;
  if p ? 'guestsCanSee' then e.guests_can_see := coalesce((p ->> 'guestsCanSee')::boolean, true); end if;
  return e;
end $$;

-- 予定の行を保存する（変えてよい項目だけ）
create function public._event_save(e public.events, p_actor text) returns void
language sql security definer set search_path = public as $$
  update public.events set
    calendar_id = e.calendar_id, title = e.title, description = e.description, location = e.location, all_day = e.all_day,
    start_at = e.start_at, end_at = e.end_at, rrule = e.rrule, recurring_id = e.recurring_id, original_start = e.original_start,
    status = e.status, color = e.color, busy = e.busy, visibility = e.visibility, reminders = e.reminders, attendees = e.attendees,
    guests_can_modify = e.guests_can_modify, guests_can_invite = e.guests_can_invite, guests_can_see = e.guests_can_see,
    deleted_at = e.deleted_at, deleted_by = e.deleted_by,
    version = version + 1, updated_at = now(), updated_by = coalesce(p_actor, '')
  where id = e.id;
$$;

-- 繰り返しの1回分の行（あればそれ、なければ親から写して作る。まだ保存しない）
create function public._event_instance(m public.events, p_inst timestamptz, p_actor text) returns public.events
language plpgsql security definer set search_path = public as $$
declare x public.events;
begin
  select * into x from public.events where recurring_id = m.id and original_start = p_inst for update;
  if found then return x; end if;
  x := m;
  x.id := public._new_id();
  x.rrule := '';
  x.recurring_id := m.id;
  x.original_start := p_inst;
  x.start_at := p_inst;
  x.end_at := p_inst + (m.end_at - m.start_at);
  x.created_at := now(); x.created_by := coalesce(p_actor, ''); x.updated_at := now(); x.updated_by := coalesce(p_actor, '');
  x.deleted_at := null; x.deleted_by := ''; x.version := 0; x.rev := 0;
  return x;
end $$;

/* ---------------- 読み込み（カレンダーと予定も届ける） ---------------- */

create or replace function public._changes(p_since bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'lists', coalesce((select jsonb_agg(public._camel(to_jsonb(l))) from public.lists l where l.rev > p_since), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(public._camel(to_jsonb(t))) from public.tasks t where t.rev > p_since), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(public._camel(to_jsonb(m))) from public.members m where m.rev > p_since), '[]'::jsonb),
    'calendars', coalesce((select jsonb_agg(public._camel(to_jsonb(c))) from public.calendars c where c.rev > p_since), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(public._camel(to_jsonb(e))) from public.events e where e.rev > p_since), '[]'::jsonb))
$$;

create or replace function public.api_sync(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_since bigint := coalesce((p ->> 'rev')::bigint, 0);
  v_rev bigint;
  v_purge bigint;
  v_full boolean;
  v_out jsonb;
begin
  perform public._guard(false);
  v_rev := coalesce(public._state('rev')::bigint, 0);
  if v_since > 0 and v_since = v_rev then
    return jsonb_build_object('rev', v_rev, 'unchanged', true);
  end if;
  v_purge := coalesce(public._state('purge_rev')::bigint, 0);
  v_full := v_since = 0 or v_since < v_purge or v_since > v_rev;
  if v_full then
    v_out := jsonb_build_object('rev', v_rev, 'full', true,
      'lists', coalesce((select jsonb_agg(public._camel(to_jsonb(l))) from public.lists l where l.deleted_at is null and l.rev <= v_rev), '[]'::jsonb),
      'tasks', coalesce((select jsonb_agg(public._camel(to_jsonb(t))) from public.tasks t
                          where t.deleted_at is null and t.rev <= v_rev
                            and (t.status <> 'done' or t.completed_at is null or t.completed_at >= now() - interval '90 days')), '[]'::jsonb),
      'members', coalesce((select jsonb_agg(public._camel(to_jsonb(m))) from public.members m where m.rev <= v_rev), '[]'::jsonb),
      'calendars', coalesce((select jsonb_agg(public._camel(to_jsonb(c))) from public.calendars c where c.deleted_at is null and c.rev <= v_rev), '[]'::jsonb),
      -- 予定は、繰り返しと、400日前より後に終わるものだけ（それより前は、見るときに取りに行く）
      'events', coalesce((select jsonb_agg(public._camel(to_jsonb(e))) from public.events e
                           where e.deleted_at is null and e.rev <= v_rev
                             and (e.rrule <> '' or e.recurring_id is not null or e.end_at >= now() - interval '400 days')), '[]'::jsonb),
      'config', public._config());
  else
    v_out := jsonb_build_object('rev', v_rev, 'full', false,
      'lists', coalesce((select jsonb_agg(public._camel(to_jsonb(l))) from public.lists l where l.rev > v_since and l.rev <= v_rev), '[]'::jsonb),
      'tasks', coalesce((select jsonb_agg(public._camel(to_jsonb(t))) from public.tasks t where t.rev > v_since and t.rev <= v_rev), '[]'::jsonb),
      'members', coalesce((select jsonb_agg(public._camel(to_jsonb(m))) from public.members m where m.rev > v_since and m.rev <= v_rev), '[]'::jsonb),
      'calendars', coalesce((select jsonb_agg(public._camel(to_jsonb(c))) from public.calendars c where c.rev > v_since and c.rev <= v_rev), '[]'::jsonb),
      'events', coalesce((select jsonb_agg(public._camel(to_jsonb(e))) from public.events e where e.rev > v_since and e.rev <= v_rev), '[]'::jsonb));
    if exists (select 1 from public.settings where key = 'app' and rev > v_since) then
      v_out := v_out || jsonb_build_object('config', public._config());
    end if;
  end if;
  return v_out;
end $$;

-- 400日より前の期間を見るとき
create function public.api_events_range(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz; v_to timestamptz;
begin
  perform public._guard(false);
  v_from := public._check_ts(p ->> 'from', '期間の始め');
  v_to := public._check_ts(p ->> 'to', '期間の終わり');
  if v_to - v_from > interval '400 days' then raise exception '期間は400日までです'; end if;
  return jsonb_build_object('events', coalesce((select jsonb_agg(public._camel(to_jsonb(e))) from public.events e
    where e.deleted_at is null and e.start_at < v_to and e.end_at > v_from), '[]'::jsonb));
end $$;

/* ---------------- カレンダー ---------------- */

create function public.api_save_calendar(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); c jsonb := coalesce(p -> 'calendar', '{}'::jsonb);
  v_id text; v_name text; v_color text;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_id := public._check_id(c ->> 'id');
  v_name := left(btrim(coalesce(c ->> 'name', '')), 100);
  v_color := lower(coalesce(c ->> 'color', ''));
  if v_color <> '' and v_color !~ '^#[0-9a-f]{6}$' then raise exception '色の指定が正しくありません'; end if;
  if exists (select 1 from public.calendars where id = v_id) then
    update public.calendars set
      name = case when c ? 'name' then (case when v_name = '' then name else v_name end) else name end,
      description = case when c ? 'description' then left(coalesce(c ->> 'description', ''), 2000) else description end,
      color = case when v_color <> '' then v_color else color end,
      deleted_at = null, updated_at = now(), updated_by = v_actor
    where id = v_id;
  else
    if v_name = '' then raise exception 'カレンダーの名前を入れてください'; end if;
    insert into public.calendars (id, name, description, color, sort_order, created_by, updated_by)
    values (v_id, v_name, left(coalesce(c ->> 'description', ''), 2000), case when v_color = '' then '#039be5' else v_color end,
            coalesce((select max(sort_order) from public.calendars), 0) + 1, v_actor, v_actor);
  end if;
  return public._finish(v_start, null);
end $$;

create function public.api_delete_calendar(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); c public.calendars;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  c := public._active_calendar(p ->> 'id');
  if c.owner is not null then raise exception 'メンバーのカレンダーは削除できません'; end if;
  update public.calendars set deleted_at = now(), updated_at = now(), updated_by = v_actor where id = c.id;
  update public.events set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
  where calendar_id = c.id and deleted_at is null;
  return public._finish(v_start, null);
end $$;

/* ---------------- 予定 ---------------- */

create function public.api_create_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v jsonb := coalesce(p -> 'event', '{}'::jsonb);
  v_id text; e public.events; m public.events; v_existing public.events;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_id := public._check_id(v ->> 'id');
  select * into v_existing from public.events where id = v_id;
  if found then -- 通信のやり直しで2回届いたとき
    return jsonb_build_object('rev', public._commit_rev(), 'events', jsonb_build_array(public._camel(to_jsonb(v_existing))));
  end if;
  e := public._event_new(v_id, v_actor);
  e.calendar_id := v ->> 'calendarId';
  if coalesce(v ->> 'recurringId', '') <> '' then
    select * into m from public.events where id = v ->> 'recurringId' and deleted_at is null;
    if not found or m.rrule = '' then raise exception '繰り返しの予定が見つかりません'; end if;
    e.recurring_id := m.id;
    e.original_start := public._check_ts(v ->> 'originalStart', '元の日時');
    if exists (select 1 from public.events where recurring_id = m.id and original_start = e.original_start) then
      raise exception 'この回はすでに変更されています。画面を読み込み直してください';
    end if;
  end if;
  e := public._event_apply(e, v);
  insert into public.events select (e).*;
  return public._finish(v_start, null);
end $$;

create function public.api_update_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_patch jsonb := coalesce(p -> 'patch', '{}'::jsonb);
  v_scope text := coalesce(nullif(p ->> 'scope', ''), 'this'); v_inst timestamptz; e public.events; x public.events; n public.events;
  v_count int; v_before int; v_rule text; v_base int := coalesce((p ->> 'baseVersion')::int, 0); v_merged boolean := false; v_merged_by text := '';
begin
  perform public._guard(true);
  v_start := public._last_rev();
  if v_scope not in ('this', 'following', 'all') then raise exception '変更の範囲が正しくありません'; end if;
  select * into e from public.events where id = p ->> 'id' for update;
  if not found or e.deleted_at is not null then raise exception 'この予定は削除されています'; end if;
  if coalesce(p ->> 'instanceStart', '') <> '' then v_inst := public._check_ts(p ->> 'instanceStart', '繰り返しの回'); end if;

  if e.rrule <> '' and v_inst is not null and v_scope = 'this' then
    -- 繰り返しのこの回だけ
    x := public._event_instance(e, v_inst, v_actor);
    x := public._event_apply(x, v_patch - 'rrule');
    if x.version = 0 then
      x.version := 1;
      insert into public.events select (x).*;
    else
      perform public._event_save(x, v_actor);
    end if;
  elsif e.rrule <> '' and v_inst is not null and v_scope = 'following' and v_inst > e.start_at then
    -- これ以降: 元の繰り返しをこの回の前日で終わらせ、この回から新しい繰り返しを作る
    v_count := nullif(public._rr_get(e.rrule, 'COUNT'), '')::int;
    n := e;
    n.id := public._new_id();
    n.start_at := v_inst;
    n.end_at := v_inst + (e.end_at - e.start_at);
    n.created_at := now(); n.created_by := v_actor; n.updated_at := now(); n.updated_by := v_actor; n.version := 1; n.rev := 0;
    v_rule := e.rrule;
    if v_count is not null then
      v_before := public._rr_count_before(e.rrule, (e.start_at at time zone 'Asia/Tokyo')::date, (v_inst at time zone 'Asia/Tokyo')::date);
      v_rule := public._rr_strip_end(e.rrule) || ';COUNT=' || greatest(1, v_count - v_before);
    end if;
    n.rrule := v_rule;
    n := public._event_apply(n, v_patch);
    e.rrule := public._rr_strip_end(e.rrule) || ';UNTIL=' || to_char((v_inst at time zone 'Asia/Tokyo')::date - 1, 'YYYYMMDD');
    perform public._event_save(e, v_actor);
    insert into public.events select (n).*;
    update public.events set recurring_id = n.id, version = version + 1, updated_at = now(), updated_by = v_actor
    where recurring_id = e.id and original_start >= v_inst;
  else
    -- 1回だけの予定・変更済みの回・繰り返しのすべて
    v_merged := v_base > 0 and v_base <> e.version;
    if v_merged and e.updated_by <> '' and e.updated_by <> v_actor then v_merged_by := e.updated_by; end if;
    e := public._event_apply(e, v_patch);
    perform public._event_save(e, v_actor);
  end if;
  return public._finish(v_start, jsonb_build_object('merged', v_merged, 'mergedBy', v_merged_by));
end $$;

create function public.api_delete_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_scope text := coalesce(nullif(p ->> 'scope', ''), 'this');
  v_inst timestamptz; e public.events; x public.events;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  select * into e from public.events where id = p ->> 'id' for update;
  if not found or e.deleted_at is not null then raise exception 'この予定は削除されています'; end if;
  if coalesce(p ->> 'instanceStart', '') <> '' then v_inst := public._check_ts(p ->> 'instanceStart', '繰り返しの回'); end if;

  if e.recurring_id is not null then
    -- 変更済みの回を消す（その回は表示しない）
    e.status := 'cancelled';
    perform public._event_save(e, v_actor);
  elsif e.rrule <> '' and v_inst is not null and v_scope = 'this' then
    x := public._event_instance(e, v_inst, v_actor);
    x.status := 'cancelled';
    if x.version = 0 then
      x.version := 1;
      insert into public.events select (x).*;
    else
      perform public._event_save(x, v_actor);
    end if;
  elsif e.rrule <> '' and v_inst is not null and v_scope = 'following' and v_inst > e.start_at then
    e.rrule := public._rr_strip_end(e.rrule) || ';UNTIL=' || to_char((v_inst at time zone 'Asia/Tokyo')::date - 1, 'YYYYMMDD');
    perform public._event_save(e, v_actor);
    update public.events set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
    where recurring_id = e.id and original_start >= v_inst and deleted_at is null;
  else
    update public.events set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
    where (id = e.id or recurring_id = e.id) and deleted_at is null;
  end if;
  return public._finish(v_start, null);
end $$;

-- 出欠（はい・いいえ・未定）
create function public.api_respond_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_mid text := coalesce(p ->> 'member', ''); v_resp text := coalesce(p ->> 'response', '');
  v_scope text := coalesce(nullif(p ->> 'scope', ''), 'all'); v_inst timestamptz; e public.events;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  if v_resp not in ('accepted', 'declined', 'tentative', 'needsAction') then raise exception '出欠の答えが正しくありません'; end if;
  select * into e from public.events where id = p ->> 'id' for update;
  if not found or e.deleted_at is not null then raise exception 'この予定は削除されています'; end if;
  if not e.attendees @> jsonb_build_array(jsonb_build_object('id', v_mid)) then raise exception 'この予定のゲストではありません'; end if;
  if coalesce(p ->> 'instanceStart', '') <> '' then v_inst := public._check_ts(p ->> 'instanceStart', '繰り返しの回'); end if;
  if e.rrule <> '' and v_inst is not null and v_scope = 'this' then
    e := public._event_instance(e, v_inst, v_actor);
  end if;
  select coalesce(jsonb_agg(case when x ->> 'id' = v_mid then jsonb_set(x, '{response}', to_jsonb(v_resp)) else x end order by ord), '[]'::jsonb)
  into e.attendees from jsonb_array_elements(e.attendees) with ordinality as t(x, ord);
  if e.version = 0 then
    e.version := 1;
    insert into public.events select (e).*;
  else
    perform public._event_save(e, v_actor);
  end if;
  return public._finish(v_start, null);
end $$;

-- ごみ箱（30日間戻せる）
create function public.api_event_trash(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._guard(false);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'start', e.start_at, 'end', e.end_at, 'allDay', e.all_day,
      'rrule', e.rrule, 'calendarId', e.calendar_id, 'deletedAt', e.deleted_at, 'deletedBy', e.deleted_by) order by e.deleted_at desc)
    from public.events e
    join public.calendars c on c.id = e.calendar_id and c.deleted_at is null
    where e.deleted_at is not null and e.deleted_at >= now() - interval '30 days' and e.recurring_id is null), '[]'::jsonb));
end $$;

create function public.api_restore_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); e public.events;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  select * into e from public.events where id = p ->> 'id';
  if not found then raise exception 'この予定は見つかりません'; end if;
  if e.deleted_at is null then return public._finish(v_start, null); end if;
  perform public._active_calendar(e.calendar_id);
  update public.events set deleted_at = null, deleted_by = '', version = version + 1, updated_at = now(), updated_by = v_actor
  where id = e.id or (recurring_id = e.id and deleted_at = e.deleted_at);
  return public._finish(v_start, null);
end $$;

/* ---------------- メンバーを登録したら、そのメンバーのカレンダーも作る ---------------- */

create or replace function public.api_save_member(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); m jsonb := coalesce(p -> 'member', '{}'::jsonb);
  v_id text; v_name text; v_email text; v_active boolean; v_old text;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_id := public._check_id(m ->> 'id');
  v_name := left(btrim(coalesce(m ->> 'name', '')), 50);
  if v_name = '' then raise exception '名前を入れてください'; end if;
  v_email := left(btrim(coalesce(m ->> 'email', '')), 200);
  if v_email <> '' and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'メールアドレスの形が正しくありません'; end if;
  v_active := coalesce((m ->> 'active')::boolean, true);
  if exists (select 1 from public.members where id <> v_id and active and name = v_name) then raise exception '同じ名前のメンバーがいます'; end if;
  select name into v_old from public.members where id = v_id;
  insert into public.members (id, name, email, active, sort_order)
  values (v_id, v_name, v_email, v_active, coalesce((select max(sort_order) from public.members), 0) + 1)
  on conflict (id) do update set name = excluded.name, email = excluded.email, active = excluded.active, updated_at = now();
  if not exists (select 1 from public.calendars where owner = v_id) then
    insert into public.calendars (id, name, color, owner, sort_order, created_by, updated_by)
    values ('cal-' || v_id, v_name, public._calendar_color(v_id), v_id, coalesce((select max(sort_order) from public.calendars), 0) + 1, v_actor, v_actor);
  elsif v_old is distinct from v_name then
    update public.calendars set name = v_name, updated_at = now(), updated_by = v_actor where owner = v_id and name = v_old;
  end if;
  return public._finish(v_start, null);
end $$;

-- いるメンバーのカレンダーを作っておく
insert into public.calendars (id, name, color, owner, sort_order)
select 'cal-' || m.id, m.name, public._calendar_color(m.id), m.id, m.sort_order
from public.members m
where not exists (select 1 from public.calendars c where c.owner = m.id);
select public._commit_rev();

/* ---------------- 権限 ---------------- */

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.has_access() to authenticated;
grant execute on function
  public.api_sync(jsonb), public.api_bootstrap(jsonb), public.api_task_detail(jsonb), public.api_trash(jsonb),
  public.api_create_list(jsonb), public.api_update_list(jsonb), public.api_delete_list(jsonb), public.api_reorder_lists(jsonb),
  public.api_create_task(jsonb), public.api_update_task(jsonb), public.api_delete_task(jsonb), public.api_restore_task(jsonb),
  public.api_clear_completed(jsonb), public.api_add_note(jsonb), public.api_save_member(jsonb), public.api_save_config(jsonb),
  public.api_mail_status(jsonb), public.api_request_test_mail(jsonb),
  public.api_events_range(jsonb), public.api_save_calendar(jsonb), public.api_delete_calendar(jsonb),
  public.api_create_event(jsonb), public.api_update_event(jsonb), public.api_delete_event(jsonb), public.api_respond_event(jsonb),
  public.api_event_trash(jsonb), public.api_restore_event(jsonb)
to authenticated;
