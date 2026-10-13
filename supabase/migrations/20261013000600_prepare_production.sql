-- 試験に使ったデータを見えなくし、本番の準備をする（1回だけ使う。呼ぶときにメールアドレスと公開URLを渡す）
create or replace function public._prepare_production(p_email text, p_app_url text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(4242);
  -- ログインしてよいのは本部の共有アカウントだけにする
  update public.app_access set email = lower(p_email) where email = 'test-user@example.com';
  insert into public.app_access (email) values (lower(p_email)) on conflict do nothing;
  -- 試験のタスク・最新状況・メンバーを見えなくする
  update public.tasks set deleted_at = timestamptz '2000-01-01 00:00:00+00', deleted_by = '', title = '（試験データ）', details = '', note_text = ''
  where deleted_at is null or deleted_at > timestamptz '2000-01-02 00:00:00+00';
  update public.task_notes set body = '（試験データ）' where body <> '（試験データ）';
  update public.members set active = false, name = '（試験用' || right(id, 1) || '）', email = '' where name like 'テスト%';
  -- メール設定は最初の状態に戻す
  update public.settings set value = '{}'::jsonb where key = 'app';
  update public.app_state set value = '' where key in ('test_request', 'mail_slot', 'mail_rev', 'mail_at', 'relay_seen_at', 'relay_quota');
  insert into public.app_state (key, value) values ('app_url', p_app_url)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  perform public._commit_rev();
  return jsonb_build_object(
    'access', (select jsonb_agg(email) from public.app_access),
    'visibleTasks', (select count(*) from public.tasks where deleted_at is null),
    'activeMembers', (select count(*) from public.members where active),
    'appUrl', public._state('app_url'));
end $$;
revoke all on function public._prepare_production(text, text) from public, anon, authenticated;
