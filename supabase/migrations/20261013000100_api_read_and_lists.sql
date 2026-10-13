/* ---------------- 読み込み ---------------- */

create function public.api_sync(p jsonb) returns jsonb
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
      'config', public._config());
  else
    v_out := jsonb_build_object('rev', v_rev, 'full', false,
      'lists', coalesce((select jsonb_agg(public._camel(to_jsonb(l))) from public.lists l where l.rev > v_since and l.rev <= v_rev), '[]'::jsonb),
      'tasks', coalesce((select jsonb_agg(public._camel(to_jsonb(t))) from public.tasks t where t.rev > v_since and t.rev <= v_rev), '[]'::jsonb),
      'members', coalesce((select jsonb_agg(public._camel(to_jsonb(m))) from public.members m where m.rev > v_since and m.rev <= v_rev), '[]'::jsonb));
    if exists (select 1 from public.settings where key = 'app' and rev > v_since) then
      v_out := v_out || jsonb_build_object('config', public._config());
    end if;
  end if;
  return v_out;
end $$;

create function public.api_bootstrap(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._guard(false);
  return public.api_sync('{"rev":0}'::jsonb) || jsonb_build_object('serverTime', now());
end $$;

create function public.api_task_detail(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_id text := coalesce(p ->> 'id', '');
begin
  perform public._guard(false);
  return jsonb_build_object('id', v_id,
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'taskId', n.task_id, 'text', n.body, 'by', n.actor, 'at', n.created_at) order by n.created_at desc)
                         from (select * from public.task_notes where task_id = v_id order by created_at desc limit 200) n), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'taskId', h.task_id, 'action', h.action, 'field', h.field,
                           'before', h.before_value, 'after', h.after_value, 'by', h.actor, 'at', h.created_at) order by h.created_at desc, h.id desc)
                         from (select * from public.task_history where task_id = v_id order by created_at desc, id desc limit 200) h), '[]'::jsonb));
end $$;

create function public.api_trash(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._guard(false);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'parentTitle', coalesce(pt.title, ''),
      'listName', coalesce(l.name, ''), 'listDeleted', l.id is null or l.deleted_at is not null,
      'assignee', t.assignee, 'due', t.due, 'status', t.status, 'deletedAt', t.deleted_at, 'deletedBy', t.deleted_by)
      order by t.deleted_at desc)
    from public.tasks t
    left join public.tasks pt on pt.id = t.parent_id
    left join public.lists l on l.id = t.list_id
    where t.deleted_at is not null and t.deleted_at >= now() - interval '30 days'
      and (t.parent_id is null or (pt.id is not null and pt.deleted_at is null))), '[]'::jsonb));
end $$;

/* ---------------- リスト ---------------- */

create function public.api_create_list(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_id text; v_name text := left(btrim(coalesce(p ->> 'name', '')), 100);
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_id := public._check_id(p ->> 'id');
  if v_name = '' then raise exception 'リスト名を入れてください'; end if;
  if not exists (select 1 from public.lists where id = v_id) then
    insert into public.lists (id, name, sort_order, created_by, updated_by)
    values (v_id, v_name, coalesce((select max(sort_order) from public.lists), 0) + 1, v_actor, v_actor);
  end if;
  return public._finish(v_start, null);
end $$;

create function public.api_update_list(p jsonb) returns jsonb
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
    if v_mode not in ('my', 'date', 'starred', 'title', 'assignee') then raise exception '並べ替えの指定が正しくありません'; end if;
    update public.lists set sort_mode = v_mode, updated_at = now(), updated_by = v_actor where id = v_id;
  end if;
  return public._finish(v_start, null);
end $$;

create function public.api_delete_list(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_id text := p ->> 'id';
begin
  perform public._guard(true);
  v_start := public._last_rev();
  perform public._active_list(v_id);
  if (select count(*) from public.lists where deleted_at is null) <= 1 then raise exception 'リストは最低1つ必要です'; end if;
  update public.lists set deleted_at = now(), updated_at = now(), updated_by = v_actor where id = v_id;
  update public.tasks set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
  where list_id = v_id and deleted_at is null;
  return public._finish(v_start, null);
end $$;

create function public.api_reorder_lists(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); r record;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  for r in select value as id, ordinality as n from jsonb_array_elements_text(coalesce(p -> 'ids', '[]'::jsonb)) with ordinality loop
    update public.lists set sort_order = r.n, updated_at = now(), updated_by = v_actor
    where id = r.id and deleted_at is null and sort_order <> r.n;
  end loop;
  return public._finish(v_start, null);
end $$;
