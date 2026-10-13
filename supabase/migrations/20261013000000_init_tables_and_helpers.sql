-- 本部タスク: データベースの初期設定
-- 画面からの書き込みは、すべて下の api_* 関数を通す（表への直接の書き込みはできない）。
-- 書き込みは1件ずつ順番に行い、変えた行に「同期番号（rev）」を付ける。
-- 画面は「前に見た番号より新しい行」だけを受け取る。リアルタイム通知はその合図に使う。

create extension if not exists pg_cron;

create sequence if not exists public.rev_seq;

-- 内部の状態（同期番号・メール送信の状態など）。画面からは読めない
create table public.app_state (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.app_state enable row level security;

-- 使ってよいアカウント（メールアドレス）。画面からは読めない
create table public.app_access (
  email text primary key,
  created_at timestamptz not null default now()
);
alter table public.app_access enable row level security;

create table public.members (
  id text primary key,
  name text not null check (length(btrim(name)) > 0),
  email text not null default '',
  active boolean not null default true,
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rev bigint not null default 0
);

create table public.lists (
  id text primary key,
  name text not null check (length(btrim(name)) > 0),
  sort_mode text not null default 'my' check (sort_mode in ('my', 'date', 'starred', 'title', 'assignee')),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  deleted_at timestamptz,
  rev bigint not null default 0
);

create table public.tasks (
  id text primary key,
  list_id text not null references public.lists (id) on delete cascade,
  parent_id text references public.tasks (id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  details text not null default '',
  assignee text references public.members (id),
  due date,
  due_time text not null default '' check (due_time = '' or due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  repeat text not null default '',
  starred boolean not null default false,
  starred_at timestamptz,
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  completed_at timestamptz,
  completed_by text not null default '',
  on_time boolean,
  note_text text not null default '',
  note_at timestamptz,
  note_by text not null default '',
  next_id text,
  deleted_at timestamptz,
  deleted_by text not null default '',
  version integer not null default 1,
  rev bigint not null default 0,
  -- 親タスクは「誰が（担当者）」と「いつまでに（期限）」が必須
  constraint tasks_who_and_when check (parent_id is not null or (assignee is not null and due is not null))
);

create table public.task_notes (
  id text primary key,
  task_id text not null references public.tasks (id) on delete cascade,
  body text not null,
  actor text not null default '',
  created_at timestamptz not null default now()
);

create table public.task_history (
  id bigint generated always as identity primary key,
  task_id text not null,
  action text not null,
  field text not null default '',
  before_value text not null default '',
  after_value text not null default '',
  actor text not null default '',
  created_at timestamptz not null default now()
);

create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  rev bigint not null default 0
);

create table public.mail_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  to_addr text not null default '',
  subject text not null default '',
  result text not null default '',
  error text not null default ''
);

create index tasks_rev_idx on public.tasks (rev);
create index tasks_list_idx on public.tasks (list_id) where deleted_at is null;
create index tasks_parent_idx on public.tasks (parent_id);
create index tasks_assignee_idx on public.tasks (assignee, status) where deleted_at is null;
create index tasks_open_due_idx on public.tasks (due) where deleted_at is null and status <> 'done';
create index tasks_deleted_idx on public.tasks (deleted_at) where deleted_at is not null;
create index lists_rev_idx on public.lists (rev);
create index members_rev_idx on public.members (rev);
create index task_notes_task_idx on public.task_notes (task_id, created_at desc);
create index task_notes_created_idx on public.task_notes (created_at);
create index task_history_task_idx on public.task_history (task_id, created_at desc);
create index mail_log_created_idx on public.mail_log (created_at desc);

-- 変えた行に新しい同期番号を付ける
create function public._bump_rev() returns trigger
language plpgsql set search_path = public as $$
begin
  new.rev := nextval('public.rev_seq');
  return new;
end $$;

create trigger tasks_rev before insert or update on public.tasks for each row execute function public._bump_rev();
create trigger lists_rev before insert or update on public.lists for each row execute function public._bump_rev();
create trigger members_rev before insert or update on public.members for each row execute function public._bump_rev();
create trigger settings_rev before insert or update on public.settings for each row execute function public._bump_rev();

/* ---------------- 守り ---------------- */

create function public.has_access() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_access a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;

alter table public.members enable row level security;
alter table public.lists enable row level security;
alter table public.tasks enable row level security;
alter table public.task_notes enable row level security;
alter table public.task_history enable row level security;
alter table public.settings enable row level security;
alter table public.mail_log enable row level security;

create policy members_read on public.members for select to authenticated using ((select public.has_access()));
create policy lists_read on public.lists for select to authenticated using ((select public.has_access()));
create policy tasks_read on public.tasks for select to authenticated using ((select public.has_access()));
create policy task_notes_read on public.task_notes for select to authenticated using ((select public.has_access()));
create policy task_history_read on public.task_history for select to authenticated using ((select public.has_access()));
create policy settings_read on public.settings for select to authenticated using ((select public.has_access()));
create policy mail_log_read on public.mail_log for select to authenticated using ((select public.has_access()));

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on public.app_state, public.app_access from anon, authenticated;

/* ---------------- 小さな道具 ---------------- */

-- 書き込みの入口: 使ってよいアカウントか確かめ、書き込みを1件ずつ順番にする
create function public._guard(p_write boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_access() then
    raise exception 'このアカウントでは使えません。本部の共有アカウントでログインしてください';
  end if;
  if p_write then
    perform pg_advisory_xact_lock(4242);
  end if;
end $$;

-- いま使われている最後の同期番号
create function public._last_rev() returns bigint
language sql volatile security definer set search_path = public as $$
  select case when is_called then last_value else last_value - 1 end from public.rev_seq
$$;

-- 書き終わった番号を公開する（画面はこの番号までを受け取る）
create function public._commit_rev() returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint := public._last_rev();
begin
  insert into public.app_state (key, value) values ('rev', v::text)
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return v;
end $$;

create function public._state(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from public.app_state where key = p_key
$$;

create function public._set_state(p_key text, p_value text) returns void
language sql security definer set search_path = public as $$
  insert into public.app_state (key, value) values (p_key, coalesce(p_value, ''))
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;

-- 列名を画面で使う形（list_id → listId）にする
create function public._camel(j jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(
    (select string_agg(case when i = 1 then part else initcap(part) end, '' order by i)
       from unnest(string_to_array(e.key, '_')) with ordinality as s(part, i)),
    e.value), '{}'::jsonb)
  from jsonb_each(j) as e
$$;

-- p_since より後に変わった行
create function public._changes(p_since bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'lists', coalesce((select jsonb_agg(public._camel(to_jsonb(l))) from public.lists l where l.rev > p_since), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(public._camel(to_jsonb(t))) from public.tasks t where t.rev > p_since), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(public._camel(to_jsonb(m))) from public.members m where m.rev > p_since), '[]'::jsonb))
$$;

-- 書き込みの終わり: 番号を公開し、変わった行を返す
create function public._finish(p_start bigint, p_extra jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v bigint := public._commit_rev();
begin
  return public._changes(p_start) || jsonb_build_object('rev', v) || coalesce(p_extra, '{}'::jsonb);
end $$;

create function public._new_id() returns text
language sql volatile set search_path = public as $$
  select replace(gen_random_uuid()::text, '-', '')
$$;

create function public._check_id(p text) returns text
language plpgsql immutable set search_path = public as $$
begin
  if p is null or p !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'IDが正しくありません'; end if;
  return p;
end $$;

create function public._check_date(p text) returns date
language plpgsql immutable set search_path = public as $$
begin
  if p !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '期限の日付が正しくありません'; end if;
  begin
    return p::date;
  exception when others then
    raise exception '期限の日付が正しくありません';
  end;
end $$;

create function public._check_time(p text) returns text
language plpgsql immutable set search_path = public as $$
begin
  if coalesce(p, '') <> '' and p !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception '期限の時刻が正しくありません'; end if;
  return coalesce(p, '');
end $$;

create function public._check_repeat(p text) returns text
language plpgsql immutable set search_path = public as $$
begin
  if coalesce(p, '') = '' then return ''; end if;
  if p ~ '^(daily|weekdays|weekly|monthly|yearly)$' then return p; end if;
  if p ~ '^every:[0-9]{1,3}:(day|week|month|year)(:[0-6](,[0-6]){0,6})?$' and split_part(p, ':', 2)::int > 0 then return p; end if;
  raise exception '繰り返しの設定が正しくありません';
end $$;

create function public._check_member(p text) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.members where id = p) then
    raise exception '担当者が見つかりません。メンバーに登録してください';
  end if;
  return p;
end $$;

create function public._active_list(p text) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.lists where id = p and deleted_at is null) then
    raise exception 'リストが見つかりません。画面を読み込み直してください';
  end if;
  return p;
