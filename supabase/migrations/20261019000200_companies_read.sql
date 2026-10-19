-- 本部タスク: 会社ごとの所属（2/2: 読み込みと管理画面）
-- - 読み込み（api_sync・_changes・詳細・ごみ箱・予定）を、見られる会社の分だけにする。見られる会社が変わったら全部読み直す（scope）
-- - リストは会社を選んで作る。最後の1つは会社ごと
-- - 管理画面: 会社の一覧・作成・名前・人の会社・会社の管理者

/* ---------------- 読み込み（見られる会社の分だけ） ---------------- */

-- 見られる会社が変わったかを画面が気づけるように（変わったら全部読み直す）
create function public._my_scope() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(array_to_string(array(select unnest(public._my_companies()) order by 1), ','), '')
$$;

create or replace function public._changes(p_since bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  with v as (select public._my_companies() as cos)
  select jsonb_build_object(
    'lists', coalesce((select jsonb_agg(public._camel(to_jsonb(l))) from public.lists l, v where l.rev > p_since and l.company_id = any (v.cos)), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(public._camel(to_jsonb(t))) from public.tasks t, v where t.rev > p_since and t.company_id = any (v.cos)), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(public._camel(to_jsonb(m))) from public.members m, v where m.rev > p_since and m.company_id = any (v.cos)), '[]'::jsonb),
    'calendars', coalesce((select jsonb_agg(public._camel(to_jsonb(c))) from public.calendars c, v where c.rev > p_since and c.company_id = any (v.cos)), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(public._camel(to_jsonb(e))) from public.events e, v where e.rev > p_since and e.company_id = any (v.cos)), '[]'::jsonb),
    'companies', coalesce((select jsonb_agg(public._camel(to_jsonb(co))) from public.companies co, v where co.rev > p_since and co.id = any (v.cos)), '[]'::jsonb))
$$;

create or replace function public.api_sync(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_since bigint := coalesce((p ->> 'rev')::bigint, 0);
  v_rev bigint;
  v_purge bigint;
  v_full boolean;
  v_out jsonb;
  v_cos text[] := public._my_companies();
  v_scope text := public._my_scope();
  v_scope_changed boolean := p ? 'scope' and coalesce(p ->> 'scope', '') <> v_scope;
begin
  perform public._guard(false);
  v_rev := coalesce(public._state('rev')::bigint, 0);
  if v_since > 0 and v_since = v_rev and not v_scope_changed then
    return jsonb_build_object('rev', v_rev, 'unchanged', true, 'scope', v_scope);
  end if;
  v_purge := coalesce(public._state('purge_rev')::bigint, 0);
  v_full := v_since = 0 or v_since < v_purge or v_since > v_rev or v_scope_changed;
  if v_full then
    v_out := jsonb_build_object('rev', v_rev, 'full', true, 'scope', v_scope,
      'companies', coalesce((select jsonb_agg(public._camel(to_jsonb(co))) from public.companies co where co.deleted_at is null and co.id = any (v_cos)), '[]'::jsonb),
      'lists', coalesce((select jsonb_agg(public._camel(to_jsonb(l))) from public.lists l where l.deleted_at is null and l.rev <= v_rev and l.company_id = any (v_cos)), '[]'::jsonb),
      'tasks', coalesce((select jsonb_agg(public._camel(to_jsonb(t))) from public.tasks t
                          where t.deleted_at is null and t.rev <= v_rev and t.company_id = any (v_cos)
                            and (t.status <> 'done' or t.completed_at is null or t.completed_at >= now() - interval '90 days')), '[]'::jsonb),
      'members', coalesce((select jsonb_agg(public._camel(to_jsonb(m))) from public.members m where m.rev <= v_rev and m.company_id = any (v_cos)), '[]'::jsonb),
      'calendars', coalesce((select jsonb_agg(public._camel(to_jsonb(c))) from public.calendars c where c.deleted_at is null and c.rev <= v_rev and c.company_id = any (v_cos)), '[]'::jsonb),
      -- 予定は、繰り返しと、400日前より後に終わるものだけ（それより前は、見るときに取りに行く）
      'events', coalesce((select jsonb_agg(public._camel(to_jsonb(e))) from public.events e
                           where e.deleted_at is null and e.rev <= v_rev and e.company_id = any (v_cos)
                             and (e.rrule <> '' or e.recurring_id is not null or e.end_at >= now() - interval '400 days')), '[]'::jsonb),
      'config', public._config());
  else
    v_out := jsonb_build_object('rev', v_rev, 'full', false, 'scope', v_scope,
      'companies', coalesce((select jsonb_agg(public._camel(to_jsonb(co))) from public.companies co where co.rev > v_since and co.rev <= v_rev and co.id = any (v_cos)), '[]'::jsonb),
      'lists', coalesce((select jsonb_agg(public._camel(to_jsonb(l))) from public.lists l where l.rev > v_since and l.rev <= v_rev and l.company_id = any (v_cos)), '[]'::jsonb),
      'tasks', coalesce((select jsonb_agg(public._camel(to_jsonb(t))) from public.tasks t where t.rev > v_since and t.rev <= v_rev and t.company_id = any (v_cos)), '[]'::jsonb),
      'members', coalesce((select jsonb_agg(public._camel(to_jsonb(m))) from public.members m where m.rev > v_since and m.rev <= v_rev and m.company_id = any (v_cos)), '[]'::jsonb),
      'calendars', coalesce((select jsonb_agg(public._camel(to_jsonb(c))) from public.calendars c where c.rev > v_since and c.rev <= v_rev and c.company_id = any (v_cos)), '[]'::jsonb),
      'events', coalesce((select jsonb_agg(public._camel(to_jsonb(e))) from public.events e where e.rev > v_since and e.rev <= v_rev and e.company_id = any (v_cos)), '[]'::jsonb));
    if exists (select 1 from public.settings where key = 'app' and rev > v_since) then
      v_out := v_out || jsonb_build_object('config', public._config());
    end if;
  end if;
  return v_out;
end $$;

create or replace function public.api_task_detail(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_id text := coalesce(p ->> 'id', '');
begin
  perform public._guard(false);
  if not exists (select 1 from public.tasks t where t.id = v_id and t.company_id = any (public._my_companies())) then
    return jsonb_build_object('id', v_id, 'notes', '[]'::jsonb, 'history', '[]'::jsonb);
  end if;
  return jsonb_build_object('id', v_id,
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'taskId', n.task_id, 'text', n.body, 'by', n.actor, 'at', n.created_at) order by n.created_at desc)
                         from (select * from public.task_notes where task_id = v_id order by created_at desc limit 200) n), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'taskId', h.task_id, 'action', h.action, 'field', h.field,
                           'before', h.before_value, 'after', h.after_value, 'by', h.actor, 'at', h.created_at) order by h.created_at desc, h.id desc)
                         from (select * from public.task_history where task_id = v_id order by created_at desc, id desc limit 200) h), '[]'::jsonb));
