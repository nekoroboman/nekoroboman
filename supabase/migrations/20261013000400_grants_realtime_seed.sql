/* ---------------- 権限 ---------------- */

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.has_access() to authenticated;
grant execute on function
  public.api_sync(jsonb), public.api_bootstrap(jsonb), public.api_task_detail(jsonb), public.api_trash(jsonb),
  public.api_create_list(jsonb), public.api_update_list(jsonb), public.api_delete_list(jsonb), public.api_reorder_lists(jsonb),
  public.api_create_task(jsonb), public.api_update_task(jsonb), public.api_delete_task(jsonb), public.api_restore_task(jsonb),
  public.api_clear_completed(jsonb), public.api_add_note(jsonb), public.api_save_member(jsonb), public.api_save_config(jsonb),
  public.api_mail_status(jsonb), public.api_request_test_mail(jsonb)
to authenticated;

/* ---------------- リアルタイム通知 ---------------- */

alter publication supabase_realtime add table public.tasks, public.lists, public.members, public.settings;

/* ---------------- 最初のデータ ---------------- */

insert into public.lists (id, name, sort_order) values (public._new_id(), 'マイタスク', 1);
select public._commit_rev();
-- メール送信用 GAS が使う合言葉（値はデータベースの中だけにある）
insert into public.app_state (key, value) values ('relay_token', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;
