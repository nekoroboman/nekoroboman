-- 本部タスク: 優先度（低・中・高）と、人ごとの色
-- - tasks.priority: low（低・青）／mid（中・黄）／high（高・赤）。親タスクは登録のとき必ず選ぶ（サブタスクは使わない）
--   優先度を送ってこない古い画面からの登録は「中」にする
--   これまでのタスクは「中」にする。繰り返しの次の回も同じ優先度
-- - members.color: 人ごとの色。今のカレンダーの色から始める。変えると、その人のカレンダーの色も同じにする
-- - リストの並べ替えに「優先度」を足す

alter table public.tasks add column priority text default 'mid' check (priority in ('low', 'mid', 'high'));
alter table public.tasks alter column priority drop default;

alter table public.members add column color text not null default '';
update public.members m set color = coalesce((select c.color from public.calendars c where c.owner = m.id and c.deleted_at is null order by c.created_at limit 1), public._calendar_color(m.id))
where m.color = '';

alter table public.lists drop constraint lists_sort_mode_check;
alter table public.lists add constraint lists_sort_mode_check check (sort_mode in ('my', 'do', 'date', 'starred', 'title', 'assignee', 'priority'));

create function public._check_priority(p text) returns text
language plpgsql immutable set search_path = public as $$
begin
  if coalesce(p, '') not in ('low', 'mid', 'high') then raise exception '優先度（低・中・高）を選んでください'; end if;
  return p;
end $$;

create or replace function public.api_create_task(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); t jsonb := coalesce(p -> 'task', '{}'::jsonb);
  v_id text; v_parent public.tasks; v_list text; v_title text; v_assignee text;
  v_due date; v_time text := ''; v_do date; v_do_time text := ''; v_repeat text := '';
  v_starred boolean := coalesce((t ->> 'starred')::boolean, false); v_existing public.tasks; v_priority text;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_id := public._check_id(t ->> 'id');
  select * into v_existing from public.tasks where id = v_id;
  if found then -- 通信のやり直しで2回届いたとき
    return jsonb_build_object('rev', public._commit_rev(), 'lists', '[]'::jsonb, 'members', '[]'::jsonb,
      'tasks', jsonb_build_array(public._camel(to_jsonb(v_existing))));
  end if;
  if coalesce(t ->> 'parentId', '') <> '' then
    select * into v_parent from public.tasks where id = t ->> 'parentId' and deleted_at is null;
    if not found then raise exception '親タスクが見つかりません'; end if;
    if v_parent.parent_id is not null then raise exception 'サブタスクの中にはサブタスクを作れません'; end if;
    v_list := v_parent.list_id;
  else
    v_list := public._active_list(t ->> 'listId');
  end if;
  v_title := left(btrim(coalesce(t ->> 'title', '')), 500);
  if v_title = '' then raise exception 'タスク名（何を）を入れてください'; end if;
  v_assignee := nullif(btrim(coalesce(t ->> 'assignee', '')), '');
  if coalesce(t ->> 'due', '') <> '' then
    v_due := public._check_day(t ->> 'due', '期限');
    v_time := public._check_clock(t ->> 'dueTime', '期限');
  end if;
  if coalesce(t ->> 'doDate', '') <> '' then
    v_do := public._check_day(t ->> 'doDate', 'いつやる');
    v_do_time := public._check_clock(t ->> 'doTime', 'いつやる');
  end if;
  if v_parent.id is null then
    v_repeat := public._repeat_fill(public._check_repeat(t ->> 'repeat'), coalesce(v_do, v_due));
    if v_assignee is null then raise exception '担当者（誰が）を選んでください'; end if;
    -- 優先度は必ず選ぶ（画面が必ず送る）。優先度を送ってこない古い画面からの登録だけは「中」にする（公開を入れ替えるまでのあいだ止まらないように）
    v_priority := case when t ? 'priority' then public._check_priority(t ->> 'priority') else 'mid' end;
    if v_due is null and not (v_repeat <> '' and v_do is not null) then
      raise exception '期限（いつまでに）を選んでください（繰り返しのタスクは「いつやる」を決めれば期限なしにできます）';
    end if;
  end if;
  if v_assignee is not null then perform public._check_member(v_assignee); end if;
  insert into public.tasks (id, list_id, parent_id, title, details, assignee, do_date, do_time, due, due_time, repeat,
                            starred, starred_at, sort_order, created_by, updated_by, priority)
  values (v_id, v_list, v_parent.id, v_title, left(coalesce(t ->> 'details', ''), 5000), v_assignee, v_do, v_do_time, v_due, v_time, v_repeat,
          v_starred, case when v_starred then now() end,
          case when jsonb_typeof(t -> 'sortOrder') = 'number' then (t ->> 'sortOrder')::double precision else 0 end,
          v_actor, v_actor, v_priority);
  perform public._hist(v_id, 'create', '', '', v_title, v_actor);
  return public._finish(v_start, null);