end $$;

create or replace function public.api_trash(p jsonb) returns jsonb
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
    where t.deleted_at is not null and t.deleted_at >= now() - interval '30 days' and t.company_id = any (public._my_companies())
      and (t.parent_id is null or (pt.id is not null and pt.deleted_at is null))), '[]'::jsonb));
end $$;

create or replace function public.api_events_range(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz; v_to timestamptz;
begin
  perform public._guard(false);
  v_from := public._check_ts(p ->> 'from', '期間の始め');
  v_to := public._check_ts(p ->> 'to', '期間の終わり');
  if v_to - v_from > interval '400 days' then raise exception '期間は400日までです'; end if;
  return jsonb_build_object('events', coalesce((select jsonb_agg(public._camel(to_jsonb(e))) from public.events e
    where e.deleted_at is null and e.start_at < v_to and e.end_at > v_from and e.company_id = any (public._my_companies())), '[]'::jsonb));
end $$;

create or replace function public.api_event_trash(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._guard(false);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'start', e.start_at, 'end', e.end_at, 'allDay', e.all_day,
      'rrule', e.rrule, 'calendarId', e.calendar_id, 'deletedAt', e.deleted_at, 'deletedBy', e.deleted_by) order by e.deleted_at desc)
    from public.events e
    join public.calendars c on c.id = e.calendar_id and c.deleted_at is null
    where e.deleted_at is not null and e.deleted_at >= now() - interval '30 days' and e.recurring_id is null
      and e.company_id = any (public._my_companies())), '[]'::jsonb));
end $$;