end $$;

-- 期限の日時（時刻なしは、その日の 23:59 まで。日本時間）
create function public._due_at(p_due date, p_time text) returns timestamptz
language sql immutable set search_path = public as $$
  select case when p_due is null then null
    else ((p_due::text || ' ' || coalesce(nullif(p_time, ''), '23:59') || ':59')::timestamp at time zone 'Asia/Tokyo') end
$$;

-- 繰り返しの次の期限
create function public._next_due(p_due date, p_repeat text) returns date
language plpgsql immutable set search_path = public as $$
declare
  v_every int; v_unit text; v_days int[]; d date; i int; base int;
begin
  case p_repeat
    when 'daily' then return p_due + 1;
    when 'weekdays' then
      d := p_due + 1;
      while extract(dow from d) in (0, 6) loop d := d + 1; end loop;
      return d;
    when 'weekly' then return p_due + 7;
    when 'monthly' then return (p_due + interval '1 month')::date;
    when 'yearly' then return (p_due + interval '1 year')::date;
    else null;
  end case;
  v_every := split_part(p_repeat, ':', 2)::int;
  v_unit := split_part(p_repeat, ':', 3);
  if v_unit = 'day' then return p_due + v_every; end if;
  if v_unit = 'month' then return (p_due + make_interval(months => v_every))::date; end if;
  if v_unit = 'year' then return (p_due + make_interval(years => v_every))::date; end if;
  if split_part(p_repeat, ':', 4) = '' then return p_due + 7 * v_every; end if;
  v_days := string_to_array(split_part(p_repeat, ':', 4), ',')::int[];
  base := (p_due - date '1970-01-05') / 7;
  for i in 1 .. 7 * v_every + 7 loop
    d := p_due + i;
    if extract(dow from d)::int = any (v_days) and (((d - date '1970-01-05') / 7) - base) % v_every = 0 then
      return d;
    end if;
  end loop;
  return p_due + 7 * v_every;
end $$;

create function public._hist(p_task text, p_action text, p_field text, p_before text, p_after text, p_actor text) returns void
language sql security definer set search_path = public as $$
  insert into public.task_history (task_id, action, field, before_value, after_value, actor)
  values (p_task, p_action, coalesce(p_field, ''), coalesce(p_before, ''), coalesce(p_after, ''), coalesce(p_actor, ''));
$$;

-- 設定（保存されていない項目は最初の値）
create function public._config() returns jsonb
language sql stable security definer set search_path = public as $$
  with d as (
    select '{"mail":{"enabled":false,"recipients":[],"days":[1,2,3,4,5],"startHour":10,"endHour":17,"summaryTime":"17:30","skipHolidays":true,"skipYearEnd":true,"sendWhenNoChange":true},"soonDays":3,"staleDays":3}'::jsonb as v
  ), s as (
    select coalesce((select value from public.settings where key = 'app'), '{}'::jsonb) as v
  )
  select d.v || s.v || jsonb_build_object('mail', (d.v -> 'mail') || coalesce(s.v -> 'mail', '{}'::jsonb)) from d, s
$$;