end $$;

-- 完了にしたとき・戻したときの後始末（繰り返しの次の回にも優先度を引き継ぐ）
create or replace function public._apply_status(t public.tasks, p_old text, p_actor text) returns public.tasks
language plpgsql security definer set search_path = public as $$
declare
  v_next text; v_anchor date; v_next_date date; v_next_index int; v_shift int;
begin
  if t.status = 'done' and p_old <> 'done' then
    t.completed_at := now();
    t.completed_by := p_actor;
    t.on_time := case when t.due is null then null else now() <= public._due_at(t.due, t.due_time) end;
    update public.tasks set status = 'done', completed_at = now(), completed_by = p_actor,
      version = version + 1, updated_at = now(), updated_by = p_actor
    where parent_id = t.id and deleted_at is null and status <> 'done';
    v_anchor := coalesce(t.do_date, t.due);
    if t.repeat <> '' and t.parent_id is null and t.next_id is null and v_anchor is not null then
      select r.next_date, r.next_index into v_next_date, v_next_index
      from public._repeat_next(t.repeat, v_anchor, t.repeat_index, (now() at time zone 'Asia/Tokyo')::date) as r;
      if v_next_date is not null then
        v_shift := v_next_date - v_anchor;
        v_next := public._new_id();
        -- 次の回も、頼んだ人（作成者）は同じ
        insert into public.tasks (id, list_id, title, details, assignee, do_date, do_time, due, due_time, repeat, repeat_index,
                                  starred, starred_at, sort_order, created_by, updated_by, priority)
        values (v_next, t.list_id, t.title, t.details, t.assignee, t.do_date + v_shift, t.do_time, t.due + v_shift, t.due_time, t.repeat, v_next_index,
                t.starred, case when t.starred then now() end, t.sort_order, coalesce(nullif(t.created_by, ''), p_actor), p_actor, t.priority);
        perform public._hist(v_next, 'create', 'repeat', t.id, t.title, p_actor);
        insert into public.tasks (id, list_id, parent_id, title, details, assignee, do_date, do_time, due, due_time, sort_order, created_by, updated_by)
        select public._new_id(), list_id, v_next, title, details, assignee, do_date + v_shift, do_time, due + v_shift, due_time, sort_order, created_by, p_actor
        from public.tasks where parent_id = t.id and deleted_at is null;
        t.next_id := v_next;
      end if;
    end if;
  elsif t.status <> 'done' and p_old = 'done' then
    t.completed_at := null;
    t.completed_by := '';
    t.on_time := null;
  end if;
  return t;
end $$;

