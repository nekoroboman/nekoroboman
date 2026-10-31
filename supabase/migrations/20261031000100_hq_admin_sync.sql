-- 本部タスク: 本部タスクの管理者（app_access.is_admin）を、管理システムの「アカウント管理ができる」（profiles.can_manage_accounts）にそろえる
-- （2026-10-31 ユーザーの決定。正は管理システム。全権限 is_owner は今までどおり本部タスクで持ち、全権限の人は管理者でもある）
-- - task_sync_hq_member(): 本部の人のアカウントの is_admin を can_manage_accounts に合わせる
-- - 管理システムとつながった人は、本部タスクで「管理者にする／外す」ができない（トリガー _hq_lock）
-- - 共有のデータベースなので、権限は本部タスクの関数だけを名指しで外す

create or replace function public.task_sync_hq_member(p_profile_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p record; m public.members; a public.app_access; v_co text; v_live boolean; v_name text;
begin
  if p_profile_id is null then return; end if;
  -- 会社の決まり（ログインした人の見られる会社だけ）と、下の「管理システムで変える」決まりを、この処理の間だけ通す
  perform set_config('honbu.company_bypass', 'on', true);
  perform set_config('honbu.hq_sync', 'on', true);

  select pr.id, lower(btrim(pr.email)) as email, btrim(pr.display_name) as name, pr.disabled_at, pr.is_hq, coalesce(pr.can_manage_accounts, false) as can_manage,
         pr.organization_id as org_id, o.name as org_name, o.kind::text as kind
    into p
  from public.profiles pr left join public.organizations o on o.id = pr.organization_id
  where pr.id = p_profile_id;
  v_live := p.id is not null and coalesce(p.is_hq, false) and p.disabled_at is null and coalesce(p.email, '') <> '';

  -- 本部タスクのメンバー（つないだことがあれば profile_id、はじめてならアカウントのメールアドレス → メンバーのメールアドレス）
  select * into m from public.members where profile_id = p_profile_id;
  if not found and v_live then
    select mm.* into m from public.app_access aa join public.members mm on mm.id = aa.member_id
    where aa.email = p.email and mm.profile_id is null limit 1;
    if not found then
      select * into m from public.members where lower(email) = p.email and profile_id is null order by active desc, created_at limit 1;
    end if;
  end if;

  if not v_live then
    -- 削除・無効: 使えない状態にする（タスクや記録は残す）
    if m.id is not null then
      if exists (select 1 from public.app_access where member_id = m.id and is_owner and status in ('invited', 'active')) then
        raise exception '本部タスクの全権限のアカウントは止められません（先に本部タスクで全権限を外してください）';
      end if;
      update public.app_access set status = 'stopped', updated_at = now(), updated_by = 'kanri'
      where member_id = m.id and status in ('invited', 'active');
      update public.invitations set revoked_at = now()
      where email in (select email from public.app_access where member_id = m.id) and used_at is null and revoked_at is null;
      update public.members set active = false, updated_at = now() where id = m.id and active;
      perform public._commit_rev();
    end if;
    perform set_config('honbu.hq_sync', '', true);
    perform set_config('honbu.company_bypass', '', true);
    return;
  end if;

  -- 会社: 本部（organizations）に対応する会社。まだ対応づけていなければ、同じ名前の会社を対応づける
  if p.kind in ('fc_hq', 'direct_hq') then
    select id into v_co from public.companies where organization_id = p.org_id and deleted_at is null;
    if v_co is null then
      select id into v_co from public.companies where name = p.org_name and organization_id is null and deleted_at is null limit 1;
      if v_co is not null then update public.companies set organization_id = p.org_id, updated_at = now() where id = v_co; end if;
    end if;
  end if;
  v_name := left(coalesce(nullif(p.name, ''), split_part(p.email, '@', 1)), 50);

  if m.id is null then
    insert into public.members (id, name, email, active, sort_order, company_id, profile_id)
    values ('hq-' || replace(p_profile_id::text, '-', ''), v_name, p.email, true,
            coalesce((select max(sort_order) from public.members), 0) + 1, coalesce(v_co, public._default_company()), p_profile_id)
    returning * into m;
  else
    update public.members set profile_id = p_profile_id, name = v_name, email = p.email, active = true,
      company_id = coalesce(v_co, company_id, public._default_company()), updated_at = now()
    where id = m.id
      and (profile_id, name, email, active, company_id) is distinct from (p_profile_id, v_name, p.email, true, coalesce(v_co, company_id, public._default_company()));
  end if;

  -- アカウント（ログインに使うメールアドレス）
  select * into a from public.app_access where email = p.email;
  if found then
    update public.app_access set member_id = m.id, status = 'active', activated_at = coalesce(activated_at, now()),
      is_admin = p.can_manage or is_owner, updated_at = now(), updated_by = 'kanri'
    where email = p.email and (member_id is distinct from m.id or status <> 'active' or is_admin is distinct from (p.can_manage or is_owner));
  else
    -- メールアドレスが変わった: 前のアカウントの全権限・会社の管理者を引き継ぎ、前のものは取り消す（管理者は管理システムに合わせる）
    select * into a from public.app_access where member_id = m.id and status <> 'cancelled'
    order by (status = 'active') desc, created_at desc limit 1;
    if a.email is not null then
      update public.app_access set status = 'cancelled', is_owner = false, is_admin = false, member_id = null,
        updated_at = now(), updated_by = 'kanri'
      where email = a.email;
    end if;
    insert into public.app_access (email, member_id, is_admin, is_owner, status, activated_at, created_by, updated_by)
    values (p.email, m.id, p.can_manage or coalesce(a.is_owner, false), coalesce(a.is_owner, false), 'active', now(), 'kanri', 'kanri');
    if a.email is not null then
      insert into public.company_admins (email, company_id, created_by)
      select p.email, ca.company_id, 'kanri' from public.company_admins ca where ca.email = a.email and ca.revoked_at is null
      on conflict (email, company_id) do update set revoked_at = null;
      update public.company_admins set revoked_at = now() where email = a.email and revoked_at is null;
    end if;
  end if;
  -- 本部タスクの招待のリンクは使わない（管理システムから招待する）
  update public.invitations set revoked_at = now()
  where email = p.email and kind = 'invite' and used_at is null and revoked_at is null;

  perform public._commit_rev();
  perform set_config('honbu.hq_sync', '', true);
  perform set_config('honbu.company_bypass', '', true);
end $$;

create or replace function public._hq_lock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('honbu.hq_sync', true), '') = 'on' then return new; end if;
  if tg_table_name = 'members' then
    if old.profile_id is not null
       and (new.name, new.email, new.active, new.company_id, new.profile_id) is distinct from (old.name, old.email, old.active, old.company_id, old.profile_id) then
      raise exception '本部の人の名前・メールアドレス・会社（所属）・在籍は、管理システムのアカウント管理で変えてください';
    end if;
  elsif tg_table_name = 'app_access' then
    if exists (select 1 from public.members mm where mm.id = old.member_id and mm.profile_id is not null) then
      if (new.status, new.email, new.member_id) is distinct from (old.status, old.email, old.member_id) then
        raise exception '本部の人のアカウントの停止・再開・取り消しは、管理システムのアカウント管理で行ってください';
      end if;
      if new.is_admin is distinct from old.is_admin then
        raise exception '本部の人を管理者にする／外すのは、管理システムのアカウント管理（アカウント管理ができる）で変えてください';
      end if;
    end if;
  elsif tg_table_name = 'invitations' then
    -- 管理システムで本部の人を管理しているあいだは、本部タスクの招待は使わない（パスワード再設定のリンクは使える）
    if new.kind = 'invite' and exists (select 1 from public.profiles where is_hq) then
      raise exception '本部の人の招待は、管理システムのアカウント管理から行ってください（本部タスクの招待は使いません）';
    end if;
  end if;
  return new;
end $$;

/* ---------------- 今いる本部の人を、いまの管理システムの内容にそろえる ---------------- */

select public.task_sync_hq_member(pr.id) from public.profiles pr where pr.is_hq;

/* ---------------- 権限（本部タスクの関数だけを名指しで。スキーマ全体にはかけない） ---------------- */

revoke all on function public.task_sync_hq_member(uuid) from public, anon, authenticated;
revoke all on function public._hq_lock() from public, anon, authenticated;
