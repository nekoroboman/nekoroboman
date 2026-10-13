/* ---------------- タスク ---------------- */

create function public.api_create_task(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); t jsonb := coalesce(p -> 'task', '{}'::jsonb);
  v_id text; v_parent public.tasks; v_list text; v_title text; v_assignee text; v_due date; v_time text; v_repeat text;
  v_starred boolean := coalesce((t ->> 'starred')::boolean, false); v_existing public.tasks;
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
  if v_parent.id is null then
    if v_assignee is null then raise exception '担当者（誰が）を選んでください'; end if;
    if coalesce(t ->> 'due', '') = '' then raise exception '期限（いつまでに）を選んでください'; end if;
  end if;
  if v_assignee is not null then perform public._check_member(v_assignee); end if;
  if coalesce(t ->> 'due', '') <> '' then v_due := public._check_date(t ->> 'due'); end if;
  v_time := case when v_due is null then '' else public._check_time(t ->> 'dueTime') end;
  v_repeat := case when v_parent.id is null then public._check_repeat(t ->> 'repeat') else '' end;
  insert into public.tasks (id, list_id, parent_id, title, details, assignee, due, due_time, repeat, starred, starred_at, sort_order, created_by, updated_by)
  values (v_id, v_list, v_parent.id, v_title, left(coalesce(t ->> 'details', ''), 5000), v_assignee, v_due, v_time, v_repeat,
          v_starred, case when v_starred then now() end,
          case when jsonb_typeof(t -> 'sortOrder') = 'number' then (t ->> 'sortOrder')::double precision else 0 end,
          v_actor, v_actor);
  perform public._hist(v_id, 'create', '', '', v_title, v_actor);
  return public._finish(v_start, null);
end $$;

-- 完了にしたとき・戻したときの後始末（完了日時・サブタスク・繰り返し）
create function public._apply_status(t public.tasks, p_old text, p_actor text) returns public.tasks
language plpgsql security definer set search_path = public as $$
declare v_next text;
begin
  if t.status = 'done' and p_old <> 'done' then
    t.completed_at := now();
    t.completed_by := p_actor;
    t.on_time := case when t.due is null then null else now() <= public._due_at(t.due, t.due_time) end;
    update public.tasks set status = 'done', completed_at = now(), completed_by = p_actor,
      version = version + 1, updated_at = now(), updated_by = p_actor
    where parent_id = t.id and deleted_at is null and status <> 'done';
    if t.repeat <> '' and t.parent_id is null and t.next_id is null and t.due is not null then
      v_next := public._new_id();
      insert into public.tasks (id, list_id, title, details, assignee, due, due_time, repeat, starred, starred_at, sort_order, created_by, updated_by)
      values (v_next, t.list_id, t.title, t.details, t.assignee, public._next_due(t.due, t.repeat), t.due_time, t.repeat,
              t.starred, case when t.starred then now() end, t.sort_order, p_actor, p_actor);
      perform public._hist(v_next, 'create', 'repeat', t.id, t.title, p_actor);
      insert into public.tasks (id, list_id, parent_id, title, details, assignee, due, due_time, sort_order, created_by, updated_by)
      select public._new_id(), list_id, v_next, title, details, assignee,
             case when due is null then null else public._next_due(due, t.repeat) end, due_time, sort_order, p_actor, p_actor
      from public.tasks where parent_id = t.id and deleted_at is null;
      t.next_id := v_next;
    end if;
  elsif t.status <> 'done' and p_old = 'done' then
    t.completed_at := null;
    t.completed_by := '';
    t.on_time := null;
  end if;
  return t;
end $$;