create or replace function public.api_me(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.app_access := public._account();
begin
  return jsonb_build_object(
    'email', a.email, 'memberId', coalesce(a.member_id, ''), 'isAdmin', public._is_admin(a), 'isOwner', a.is_owner,
    'kind', case when a.member_id is null then 'shared' else 'personal' end,
    'name', coalesce((select name from public.members where id = a.member_id), ''),
    'companyId', public._my_company(), 'companies', to_jsonb(public._my_companies()),
    'loginAge', public._login_age());
end $$;

/* ---------------- リスト（会社を選んで作る・最後の1つは会社ごと） ---------------- */

create or replace function public.api_create_list(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_id text; v_name text := left(btrim(coalesce(p ->> 'name', '')), 100);
  v_co text := nullif(p ->> 'companyId', '');
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_id := public._check_id(p ->> 'id');
  if v_name = '' then raise exception 'リスト名を入れてください'; end if;
  if v_co is not null and not (v_co = any (public._my_companies())) then raise exception 'この会社にはリストを作れません'; end if;
  if not exists (select 1 from public.lists where id = v_id) then
    insert into public.lists (id, name, sort_order, created_by, updated_by, company_id)
    values (v_id, v_name, coalesce((select max(sort_order) from public.lists), 0) + 1, v_actor, v_actor, coalesce(v_co, public._my_company()));
  end if;
  return public._finish(v_start, null);
end $$;

create or replace function public.api_delete_list(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_id text := p ->> 'id';
  v_admin boolean := public._is_admin(public._account()); v_co text;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  perform public._active_list(v_id);
  select company_id into v_co from public.lists where id = v_id;
  if (select count(*) from public.lists where deleted_at is null and company_id is not distinct from v_co) <= 1 then
    raise exception 'リストは会社ごとに最低1つ必要です';
  end if;
  if exists (select 1 from public.tasks t where t.list_id = v_id and t.deleted_at is null and not public._can_delete_task(t, v_actor, v_admin)) then
    raise exception 'このリストには、ほかの人が頼んだタスクがあるため削除できません（管理者に頼んでください）';
  end if;
  update public.lists set deleted_at = now(), updated_at = now(), updated_by = v_actor where id = v_id;
  update public.tasks set deleted_at = now(), deleted_by = v_actor, version = version + 1, updated_at = now(), updated_by = v_actor
  where list_id = v_id and deleted_at is null;
  return public._finish(v_start, null);
end $$;

-- 並べ替えは、見られる会社のリストだけ（ほかの会社のリストの ID が混ざっても無視する）
create or replace function public.api_reorder_lists(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); r record; v_cos text[] := public._my_companies();
begin
  perform public._guard(true);
  v_start := public._last_rev();
  for r in select value as id, ordinality as n from jsonb_array_elements_text(coalesce(p -> 'ids', '[]'::jsonb)) with ordinality loop
    update public.lists set sort_order = r.n, updated_at = now(), updated_by = v_actor
    where id = r.id and deleted_at is null and sort_order <> r.n and company_id = any (v_cos);
  end loop;
  return public._finish(v_start, null);
end $$;

/* ---------------- 管理画面（管理者だけ。api_call が確かめる） ---------------- */

create or replace function public.api_admin_accounts(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._guard(false);
  return jsonb_build_object(
    'me', (public._account()).email,
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'email', a.email, 'memberId', coalesce(a.member_id, ''), 'name', coalesce(m.name, ''), 'memberActive', coalesce(m.active, true),
        'kind', case when a.member_id is null then 'shared' else 'personal' end,
        'isAdmin', public._is_admin(a), 'isOwner', a.is_owner, 'status', a.status, 'createdAt', a.created_at, 'activatedAt', a.activated_at,
        'companyId', coalesce(m.company_id, a.company_id, public._default_company()),
        'adminCompanies', coalesce((select jsonb_agg(ca.company_id order by ca.company_id) from public.company_admins ca where ca.email = a.email and ca.revoked_at is null), '[]'::jsonb),
        'lastSignInAt', (select u.last_sign_in_at from auth.users u where lower(u.email) = a.email limit 1),
        'link', (select jsonb_build_object('kind', i.kind, 'createdAt', i.created_at, 'expiresAt', i.expires_at,
                   'expired', i.expires_at < now(), 'mailStatus', i.mail_status, 'mailAt', i.mail_at, 'mailError', i.mail_error)
                 from public.invitations i where i.email = a.email and i.used_at is null and i.revoked_at is null
                 order by i.created_at desc limit 1))
        order by a.is_owner desc, (a.member_id is not null), m.sort_order, a.created_at)
      from public.app_access a left join public.members m on m.id = a.member_id where a.status <> 'cancelled'), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'email', m.email, 'active', m.active, 'companyId', m.company_id,
        'hasAccount', exists (select 1 from public.app_access a where a.member_id = m.id)) order by m.active desc, m.sort_order)
      from public.members m), '[]'::jsonb),
    'companies', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sortOrder', c.sort_order,
        'memberCount', (select count(*) from public.members m where m.company_id = c.id and m.active)) order by c.sort_order, c.created_at)
      from public.companies c where c.deleted_at is null), '[]'::jsonb),
    'relaySeenAt', public._state('relay_seen_at'));
end $$;

