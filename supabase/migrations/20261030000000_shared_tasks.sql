-- 本部タスク: 共有タスク（1つのタスクに担当者を2人以上）
-- - tasks.assignees = 担当者全員（並び順のまま。1人目が tasks.assignee）。担当者が1人なら今までと同じ
-- - 誰か1人が完了にすると完了（status は1つのまま）。主担当は決めない（全員同じ扱い）
-- - tasks.unacked = 頼まれて、まだ開いていない担当者。担当者ごとに「新着」を出し、頼んだ人には「○/○人 確認済み」を出す
--   ack_at は「全員が見た」日時（古い画面のため。unacked が空になったときに入る）
-- - 担当者を1人だけ送ってくる古い画面からの変更は、1人目だけを入れかえる（ほかの担当者はそのまま）
-- - 消せるのは、今までどおり頼んだ人と管理者だけ（自分で作ったタスクでも、ほかの人が担当に入っていれば「頼んだタスク」）
-- - 担当者は全員、タスクと同じ会社の人だけ
-- - 共有のデータベース（ホームと同じ）なので、権限は本部タスクの関数だけを名指しで外す

alter table public.tasks add column assignees text[] not null default '{}';
alter table public.tasks add column unacked text[] not null default '{}';

update public.tasks set assignees = array[assignee] where assignee is not null and cardinality(assignees) = 0;
update public.tasks set unacked = array[assignee] where assignee is not null and ack_at is null and parent_id is null and deleted_at is null;

-- 上で書き換えた行を、画面の読み込みに出す
select public._commit_rev();

create index tasks_assignees_idx on public.tasks using gin (assignees);

/* ---------------- 担当者の並びをそろえる（assignee は1人目） ---------------- */

create function public._task_assignees() returns trigger
language plpgsql set search_path = public as $$
declare v text[];
begin
  if tg_op = 'UPDATE' and new.assignees is not distinct from old.assignees and new.assignee is distinct from old.assignee then
    -- 担当者を1人だけ送ってくる古い画面: 1人目を入れかえ、ほかの担当者はそのまま
    v := case when new.assignee is null then '{}'::text[]
              else array[new.assignee] || array(select x from unnest(old.assignees) x where x is distinct from old.assignee and x <> new.assignee) end;
  else
    v := coalesce(new.assignees, '{}');
    if cardinality(v) = 0 and new.assignee is not null and (tg_op = 'INSERT' or new.assignee is distinct from old.assignee) then
      v := array[new.assignee];
    end if;
  end if;
  -- 重ねない・空を除く（順番はそのまま）
  select coalesce(array_agg(y order by i), '{}') into v
  from (select y, min(i) as i from unnest(v) with ordinality as u(y, i) where coalesce(y, '') <> '' group by y) s;
  new.assignees := v;
  new.assignee := v[1];
  return new;
end $$;

-- 名前の順で、ほかのトリガー（tasks_ack・会社の決まり）より先に動く
create trigger tasks_a0_assignees before insert or update on public.tasks for each row execute function public._task_assignees();

/* ---------------- 担当者ごとの「まだ見ていない」 ---------------- */

create or replace function public._task_ack() returns trigger
language plpgsql set search_path = public as $$
declare v_by text := coalesce(new.updated_by, ''); v_from text := coalesce(new.created_by, ''); v text[];
begin
  if new.parent_id is not null then
    v := '{}';
  elsif tg_op = 'INSERT' then
    -- 自分で作った自分の分・作った人がわからないもの・最初から見たことにしてあるもの（繰り返しの次の回）は、見たことにする
    v := case when v_from = '' or new.ack_at is not null then '{}'::text[]
              else array(select x from unnest(new.assignees) x where x <> v_from and x <> v_by) end;
  else
    -- 前の「まだ見ていない人」（開いて外した分はそのまま）から、担当でなくなった人を外し、ほかの人が新しく担当にした人を足す
    v := case when new.unacked is distinct from old.unacked then new.unacked else old.unacked end;
    v := array(select x from unnest(v) x where x = any (new.assignees))
      || array(select x from unnest(new.assignees) x
               where not (x = any (old.assignees)) and x <> v_from and x <> v_by and not (x = any (v)));
    -- 担当の人が中身を変えたら（完了・最新状況など）、その人は見たことにする
    if new.version > old.version then v := array_remove(v, v_by); end if;
  end if;
  new.unacked := coalesce(v, '{}');
  new.ack_at := case when cardinality(new.unacked) = 0 then coalesce(new.ack_at, now()) end;
  return new;
end $$;

