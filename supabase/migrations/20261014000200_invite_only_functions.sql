-- 本部タスク: アカウントは招待制にする（2/3: 画面からの入り口 api_call・管理画面の操作・リンクの処理・権限）

/* ---------------- 取り消した招待は、消さずに「取り消し済み」として残す ---------------- */

alter table public.app_access drop constraint app_access_status_check,
  add constraint app_access_status_check check (status in ('invited', 'active', 'stopped', 'cancelled'));

/* ---------------- 小さな道具 ---------------- */

create or replace function public.has_access() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_access a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', '')) and a.status = 'active'
  )
$$;

create or replace function public._guard(p_write boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_access() then
    raise exception 'このアカウントは使えません。招待されたアカウントでログインしてください（止められているときは、管理者に連絡してください）';
  end if;
  if p_write then
    perform pg_advisory_xact_lock(4242);
  end if;
end $$;

-- ログインしているアカウント（使用中のものだけ）
create function public._account() returns public.app_access
language plpgsql stable security definer set search_path = public as $$
declare a public.app_access;
begin
  select * into a from public.app_access where email = lower(coalesce(auth.jwt() ->> 'email', '')) and status = 'active';
  if not found then
    raise exception 'このアカウントは使えません。招待されたアカウントでログインしてください（止められているときは、管理者に連絡してください）';
  end if;
  return a;
end $$;

-- パスワードなどでログインしてから何秒たったか（ログインの記録がなければとても大きな数）
create function public._login_age() returns bigint
language sql stable set search_path = public as $$
  select extract(epoch from now())::bigint - coalesce((
    select max((x ->> 'timestamp')::bigint)
    from jsonb_array_elements(case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]'::jsonb end) x
    where x ->> 'method' in ('password', 'otp', 'totp', 'recovery', 'invite', 'magiclink')
  ), 0)
$$;

create function public._token_hash(p text) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

-- リンクに入れる合言葉（推測できない 32 バイト。URL に使える文字だけ）
create function public._new_token() returns text
language sql volatile set search_path = public as $$
  select translate(encode(extensions.gen_random_bytes(32), 'base64'), E'+/=\n', '-_')
$$;

-- 招待・パスワード再設定のリンクを作る（同じアドレスの古いリンクは使えなくする）
create function public._issue_link(p_email text, p_kind text, p_actor text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_token text := public._new_token(); v_exp timestamptz;
begin
  update public.invitations set revoked_at = now(), pending_token = null
  where email = p_email and used_at is null and revoked_at is null;
  v_exp := now() + case when p_kind = 'invite' then interval '7 days' else interval '24 hours' end;
  insert into public.invitations (id, email, kind, token_hash, pending_token, expires_at, created_by)
  values (public._new_id(), p_email, p_kind, public._token_hash(v_token), v_token, v_exp, coalesce(p_actor, ''));
  return jsonb_build_object('token', v_token, 'kind', p_kind, 'email', p_email, 'expiresAt', v_exp);
end $$;

create function public._admin_count(p_except text) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.app_access where is_admin and status = 'active' and email <> coalesce(p_except, '')
$$;

/* ---------------- 画面からの入り口（すべての操作はここを通る） ---------------- */

create function public.api_call(p_fn text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.app_access; v_out jsonb; v_actor text;
begin
  a := public._account();
  if p_fn is null or p_fn !~ '^api_[a-z_]+$' or p_fn = 'api_call' or not exists (
    select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = p_fn and pg_get_function_identity_arguments(oid) = 'p jsonb'
  ) then
    raise exception '不明な操作です';
  end if;
  if (p_fn like 'api_admin_%' or p_fn in ('api_save_member', 'api_save_config', 'api_request_test_mail')) and not a.is_admin then
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

-- ログインしている自分のこと
create function public.api_me(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a public.app_access := public._account();
begin
  return jsonb_build_object(
    'email', a.email, 'memberId', coalesce(a.member_id, ''), 'isAdmin', a.is_admin,
    'kind', case when a.member_id is null then 'shared' else 'personal' end,
    'name', coalesce((select name from public.members where id = a.member_id), ''),
    'loginAge', public._login_age());
end $$;

/* ---------------- 管理画面（管理者だけ。api_call が確かめる） ---------------- */

create function public.api_admin_accounts(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._guard(false);
  return jsonb_build_object(
    'me', (public._account()).email,
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'email', a.email, 'memberId', coalesce(a.member_id, ''), 'name', coalesce(m.name, ''), 'memberActive', coalesce(m.active, true),
        'kind', case when a.member_id is null then 'shared' else 'personal' end,
        'isAdmin', a.is_admin, 'status', a.status, 'createdAt', a.created_at, 'activatedAt', a.activated_at,
        'lastSignInAt', (select u.last_sign_in_at from auth.users u where lower(u.email) = a.email limit 1),
        'link', (select jsonb_build_object('kind', i.kind, 'createdAt', i.created_at, 'expiresAt', i.expires_at,
                   'expired', i.expires_at < now(), 'mailStatus', i.mail_status, 'mailAt', i.mail_at, 'mailError', i.mail_error)
                 from public.invitations i where i.email = a.email and i.used_at is null and i.revoked_at is null
                 order by i.created_at desc limit 1))
        order by (a.member_id is not null), m.sort_order, a.created_at)
      from public.app_access a left join public.members m on m.id = a.member_id where a.status <> 'cancelled'), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'email', m.email, 'active', m.active,
        'hasAccount', exists (select 1 from public.app_access a where a.member_id = m.id)) order by m.active desc, m.sort_order)
      from public.members m), '[]'::jsonb),
    'relaySeenAt', public._state('relay_seen_at'));
