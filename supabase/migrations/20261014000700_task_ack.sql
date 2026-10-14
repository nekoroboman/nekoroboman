-- 本部タスク: 届いたタスクは、受け取った人が開くまで「新着」として残す
-- - ack_at = 担当の人がそのタスクを見た（開いた・さわった）日時。空なら「まだ見ていない」
-- - ほかの人が作って担当にしたとき・担当をほかの人に変えたときだけ空になる（自分で作った自分のタスク・サブタスクは最初から見たことにする）
-- - 担当の人が開く（api_ack_tasks）か、完了・最新状況などで中身を変えると「見た」になる
-- - 頼んだ人の画面には、相手がまだ見ていないあいだ「未確認」と出る
-- - これまでのタスクは、この変更の時点で見たことにする

alter table public.tasks add column ack_at timestamptz default now();
alter table public.tasks alter column ack_at drop default;

create function public._task_ack() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.ack_at is null and (new.parent_id is not null or new.assignee is null or coalesce(new.created_by, '') = ''
        or new.assignee = new.created_by or new.assignee = coalesce(new.updated_by, '')) then
      new.ack_at := now();
    end if;
  elsif new.assignee is distinct from old.assignee then
    new.ack_at := case when new.parent_id is not null or new.assignee is null
                         or new.assignee = coalesce(new.updated_by, '') or new.assignee = coalesce(new.created_by, '') then now() end;
  elsif new.ack_at is null and new.assignee = coalesce(new.updated_by, '') and new.version > old.version then
    new.ack_at := now();
  end if;
  return new;
end $$;

create trigger tasks_ack before insert or update on public.tasks for each row execute function public._task_ack();

-- 担当の人が、届いたタスクを見たことにする（開いたとき・「確認済みにする」）
create function public.api_ack_tasks(p jsonb) returns jsonb
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
    update public.tasks set ack_at = now()
    where id = any(v_ids) and assignee = v_actor and ack_at is null and deleted_at is null;
  end if;
  return public._finish(v_start, null);
end $$;

/* ---------------- 権限 ---------------- */

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.has_access() to authenticated;
grant execute on function public.api_call(text, jsonb) to authenticated;
grant execute on function public._invite_lookup(text), public._invite_complete(text) to service_role;