-- 担当の人が、届いたタスクを見たことにする（開いたとき）。ほかの担当者の分は変えない
create or replace function public.api_ack_tasks(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_ids text[];
begin
  perform public._guard(true);
  v_start := public._last_rev();
  if jsonb_typeof(p -> 'ids') is distinct from 'array' or jsonb_array_length(p -> 'ids') > 500 then
    raise exception 'IDが正しくありません';
  end if;
  select coalesce(array_agg(x), '{}') into v_ids from jsonb_array_elements_text(p -> 'ids') as x;
  if v_actor <> '' then
    update public.tasks set unacked = array_remove(unacked, v_actor)
    where id = any (v_ids) and v_actor = any (unacked) and deleted_at is null;
  end if;
  return public._finish(v_start, null);
end $$;

/* ---------------- 担当者は、そのタスクと同じ会社の人だけ（全員） ---------------- */

create or replace function public._company_assignee() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' or new.assignees is distinct from old.assignees or new.assignee is distinct from old.assignee)
     and exists (select 1 from public.members m where m.id = any (new.assignees) and m.company_id is distinct from new.company_id) then
    raise exception '担当者は、同じ会社（所属）の人だけ選べます';
  end if;
  return new;
end $$;

create trigger tasks_co4_assignees before update of assignees on public.tasks for each row execute function public._company_assignee();

/* ---------------- 消せる人（ほかの人が担当に入っていれば「頼んだタスク」） ---------------- */

create or replace function public._can_delete_task(t public.tasks, p_actor text, p_admin boolean) returns boolean
language sql immutable set search_path = public as $$
  select t.parent_id is not null
      or coalesce(t.created_by, '') = ''
      or (t.created_by = coalesce(t.assignee, '') and cardinality(t.assignees) <= 1)
      or t.created_by = coalesce(p_actor, '')
      or coalesce(p_admin, false)
$$;

/* ---------------- 担当者の受け取り（画面から） ---------------- */

-- 担当者の並び（JSON の配列）を確かめる。重ねない・空を除く・20人まで・メンバーにいる人だけ
create function public._check_assignees(p jsonb) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare v text[]; x text;
begin
  if jsonb_typeof(p) is distinct from 'array' then raise exception '担当者の指定が正しくありません'; end if;
  select coalesce(array_agg(y order by i), '{}') into v
  from (select y, min(i) as i from (select btrim(e) as y, i from jsonb_array_elements_text(p) with ordinality as a(e, i)) b
        where y <> '' group by y) s;
  if cardinality(v) > 20 then raise exception '担当者は20人までです'; end if;
  foreach x in array v loop perform public._check_member(x); end loop;
  return v;
end $$;

create or replace function public.api_create_task(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); t jsonb := coalesce(p -> 'task', '{}'::jsonb);
  v_id text; v_parent public.tasks; v_list text; v_title text; v_assignee text; v_assignees text[] := '{}';
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
  -- 担当者: 新しい画面は assignees（全員）、古い画面は assignee（1人）
  if jsonb_typeof(t -> 'assignees') = 'array' then v_assignees := public._check_assignees(t -> 'assignees'); end if;
  if cardinality(v_assignees) = 0 then
    v_assignee := nullif(btrim(coalesce(t ->> 'assignee', '')), '');
    if v_assignee is not null then v_assignees := array[public._check_member(v_assignee)]; end if;
  end if;
  if v_parent.id is not null then v_assignees := v_assignees[1:1]; end if; -- サブタスクの担当は1人まで
  v_assignee := v_assignees[1];
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
    -- 優先度は必ず選ぶ（画面が必ず送る）。優先度を送ってこない古い画面からの登録だけは「中」にする
    v_priority := case when t ? 'priority' then public._check_priority(t ->> 'priority') else 'mid' end;
    if v_due is null and not (v_repeat <> '' and v_do is not null) then
      raise exception '期限（いつまでに）を選んでください（繰り返しのタスクは「いつやる」を決めれば期限なしにできます）';
    end if;
  end if;
  insert into public.tasks (id, list_id, parent_id, title, details, assignee, assignees, do_date, do_time, due, due_time, repeat,
                            starred, starred_at, sort_order, created_by, updated_by, priority)
  values (v_id, v_list, v_parent.id, v_title, left(coalesce(t ->> 'details', ''), 5000), v_assignee, v_assignees, v_do, v_do_time, v_due, v_time, v_repeat,
          v_starred, case when v_starred then now() end,
          case when jsonb_typeof(t -> 'sortOrder') = 'number' then (t ->> 'sortOrder')::double precision else 0 end,
          v_actor, v_actor, v_priority);
  perform public._hist(v_id, 'create', '', '', v_title, v_actor);
  return public._finish(v_start, null);
end $$;

-- 完了にしたとき・戻したときの後始末（繰り返しの次の回も、担当者全員・優先度を引き継ぐ。みんなが見ていれば次の回も見たことにする）
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
        insert into public.tasks (id, list_id, title, details, assignee, assignees, do_date, do_time, due, due_time, repeat, repeat_index,
                                  starred, starred_at, sort_order, created_by, updated_by, priority, ack_at)
        values (v_next, t.list_id, t.title, t.details, t.assignee, t.assignees, t.do_date + v_shift, t.do_time, t.due + v_shift, t.due_time, t.repeat, v_next_index,
                t.starred, case when t.starred then now() end, t.sort_order, coalesce(nullif(t.created_by, ''), p_actor), p_actor, t.priority,
                case when cardinality(t.unacked) = 0 then now() end);
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
  if v_patch ? 'assignees' and v_top then
    -- 新しい画面: 担当者全員
    t.assignees := public._check_assignees(v_patch -> 'assignees');
    if cardinality(t.assignees) = 0 then raise exception '担当者（誰が）は空にできません'; end if;
    t.assignee := t.assignees[1];
  elsif v_patch ? 'assignee' then
    -- 古い画面・サブタスク: 1人（共有タスクなら1人目を入れかえる。ほかの担当者はトリガーが残す）
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

  if (t.title, t.details, t.assignee, t.assignees, t.due, t.due_time, t.do_date, t.do_time, t.repeat, t.starred, t.status, t.sort_order, t.list_id, t.priority)
     is not distinct from (b.title, b.details, b.assignee, b.assignees, b.due, b.due_time, b.do_date, b.do_time, b.repeat, b.starred, b.status, b.sort_order, b.list_id, b.priority) then
    return jsonb_build_object('rev', public._commit_rev(), 'lists', '[]'::jsonb, 'members', '[]'::jsonb,
      'tasks', jsonb_build_array(public._camel(to_jsonb(b))), 'merged', v_merged, 'mergedBy', v_merged_by);
  end if;

  if t.status <> b.status then t := public._apply_status(t, b.status, v_actor); end if;
  update public.tasks set
    list_id = t.list_id, title = t.title, details = t.details, assignee = t.assignee, assignees = t.assignees, due = t.due, due_time = t.due_time,
    do_date = t.do_date, do_time = t.do_time, repeat = t.repeat, repeat_index = t.repeat_index,
    starred = t.starred, starred_at = t.starred_at, status = t.status, sort_order = t.sort_order, priority = t.priority,
    completed_at = t.completed_at, completed_by = t.completed_by, on_time = t.on_time, next_id = t.next_id,
    version = b.version + 1, updated_at = now(), updated_by = v_actor
  where id = t.id
  returning * into t;

  if t.title is distinct from b.title then perform public._hist(t.id, 'update', 'title', b.title, t.title, v_actor); end if;
  if t.assignees is distinct from b.assignees then
    perform public._hist(t.id, 'update', 'assignees', array_to_string(b.assignees, ','), array_to_string(t.assignees, ','), v_actor);
  end if;
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

-- ごみ箱にも担当者全員を出す
create or replace function public.api_trash(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._guard(false);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'parentTitle', coalesce(pt.title, ''),
      'listName', coalesce(l.name, ''), 'listDeleted', l.id is null or l.deleted_at is not null,
      'assignee', t.assignee, 'assignees', t.assignees, 'due', t.due, 'status', t.status, 'deletedAt', t.deleted_at, 'deletedBy', t.deleted_by)
      order by t.deleted_at desc)
    from public.tasks t
    left join public.tasks pt on pt.id = t.parent_id
    left join public.lists l on l.id = t.list_id
    where t.deleted_at is not null and t.deleted_at >= now() - interval '30 days' and t.company_id = any (public._my_companies())
      and (t.parent_id is null or (pt.id is not null and pt.deleted_at is null))), '[]'::jsonb));
end $$;

/* ---------------- 権限（本部タスクの関数だけを名指しで。スキーマ全体にはかけない） ---------------- */

revoke all on function public._task_assignees() from public, anon, authenticated;
revoke all on function public._task_ack() from public, anon, authenticated;
revoke all on function public.api_ack_tasks(jsonb) from public, anon, authenticated;
revoke all on function public._company_assignee() from public, anon, authenticated;
revoke all on function public._can_delete_task(public.tasks, text, boolean) from public, anon, authenticated;
revoke all on function public._check_assignees(jsonb) from public, anon, authenticated;
revoke all on function public.api_create_task(jsonb) from public, anon, authenticated;
revoke all on function public._apply_status(public.tasks, text, text) from public, anon, authenticated;
revoke all on function public.api_update_task(jsonb) from public, anon, authenticated;
revoke all on function public.api_trash(jsonb) from public, anon, authenticated;
