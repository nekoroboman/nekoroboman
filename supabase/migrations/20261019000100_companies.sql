-- 本部タスク: 会社ごとの所属（1/2: 表・決まり）（株式会社ネコロボマン・Selected Group 株式会社）
-- - 人（members）・リスト（lists）・カレンダー（calendars）は、どこかの会社に入る。タスクはリストの会社、予定はカレンダーの会社になる
-- - 見える範囲: ふつうの人は自分の会社の分だけ。会社の管理者（company_admins）に入った人は、その会社の分も見える。全権限のアカウントは全部
-- - 共有のアカウント（人に結びつかない）は app_access.company_id の会社
-- - 担当者は、そのタスクと同じ会社の人だけ選べる
-- - 会社の作成・名前の変更・人の所属・会社の管理者は、管理画面（管理者だけ）で決める
-- - これまでの人・リスト・カレンダーは「株式会社ネコロボマン」。今の管理者は、両方の会社の管理者にする
-- - 共有のデータベース（ホームと同じ）なので、権限は本部タスクの関数だけを名指しで外す

create table public.companies (
  id text primary key,
  name text not null check (length(btrim(name)) > 0),
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  deleted_at timestamptz,
  rev bigint not null default 0
);
alter table public.companies enable row level security;
create trigger companies_rev before insert or update on public.companies for each row execute function public._bump_rev();
insert into public.companies (id, name, sort_order) values ('co-nekoroboman', '株式会社ネコロボマン', 1), ('co-selected', 'Selected Group 株式会社', 2);

-- 会社の管理者（その会社の分も見られる人）。アカウントのメールアドレスで決める。外すときは revoked_at を入れる（行は消さない）
create table public.company_admins (
  email text not null references public.app_access (email),
  company_id text not null references public.companies (id),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  revoked_at timestamptz,
  primary key (email, company_id)
);
alter table public.company_admins enable row level security;

alter table public.members add column company_id text references public.companies (id);
alter table public.lists add column company_id text references public.companies (id);
alter table public.tasks add column company_id text references public.companies (id);
alter table public.calendars add column company_id text references public.companies (id);
alter table public.events add column company_id text references public.companies (id);
alter table public.app_access add column company_id text references public.companies (id);

update public.members set company_id = 'co-nekoroboman' where company_id is null;
update public.lists set company_id = 'co-nekoroboman' where company_id is null;
update public.tasks set company_id = 'co-nekoroboman' where company_id is null;
update public.calendars set company_id = 'co-nekoroboman' where company_id is null;
update public.events set company_id = 'co-nekoroboman' where company_id is null;
update public.app_access set company_id = 'co-nekoroboman' where company_id is null and member_id is null;
insert into public.company_admins (email, company_id, created_by)
select a.email, c.id, 'migration' from public.app_access a cross join public.companies c
where (a.is_admin or a.is_owner) and a.status in ('invited', 'active')
on conflict do nothing;

-- Selected Group 株式会社にも、最初のリスト「マイタスク」を作っておく
insert into public.lists (id, name, sort_order, company_id)
select replace(gen_random_uuid()::text, '-', ''), 'マイタスク', coalesce((select max(sort_order) from public.lists), 0) + 1, 'co-selected'
where not exists (select 1 from public.lists where company_id = 'co-selected');

-- 上で書き換えた行を、画面の読み込みに出す
select public._commit_rev();

create index tasks_company_idx on public.tasks (company_id);
create index events_company_idx on public.events (company_id);

/* ---------------- だれが、どの会社を見られるか ---------------- */

-- 最初の会社（決まっていないときに使う）
create function public._default_company() returns text
language sql stable security definer set search_path = public as $$
  select id from public.companies where deleted_at is null order by sort_order, created_at limit 1
$$;

-- ログインしているアカウント（見つからなければ空。_account と違ってエラーにしない）
create function public._me_access() returns public.app_access
language sql stable security definer set search_path = public as $$
  select a from public.app_access a where a.email = lower(coalesce(auth.jwt() ->> 'email', '')) and a.status = 'active'
$$;

-- ログインしている人の会社（人のアカウントは、その人の会社。共有のアカウントは、アカウントの会社）
create function public._my_company() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select m.company_id from public.members m where m.id = a.member_id), a.company_id, public._default_company())
  from (select (public._me_access()).*) a where a.email is not null
$$;

-- 見られる会社（自分の会社＋会社の管理者になっている会社。全権限は全部）
create function public._my_companies() returns text[]
language plpgsql stable security definer set search_path = public as $$
declare a public.app_access := public._me_access(); v text[];
begin
  if a.email is null then return '{}'::text[]; end if;
  if a.is_owner then
    return coalesce((select array_agg(id order by sort_order) from public.companies where deleted_at is null), '{}'::text[]);
  end if;
  select array_agg(distinct x) into v from (
    select public._my_company() as x
    union all
    select ca.company_id from public.company_admins ca join public.companies c on c.id = ca.company_id and c.deleted_at is null
    where ca.email = a.email and ca.revoked_at is null
  ) s where x is not null;
  return coalesce(v, '{}'::text[]);
end $$;

/* ---------------- 会社を自動で決める・見られない会社のデータは変えられない ---------------- */

create function public._company_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'tasks' then
    if tg_op = 'INSERT' or new.list_id is distinct from old.list_id then
      new.company_id := coalesce((select l.company_id from public.lists l where l.id = new.list_id), new.company_id, public._default_company());
    end if;
  elsif tg_table_name = 'events' then
    if tg_op = 'INSERT' or new.calendar_id is distinct from old.calendar_id then
      new.company_id := coalesce((select c.company_id from public.calendars c where c.id = new.calendar_id), new.company_id, public._default_company());
    end if;
  elsif tg_table_name = 'calendars' then
    if tg_op = 'INSERT' and new.company_id is null then
      new.company_id := coalesce((select m.company_id from public.members m where m.id = new.owner), public._my_company(), public._default_company());
    end if;
  elsif tg_op = 'INSERT' and new.company_id is null then
    new.company_id := coalesce(public._my_company(), public._default_company());
  end if;
  return new;
