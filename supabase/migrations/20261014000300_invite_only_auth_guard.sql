-- 本部タスク: アカウントは招待制にする（3/3）

/* ---------------- 招待されていないアドレスでは、ログインを作れない ---------------- */

create function public._auth_user_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and lower(coalesce(new.email, '')) = lower(coalesce(old.email, '')) then return new; end if;
  if not exists (select 1 from public.app_access a where a.email = lower(coalesce(new.email, '')) and a.status in ('invited', 'active')) then
    raise exception 'このアドレスは招待されていません';
  end if;
  return new;
end $$;
create trigger honbu_invite_only before insert or update of email on auth.users
  for each row execute function public._auth_user_guard();
revoke all on function public._auth_user_guard() from public, anon, authenticated;