end $$;

-- 招待する（メンバーがいなければ作る）。リンクは画面に返し、メールでも送る（送信用 GAS が動いていれば1分以内）
create function public.api_admin_invite(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', '');
  v_email text := lower(btrim(coalesce(p ->> 'email', ''))); v_name text := left(btrim(coalesce(p ->> 'name', '')), 50);
  v_mid text := nullif(btrim(coalesce(p ->> 'memberId', '')), ''); ex public.app_access; m public.members; v_link jsonb;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(v_email) > 200 then raise exception 'メールアドレスの形が正しくありません'; end if;
  select * into ex from public.app_access where email = v_email;
  if found and ex.status <> 'cancelled' then
    if ex.status = 'invited' then raise exception 'このアドレスは招待中です。一覧の「招待を送り直す」を使ってください'; end if;
    raise exception 'このアドレスは、もうアカウントがあります';
  end if;
  if v_mid is not null then
    select * into m from public.members where id = v_mid;
    if not found then raise exception 'メンバーが見つかりません。画面を読み込み直してください'; end if;
  else
    select * into m from public.members where lower(email) = v_email and not exists (select 1 from public.app_access a where a.member_id = members.id)
    order by active desc, sort_order limit 1;
    if not found then
      if v_name = '' then raise exception '名前を入れてください'; end if;
      if exists (select 1 from public.members where active and name = v_name) then
        raise exception '同じ名前のメンバーがいます。下の「アカウントのないメンバー」から招待してください';
      end if;
      v_mid := public._new_id();
      perform public.api_save_member(jsonb_build_object('actor', v_actor,
        'member', jsonb_build_object('id', v_mid, 'name', v_name, 'email', v_email, 'active', true)));
      select * into m from public.members where id = v_mid;
    end if;
  end if;
  if exists (select 1 from public.app_access where member_id = m.id) then raise exception 'このメンバーには、もうアカウントがあります'; end if;
  update public.members set email = v_email, active = true, updated_at = now() where id = m.id and (email <> v_email or not active);
  insert into public.app_access (email, member_id, is_admin, status, created_by, updated_by)
  values (v_email, m.id, coalesce((p ->> 'isAdmin')::boolean, false), 'invited', v_actor, v_actor)
  on conflict (email) do update set member_id = excluded.member_id, is_admin = excluded.is_admin, status = 'invited',
    activated_at = null, created_at = now(), created_by = excluded.created_by, updated_at = now(), updated_by = excluded.updated_by;
  v_link := public._issue_link(v_email, 'invite', v_actor);
  return public._finish(v_start, jsonb_build_object('link', v_link));
end $$;

-- 招待のリンクを作り直す（前のリンクは使えなくなる）
create function public.api_admin_reinvite(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.app_access; v_email text := lower(btrim(coalesce(p ->> 'email', '')));
begin
  perform public._guard(true);
  select * into a from public.app_access where email = v_email;
  if not found then raise exception 'アカウントが見つかりません。画面を読み込み直してください'; end if;
  if a.status <> 'invited' then raise exception '招待中のアカウントではありません（パスワードを忘れたときは「パスワード再設定」）'; end if;
  return jsonb_build_object('link', public._issue_link(v_email, 'invite', coalesce(p ->> 'actor', '')));
end $$;

-- パスワード再設定のリンクを作る（24時間だけ使える）
create function public.api_admin_reset(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.app_access; v_email text := lower(btrim(coalesce(p ->> 'email', '')));
begin
  perform public._guard(true);
  select * into a from public.app_access where email = v_email;
  if not found then raise exception 'アカウントが見つかりません。画面を読み込み直してください'; end if;
  if a.status <> 'active' then raise exception '使用中のアカウントではありません'; end if;
  return jsonb_build_object('link', public._issue_link(v_email, 'reset', coalesce(p ->> 'actor', '')));
end $$;

-- 招待を取り消す（まだ使い始めていないアカウントだけ。メンバーは残り、同じアドレスをあとでまた招待できる）
create function public.api_admin_cancel(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.app_access; v_email text := lower(btrim(coalesce(p ->> 'email', '')));
begin
  perform public._guard(true);
  select * into a from public.app_access where email = v_email for update;
  if not found then raise exception 'アカウントが見つかりません。画面を読み込み直してください'; end if;
  if a.status <> 'invited' or a.activated_at is not null then raise exception '使い始めたアカウントは取り消せません。「停止」を使ってください'; end if;
  if a.is_admin and public._admin_count(a.email) = 0 then raise exception 'ほかに管理者がいなくなるため、取り消せません'; end if;
  update public.invitations set revoked_at = now(), pending_token = null where email = v_email and used_at is null and revoked_at is null;
  update public.app_access set status = 'cancelled', member_id = null, is_admin = false, updated_at = now(), updated_by = coalesce(p ->> 'actor', '')
  where email = v_email;
  return jsonb_build_object('ok', true);
end $$;

-- 管理者にする・外す、停止する・再開する
create function public.api_admin_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a public.app_access; me public.app_access := public._account(); v_actor text := coalesce(p ->> 'actor', '');
  v_email text := lower(btrim(coalesce(p ->> 'email', ''))); v_admin boolean := (p ->> 'isAdmin')::boolean; v_status text := p ->> 'status';
begin
  perform public._guard(true);
  select * into a from public.app_access where email = v_email and status <> 'cancelled' for update;
  if not found then raise exception 'アカウントが見つかりません。画面を読み込み直してください'; end if;
  if v_status is not null and v_status not in ('active', 'stopped') then raise exception '状態の指定が正しくありません'; end if;
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

/* ---------------- リンクを開いた人（Edge Function「account」から。管理用の鍵でだけ呼べる） ---------------- */

create function public._invite_lookup(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i public.invitations; a public.app_access; v_user uuid;
begin
  select * into i from public.invitations where token_hash = public._token_hash(p_token);
  if not found then return jsonb_build_object('ok', false, 'error', 'このリンクは使えません。管理者に新しいリンクを頼んでください'); end if;
  if i.used_at is not null then return jsonb_build_object('ok', false, 'error', 'このリンクは、もう使われています。ログイン画面から入ってください'); end if;
  if i.revoked_at is not null then return jsonb_build_object('ok', false, 'error', 'このリンクは取り消されています。いちばん新しいリンク（メール）を使うか、管理者に頼んでください'); end if;
  if i.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'このリンクは期限が切れています。管理者に新しいリンクを頼んでください'); end if;
  select * into a from public.app_access where email = i.email;
  if not found or a.status in ('stopped', 'cancelled') or (i.kind = 'reset' and a.status <> 'active') then
    return jsonb_build_object('ok', false, 'error', 'このアカウントは使えません。管理者に連絡してください');
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = i.email limit 1;
  return jsonb_build_object('ok', true, 'email', i.email, 'kind', i.kind, 'expiresAt', i.expires_at, 'userId', v_user,
    'name', coalesce((select name from public.members where id = a.member_id), ''));
end $$;

create function public._invite_complete(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i public.invitations;
begin
  select * into i from public.invitations where token_hash = public._token_hash(p_token) for update;
  if not found or i.used_at is not null or i.revoked_at is not null or i.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'このリンクは使えません');
  end if;
  update public.invitations set used_at = now(), pending_token = null where id = i.id;
  update public.app_access set status = 'active', activated_at = coalesce(activated_at, now()), updated_at = now()
  where email = i.email and status = 'invited';
  return jsonb_build_object('ok', true, 'email', i.email);
end $$;

/* ---------------- 権限 ---------------- */

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.has_access() to authenticated;
grant execute on function public.api_call(text, jsonb) to authenticated;
grant execute on function public._invite_lookup(text), public._invite_complete(text) to service_role;
