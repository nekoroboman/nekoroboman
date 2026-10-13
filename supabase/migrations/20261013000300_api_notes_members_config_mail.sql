/* ---------------- 最新状況 ---------------- */

create function public.api_add_note(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_text text := left(btrim(coalesce(p ->> 'text', '')), 2000);
  v_id text; t public.tasks;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  select * into t from public.tasks where id = p ->> 'taskId' and deleted_at is null for update;
  if not found then raise exception 'このタスクは削除されています'; end if;
  if v_text = '' then raise exception '最新状況を入れてください'; end if;
  v_id := case when coalesce(p ->> 'id', '') = '' then public._new_id() else public._check_id(p ->> 'id') end;
  if exists (select 1 from public.task_notes where id = v_id) then return public._finish(v_start, null); end if;
  insert into public.task_notes (id, task_id, body, actor) values (v_id, t.id, v_text, v_actor);
  if t.status = 'todo' then perform public._hist(t.id, 'update', 'status', 'todo', 'doing', v_actor); end if;
  update public.tasks set note_text = v_text, note_at = now(), note_by = v_actor,
    status = case when status = 'todo' then 'doing' else status end,
    version = version + 1, updated_at = now(), updated_by = v_actor
  where id = t.id;
  return public._finish(v_start, null);
end $$;

/* ---------------- メンバー・設定 ---------------- */

create function public.api_save_member(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; m jsonb := coalesce(p -> 'member', '{}'::jsonb); v_id text; v_name text; v_email text; v_active boolean;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_id := public._check_id(m ->> 'id');
  v_name := left(btrim(coalesce(m ->> 'name', '')), 50);
  if v_name = '' then raise exception '名前を入れてください'; end if;
  v_email := left(btrim(coalesce(m ->> 'email', '')), 200);
  if v_email <> '' and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'メールアドレスの形が正しくありません'; end if;
  v_active := coalesce((m ->> 'active')::boolean, true);
  if exists (select 1 from public.members where id <> v_id and active and name = v_name) then raise exception '同じ名前のメンバーがいます'; end if;
  insert into public.members (id, name, email, active, sort_order)
  values (v_id, v_name, v_email, v_active, coalesce((select max(sort_order) from public.members), 0) + 1)
  on conflict (id) do update set name = excluded.name, email = excluded.email, active = excluded.active, updated_at = now();
  return public._finish(v_start, null);
end $$;

create function public.api_save_config(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; c jsonb := coalesce(p -> 'config', '{}'::jsonb); m jsonb := coalesce(c -> 'mail', '{}'::jsonb);
  v_recipients jsonb; v_days jsonb; v_start_hour int; v_end_hour int; v_summary text; v_cfg jsonb; e text;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  select coalesce(jsonb_agg(distinct x), '[]'::jsonb) into v_recipients
  from (select btrim(value) as x from jsonb_array_elements_text(coalesce(m -> 'recipients', '[]'::jsonb))) s where x <> '';
  for e in select jsonb_array_elements_text(v_recipients) loop
    if e !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'メールアドレスの形が正しくありません: %', e; end if;
  end loop;
  if jsonb_array_length(v_recipients) > 50 then raise exception '送信先は50件までです'; end if;
  select coalesce(jsonb_agg(distinct (value)::int), '[]'::jsonb) into v_days
  from jsonb_array_elements_text(coalesce(m -> 'days', '[]'::jsonb)) where value ~ '^[0-6]$';
  v_start_hour := least(23, greatest(0, coalesce((m ->> 'startHour')::int, 10)));
  v_end_hour := least(23, greatest(0, coalesce((m ->> 'endHour')::int, 17)));
  if v_end_hour < v_start_hour then raise exception '送る時間帯の「まで」は「から」より後にしてください'; end if;
  v_summary := coalesce(m ->> 'summaryTime', '');
  if v_summary <> '' and v_summary !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception '「今日のまとめ」の時刻が正しくありません'; end if;
  if coalesce((m ->> 'enabled')::boolean, false) and jsonb_array_length(v_recipients) = 0 then
    raise exception 'メールを送るには、送信先を1件以上入れてください';
  end if;
  v_cfg := jsonb_build_object(
    'mail', jsonb_build_object(
      'enabled', coalesce((m ->> 'enabled')::boolean, false), 'recipients', v_recipients, 'days', v_days,
      'startHour', v_start_hour, 'endHour', v_end_hour, 'summaryTime', v_summary,
      'skipHolidays', coalesce((m ->> 'skipHolidays')::boolean, false), 'skipYearEnd', coalesce((m ->> 'skipYearEnd')::boolean, false),
      'sendWhenNoChange', coalesce((m ->> 'sendWhenNoChange')::boolean, false)),
    'soonDays', least(14, greatest(1, coalesce((c ->> 'soonDays')::int, 3))),
    'staleDays', least(30, greatest(1, coalesce((c ->> 'staleDays')::int, 3))));
  insert into public.settings (key, value) values ('app', v_cfg)
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return public._finish(v_start, jsonb_build_object('config', public._config()));
end $$;

/* ---------------- メール（画面から見る・頼む） ---------------- */

create function public.api_mail_status(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_seen timestamptz := nullif(public._state('relay_seen_at'), '')::timestamptz;
begin
  perform public._guard(false);
  return jsonb_build_object(
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', l.created_at, 'to', l.to_addr, 'subject', l.subject, 'result', l.result, 'error', l.error) order by l.created_at desc)
                     from (select * from public.mail_log order by created_at desc limit 30) l), '[]'::jsonb),
    'lastSentAt', coalesce(public._state('mail_at'), ''),
    'relaySeenAt', v_seen,
    'trigger', v_seen is not null and v_seen > now() - interval '5 minutes',
    'quota', nullif(public._state('relay_quota'), '')::int,
    'testPending', coalesce(public._state('test_request'), '') <> '');
end $$;

create function public.api_request_test_mail(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public._guard(true);
  if jsonb_array_length(coalesce(public._config() -> 'mail' -> 'recipients', '[]'::jsonb)) = 0 then
    raise exception '送信先を入れて保存してから、テスト送信してください';
  end if;
  perform public._set_state('test_request', now()::text);
  return public.api_mail_status('{}'::jsonb);
end $$;
