-- 本部タスク: 頼んだタスクを消せるのは、頼んだ人と管理者だけ
-- - 「頼んだタスク」= 作った人（created_by）と担当（assignee）がちがう親タスク
-- - 担当の人は、完了・最新状況・期限の変更などはできるが、消すことはできない
-- - サブタスク（チェック項目）と、自分で作った自分のタスクは、今までどおり
-- - 「完了したタスクをすべて削除」は、消せるものだけを消す。リストの削除は、ほかの人が頼んだタスクが入っていれば管理者だけ

create function public._can_delete_task(t public.tasks, p_actor text, p_admin boolean) returns boolean
language sql immutable set search_path = public as $$
  select t.parent_id is not null
      or coalesce(t.created_by, '') = ''
      or t.created_by = coalesce(t.assignee, '')
      or t.created_by = coalesce(p_actor, '')
      or coalesce(p_admin, false)
$$;

create or replace function public.api_delete_task(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_id text := p ->> 'id'; t public.tasks;
  v_admin boolean := public._is_admin(public._account());
begin
  perform public._guard(true);
  v_start := public._last_rev();
  select * into t from public.tasks where id = v_id and deleted_at is null;
  if not found then raise exception 'このタスクは削除されています'; end if;
  if not public._can_delete_task(t, v_actor, v_admin) then
    raise exception '頼まれたタスクは、頼んだ人（%）と管理者だけが削除できます', coalesce((select name from public.members where id = t.created_by), '');
  end if;
  update public.tasks set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
  where (id = v_id or parent_id = v_id) and deleted_at is null;
  perform public._hist(v_id, 'delete', '', '', '', v_actor);
  return public._finish(v_start, null);
end $$;

create or replace function public.api_clear_completed(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_list text;
  v_admin boolean := public._is_admin(public._account());
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_list := public._active_list(p ->> 'listId');
  update public.tasks t set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
  where t.list_id = v_list and t.deleted_at is null
    and ((t.parent_id is null and t.status = 'done' and public._can_delete_task(t, v_actor, v_admin))
      or (t.parent_id is not null and (t.status = 'done' or t.parent_id in (
            select x.id from public.tasks x
            where x.list_id = v_list and x.parent_id is null and x.status = 'done' and x.deleted_at is null
              and public._can_delete_task(x, v_actor, v_admin)))));
  return public._finish(v_start, null);
end $$;

create or replace function public.api_delete_list(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_id text := p ->> 'id';
  v_admin boolean := public._is_admin(public._account());
begin
  perform public._guard(true);
  v_start := public._last_rev();
  perform public._active_list(v_id);
  if (select count(*) from public.lists where deleted_at is null) <= 1 then raise exception 'リストは最低1つ必要です'; end if;
  if exists (select 1 from public.tasks t where t.list_id = v_id and t.deleted_at is null and not public._can_delete_task(t, v_actor, v_admin)) then
    raise exception 'このリストには、ほかの人が頼んだタスクがあるため削除できません（管理者に頼んでください）';
  end if;
  update public.lists set deleted_at = now(), updated_at = now(), updated_by = v_actor where id = v_id;
  update public.tasks set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
  where list_id = v_id and deleted_at is null;
  return public._finish(v_start, null);
end $$;

/* ---------------- 権限 ---------------- */

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.has_access() to authenticated;
grant execute on function public.api_call(text, jsonb) to authenticated;
grant execute on function public._invite_lookup(text), public._invite_complete(text) to service_role;