create or replace function public.api_update_task(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_patch jsonb := coalesce(p -> 'patch', '{}'::jsonb);
  t public.tasks; b public.tasks; v_top boolean; v_merged boolean; v_merged_by text := ''; v_base int := coalesce((p ->> 'baseVersion')::int, 0);
begin
  perform public._guard(true);
  v_start := public._last_rev();
  select * into t from public.tasks where id = p ->> 'id' for update;
  if not found or t.deleted_at is not null then raise exception 'このタスクは削除されています'; end if;
  b := t;
  v_top := t.parent_id is null;
  v_merged := v_base > 0 and v_base <> t.version;
  if v_merged and b.updated_by <> '' and b.updated_by <> v_actor then v_merged_by := b.updated_by; end if;

  if v_patch ? 'title' then
    if btrim(coalesce(v_patch ->> 'title', '')) = '' then raise exception 'タスク名（何を）は空にできません'; end if;
    t.title := left(btrim(v_patch ->> 'title'), 500);
  end if;
  if v_patch ? 'details' then t.details := left(coalesce(v_patch ->> 'details', ''), 5000); end if;
  if v_patch ? 'assignee' then
    if coalesce(v_patch ->> 'assignee', '') = '' then
      if v_top then raise exception '担当者（誰が）は空にできません'; end if;
      t.assignee := null;
    else
      t.assignee := public._check_member(v_patch ->> 'assignee');
    end if;
  end if;
  if v_patch ? 'due' then
    if coalesce(v_patch ->> 'due', '') = '' then
      t.due := null;
      t.due_time := '';
    else
      t.due := public._check_day(v_patch ->> 'due', '期限');
    end if;
  end if;
  if v_patch ? 'dueTime' then t.due_time := case when t.due is null then '' else public._check_clock(v_patch ->> 'dueTime', '期限') end; end if;
  if v_patch ? 'doDate' then
    if coalesce(v_patch ->> 'doDate', '') = '' then
      t.do_date := null;
      t.do_time := '';
    else
      t.do_date := public._check_day(v_patch ->> 'doDate', 'いつやる');
    end if;
  end if;
  if v_patch ? 'doTime' then t.do_time := case when t.do_date is null then '' else public._check_clock(v_patch ->> 'doTime', 'いつやる') end; end if;
  if v_patch ? 'repeat' then
    t.repeat := case when v_top then public._repeat_fill(public._check_repeat(v_patch ->> 'repeat'), coalesce(t.do_date, t.due)) else '' end;
    if t.repeat is distinct from b.repeat then t.repeat_index := 1; end if;
  end if;
  if v_top and t.due is null and not (t.repeat <> '' and t.do_date is not null) then
    raise exception '期限（いつまでに）は空にできません（繰り返しのタスクは「いつやる」があれば期限なしにできます）';
  end if;
  if v_patch ? 'starred' then
    t.starred := coalesce((v_patch ->> 'starred')::boolean, false);
    t.starred_at := case when t.starred then coalesce(case when b.starred then b.starred_at end, now()) else null end;
  end if;
  if v_patch ? 'status' then
    if coalesce(v_patch ->> 'status', '') not in ('todo', 'doing', 'done') then raise exception 'ステータスが正しくありません'; end if;
    t.status := v_patch ->> 'status';
  end if;
  if v_patch ? 'priority' and v_top then t.priority := public._check_priority(v_patch ->> 'priority'); end if;
  if v_patch ? 'sortOrder' and jsonb_typeof(v_patch -> 'sortOrder') = 'number' then t.sort_order := (v_patch ->> 'sortOrder')::double precision; end if;
  if v_patch ? 'listId' and v_top and coalesce(v_patch ->> 'listId', '') <> t.list_id then
    t.list_id := public._active_list(v_patch ->> 'listId');
  end if;

  if (t.title, t.details, t.assignee, t.due, t.due_time, t.do_date, t.do_time, t.repeat, t.starred, t.status, t.sort_order, t.list_id, t.priority)
     is not distinct from (b.title, b.details, b.assignee, b.due, b.due_time, b.do_date, b.do_time, b.repeat, b.starred, b.status, b.sort_order, b.list_id, b.priority) then
    return jsonb_build_object('rev', public._commit_rev(), 'lists', '[]'::jsonb, 'members', '[]'::jsonb,
      'tasks', jsonb_build_array(public._camel(to_jsonb(b))), 'merged', v_merged, 'mergedBy', v_merged_by);
  end if;

  if t.status <> b.status then t := public._apply_status(t, b.status, v_actor); end if;
  update public.tasks set
    list_id = t.list_id, title = t.title, details = t.details, assignee = t.assignee, due = t.due, due_time = t.due_time,
    do_date = t.do_date, do_time = t.do_time, repeat = t.repeat, repeat_index = t.repeat_index,
    starred = t.starred, starred_at = t.starred_at, status = t.status, sort_order = t.sort_order, priority = t.priority,
    completed_at = t.completed_at, completed_by = t.completed_by, on_time = t.on_time, next_id = t.next_id,
    version = b.version + 1, updated_at = now(), updated_by = v_actor
  where id = t.id;

  if t.title is distinct from b.title then perform public._hist(t.id, 'update', 'title', b.title, t.title, v_actor); end if;
  if t.assignee is distinct from b.assignee then perform public._hist(t.id, 'update', 'assignee', b.assignee, t.assignee, v_actor); end if;
  if t.due is distinct from b.due then perform public._hist(t.id, 'update', 'due', b.due::text, t.due::text, v_actor); end if;
  if t.due_time is distinct from b.due_time then perform public._hist(t.id, 'update', 'dueTime', b.due_time, t.due_time, v_actor); end if;
  if t.do_date is distinct from b.do_date then perform public._hist(t.id, 'update', 'doDate', b.do_date::text, t.do_date::text, v_actor); end if;
  if t.do_time is distinct from b.do_time then perform public._hist(t.id, 'update', 'doTime', b.do_time, t.do_time, v_actor); end if;
  if t.status is distinct from b.status then perform public._hist(t.id, 'update', 'status', b.status, t.status, v_actor); end if;
  if t.list_id is distinct from b.list_id then perform public._hist(t.id, 'update', 'listId', b.list_id, t.list_id, v_actor); end if;
  if t.repeat is distinct from b.repeat then perform public._hist(t.id, 'update', 'repeat', b.repeat, t.repeat, v_actor); end if;
  if t.priority is distinct from b.priority then perform public._hist(t.id, 'update', 'priority', b.priority, t.priority, v_actor); end if;

  if v_top and t.list_id <> b.list_id then
    update public.tasks set list_id = t.list_id, version = version + 1, updated_at = now(), updated_by = v_actor
    where parent_id = t.id and deleted_at is null;
  end if;
  return public._finish(v_start, jsonb_build_object('merged', v_merged, 'mergedBy', v_merged_by));
end $$;

create or replace function public.api_update_list(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_id text := p ->> 'id'; v_patch jsonb := coalesce(p -> 'patch', '{}'::jsonb);
  v_name text; v_mode text;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  perform public._active_list(v_id);
  if v_patch ? 'name' then
    v_name := left(btrim(coalesce(v_patch ->> 'name', '')), 100);
    if v_name = '' then raise exception 'リスト名を入れてください'; end if;
    update public.lists set name = v_name, updated_at = now(), updated_by = v_actor where id = v_id;
  end if;
  if v_patch ? 'sortMode' then
    v_mode := v_patch ->> 'sortMode';
    if v_mode not in ('my', 'do', 'date', 'starred', 'title', 'assignee', 'priority') then raise exception '並べ替えの指定が正しくありません'; end if;
    update public.lists set sort_mode = v_mode, updated_at = now(), updated_by = v_actor where id = v_id;
  end if;
  return public._finish(v_start, null);
end $$;

create or replace function public.api_save_member(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); m jsonb := coalesce(p -> 'member', '{}'::jsonb);
  v_id text; v_name text; v_email text; v_active boolean; v_old text; v_color text;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_id := public._check_id(m ->> 'id');
  v_name := left(btrim(coalesce(m ->> 'name', '')), 50);
  if v_name = '' then raise exception '名前を入れてください'; end if;
  v_email := left(btrim(coalesce(m ->> 'email', '')), 200);
  if v_email <> '' and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'メールアドレスの形が正しくありません'; end if;
  v_active := coalesce((m ->> 'active')::boolean, true);
  v_color := coalesce(m ->> 'color', '');
  if v_color <> '' and v_color !~ '^#[0-9a-fA-F]{6}$' then raise exception '色の指定が正しくありません'; end if;
  if exists (select 1 from public.members where id <> v_id and active and name = v_name) then raise exception '同じ名前のメンバーがいます'; end if;
  select name into v_old from public.members where id = v_id;
  insert into public.members (id, name, email, active, sort_order, color)
  values (v_id, v_name, v_email, v_active, coalesce((select max(sort_order) from public.members), 0) + 1, case when v_color = '' then public._calendar_color(v_id) else v_color end)
  on conflict (id) do update set name = excluded.name, email = excluded.email, active = excluded.active,
    color = case when m ? 'color' and v_color <> '' then v_color else public.members.color end, updated_at = now();
  if not exists (select 1 from public.calendars where owner = v_id) then
    insert into public.calendars (id, name, color, owner, sort_order, created_by, updated_by)
    values ('cal-' || v_id, v_name, public._calendar_color(v_id), v_id, coalesce((select max(sort_order) from public.calendars), 0) + 1, v_actor, v_actor);
  elsif v_old is distinct from v_name then
    update public.calendars set name = v_name, updated_at = now(), updated_by = v_actor where owner = v_id and name = v_old;
  end if;
  -- 人の色は、その人のカレンダーの色にもする（タスクと予定を同じ色で見分けられるように）
  if m ? 'color' and v_color <> '' then
    update public.calendars set color = v_color, updated_at = now(), updated_by = v_actor where owner = v_id and color is distinct from v_color;
  end if;
  return public._finish(v_start, null);
end $$;

/* ---------------- 権限（作り直した関数だけを名指しで。スキーマ全体にはかけない） ---------------- */

revoke all on function public._check_priority(text) from public, anon, authenticated;
revoke all on function public.api_create_task(jsonb) from public, anon, authenticated;
revoke all on function public._apply_status(public.tasks, text, text) from public, anon, authenticated;
revoke all on function public.api_update_task(jsonb) from public, anon, authenticated;
revoke all on function public.api_update_list(jsonb) from public, anon, authenticated;
revoke all on function public.api_save_member(jsonb) from public, anon, authenticated;