create function public.api_update_task(p jsonb) returns jsonb
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
      if v_top then raise exception '期限（いつまでに）は空にできません'; end if;
      t.due := null;
      t.due_time := '';
    else
      t.due := public._check_date(v_patch ->> 'due');
    end if;
  end if;
  if v_patch ? 'dueTime' then t.due_time := case when t.due is null then '' else public._check_time(v_patch ->> 'dueTime') end; end if;
  if v_patch ? 'repeat' then t.repeat := case when v_top then public._check_repeat(v_patch ->> 'repeat') else '' end; end if;
  if v_patch ? 'starred' then
    t.starred := coalesce((v_patch ->> 'starred')::boolean, false);
    t.starred_at := case when t.starred then coalesce(case when b.starred then b.starred_at end, now()) else null end;
  end if;
  if v_patch ? 'status' then
    if coalesce(v_patch ->> 'status', '') not in ('todo', 'doing', 'done') then raise exception 'ステータスが正しくありません'; end if;
    t.status := v_patch ->> 'status';
  end if;
  if v_patch ? 'sortOrder' and jsonb_typeof(v_patch -> 'sortOrder') = 'number' then t.sort_order := (v_patch ->> 'sortOrder')::double precision; end if;
  if v_patch ? 'listId' and v_top and coalesce(v_patch ->> 'listId', '') <> t.list_id then
    t.list_id := public._active_list(v_patch ->> 'listId');
  end if;

  if (t.title, t.details, t.assignee, t.due, t.due_time, t.repeat, t.starred, t.status, t.sort_order, t.list_id)
     is not distinct from (b.title, b.details, b.assignee, b.due, b.due_time, b.repeat, b.starred, b.status, b.sort_order, b.list_id) then
    return jsonb_build_object('rev', public._commit_rev(), 'lists', '[]'::jsonb, 'members', '[]'::jsonb,
      'tasks', jsonb_build_array(public._camel(to_jsonb(b))), 'merged', v_merged, 'mergedBy', v_merged_by);
  end if;

  if t.status <> b.status then t := public._apply_status(t, b.status, v_actor); end if;
  update public.tasks set
    list_id = t.list_id, title = t.title, details = t.details, assignee = t.assignee, due = t.due, due_time = t.due_time,
    repeat = t.repeat, starred = t.starred, starred_at = t.starred_at, status = t.status, sort_order = t.sort_order,
    completed_at = t.completed_at, completed_by = t.completed_by, on_time = t.on_time, next_id = t.next_id,
    version = b.version + 1, updated_at = now(), updated_by = v_actor
  where id = t.id;

  if t.title is distinct from b.title then perform public._hist(t.id, 'update', 'title', b.title, t.title, v_actor); end if;
  if t.assignee is distinct from b.assignee then perform public._hist(t.id, 'update', 'assignee', b.assignee, t.assignee, v_actor); end if;
  if t.due is distinct from b.due then perform public._hist(t.id, 'update', 'due', b.due::text, t.due::text, v_actor); end if;
  if t.due_time is distinct from b.due_time then perform public._hist(t.id, 'update', 'dueTime', b.due_time, t.due_time, v_actor); end if;
  if t.status is distinct from b.status then perform public._hist(t.id, 'update', 'status', b.status, t.status, v_actor); end if;
  if t.list_id is distinct from b.list_id then perform public._hist(t.id, 'update', 'listId', b.list_id, t.list_id, v_actor); end if;
  if t.repeat is distinct from b.repeat then perform public._hist(t.id, 'update', 'repeat', b.repeat, t.repeat, v_actor); end if;

  if v_top and t.list_id <> b.list_id then
    update public.tasks set list_id = t.list_id, version = version + 1, updated_at = now(), updated_by = v_actor
    where parent_id = t.id and deleted_at is null;
  end if;
  return public._finish(v_start, jsonb_build_object('merged', v_merged, 'mergedBy', v_merged_by));
end $$;

create function public.api_delete_task(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_id text := p ->> 'id';
begin
  perform public._guard(true);
  v_start := public._last_rev();
  if not exists (select 1 from public.tasks where id = v_id and deleted_at is null) then raise exception 'このタスクは削除されています'; end if;
  update public.tasks set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
  where (id = v_id or parent_id = v_id) and deleted_at is null;
  perform public._hist(v_id, 'delete', '', '', '', v_actor);
  return public._finish(v_start, null);
end $$;

create function public.api_restore_task(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); t public.tasks; v_list text; v_deleted timestamptz;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  select * into t from public.tasks where id = p ->> 'id';
  if not found then raise exception 'このタスクは見つかりません（30日たって完全に削除された可能性があります）'; end if;
  if t.deleted_at is null then return public._finish(v_start, null); end if;
  if t.parent_id is not null and not exists (select 1 from public.tasks where id = t.parent_id and deleted_at is null) then
    raise exception '親タスクが削除されているため戻せません。先に親タスクを戻してください';
  end if;
  v_deleted := t.deleted_at;
  v_list := t.list_id;
  if not exists (select 1 from public.lists where id = v_list and deleted_at is null) then
    select id into v_list from public.lists where deleted_at is null order by sort_order limit 1;
  end if;
  update public.tasks set deleted_at = null, deleted_by = '', list_id = v_list, version = version + 1, updated_at = now(), updated_by = v_actor
  where id = t.id or (parent_id = t.id and deleted_at = v_deleted);
  perform public._hist(t.id, 'restore', '', '', '', v_actor);
  return public._finish(v_start, null);
end $$;

create function public.api_clear_completed(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_list text;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_list := public._active_list(p ->> 'listId');
  update public.tasks t set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
  where t.list_id = v_list and t.deleted_at is null
    and (t.status = 'done' or t.parent_id in (select id from public.tasks where list_id = v_list and parent_id is null and status = 'done' and deleted_at is null));
  return public._finish(v_start, null);
end $$;
