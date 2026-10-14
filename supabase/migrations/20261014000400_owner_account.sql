-- 本部タスク: 全権限のアカウント（本部の管理用アカウント）
-- - 全権限のアカウントは、管理者のすべての操作ができる。これから権限（責任者など）を足すときも、全権限のアカウントはすべて持つようにする
-- - ほかの管理者は、全権限のアカウントを停止する・管理者から外す・取り消す・招待し直す・パスワード再設定のリンクを作る ことができない
--   （リンクを作った人がパスワードを決めて乗っ取るのを防ぐ。全権限のアカウントのパスワード再設定は、本人だけができる）
-- - 全権限は管理画面からは付け外しできない（データベースで直接決める）

alter table public.app_access
  add column is_owner boolean not null default false,
  add constraint app_access_owner_check check (not is_owner or (is_admin and status in ('invited', 'active')));

-- 管理者の操作ができるか（全権限のアカウントは、いつでもできる）
create function public._is_admin(a public.app_access) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(a.is_owner, false) or coalesce(a.is_admin, false)
$$;

-- 全権限のアカウントに対する操作は、本人だけができる（p_allow_self = false なら本人もできない）
create function public._owner_guard(p_email text, p_allow_self boolean) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from public.app_access where email = p_email and is_owner)
     and not (p_allow_self and p_email = (public._account()).email) then
    raise exception '全権限のアカウントには、この操作はできません';
  end if;
end $$;

/* ---------------- 画面からの入り口 ---------------- */

create or replace function public.api_call(p_fn text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.app_access; v_out jsonb; v_actor text;
begin
  a := public._account();
  if p_fn is null or p_fn !~ '^api_[a-z_]+$' or p_fn = 'api_call' or not exists (
    select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = p_fn and pg_get_function_identity_arguments(oid) = 'p jsonb'
  ) then
    raise exception '不明な操作です';
  end if;
  if (p_fn like 'api_admin_%' or p_fn in ('api_save_member', 'api_save_config', 'api_request_test_mail')) and not public._is_admin(a) then
    raise exception 'この操作は管理者だけができます';
  end if;
  if p_fn like 'api_admin_%' and public._login_age() > 8 * 3600 then
    raise exception '管理画面にもう一度ログインしてください';
  end if;
  p := coalesce(p, '{}'::jsonb);
  if a.member_id is not null then
    -- 個人のアカウントは、操作した人＝本人
    p := p || jsonb_build_object('actor', a.member_id);
  else
    -- 共有のアカウントは、端末で選んだ人（メンバーにいる人だけ）
    v_actor := coalesce(p ->> 'actor', '');
    if v_actor <> '' and not exists (select 1 from public.members where id = v_actor) then
      p := p || jsonb_build_object('actor', '');
    end if;
  end if;
  execute format('select public.%I($1)', p_fn) into v_out using p;
  return v_out;
end $$;

create or replace function public.api_me(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.app_access := public._account();
begin
  return jsonb_build_object(
    'email', a.email, 'memberId', coalesce(a.member_id, ''), 'isAdmin', public._is_admin(a), 'isOwner', a.is_owner,
    'kind', case when a.member_id is null then 'shared' else 'personal' end,
    'name', coalesce((select name from public.members where id = a.member_id), ''),
    'loginAge', public._login_age());
end $$;

/* ---------------- 管理画面 ---------------- */

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
        'lastSignInAt', (select u.last_sign_in_at from auth.users u where lower(u.email) = a.email limit 1),
        'link', (select jsonb_build_object('kind', i.kind, 'createdAt', i.created_at, 'expiresAt', i.expires_at,
                   'expired', i.expires_at < now(), 'mailStatus', i.mail_status, 'mailAt', i.mail_at, 'mailError', i.mail_error)
                 from public.invitations i where i.email = a.email and i.used_at is null and i.revoked_at is null
                 order by i.created_at desc limit 1))
        order by a.is_owner desc, (a.member_id is not null), m.sort_order, a.created_at)
      from public.app_access a left join public.members m on m.id = a.member_id where a.status <> 'cancelled'), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'email', m.email, 'active', m.active,
        'hasAccount', exists (select 1 from public.app_access a where a.member_id = m.id)) order by m.active desc, m.sort_order)
      from public.members m), '[]'::jsonb),
    'relaySeenAt', public._state('relay_seen_at'));
