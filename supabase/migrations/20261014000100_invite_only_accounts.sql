-- 本部タスク: アカウントは招待制にする（1/3: アカウントの項目と、招待・パスワード再設定のリンクの表）
-- - アカウント（app_access）: 個人（メンバー1人と結びつく）か共有（何人かで使い、端末ごとに操作する人を選ぶ）。管理者かどうか。状態（招待中・使用中・停止中）
-- - 招待・パスワード再設定のリンク（invitations）: 1回だけ使える・期限つき。データベースにはリンクの合言葉そのものではなくハッシュを残す
--   （メールで送るまでのあいだだけ、送る係が読めるように合言葉を持つ）
-- - 画面からの呼び出しは、すべて api_call を通す。ログインしている人を確かめ、操作した人を正しく記録し、管理者だけの操作を守る
-- - 招待されていないメールアドレスでは、ログイン（auth.users）そのものを作れないようにする

/* ---------------- アカウント ---------------- */

update public.app_access set email = lower(email) where email <> lower(email);
alter table public.app_access
  add column member_id text references public.members (id),
  add column is_admin boolean not null default false,
  add column status text not null default 'invited' check (status in ('invited', 'active', 'stopped')),
  add column activated_at timestamptz,
  add column created_by text not null default '',
  add column updated_at timestamptz not null default now(),
  add column updated_by text not null default '',
  add constraint app_access_email_lower check (email = lower(email));
create unique index app_access_member_idx on public.app_access (member_id) where member_id is not null;

-- いまのアカウント（本部の共有アカウント）は管理者にする。ログインを作り終えたものは「使用中」
update public.app_access a set
  is_admin = true,
  status = case when exists (select 1 from auth.users u where lower(u.email) = a.email) then 'active' else 'invited' end,
  activated_at = case when exists (select 1 from auth.users u where lower(u.email) = a.email) then a.created_at end
where a.member_id is null;

create table public.invitations (
  id text primary key,
  email text not null,
  kind text not null check (kind in ('invite', 'reset')),
  token_hash text not null unique,
  pending_token text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  used_at timestamptz,
  revoked_at timestamptz,
  mail_status text not null default 'queued' check (mail_status in ('queued', 'sending', 'sent', 'failed')),
  mail_at timestamptz,
  mail_error text not null default ''
);
create index invitations_email_idx on public.invitations (email);
create index invitations_queue_idx on public.invitations (created_at) where mail_status = 'queued';
alter table public.invitations enable row level security;
revoke all on public.invitations from anon, authenticated;