-- 会社を作る・名前を変える（新しい会社には、リスト「マイタスク」を1つ作る）
create function public.api_admin_save_company(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor text := coalesce(p ->> 'actor', ''); v_id text := nullif(p ->> 'id', ''); v_name text := left(btrim(coalesce(p ->> 'name', '')), 100);
begin
  perform public._guard(true);
  perform set_config('honbu.company_bypass', 'on', true);
  if v_name = '' then raise exception '会社の名前を入れてください'; end if;
  if exists (select 1 from public.companies where name = v_name and deleted_at is null and id is distinct from v_id) then raise exception '同じ名前の会社があります'; end if;
  if v_id is null then
    v_id := 'co-' || public._new_id();
    insert into public.companies (id, name, sort_order, updated_by)
    values (v_id, v_name, coalesce((select max(sort_order) from public.companies), 0) + 1, v_actor);
    insert into public.lists (id, name, sort_order, created_by, updated_by, company_id)
    values (public._new_id(), 'マイタスク', coalesce((select max(sort_order) from public.lists), 0) + 1, v_actor, v_actor, v_id);
  else
    update public.companies set name = v_name, updated_at = now(), updated_by = v_actor where id = v_id and deleted_at is null;
    if not found then raise exception '会社が見つかりません。画面を読み込み直してください'; end if;
  end if;
  perform public._commit_rev();
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- 人（またはアカウント）の会社を変える。人の会社を変えると、その人のカレンダーと予定もついていく
create function public.api_admin_set_company(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(p ->> 'actor', ''); v_co text := p ->> 'companyId'; v_mid text := nullif(p ->> 'memberId', '');
  v_email text := lower(btrim(coalesce(p ->> 'email', '')));
begin
  perform public._guard(true);
  perform set_config('honbu.company_bypass', 'on', true);
  if not exists (select 1 from public.companies where id = v_co and deleted_at is null) then raise exception '会社が見つかりません。画面を読み込み直してください'; end if;
  if v_mid is not null then
    update public.members set company_id = v_co, updated_at = now() where id = v_mid;
    if not found then raise exception 'メンバーが見つかりません。画面を読み込み直してください'; end if;
  else
    update public.app_access set company_id = v_co, updated_at = now(), updated_by = v_actor where email = v_email and member_id is null;
    if not found then raise exception '共有のアカウントが見つかりません。画面を読み込み直してください'; end if;
  end if;
  perform public._commit_rev();
  return jsonb_build_object('ok', true);
end $$;

-- 会社の管理者にする・外す（その会社の分も見られるようになる）
create function public.api_admin_set_company_admin(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor text := coalesce(p ->> 'actor', ''); v_co text := p ->> 'companyId'; v_email text := lower(btrim(coalesce(p ->> 'email', '')));
begin
  perform public._guard(true);
  if not exists (select 1 from public.companies where id = v_co and deleted_at is null) then raise exception '会社が見つかりません。画面を読み込み直してください'; end if;
  if not exists (select 1 from public.app_access where email = v_email and status <> 'cancelled') then raise exception 'アカウントが見つかりません。画面を読み込み直してください'; end if;
  if coalesce((p ->> 'on')::boolean, false) then
    insert into public.company_admins (email, company_id, created_by) values (v_email, v_co, v_actor)
    on conflict (email, company_id) do update set revoked_at = null, created_at = now(), created_by = excluded.created_by;
  else
    update public.company_admins set revoked_at = now() where email = v_email and company_id = v_co and revoked_at is null;
  end if;
  return jsonb_build_object('ok', true);
end $$;

/* ---------------- 権限（本部タスクの関数だけを名指しで。スキーマ全体にはかけない） ---------------- */

revoke all on function public._my_scope() from public, anon, authenticated;
revoke all on function public._changes(bigint) from public, anon, authenticated;
revoke all on function public.api_sync(jsonb) from public, anon, authenticated;
revoke all on function public.api_task_detail(jsonb) from public, anon, authenticated;
revoke all on function public.api_trash(jsonb) from public, anon, authenticated;
revoke all on function public.api_events_range(jsonb) from public, anon, authenticated;
revoke all on function public.api_event_trash(jsonb) from public, anon, authenticated;
revoke all on function public.api_me(jsonb) from public, anon, authenticated;
revoke all on function public.api_create_list(jsonb) from public, anon, authenticated;
revoke all on function public.api_delete_list(jsonb) from public, anon, authenticated;
revoke all on function public.api_reorder_lists(jsonb) from public, anon, authenticated;
revoke all on function public.api_admin_accounts(jsonb) from public, anon, authenticated;
revoke all on function public.api_admin_save_company(jsonb) from public, anon, authenticated;
revoke all on function public.api_admin_set_company(jsonb) from public, anon, authenticated;
revoke all on function public.api_admin_set_company_admin(jsonb) from public, anon, authenticated;
