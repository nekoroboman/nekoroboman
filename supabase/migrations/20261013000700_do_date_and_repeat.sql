-- 本部タスク: 「いつやる」を追加し、繰り返しを Google ToDo リストと同じ決まり（RRULE）にする
-- - いつやる（do_date・do_time）は任意。期限（いつまでに）とは別に、両方決められる
-- - 期限は必須。ただし繰り返しのタスクは「いつやる」があれば期限なしにできる
-- - 繰り返しの例: FREQ=WEEKLY;BYDAY=MO,WE（毎週 月・水） FREQ=MONTHLY;BYDAY=2TU（毎月 第2火曜日）
--                 FREQ=MONTHLY;BYMONTHDAY=-1（毎月 最終日） FREQ=DAILY;INTERVAL=3;COUNT=10（3日ごと・10回）
-- - 完了すると次の回を作る。基準の日は「いつやる」（なければ期限）。もう一方の日も同じ日数だけずらす

alter table public.tasks add column do_date date;
alter table public.tasks add column do_time text not null default ''
  constraint tasks_do_time_check check (do_time = '' or do_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
alter table public.tasks add column repeat_index integer not null default 1;

-- 親タスクは「誰が」が必須。「いつまでに」も必須だが、繰り返しのタスクは「いつやる」があれば期限なしでよい
alter table public.tasks drop constraint tasks_who_and_when;
alter table public.tasks add constraint tasks_who_and_when check (
  parent_id is not null or (assignee is not null and (due is not null or (repeat <> '' and do_date is not null))));

-- 並べ替えに「いつやる」を追加
alter table public.lists drop constraint lists_sort_mode_check;
alter table public.lists add constraint lists_sort_mode_check check (sort_mode in ('my', 'do', 'date', 'starred', 'title', 'assignee'));

create index tasks_open_do_idx on public.tasks (do_date) where deleted_at is null and status <> 'done';

/* ---------------- 小さな道具 ---------------- */

create function public._check_day(p text, p_label text) returns date
language plpgsql immutable set search_path = public as $$
begin
  if coalesce(p, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '%の日付が正しくありません', p_label; end if;
  begin
    return p::date;
  exception when others then
    raise exception '%の日付が正しくありません', p_label;
  end;
end $$;

create function public._check_clock(p text, p_label text) returns text
language plpgsql immutable set search_path = public as $$
begin
  if coalesce(p, '') <> '' and p !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception '%の時刻が正しくありません', p_label; end if;
  return coalesce(p, '');
end $$;

-- 繰り返しの決まりから1つの項目を取り出す（例: FREQ）
create function public._rr_get(p_rule text, p_key text) returns text
language sql immutable set search_path = public as $$
  select split_part(x, '=', 2) from unnest(string_to_array(coalesce(p_rule, ''), ';')) as x where split_part(x, '=', 1) = p_key limit 1
$$;

-- 繰り返しの決まりを確かめ、決まった形（FREQ;INTERVAL;BYDAY;BYMONTHDAY;UNTIL か COUNT の順）にそろえる。前の形（daily など）も受け付ける
create or replace function public._check_repeat(p text) returns text
language plpgsql immutable set search_path = public as $$
declare
  v text := btrim(coalesce(p, ''));
  days text[] := array['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  part text; k text; val text;
  v_freq text; v_interval int := 1; v_byday text := ''; v_mday int; v_until date; v_count int;
begin
  if v = '' then return ''; end if;
  if lower(v) in ('daily', 'weekdays', 'weekly', 'monthly', 'yearly') then
    v := case lower(v) when 'daily' then 'FREQ=DAILY' when 'weekdays' then 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
      when 'weekly' then 'FREQ=WEEKLY' when 'monthly' then 'FREQ=MONTHLY' else 'FREQ=YEARLY' end;
  elsif lower(v) ~ '^every:[0-9]{1,3}:(day|week|month|year)(:[0-6](,[0-6]){0,6})?$' then
    v := 'FREQ=' || case split_part(lower(v), ':', 3) when 'day' then 'DAILY' when 'week' then 'WEEKLY' when 'month' then 'MONTHLY' else 'YEARLY' end
      || ';INTERVAL=' || split_part(v, ':', 2)
      || case when split_part(v, ':', 4) <> '' then ';BYDAY=' || (select string_agg(days[x::int + 1], ',') from unnest(string_to_array(split_part(v, ':', 4), ',')) as x) else '' end;
  end if;
  v := upper(v);
  foreach part in array string_to_array(v, ';') loop
    k := split_part(part, '=', 1);
    val := split_part(part, '=', 2);
    if k = 'FREQ' and val in ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') then v_freq := val;
    elsif k = 'INTERVAL' and val ~ '^[0-9]{1,3}$' and val::int between 1 and 999 then v_interval := val::int;
    elsif k = 'BYDAY' and val ~ '^(-1|[1-4])?(SU|MO|TU|WE|TH|FR|SA)(,(SU|MO|TU|WE|TH|FR|SA))*$' then v_byday := val;
    elsif k = 'BYMONTHDAY' and val ~ '^(-1|[1-9]|[12][0-9]|3[01])$' then v_mday := val::int;
    elsif k = 'UNTIL' and val ~ '^[0-9]{8}$' then
      begin
        v_until := (left(val, 4) || '-' || substr(val, 5, 2) || '-' || right(val, 2))::date;
      exception when others then
        raise exception '繰り返しの終了日が正しくありません';
      end;
    elsif k = 'COUNT' and val ~ '^[0-9]{1,3}$' and val::int between 1 and 999 then v_count := val::int;
    else
      raise exception '繰り返しの設定が正しくありません';
    end if;
  end loop;
  if v_freq is null
     or (v_byday <> '' and v_freq not in ('WEEKLY', 'MONTHLY'))
     or (v_freq = 'WEEKLY' and v_byday ~ '[0-9]')
     or (v_freq = 'MONTHLY' and v_byday <> '' and v_byday !~ '^(-1|[1-4])(SU|MO|TU|WE|TH|FR|SA)$')
     or (v_mday is not null and (v_freq <> 'MONTHLY' or v_byday <> ''))
     or (v_until is not null and v_count is not null) then
    raise exception '繰り返しの設定が正しくありません';
  end if;
  if v_freq = 'WEEKLY' and v_byday <> '' then
    select string_agg(x, ',' order by array_position(days, x)) into v_byday
    from (select distinct unnest(string_to_array(v_byday, ',')) as x) s;
  end if;
  return 'FREQ=' || v_freq
    || case when v_interval > 1 then ';INTERVAL=' || v_interval else '' end
    || case when v_byday <> '' then ';BYDAY=' || v_byday else '' end
    || case when v_mday is not null then ';BYMONTHDAY=' || v_mday else '' end
    || case when v_until is not null then ';UNTIL=' || to_char(v_until, 'YYYYMMDD') else '' end
    || case when v_count is not null then ';COUNT=' || v_count else '' end;
end $$;

-- 「毎週」「毎月」で曜日・日にちが決まっていないときは、基準の日から決める（あとで日を動かしても、決まりが変わらないように）
create function public._repeat_fill(p_rule text, p_anchor date) returns text
language sql immutable set search_path = public as $$
  select case
    when coalesce(p_rule, '') = '' or p_anchor is null then coalesce(p_rule, '')
    when p_rule like 'FREQ=WEEKLY%' and p_rule not like '%BYDAY=%' then
      regexp_replace(p_rule, '^(FREQ=WEEKLY(;INTERVAL=[0-9]+)?)', '\1;BYDAY=' || (array['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'])[extract(dow from p_anchor)::int + 1])
    when p_rule like 'FREQ=MONTHLY%' and p_rule not like '%BYDAY=%' and p_rule not like '%BYMONTHDAY=%' then
      regexp_replace(p_rule, '^(FREQ=MONTHLY(;INTERVAL=[0-9]+)?)', '\1;BYMONTHDAY=' || extract(day from p_anchor)::int)
    else p_rule end
$$;

-- 繰り返しの決まりで、p_from の次の日（終了の決まりは見ない）
create function public._repeat_step(p_rule text, p_from date) returns date
language plpgsql immutable set search_path = public as $$
declare
  days text[] := array['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  v_freq text := public._rr_get(p_rule, 'FREQ');
  v_int int := coalesce(nullif(public._rr_get(p_rule, 'INTERVAL'), '')::int, 1);
  v_byday text := coalesce(public._rr_get(p_rule, 'BYDAY'), '');
  v_mday int := nullif(public._rr_get(p_rule, 'BYMONTHDAY'), '')::int;
  v_dows int[]; v_nth int; v_dow int; d date; m date; v_last date; k int;
begin
  if p_from is null then return null; end if;
  if v_freq = 'DAILY' then return p_from + v_int; end if;
  if v_freq = 'YEARLY' then return (p_from + make_interval(years => v_int))::date; end if;
  if v_freq = 'WEEKLY' then
    if v_byday = '' then return p_from + 7 * v_int; end if;
    select array_agg(array_position(days, x) - 1) into v_dows from unnest(string_to_array(v_byday, ',')) as x;
    -- 同じ週（日曜はじまり）の残りの日
    for k in 1 .. 6 - extract(dow from p_from)::int loop
      if extract(dow from p_from + k)::int = any (v_dows) then return p_from + k; end if;
    end loop;
    -- 間隔の週数だけ先の週
    d := p_from - extract(dow from p_from)::int + 7 * v_int;
    for k in 0 .. 6 loop
      if extract(dow from d + k)::int = any (v_dows) then return d + k; end if;
    end loop;
    return null;
  end if;
  if v_freq = 'MONTHLY' then
    for k in 0 .. 240 loop
      m := (date_trunc('month', p_from) + make_interval(months => k * v_int))::date;
      v_last := (m + interval '1 month' - interval '1 day')::date;
      if v_byday <> '' then
        v_nth := regexp_replace(v_byday, '[A-Z]', '', 'g')::int;
        v_dow := array_position(days, regexp_replace(v_byday, '[-0-9]', '', 'g')) - 1;
        if v_nth = -1 then
          d := v_last - ((extract(dow from v_last)::int - v_dow + 7) % 7);
        else
          d := m + ((v_dow - extract(dow from m)::int + 7) % 7) + 7 * (v_nth - 1);
        end if;
      elsif coalesce(v_mday, 0) = -1 then
        d := v_last;
      else
        -- その日がない月（31日など）は月末にする
        d := least(m + (coalesce(v_mday, extract(day from p_from)::int) - 1), v_last);
      end if;
      if d > p_from then return d; end if;
    end loop;
  end if;
  return null;
end $$;

-- 次の回の日と、それが何回目か（終わりなら null）。p_min より前の回は飛ばす（期限を過ぎてから完了したとき、たまった分は作らない）
create function public._repeat_next(p_rule text, p_from date, p_index int, p_min date, out next_date date, out next_index int)
language plpgsql immutable set search_path = public as $$
declare
  v_until text := coalesce(public._rr_get(p_rule, 'UNTIL'), '');
  v_count int := nullif(public._rr_get(p_rule, 'COUNT'), '')::int;
  d date := p_from;
  i int := greatest(coalesce(p_index, 1), 1);
begin
  for guard in 1 .. 5000 loop
    d := public._repeat_step(p_rule, d);
    i := i + 1;
    if d is null or (v_until <> '' and d > to_date(v_until, 'YYYYMMDD')) or (v_count is not null and i > v_count) then
      return;
    end if;
    if p_min is null or d >= p_min then
      next_date := d;
      next_index := i;
      return;
    end if;
  end loop;
end $$;

/* ---------------- タスク ---------------- */

create or replace function public.api_create_task(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); t jsonb := coalesce(p -> 'task', '{}'::jsonb);
  v_id text; v_parent public.tasks; v_list text; v_title text; v_assignee text;
  v_due date; v_time text := ''; v_do date; v_do_time text := ''; v_repeat text := '';
  v_starred boolean := coalesce((t ->> 'starred')::boolean, false); v_existing public.tasks;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  v_id := public._check_id(t ->> 'id');
  select * into v_existing from public.tasks where id = v_id;
  if found then -- 通信のやり直しで2回届いたとき
    return jsonb_build_object('rev', public._commit_rev(), 'lists', '[]'::jsonb, 'members', '[]'::jsonb,
      'tasks', jsonb_build_array(public._camel(to_jsonb(v_existing))));
  end if;
  if coalesce(t ->> 'parentId', '') <> '' then
    select * into v_parent from public.tasks where id = t ->> 'parentId' and deleted_at is null;
    if not found then raise exception '親タスクが見つかりません'; end if;
    if v_parent.parent_id is not null then raise exception 'サブタスクの中にはサブタスクを作れません'; end if;
    v_list := v_parent.list_id;
  else
    v_list := public._active_list(t ->> 'listId');
  end if;
  v_title := left(btrim(coalesce(t ->> 'title', '')), 500);
  if v_title = '' then raise exception 'タスク名（何を）を入れてください'; end if;
  v_assignee := nullif(btrim(coalesce(t ->> 'assignee', '')), '');
  if coalesce(t ->> 'due', '') <> '' then
    v_due := public._check_day(t ->> 'due', '期限');
    v_time := public._check_clock(t ->> 'dueTime', '期限');
  end if;
  if coalesce(t ->> 'doDate', '') <> '' then
    v_do := public._check_day(t ->> 'doDate', 'いつやる');
    v_do_time := public._check_clock(t ->> 'doTime', 'いつやる');
  end if;
  if v_parent.id is null then
    v_repeat := public._repeat_fill(public._check_repeat(t ->> 'repeat'), coalesce(v_do, v_due));
    if v_assignee is null then raise exception '担当者（誰が）を選んでください'; end if;
    if v_due is null and not (v_repeat <> '' and v_do is not null) then
      raise exception '期限（いつまでに）を選んでください（繰り返しのタスクは「いつやる」を決めれば期限なしにできます）';
    end if;
  end if;
  if v_assignee is not null then perform public._check_member(v_assignee); end if;
  insert into public.tasks (id, list_id, parent_id, title, details, assignee, do_date, do_time, due, due_time, repeat,
                            starred, starred_at, sort_order, created_by, updated_by)
  values (v_id, v_list, v_parent.id, v_title, left(coalesce(t ->> 'details', ''), 5000), v_assignee, v_do, v_do_time, v_due, v_time, v_repeat,
          v_starred, case when v_starred then now() end,
          case when jsonb_typeof(t -> 'sortOrder') = 'number' then (t ->> 'sortOrder')::double precision else 0 end,
          v_actor, v_actor);
  perform public._hist(v_id, 'create', '', '', v_title, v_actor);
  return public._finish(v_start, null);
end $$;

-- 完了にしたとき・戻したときの後始末（完了日時・サブタスク・繰り返しの次の回）
create or replace function public._apply_status(t public.tasks, p_old text, p_actor text) returns public.tasks
language plpgsql security definer set search_path = public as $$
declare
  v_next text; v_anchor date; v_next_date date; v_next_index int; v_shift int;
begin
  if t.status = 'done' and p_old <> 'done' then
    t.completed_at := now();
    t.completed_by := p_actor;
    t.on_time := case when t.due is null then null else now() <= public._due_at(t.due, t.due_time) end;
    update public.tasks set status = 'done', completed_at = now(), completed_by = p_actor,
      version = version + 1, updated_at = now(), updated_by = p_actor
    where parent_id = t.id and deleted_at is null and status <> 'done';
    v_anchor := coalesce(t.do_date, t.due);
    if t.repeat <> '' and t.parent_id is null and t.next_id is null and v_anchor is not null then
      select r.next_date, r.next_index into v_next_date, v_next_index
      from public._repeat_next(t.repeat, v_anchor, t.repeat_index, (now() at time zone 'Asia/Tokyo')::date) as r;
      if v_next_date is not null then
        v_shift := v_next_date - v_anchor;
        v_next := public._new_id();
        -- 次の回も、頼んだ人（作成者）は同じ
        insert into public.tasks (id, list_id, title, details, assignee, do_date, do_time, due, due_time, repeat, repeat_index,
                                  starred, starred_at, sort_order, created_by, updated_by)
        values (v_next, t.list_id, t.title, t.details, t.assignee, t.do_date + v_shift, t.do_time, t.due + v_shift, t.due_time, t.repeat, v_next_index,
                t.starred, case when t.starred then now() end, t.sort_order, coalesce(nullif(t.created_by, ''), p_actor), p_actor);
        perform public._hist(v_next, 'create', 'repeat', t.id, t.title, p_actor);
        insert into public.tasks (id, list_id, parent_id, title, details, assignee, do_date, do_time, due, due_time, sort_order, created_by, updated_by)
        select public._new_id(), list_id, v_next, title, details, assignee, do_date + v_shift, do_time, due + v_shift, due_time, sort_order, created_by, p_actor
        from public.tasks where parent_id = t.id and deleted_at is null;
        t.next_id := v_next;
      end if;
    end if;
  elsif t.status <> 'done' and p_old = 'done' then
    t.completed_at := null;
    t.completed_by := '';
    t.on_time := null;
  end if;
  return t;
end $$;

create or replace function public.api_update_task(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_patch jsonb := coalesce(p -> 'patch', '{}'::jsonb);
  t public.tasks; b public.tasks; v_top boolean; v_merged boolean; v_merged_by text := ''; v_base int := coalesce((p ->> 'baseVersion')::int, 0);
begin
  perform public._guard(true);
  v_start := public._last_rev();
  select * into t from public.tasks where id = p ->> 'id' for update;
  if not found or t.deleted_at is not null then raise exception 'このタスクは削除されています'; end if;
  b := t;
  v_top := t.parent_id is null;
  v_merged := v_base > 0 and v_base <> t.version;
  if v_merged and b.updated_by <> '' and b.updated_by <> v_actor then v_merged_by := b.updated_by; end if;

  if v_patch ? 'title' then
    if btrim(coalesce(v_patch ->> 'title', '')) = '' then raise exception 'タスク名（何を）は空にできません'; end if;
    t.title := left(btrim(v_patch ->> 'title'), 500);
  end if;
  if v_patch ? 'details' then t.details := left(coalesce(v_patch ->> 'details', ''), 5000); end if;
  if v_patch ? 'assignee' then
    if coalesce(v_patch ->> 'assignee', '') = '' then
      if v_top then raise exception '担当者（誰が）は空にできません'; end if;
      t.assignee := null;
    else
      t.assignee := public._check_member(v_patch ->> 'assignee');
    end if;
  end if;
  if v_patch ? 'due' then
    if coalesce(v_patch ->> 'due', '') = '' then
      t.due := null;
      t.due_time := '';
    else
      t.due := public._check_day(v_patch ->> 'due', '期限');
    end if;
  end if;
  if v_patch ? 'dueTime' then t.due_time := case when t.due is null then '' else public._check_clock(v_patch ->> 'dueTime', '期限') end; end if;
  if v_patch ? 'doDate' then
    if coalesce(v_patch ->> 'doDate', '') = '' then
      t.do_date := null;
      t.do_time := '';
    else
      t.do_date := public._check_day(v_patch ->> 'doDate', 'いつやる');
    end if;
  end if;
  if v_patch ? 'doTime' then t.do_time := case when t.do_date is null then '' else public._check_clock(v_patch ->> 'doTime', 'いつやる') end; end if;
  if v_patch ? 'repeat' then
    t.repeat := case when v_top then public._repeat_fill(public._check_repeat(v_patch ->> 'repeat'), coalesce(t.do_date, t.due)) else '' end;
    if t.repeat is distinct from b.repeat then t.repeat_index := 1; end if;
  end if;
  if v_top and t.due is null and not (t.repeat <> '' and t.do_date is not null) then
    raise exception '期限（いつまでに）は空にできません（繰り返しのタスクは「いつやる」があれば期限なしにできます）';
  end if;
  if v_patch ? 'starred' then
    t.starred := coalesce((v_patch ->> 'starred')::boolean, false);
    t.starred_at := case when t.starred then coalesce(case when b.starred then b.starred_at end, now()) else null end;
  end if;
  if v_patch ? 'status' then
    if coalesce(v_patch ->> 'status', '') not in ('todo', 'doing', 'done') then raise exception 'ステータスが正しくありません'; end if;
    t.status := v_patch ->> 'status';
  end if;
  if v_patch ? 'sortOrder' and jsonb_typeof(v_patch -> 'sortOrder') = 'number' then t.sort_order := (v_patch ->> 'sortOrder')::double precision; end if;
  if v_patch ? 'listId' and v_top and coalesce(v_patch ->> 'listId', '') <> t.list_id then
    t.list_id := public._active_list(v_patch ->> 'listId');
  end if;

  if (t.title, t.details, t.assignee, t.due, t.due_time, t.do_date, t.do_time, t.repeat, t.starred, t.status, t.sort_order, t.list_id)
     is not distinct from (b.title, b.details, b.assignee, b.due, b.due_time, b.do_date, b.do_time, b.repeat, b.starred, b.status, b.sort_order, b.list_id) then
    return jsonb_build_object('rev', public._commit_rev(), 'lists', '[]'::jsonb, 'members', '[]'::jsonb,
      'tasks', jsonb_build_array(public._camel(to_jsonb(b))), 'merged', v_merged, 'mergedBy', v_merged_by);
  end if;

  if t.status <> b.status then t := public._apply_status(t, b.status, v_actor); end if;
  update public.tasks set
    list_id = t.list_id, title = t.title, details = t.details, assignee = t.assignee, due = t.due, due_time = t.due_time,
    do_date = t.do_date, do_time = t.do_time, repeat = t.repeat, repeat_index = t.repeat_index,
    starred = t.starred, starred_at = t.starred_at, status = t.status, sort_order = t.sort_order,
    completed_at = t.completed_at, completed_by = t.completed_by, on_time = t.on_time, next_id = t.next_id,
    version = b.version + 1, updated_at = now(), updated_by = v_actor
  where id = t.id;

  if t.title is distinct from b.title then perform public._hist(t.id, 'update', 'title', b.title, t.title, v_actor); end if;
  if t.assignee is distinct from b.assignee then perform public._hist(t.id, 'update', 'assignee', b.assignee, t.assignee, v_actor); end if;
  if t.due is distinct from b.due then perform public._hist(t.id, 'update', 'due', b.due::text, t.due::text, v_actor); end if;
  if t.due_time is distinct from b.due_time then perform public._hist(t.id, 'update', 'dueTime', b.due_time, t.due_time, v_actor); end if;
  if t.do_date is distinct from b.do_date then perform public._hist(t.id, 'update', 'doDate', b.do_date::text, t.do_date::text, v_actor); end if;
  if t.do_time is distinct from b.do_time then perform public._hist(t.id, 'update', 'doTime', b.do_time, t.do_time, v_actor); end if;
  if t.status is distinct from b.status then perform public._hist(t.id, 'update', 'status', b.status, t.status, v_actor); end if;
  if t.list_id is distinct from b.list_id then perform public._hist(t.id, 'update', 'listId', b.list_id, t.list_id, v_actor); end if;
  if t.repeat is distinct from b.repeat then perform public._hist(t.id, 'update', 'repeat', b.repeat, t.repeat, v_actor); end if;

  if v_top and t.list_id <> b.list_id then
    update public.tasks set list_id = t.list_id, version = version + 1, updated_at = now(), updated_by = v_actor
    where parent_id = t.id and deleted_at is null;
  end if;
  return public._finish(v_start, jsonb_build_object('merged', v_merged, 'mergedBy', v_merged_by));
end $$;

/* ---------------- リスト（並べ替えに「いつやる」を追加） ---------------- */

create or replace function public.api_update_list(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_start bigint; v_actor text := coalesce(p ->> 'actor', ''); v_id text := p ->> 'id'; v_patch jsonb := coalesce(p -> 'patch', '{}'::jsonb);
  v_name text; v_mode text;
begin
  perform public._guard(true);
  v_start := public._last_rev();
  perform public._active_list(v_id);
  if v_patch ? 'name' then
    v_name := left(btrim(coalesce(v_patch ->> 'name', '')), 100);
    if v_name = '' then raise exception 'リスト名を入れてください'; end if;
    update public.lists set name = v_name, updated_at = now(), updated_by = v_actor where id = v_id;
  end if;
  if v_patch ? 'sortMode' then
    v_mode := v_patch ->> 'sortMode';
    if v_mode not in ('my', 'do', 'date', 'starred', 'title', 'assignee') then raise exception '並べ替えの指定が正しくありません'; end if;
    update public.lists set sort_mode = v_mode, updated_at = now(), updated_by = v_actor where id = v_id;
  end if;
  return public._finish(v_start, null);
end $$;

/* ---------------- 権限（新しく作った関数は画面から直接呼べないようにする） ---------------- */

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.has_access() to authenticated;
grant execute on function
  public.api_sync(jsonb), public.api_bootstrap(jsonb), public.api_task_detail(jsonb), public.api_trash(jsonb),
  public.api_create_list(jsonb), public.api_update_list(jsonb), public.api_delete_list(jsonb), public.api_reorder_lists(jsonb),
  public.api_create_task(jsonb), public.api_update_task(jsonb), public.api_delete_task(jsonb), public.api_restore_task(jsonb),
  public.api_clear_completed(jsonb), public.api_add_note(jsonb), public.api_save_member(jsonb), public.api_save_config(jsonb),
  public.api_mail_status(jsonb), public.api_request_test_mail(jsonb)
to authenticated;