end $$;

-- 会社を変えたら、中のものもついていく（リスト → タスク、カレンダー → 予定、人 → その人のカレンダー）
create function public._company_follow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.company_id is not distinct from old.company_id then return new; end if;
  if tg_table_name = 'lists' then
    update public.tasks set company_id = new.company_id where list_id = new.id and company_id is distinct from new.company_id;
  elsif tg_table_name = 'calendars' then
    update public.events set company_id = new.company_id where calendar_id = new.id and company_id is distinct from new.company_id;
  elsif tg_table_name = 'members' then
    update public.calendars set company_id = new.company_id where owner = new.id and company_id is distinct from new.company_id;
  end if;
  return new;
end $$;

-- 画面から（ログインした人の操作で）変えるときは、見られる会社のデータだけ。
-- 自動の処理（ログインなし）と、管理画面の操作（honbu.company_bypass = on）は通す
create function public._company_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v text[];
begin
  if coalesce(auth.jwt() ->> 'email', '') = '' or coalesce(current_setting('honbu.company_bypass', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  v := public._my_companies();
  if tg_op = 'UPDATE' and old.company_id is not null and not (old.company_id = any (v)) then
    raise exception 'ほかの会社のデータは変更できません';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.company_id is not null and not (new.company_id = any (v)) then
    raise exception 'ほかの会社のデータは変更できません';
  end if;
  return coalesce(new, old);
end $$;

-- 担当者は、そのタスクと同じ会社の人だけ
create function public._company_assignee() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assignee is not null and (tg_op = 'INSERT' or new.assignee is distinct from old.assignee)
     and exists (select 1 from public.members m where m.id = new.assignee and m.company_id is distinct from new.company_id) then
    raise exception '担当者は、同じ会社（所属）の人だけ選べます';
  end if;
  return new;
end $$;

create trigger members_co1_fill before insert on public.members for each row execute function public._company_fill();
create trigger lists_co1_fill before insert on public.lists for each row execute function public._company_fill();
create trigger calendars_co1_fill before insert on public.calendars for each row execute function public._company_fill();
create trigger tasks_co1_fill before insert or update of list_id on public.tasks for each row execute function public._company_fill();
create trigger events_co1_fill before insert or update of calendar_id on public.events for each row execute function public._company_fill();

create trigger members_co2_guard before insert or update on public.members for each row execute function public._company_guard();
create trigger lists_co2_guard before insert or update on public.lists for each row execute function public._company_guard();
create trigger calendars_co2_guard before insert or update on public.calendars for each row execute function public._company_guard();
create trigger tasks_co2_guard before insert or update on public.tasks for each row execute function public._company_guard();
create trigger events_co2_guard before insert or update on public.events for each row execute function public._company_guard();

create trigger tasks_co3_assignee before insert or update of assignee on public.tasks for each row execute function public._company_assignee();

create trigger lists_co_follow after update of company_id on public.lists for each row execute function public._company_follow();
create trigger calendars_co_follow after update of company_id on public.calendars for each row execute function public._company_follow();
create trigger members_co_follow after update of company_id on public.members for each row execute function public._company_follow();

/* ---------------- 直接読むとき（リアルタイムの通知も）も、見られる会社の分だけ ---------------- */

alter policy members_read on public.members using ((select public.has_access()) and company_id = any (coalesce((select public._my_companies()), '{}'::text[])));
alter policy lists_read on public.lists using ((select public.has_access()) and company_id = any (coalesce((select public._my_companies()), '{}'::text[])));
alter policy tasks_read on public.tasks using ((select public.has_access()) and company_id = any (coalesce((select public._my_companies()), '{}'::text[])));
alter policy calendars_read on public.calendars using ((select public.has_access()) and company_id = any (coalesce((select public._my_companies()), '{}'::text[])));
alter policy events_read on public.events using ((select public.has_access()) and company_id = any (coalesce((select public._my_companies()), '{}'::text[])));
alter policy task_notes_read on public.task_notes using ((select public.has_access()) and exists (
  select 1 from public.tasks t where t.id = task_notes.task_id and t.company_id = any (coalesce((select public._my_companies()), '{}'::text[]))));
alter policy task_history_read on public.task_history using ((select public.has_access()) and exists (
  select 1 from public.tasks t where t.id = task_history.task_id and t.company_id = any (coalesce((select public._my_companies()), '{}'::text[]))));
create policy companies_read on public.companies for select to authenticated using ((select public.has_access()) and id = any (coalesce((select public._my_companies()), '{}'::text[])));
alter publication supabase_realtime add table public.companies;

/* ---------------- 権限（本部タスクの関数だけを名指しで。スキーマ全体にはかけない） ---------------- */

revoke all on function public._default_company() from public, anon, authenticated;
revoke all on function public._me_access() from public, anon, authenticated;
revoke all on function public._my_company() from public, anon, authenticated;
revoke all on function public._my_companies() from public, anon, authenticated;
revoke all on function public._company_fill() from public, anon, authenticated;
revoke all on function public._company_follow() from public, anon, authenticated;
revoke all on function public._company_guard() from public, anon, authenticated;
revoke all on function public._company_assignee() from public, anon, authenticated;
-- 直接読むときの決まり（RLS）で使うので、ログインした人は実行できる（自分の見られる会社が返るだけ）
grant execute on function public._my_companies() to authenticated;