end $$;

create or replace function public.api_admin_reinvite(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.app_access; v_email text := lower(btrim(coalesce(p ->> 'email', '')));
begin
  perform public._guard(true);
  select * into a from public.app_access where email = v_email;
  if not found then raise exception 'アカウントが見つかりません。画面を読み込み直してください'; end if;
  perform public._owner_guard(v_email, false);
  if a.status <> 'invited' then raise exception '招待中のアカウントではありません（パスワードを忘れたときは「パスワード再設定」）'; end if;
  return jsonb_build_object('link', public._issue_link(v_email, 'invite', coalesce(p ->> 'actor', '')));
end $$;

create or replace function public.api_admin_reset(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.app_access; v_email text := lower(btrim(coalesce(p ->> 'email', '')));
begin
  perform public._guard(true);
  select * into a from public.app_access where email = v_email;
  if not found then raise exception 'アカウントが見つかりません。画面を読み込み直してください'; end if;
  perform public._owner_guard(v_email, true);
  if a.status <> 'active' then raise exception '使用中のアカウントではありません'; end if;
  return jsonb_build_object('link', public._issue_link(v_email, 'reset', coalesce(p ->> 'actor', '')));
end $$;

create or replace function public.api_admin_cancel(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.app_access; v_email text := lower(btrim(coalesce(p ->> 'email', '')));
begin
  perform public._guard(true);
  select * into a from public.app_access where email = v_email for update;
  if not found then raise exception 'アカウントが見つかりません。画面を読み込み直してください'; end if;
  perform public._owner_guard(v_email, false);
  if a.status <> 'invited' or a.activated_at is not null then raise exception '使い始めたアカウントは取り消せません。「停止」を使ってください'; end if;
  if a.is_admin and public._admin_count(a.email) = 0 then raise exception 'ほかに管理者がいなくなるため、取り消せません'; end if;
  update public.invitations set revoked_at = now(), pending_token = null where email = v_email and used_at is null and revoked_at is null;
  update public.app_access set status = 'cancelled', member_id = null, is_admin = false, updated_at = now(), updated_by = coalesce(p ->> 'actor', '')
  where email = v_email;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.api_admin_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a public.app_access; me public.app_access := public._account(); v_actor text := coalesce(p ->> 'actor', '');
  v_email text := lower(btrim(coalesce(p ->> 'email', ''))); v_admin boolean := (p ->> 'isAdmin')::boolean; v_status text := p ->> 'status';
begin
  perform public._guard(true);
  select * into a from public.app_access where email = v_email and status <> 'cancelled' for update;
  if not found then raise exception 'アカウントが見つかりません。画面を読み込み直してください'; end if;
  if v_status is not null and v_status not in ('active', 'stopped') then raise exception '状態の指定が正しくありません'; end if;
  if a.is_owner and (v_status = 'stopped' or v_admin = false) then
    raise exception '全権限のアカウントは、停止したり管理者から外したりできません';
  end if;
  if (v_status = 'stopped' or v_admin = false) and a.email = me.email then
    raise exception '自分のアカウントは、停止したり管理者から外したりできません（ほかの管理者に頼んでください）';
  end if;
  if a.is_admin and (v_status = 'stopped' or v_admin = false) and public._admin_count(a.email) = 0 then
    raise exception 'ほかに管理者がいなくなるため、できません';
  end if;
  if v_status = 'stopped' then
    update public.invitations set revoked_at = now(), pending_token = null where email = v_email and used_at is null and revoked_at is null;
  end if;
  update public.app_access set
    is_admin = coalesce(v_admin, is_admin),
    status = case when v_status = 'stopped' then 'stopped'
                  when v_status = 'active' then (case when activated_at is null then 'invited' else 'active' end)
                  else status end,
    updated_at = now(), updated_by = v_actor
  where email = v_email;
  return jsonb_build_object('ok', true);
end $$;

/* ---------------- 権限 ---------------- */

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.has_access() to authenticated;
grant execute on function public.api_call(text, jsonb) to authenticated;
grant execute on function public._invite_lookup(text), public._invite_complete(text) to service_role;
