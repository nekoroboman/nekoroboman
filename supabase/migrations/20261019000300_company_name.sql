-- 本部タスク: 2つ目の会社の正式な名前（ユーザーの指示）
update public.companies set name = 'セレクトエールグループ株式会社', updated_at = now(), updated_by = 'migration'
where id = 'co-selected' and name <> 'セレクトエールグループ株式会社';
select public._commit_rev();
