/**
 * データベース（supabase/migrations）の動作確認。本物と同じ SQL を手元の PostgreSQL（PGlite）で動かす。
 * node dev/db-test.js
 */
'use strict';
const assert = require('assert');
const { createDb } = require('./pg-db');

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  NG  ' + name + '\n      ' + (e && e.message));
    process.exitCode = 1;
  }
}
const ymd = d => d.toISOString().slice(0, 10);
function jstToday(offset) {
  const d = new Date(Date.now() + 9 * 3600000);
  d.setUTCDate(d.getUTCDate() + (offset || 0));
  return ymd(d);
}

(async () => {
  const d = await createDb();
  const one = async (sql, params) => Object.values((await d.sql(sql, params))[0])[0];
  const fails = async (p, re) => {
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert.ok(err, 'エラーになるはず');
    if (re) assert.match(err.message, re);
  };

  console.log('繰り返しの決まり');
  await t('決まった形にそろえる', async () => {
    const cases = [
      ['', ''], ['daily', 'FREQ=DAILY'], ['weekdays', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'], ['every:2:week:3,1', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'],
      ['freq=weekly;byday=we,mo;interval=1', 'FREQ=WEEKLY;BYDAY=MO,WE'], ['FREQ=MONTHLY;BYDAY=-1FR;COUNT=5', 'FREQ=MONTHLY;BYDAY=-1FR;COUNT=5'],
      ['FREQ=MONTHLY;UNTIL=20261231;BYMONTHDAY=-1', 'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20261231'], ['FREQ=YEARLY;INTERVAL=2', 'FREQ=YEARLY;INTERVAL=2'],
    ];
    for (const [a, b] of cases) assert.strictEqual(await one('select public._check_repeat($1)', [a]), b, a);
    for (const bad of ['FREQ=HOURLY', 'FREQ=DAILY;BYDAY=MO', 'FREQ=WEEKLY;BYDAY=2MO', 'FREQ=MONTHLY;BYDAY=5MO', 'FREQ=DAILY;COUNT=3;UNTIL=20261231',
      'FREQ=MONTHLY;BYMONTHDAY=32', 'FREQ=DAILY;UNTIL=20260231', 'FREQ=DAILY;INTERVAL=0', 'BYDAY=MO']) {
      await fails(d.sql('select public._check_repeat($1)', [bad]), /繰り返し/);
    }
  });
  await t('曜日・日にちを基準の日から決める', async () => {
    assert.strictEqual(await one("select public._repeat_fill('FREQ=WEEKLY', '2026-10-13')"), 'FREQ=WEEKLY;BYDAY=TU');
    assert.strictEqual(await one("select public._repeat_fill('FREQ=WEEKLY;INTERVAL=2;COUNT=3', '2026-10-13')"), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=3');
    assert.strictEqual(await one("select public._repeat_fill('FREQ=MONTHLY', '2026-10-31')"), 'FREQ=MONTHLY;BYMONTHDAY=31');
    assert.strictEqual(await one("select public._repeat_fill('FREQ=MONTHLY;BYDAY=2TU', '2026-10-31')"), 'FREQ=MONTHLY;BYDAY=2TU');
  });
  await t('次の日の計算', async () => {
    const cases = [
      ['FREQ=DAILY', '2026-10-13', '2026-10-14'], ['FREQ=DAILY;INTERVAL=3', '2026-10-13', '2026-10-16'],
      ['FREQ=WEEKLY;BYDAY=MO,WE', '2026-10-12', '2026-10-14'], ['FREQ=WEEKLY;BYDAY=MO,WE', '2026-10-14', '2026-10-19'],
      ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', '2026-10-14', '2026-10-26'], ['FREQ=WEEKLY;BYDAY=SU', '2026-10-17', '2026-10-18'],
      ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-10-16', '2026-10-19'],
      ['FREQ=MONTHLY;BYMONTHDAY=13', '2026-10-13', '2026-11-13'], ['FREQ=MONTHLY;BYMONTHDAY=31', '2027-01-31', '2027-02-28'],
      ['FREQ=MONTHLY;BYMONTHDAY=31', '2027-02-28', '2027-03-31'], ['FREQ=MONTHLY;BYMONTHDAY=-1', '2026-10-31', '2026-11-30'],
      ['FREQ=MONTHLY;BYDAY=2TU', '2026-10-13', '2026-11-10'], ['FREQ=MONTHLY;BYDAY=-1FR', '2026-10-30', '2026-11-27'],
      ['FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=25', '2026-10-25', '2027-01-25'], ['FREQ=MONTHLY;BYMONTHDAY=25', '2026-10-20', '2026-10-25'],
      ['FREQ=YEARLY', '2028-02-29', '2029-02-28'], ['FREQ=YEARLY;INTERVAL=2', '2026-10-13', '2028-10-13'],
    ];
    for (const [rule, from, want] of cases) assert.strictEqual(ymd(await one('select public._repeat_step($1, $2::date)', [rule, from])), want, rule + ' ' + from);
  });
  await t('終わりの決まり（終了日・回数）と、たまった回を飛ばす', async () => {
    const next = async (rule, from, idx, min) => (await d.sql('select next_date::text as d, next_index as i from public._repeat_next($1, $2::date, $3, $4::date)', [rule, from, idx, min]))[0];
    assert.deepStrictEqual(await next('FREQ=DAILY;COUNT=3', '2026-10-13', 2, null), { d: '2026-10-14', i: 3 });
    assert.deepStrictEqual(await next('FREQ=DAILY;COUNT=3', '2026-10-14', 3, null), { d: null, i: null });
    assert.deepStrictEqual(await next('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026', '2026-10-19', 1, null), { d: '2026-10-26', i: 2 });
    assert.deepStrictEqual(await next('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261025', '2026-10-19', 1, null), { d: null, i: null });
    assert.deepStrictEqual(await next('FREQ=DAILY', '2026-10-01', 1, '2026-10-13'), { d: '2026-10-13', i: 13 });
  });

  console.log('タスク（いつやる・期限・繰り返し）');
  const boot = await d.rpc('api_bootstrap', {});
  const list = boot.lists[0].id;
  await d.rpc('api_save_member', { actor: '', member: { id: 'memberA', name: 'テストA', active: true } });
  await d.rpc('api_save_member', { actor: '', member: { id: 'memberB', name: 'テストB', active: true } });
  const create = (task, actor) => d.rpc('api_create_task', { actor: actor || 'memberA', task: Object.assign({ listId: list, assignee: 'memberA', priority: 'mid' }, task) });
  const update = (id, patch, actor) => d.rpc('api_update_task', { actor: actor || 'memberA', id: id, patch: patch });
  const get = async id => (await d.sql('select * from public.tasks where id = $1', [id]))[0];
  const today = jstToday(0);

  await t('いつやると期限を両方決められる', async () => {
    const r = await create({ id: 'task-both', title: '両方', doDate: today, doTime: '10:00', due: jstToday(2), dueTime: '17:00' });
    const x = r.tasks.find(v => v.id === 'task-both');
    assert.strictEqual(x.doDate, today);
    assert.strictEqual(x.doTime, '10:00');
    assert.strictEqual(x.due, jstToday(2));
    assert.strictEqual(x.repeatIndex, 1);
  });
  await t('期限は必須（繰り返さないタスク）', async () => {
    await fails(create({ id: 'task-nodue', title: '期限なし', doDate: today }), /期限/);
    await fails(create({ id: 'task-nodue2', title: '期限なし', repeat: 'FREQ=DAILY' }), /期限/);
    await fails(update('task-both', { due: '' }), /期限/);
  });
  await t('他の人に頼める（作成者が残る）', async () => {
    await create({ id: 'task-ask', title: '頼む', assignee: 'memberB', due: today }, 'memberA');
    const x = await get('task-ask');
    assert.strictEqual(x.assignee, 'memberB');
    assert.strictEqual(x.created_by, 'memberA');
  });
  await t('繰り返しのタスクは、いつやるがあれば期限なしにできる', async () => {
    await create({ id: 'task-rep', title: '毎週の報告', doDate: today, doTime: '09:00', repeat: 'FREQ=WEEKLY', assignee: 'memberB' }, 'memberA');
    const x = await get('task-rep');
    assert.strictEqual(x.due, null);
    assert.match(x.repeat, /^FREQ=WEEKLY;BYDAY=(SU|MO|TU|WE|TH|FR|SA)$/);
    await fails(update('task-rep', { repeat: '' }), /期限/);
    await fails(update('task-rep', { doDate: '' }), /期限/);
  });
  await t('完了すると次の回ができる（頼んだ人はそのまま・日付は同じだけずれる）', async () => {
    await create({ id: 'task-rep2', title: '毎日の確認', doDate: today, due: jstToday(1), dueTime: '12:00', repeat: 'FREQ=DAILY;COUNT=2', assignee: 'memberB' }, 'memberA');
    await d.rpc('api_create_task', { actor: 'memberA', task: { id: 'task-rep2-sub', parentId: 'task-rep2', title: 'サブ', due: jstToday(1) } });
    const r = await update('task-rep2', { status: 'done' }, 'memberB');
    const done = r.tasks.find(v => v.id === 'task-rep2');
    assert.ok(done.nextId);
    const n = await get(done.nextId);
    assert.strictEqual(ymd(n.do_date), jstToday(1));
    assert.strictEqual(ymd(n.due), jstToday(2));
    assert.strictEqual(n.due_time, '12:00');
    assert.strictEqual(n.repeat_index, 2);
    assert.strictEqual(n.created_by, 'memberA');
    assert.strictEqual(n.status, 'todo');
    const subs = await d.sql('select * from public.tasks where parent_id = $1', [n.id]);
    assert.strictEqual(subs.length, 1);
    assert.strictEqual(ymd(subs[0].due), jstToday(2));
    // 2回で終わり
    const r2 = await update(n.id, { status: 'done' }, 'memberB');
    assert.ok(!r2.tasks.find(v => v.id === n.id).nextId);
  });
  await t('優先度（低・中・高）は親タスクで必ず選ぶ・繰り返しの次の回も同じ・並べ替えに使える', async () => {
    await fails(create({ id: 'task-pr0', title: '優先度が空', due: today, priority: '' }), /優先度/);
    await d.rpc('api_create_task', { actor: 'memberA', task: { id: 'task-pr-old', listId: list, title: '古い画面から', assignee: 'memberA', due: today } });
    assert.strictEqual((await get('task-pr-old')).priority, 'mid', '優先度を送らない古い画面からは「中」');
    await fails(create({ id: 'task-pr0', title: 'へんな値', due: today, priority: 'top' }), /優先度/);
    await create({ id: 'task-pr1', title: '急ぎ', doDate: today, repeat: 'FREQ=DAILY;COUNT=3', priority: 'high' });
    await d.rpc('api_create_task', { actor: 'memberA', task: { id: 'task-pr1-sub', parentId: 'task-pr1', title: 'サブは優先度なしでよい' } });
    const r = await update('task-pr1', { status: 'done' });
    const n = await get(r.tasks.find(v => v.id === 'task-pr1').nextId);
    assert.strictEqual(n.priority, 'high', '次の回の優先度が変わった');
    await update(n.id, { priority: 'low' });
    assert.strictEqual((await get(n.id)).priority, 'low');
    await fails(update(n.id, { priority: '' }), /優先度/);
    await d.rpc('api_update_list', { actor: 'memberA', id: list, patch: { sortMode: 'priority' } });
    await d.rpc('api_update_list', { actor: 'memberA', id: list, patch: { sortMode: 'my' } });
  });
  await t('人ごとの色（変えるとその人のカレンダーの色も同じになる）', async () => {
    const m = (await d.sql("select color from public.members where id = 'memberA'"))[0];
    assert.match(m.color, /^#[0-9a-fA-F]{6}$/);
    await d.rpc('api_save_member', { actor: '', member: { id: 'memberA', name: 'テストA', active: true, color: '#d50000' } });
    assert.strictEqual((await d.sql("select color from public.members where id = 'memberA'"))[0].color, '#d50000');
    assert.strictEqual((await d.sql("select color from public.calendars where owner = 'memberA'"))[0].color, '#d50000');
    await d.rpc('api_save_member', { actor: '', member: { id: 'memberA', name: 'テストA', active: true } });
    assert.strictEqual((await d.sql("select color from public.members where id = 'memberA'"))[0].color, '#d50000', '色を送らないと消えてしまう');
    await fails(d.rpc('api_save_member', { actor: '', member: { id: 'memberA', name: 'テストA', color: 'red' } }), /色/);
  });
  await t('期限を過ぎてから完了したときは、今日以降の回を作る', async () => {
    await create({ id: 'task-late', title: '遅れた毎日', due: jstToday(-5), repeat: 'FREQ=DAILY' });
    const r = await update('task-late', { status: 'done' });
    const n = await get(r.tasks.find(v => v.id === 'task-late').nextId);
    assert.strictEqual(ymd(n.due), today);
    assert.strictEqual(n.repeat_index, 6);
  });
  await t('繰り返しを変えると回数を数え直す・変更の記録が残る', async () => {
    await update('task-both', { repeat: 'FREQ=MONTHLY;BYDAY=-1FR', doDate: jstToday(3) });
    const x = await get('task-both');
    assert.strictEqual(x.repeat, 'FREQ=MONTHLY;BYDAY=-1FR');
    assert.strictEqual(ymd(x.do_date), jstToday(3));
    const h = await d.rpc('api_task_detail', { id: 'task-both' });
    assert.ok(h.history.some(v => v.field === 'doDate'));
    assert.ok(h.history.some(v => v.field === 'repeat'));
  });
  await t('並べ替えに「いつやる」を使える', async () => {
    const r = await d.rpc('api_update_list', { actor: 'memberA', id: list, patch: { sortMode: 'do' } });
    assert.strictEqual(r.lists[0].sortMode, 'do');
    await fails(d.rpc('api_update_list', { actor: 'memberA', id: list, patch: { sortMode: 'zzz' } }));
  });
  await t('画面から内部の関数は呼べない', async () => {
    await fails(d.rpc('api_sync', {}, 'someone@example.com'), /使えません/);
    let err = null;
    try {
      await d.db.transaction(async tx => {
        await tx.exec('set local role authenticated');
        await tx.query("select public._repeat_step('FREQ=DAILY', '2026-10-13')");
      });
    } catch (e) { err = e; }
    assert.ok(err && /permission denied/.test(err.message), '内部の関数が呼べてしまう');
  });

  console.log('カレンダー');
  const jst = (ymdStr, hm) => ymdStr + 'T' + (hm || '00:00') + ':00+09:00';
  const ev = id => d.sql('select * from public.events where id = $1', [id]).then(r => r[0]);
  const createEv = (e, actor) => d.rpc('api_create_event', { actor: actor || 'memberA', event: Object.assign({ calendarId: 'cal-memberA' }, e) });
  const updEv = (p, actor) => d.rpc('api_update_event', Object.assign({ actor: actor || 'memberA' }, p));
  const delEv = (p, actor) => d.rpc('api_delete_event', Object.assign({ actor: actor || 'memberA' }, p));

  await t('メンバーごとに自分のカレンダーができる・同期で届く', async () => {
    const r = await d.rpc('api_sync', { rev: 0 });
    assert.ok(r.calendars.some(c => c.id === 'cal-memberA' && c.owner === 'memberA'));
    assert.ok(r.calendars.some(c => c.id === 'cal-memberB' && c.name === 'テストB'));
    await d.rpc('api_save_member', { actor: '', member: { id: 'memberB', name: 'テストB2', active: true } });
    assert.strictEqual((await d.sql("select name from public.calendars where id = 'cal-memberB'"))[0].name, 'テストB2');
  });
  await t('時刻つきの予定・終日の予定を作れる', async () => {
    await createEv({ id: 'ev-timed', title: '会議', start: jst('2026-10-20', '10:00'), end: jst('2026-10-20', '11:00'), location: '本部', attendees: [{ id: 'memberA' }, { id: 'memberB' }] });
    const x = await ev('ev-timed');
    assert.strictEqual(x.title, '会議');
    assert.deepStrictEqual(x.attendees.map(a => a.id + ':' + a.response), ['memberA:accepted', 'memberB:needsAction']);
    assert.deepStrictEqual(x.reminders, [{ method: 'popup', minutes: 10 }]);
    await createEv({ id: 'ev-allday', title: '研修', allDay: true, start: jst('2026-10-21', '13:00'), end: jst('2026-10-22', '09:00') });
    const y = await ev('ev-allday');
    assert.strictEqual(y.start_at.toISOString(), '2026-10-20T15:00:00.000Z');
    assert.strictEqual(y.end_at.toISOString(), '2026-10-22T15:00:00.000Z');
    await fails(createEv({ id: 'ev-bad', start: jst('2026-10-20', '11:00'), end: jst('2026-10-20', '10:00') }), /終了/);
  });
  await t('出欠を答えられる（ゲストだけ）', async () => {
    await d.rpc('api_respond_event', { actor: 'memberB', id: 'ev-timed', member: 'memberB', response: 'tentative' });
    assert.strictEqual((await ev('ev-timed')).attendees[1].response, 'tentative');
    await fails(d.rpc('api_respond_event', { actor: 'memberB', id: 'ev-allday', member: 'memberB', response: 'accepted' }), /ゲストではありません/);
  });
  await t('繰り返しの予定: この回だけ変える・消す', async () => {
    await createEv({ id: 'ev-weekly', title: '朝会', start: jst('2026-10-19', '09:00'), end: jst('2026-10-19', '09:30'), rrule: 'FREQ=WEEKLY' });
    assert.strictEqual((await ev('ev-weekly')).rrule, 'FREQ=WEEKLY;BYDAY=MO');
    await updEv({ id: 'ev-weekly', scope: 'this', instanceStart: jst('2026-10-26', '09:00'), patch: { title: '朝会（拡大版）', start: jst('2026-10-26', '10:00'), end: jst('2026-10-26', '11:00') } });
    const ex = (await d.sql("select * from public.events where recurring_id = 'ev-weekly'"))[0];
    assert.strictEqual(ex.title, '朝会（拡大版）');
    assert.strictEqual(ex.original_start.toISOString(), '2026-10-26T00:00:00.000Z');
    assert.strictEqual(ex.rrule, '');
    // もう一度同じ回を変えると、同じ行を直す
    await updEv({ id: 'ev-weekly', scope: 'this', instanceStart: jst('2026-10-26', '09:00'), patch: { location: '会議室' } });
    assert.strictEqual((await d.sql("select count(*)::int as n from public.events where recurring_id = 'ev-weekly'"))[0].n, 1);
    await delEv({ id: 'ev-weekly', scope: 'this', instanceStart: jst('2026-11-02', '09:00') });
    const cancelled = (await d.sql("select status from public.events where recurring_id = 'ev-weekly' and original_start = $1", [jst('2026-11-02', '09:00')]))[0];
    assert.strictEqual(cancelled.status, 'cancelled');
  });
  await t('繰り返しの予定: これ以降を変える（回数の決まりも引き継ぐ）', async () => {
    await createEv({ id: 'ev-daily', title: '日報', start: jst('2026-10-19', '17:00'), end: jst('2026-10-19', '17:15'), rrule: 'FREQ=DAILY;COUNT=10' });
    await updEv({ id: 'ev-daily', scope: 'following', instanceStart: jst('2026-10-23', '17:00'), patch: { title: '日報（新）' } });
    const old = await ev('ev-daily');
    assert.strictEqual(old.rrule, 'FREQ=DAILY;UNTIL=20261022');
    const nw = (await d.sql("select * from public.events where title = '日報（新）'"))[0];
    assert.strictEqual(nw.rrule, 'FREQ=DAILY;COUNT=6');
    assert.strictEqual(nw.start_at.toISOString(), '2026-10-23T08:00:00.000Z');
  });
  await t('繰り返しの予定: これ以降を消す・すべて消す・ごみ箱から戻す', async () => {
    await delEv({ id: 'ev-weekly', scope: 'following', instanceStart: jst('2026-11-09', '09:00') });
    assert.strictEqual((await ev('ev-weekly')).rrule, 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261108');
    await delEv({ id: 'ev-weekly', scope: 'all' });
    assert.ok((await ev('ev-weekly')).deleted_at);
    assert.ok((await d.sql("select deleted_at from public.events where recurring_id = 'ev-weekly'")).every(r => r.deleted_at));
    const trash = await d.rpc('api_event_trash', {});
    assert.ok(trash.items.some(i => i.id === 'ev-weekly'));
    await d.rpc('api_restore_event', { actor: 'memberA', id: 'ev-weekly' });
    assert.ok(!(await ev('ev-weekly')).deleted_at);
    assert.ok((await d.sql("select deleted_at from public.events where recurring_id = 'ev-weekly'")).every(r => !r.deleted_at));
  });
  await t('共有のカレンダーを作る・消す（メンバーのカレンダーは消せない）', async () => {
    await d.rpc('api_save_calendar', { actor: 'memberA', calendar: { id: 'cal-shared1', name: '会議室', color: '#33B679' } });
    assert.strictEqual((await d.sql("select color from public.calendars where id = 'cal-shared1'"))[0].color, '#33b679');
    await createEv({ id: 'ev-room', calendarId: 'cal-shared1', title: '会議室予約', start: jst('2026-10-20', '13:00'), end: jst('2026-10-20', '14:00') });
    await d.rpc('api_delete_calendar', { actor: 'memberA', id: 'cal-shared1' });
    assert.ok((await ev('ev-room')).deleted_at);
    await fails(d.rpc('api_delete_calendar', { actor: 'memberA', id: 'cal-memberA' }), /削除できません/);
  });
  await t('予定の書き込みは関数からだけ・同期で変わった予定が届く', async () => {
    const before = await d.rpc('api_sync', { rev: 0 });
    await updEv({ id: 'ev-timed', patch: { color: '#D50000' } });
    const delta = await d.rpc('api_sync', { rev: before.rev });
    assert.ok(delta.events.some(e => e.id === 'ev-timed' && e.color === '#d50000'));
    let err = null;
    try {
      await d.db.transaction(async tx => {
        await tx.exec('set local role authenticated');
        await tx.query("update public.events set title = 'x'");
      });
    } catch (e) { err = e; }
    assert.ok(err && /permission denied/.test(err.message), '画面から直接書き換えられてしまう');
  });

  console.log('招待制のアカウント');
  const ADMIN = 'honbu-test@example.com';
  const INV = 'invitee.one@example.com';
  let invToken = '';
  let invMember = '';
  await t('管理者が招待すると、メンバーと招待中のアカウントができる（まだ使えない）', async () => {
    const r = await d.rpc('api_admin_invite', { actor: 'memberA', name: '招待 一郎', email: 'Invitee.One@Example.com', isAdmin: false });
    invToken = r.link.token;
    assert.match(invToken, /^[A-Za-z0-9_-]{40,}$/);
    const acc = (await d.sql('select * from public.app_access where email = $1', [INV]))[0];
    assert.strictEqual(acc.status, 'invited');
    invMember = acc.member_id;
    assert.strictEqual((await d.sql('select name, email from public.members where id = $1', [invMember]))[0].email, INV);
    assert.ok((await d.sql('select 1 from public.calendars where owner = $1', [invMember])).length, 'メンバーのカレンダーができていない');
    const inv = (await d.sql('select * from public.invitations where email = $1', [INV]))[0];
    assert.notStrictEqual(inv.token_hash, invToken, '合言葉そのままを残している');
    await fails(d.rpc('api_sync', { rev: 0 }, INV), /使えません/);
    await fails(d.rpc('api_admin_invite', { name: '招待 一郎', email: INV }), /招待中/);
  });
  await t('招待されていないアドレスでは、ログインそのものを作れない', async () => {
    await fails(d.sql("insert into auth.users (email) values ('stranger@example.com')"), /招待されていません/);
    await d.sql("insert into auth.users (email) values ($1)", [ADMIN]).catch(() => {});
    await fails(d.sql("update auth.users set email = 'stranger@example.com' where email = $1", [ADMIN]), /招待されていません/);
  });
  await t('リンクからパスワードを決めると使えるようになり、操作した人は本人に決まる', async () => {
    const r = await d.acceptLink(invToken);
    assert.ok(r.ok, r.error);
    const me = await d.rpc('api_me', {}, INV);
    assert.deepStrictEqual([me.memberId, me.kind, me.isAdmin, me.name], [invMember, 'personal', false, '招待 一郎']);
    await d.rpc('api_save_calendar', { actor: 'memberA', calendar: { id: 'cal-inv-test', name: '本人の確認' } }, INV);
    assert.strictEqual((await d.sql("select created_by from public.calendars where id = 'cal-inv-test'"))[0].created_by, invMember, 'ほかの人になりすませてしまう');
    const again = await d.acceptLink(invToken);
    assert.ok(!again.ok && /もう使われています/.test(again.error));
  });
  await t('共有のアカウントは、選んだ人（メンバーにいる人だけ）が記録に残る', async () => {
    await d.rpc('api_save_calendar', { actor: 'no-such-member', calendar: { id: 'cal-shared-x', name: '共有の確認' } });
    assert.strictEqual((await d.sql("select created_by from public.calendars where id = 'cal-shared-x'"))[0].created_by, '');
    await d.rpc('api_save_calendar', { actor: 'memberA', calendar: { id: 'cal-shared-x', name: '共有の確認2' } });
    assert.strictEqual((await d.sql("select updated_by from public.calendars where id = 'cal-shared-x'"))[0].updated_by, 'memberA');
  });
  await t('管理者だけの操作は、ほかの人にはできない', async () => {
    await fails(d.rpc('api_admin_accounts', {}, INV), /管理者だけ/);
    await fails(d.rpc('api_admin_invite', { name: '勝手', email: 'x@example.com' }, INV), /管理者だけ/);
    await fails(d.rpc('api_save_member', { member: { id: 'mem-hack1', name: '勝手', email: 'x@example.com' } }, INV), /管理者だけ/);
    await fails(d.rpc('api_save_config', { config: {} }, INV), /管理者だけ/);
    await fails(d.rpc('api_request_test_mail', {}, INV), /管理者だけ/);
    await fails(d.rpc('api_call', {}), /不明な操作/);
  });
  await t('管理画面の操作は、パスワードでログインしてから8時間以内だけ', async () => {
    const old = Math.floor(Date.now() / 1000) - 9 * 3600;
    await fails(d.rpc('api_admin_accounts', {}, ADMIN, old), /もう一度ログイン/);
    await d.rpc('api_sync', { rev: 0 }, ADMIN, old);
    const list = await d.rpc('api_admin_accounts', {});
    const row = list.accounts.find(a => a.email === INV);
    assert.deepStrictEqual([row.status, row.kind, row.name], ['active', 'personal', '招待 一郎']);
    assert.ok(!JSON.stringify(list).includes(invToken), '一覧にリンクの合言葉が出ている');
  });
  await t('リンクの表は画面から読めない', async () => {
    let err = null;
    try {
      await d.db.transaction(async tx => { await tx.exec('set local role authenticated'); await tx.query('select * from public.invitations'); });
    } catch (e) { err = e; }
    assert.ok(err && /permission denied/.test(err.message));
  });
  await t('停止すると使えなくなり、再開で戻る（自分は止められない）', async () => {
    await d.rpc('api_admin_update', { email: INV, status: 'stopped' });
    await fails(d.rpc('api_sync', { rev: 0 }, INV), /使えません/);
    await d.rpc('api_admin_update', { email: INV, status: 'active' });
    await d.rpc('api_sync', { rev: 0 }, INV);
    await fails(d.rpc('api_admin_update', { email: ADMIN, status: 'stopped' }), /自分のアカウント/);
    await fails(d.rpc('api_admin_update', { email: ADMIN, isAdmin: false }), /自分のアカウント/);
    await d.rpc('api_admin_update', { email: INV, isAdmin: true });
    assert.strictEqual((await d.rpc('api_me', {}, INV)).isAdmin, true);
    await d.rpc('api_admin_update', { email: INV, isAdmin: false });
  });
  await t('招待のやり直し（古いリンクは使えない）・期限切れ・取り消し', async () => {
    const a = await d.rpc('api_admin_invite', { name: '招待 二郎', email: 'invitee.two@example.com' });
    const b = await d.rpc('api_admin_reinvite', { email: 'invitee.two@example.com' });
    assert.match((await d.acceptLink(a.link.token)).error, /取り消されています/);
    await d.sql("update public.invitations set expires_at = now() - interval '1 hour' where token_hash = public._token_hash($1)", [b.link.token]);
    assert.match((await d.acceptLink(b.link.token)).error, /期限/);
    const c = await d.rpc('api_admin_reinvite', { email: 'invitee.two@example.com' });
    await d.rpc('api_admin_cancel', { email: 'invitee.two@example.com' });
    assert.match((await d.acceptLink(c.link.token)).error, /取り消されています|使えません/);
    assert.strictEqual((await d.sql("select status from public.app_access where email = 'invitee.two@example.com'"))[0].status, 'cancelled');
    assert.ok(!(await d.rpc('api_admin_accounts', {})).accounts.some(a => a.email === 'invitee.two@example.com'), '取り消した招待が一覧に出る');
    assert.ok((await d.sql("select 1 from public.members where email = 'invitee.two@example.com'")).length, 'メンバーは残るはず');
    await fails(d.sql("insert into auth.users (email) values ('invitee.two@example.com')"), /招待されていません/);
    const again = await d.rpc('api_admin_invite', { name: '招待 二郎', email: 'invitee.two@example.com' });
    assert.ok((await d.acceptLink(again.link.token)).ok, '取り消したアドレスをもう一度招待できない');
    await fails(d.rpc('api_admin_cancel', { email: INV }), /取り消せません/);
  });
  await t('パスワード再設定のリンク（使用中のアカウントだけ・1回だけ）', async () => {
    const r = await d.rpc('api_admin_reset', { email: INV });
    assert.strictEqual(r.link.kind, 'reset');
    const users = (await d.sql('select count(*)::int as n from auth.users where email = $1', [INV]))[0].n;
    assert.ok((await d.acceptLink(r.link.token)).ok);
    assert.strictEqual((await d.sql('select count(*)::int as n from auth.users where email = $1', [INV]))[0].n, users, 'ログインが2つできた');
    assert.ok(!(await d.acceptLink(r.link.token)).ok);
    await fails(d.rpc('api_admin_reset', { email: 'nobody@example.com' }), /見つかりません/);
  });
  await t('アカウントのないメンバーを、あとから招待できる', async () => {
    await d.rpc('api_save_member', { member: { id: 'mem-noacc1', name: '名前だけ 三郎', email: '', active: true } });
    const r = await d.rpc('api_admin_invite', { memberId: 'mem-noacc1', email: 'saburo@example.com' });
    assert.ok(r.link.token);
    assert.strictEqual((await d.sql("select email from public.members where id = 'mem-noacc1'"))[0].email, 'saburo@example.com');
    await fails(d.rpc('api_admin_invite', { memberId: 'mem-noacc1', email: 'other@example.com' }), /もうアカウント/);
  });
  await t('全権限のアカウントは、ほかの管理者が止めたり外したり、リンクを作ったりできない', async () => {
    await d.rpc('api_admin_update', { email: INV, isAdmin: true });
    await d.sql('update public.app_access set is_owner = true where email = $1', [ADMIN]);
    assert.strictEqual((await d.rpc('api_me', {})).isOwner, true);
    await fails(d.rpc('api_admin_update', { email: ADMIN, status: 'stopped' }, INV), /全権限/);
    await fails(d.rpc('api_admin_update', { email: ADMIN, isAdmin: false }, INV), /全権限/);
    await fails(d.rpc('api_admin_reset', { email: ADMIN }, INV), /全権限/);
    assert.strictEqual((await d.rpc('api_admin_reset', { email: ADMIN })).link.kind, 'reset', '本人は再設定のリンクを作れるはず');
    const row = (await d.rpc('api_admin_accounts', {}, INV)).accounts[0];
    assert.deepStrictEqual([row.email, row.isOwner, row.isAdmin], [ADMIN, true, true]);
    await fails(d.sql('update public.app_access set is_admin = false where email = $1', [ADMIN]), /app_access_owner_check/);
    await d.rpc('api_admin_update', { email: INV, isAdmin: false });
  });
  await t('頼んだタスクを消せるのは、頼んだ人と管理者だけ（担当の人は完了や更新はできる）', async () => {
    const lid = (await d.sql('select id from public.lists where deleted_at is null order by sort_order limit 1'))[0].id;
    await d.rpc('api_create_task', { actor: 'memberA', task: { id: 'req-t1', priority: 'mid', listId: lid, title: '頼んだ仕事', assignee: invMember, due: '2026-12-01' } });
    await fails(d.rpc('api_delete_task', { id: 'req-t1' }, INV), /頼んだ人/);
    await d.rpc('api_update_task', { id: 'req-t1', patch: { status: 'done' } }, INV);
    await d.rpc('api_clear_completed', { listId: lid }, INV);
    assert.strictEqual((await d.sql("select deleted_at from public.tasks where id = 'req-t1'"))[0].deleted_at, null, '「完了したタスクをすべて削除」で消えてしまう');
    await d.rpc('api_create_list', { id: 'req-l2', name: '頼みごと' });
    await d.rpc('api_create_task', { actor: 'memberA', task: { id: 'req-t2', priority: 'mid', listId: 'req-l2', title: '頼んだ仕事2', assignee: invMember, due: '2026-12-01' } });
    await fails(d.rpc('api_delete_list', { id: 'req-l2' }, INV), /ほかの人が頼んだ/);
    // 頼んだ本人は消せる（INV → memberA に頼んだもの）
    await d.rpc('api_create_task', { task: { id: 'req-t3', priority: 'mid', listId: lid, title: '本人が頼んだ', assignee: 'memberA', due: '2026-12-01' } }, INV);
    await d.rpc('api_delete_task', { id: 'req-t3' }, INV);
    // 自分のタスクは今までどおり消せる
    await d.rpc('api_create_task', { task: { id: 'req-t4', priority: 'mid', listId: lid, title: '自分の', assignee: invMember, due: '2026-12-01' } }, INV);
    await d.rpc('api_delete_task', { id: 'req-t4' }, INV);
    // 管理者は消せる
    await d.rpc('api_delete_task', { id: 'req-t1' });
    await d.rpc('api_delete_list', { id: 'req-l2' });
    assert.ok((await d.sql("select deleted_at from public.tasks where id in ('req-t1', 'req-t2', 'req-t3', 'req-t4') and deleted_at is null")).length === 0);
  });
  await t('届いたタスクは、担当の人が開くまで「まだ見ていない」のまま（ほかの人は見たことにできない）', async () => {
    const lid = (await d.sql('select id from public.lists where deleted_at is null order by sort_order limit 1'))[0].id;
    const ack = async id => (await d.sql('select ack_at from public.tasks where id = $1', [id]))[0].ack_at;
    await d.rpc('api_create_task', { actor: 'memberA', task: { id: 'ack-t1', priority: 'mid', listId: lid, title: '届く仕事', assignee: invMember, due: '2026-12-01' } });
    assert.strictEqual(await ack('ack-t1'), null, '頼まれたのに見たことになっている');
    const sy = await d.rpc('api_sync', { rev: 0 }, INV);
    assert.ok((sy.tasks || []).some(x => x.id === 'ack-t1' && x.ackAt === null), '画面に「まだ見ていない」が届かない');
    // 自分で作った自分のタスク・サブタスクは、最初から見たことにする
    await d.rpc('api_create_task', { task: { id: 'ack-t2', priority: 'mid', listId: lid, title: '自分の', assignee: invMember, due: '2026-12-01' } }, INV);
    assert.ok(await ack('ack-t2'));
    await d.rpc('api_create_task', { actor: 'memberA', task: { id: 'ack-s1', parentId: 'ack-t1', title: 'チェック', assignee: invMember } });
    assert.ok(await ack('ack-s1'));
    // 頼んだ人が中身を変えても・ほかの人が「見た」にしようとしても、まだ見ていないまま
    await d.rpc('api_update_task', { actor: 'memberA', id: 'ack-t1', patch: { details: '詳しく' } });
    await d.rpc('api_ack_tasks', { actor: 'memberA', ids: ['ack-t1'] });
    assert.strictEqual(await ack('ack-t1'), null);
    // 担当の人が開くと見たことになり、頼んだ人の画面にも届く
    const r = await d.rpc('api_ack_tasks', { ids: ['ack-t1'] }, INV);
    assert.ok(r.tasks.some(x => x.id === 'ack-t1' && x.ackAt), '開いても見たことにならない');
    // 担当をほかの人に変えると、新しい担当の人はまだ見ていない。その人がさわると見たことになる
    await d.rpc('api_update_task', { id: 'ack-t2', patch: { assignee: 'memberA' } }, INV);
    assert.strictEqual(await ack('ack-t2'), null);
    await d.rpc('api_add_note', { actor: 'memberA', taskId: 'ack-t2', text: '見ました', id: 'ack-n1' });
    assert.ok(await ack('ack-t2'));
    await fails(d.rpc('api_ack_tasks', { ids: 'ack-t1' }, INV), /IDが正しくありません/);
  });
  await t('会社ごとの所属: 自分の会社の分だけ見える・会社の管理者はその会社も見える・ほかの会社は変えられない・担当は同じ会社の人だけ', async () => {
    const SEL = 'selected.one@example.com';
    const acc = await d.rpc('api_admin_accounts', {});
    assert.deepStrictEqual(acc.companies.map(c => c.name), ['株式会社ネコロボマン', 'Selected Group 株式会社']);
    // Selected の人を招待して、会社を Selected にする（その人のカレンダーもついていく）
    const r = await d.rpc('api_admin_invite', { name: 'セレクト 花子', email: SEL });
    const selMember = (await d.sql('select member_id from public.app_access where email = $1', [SEL]))[0].member_id;
    await d.rpc('api_admin_set_company', { memberId: selMember, companyId: 'co-selected' });
    assert.ok((await d.acceptLink(r.link.token)).ok);
    assert.strictEqual((await d.sql('select company_id from public.calendars where owner = $1', [selMember]))[0].company_id, 'co-selected');
    const me = await d.rpc('api_me', {}, SEL);
    assert.deepStrictEqual([me.companyId, me.companies], ['co-selected', ['co-selected']]);
    // Selected の人がリストとタスクを作る
    await d.rpc('api_create_list', { id: 'list-sel-1', name: 'セレクトの仕事' }, SEL);
    await d.rpc('api_create_task', { task: { id: 'task-sel-1', listId: 'list-sel-1', title: 'セレクトのタスク', assignee: selMember, due: '2026-12-01', priority: 'mid' } }, SEL);
    assert.strictEqual((await d.sql("select company_id from public.tasks where id = 'task-sel-1'"))[0].company_id, 'co-selected');
    // お互いに、ほかの会社の分は見えない
    const sSel = await d.rpc('api_sync', { rev: 0 }, SEL);
    assert.ok(sSel.tasks.every(x => x.companyId === 'co-selected') && sSel.tasks.some(x => x.id === 'task-sel-1'), 'Selected の人にネコロボマンのタスクが見える');
    assert.ok(sSel.members.every(x => x.companyId === 'co-selected'));
    assert.deepStrictEqual(sSel.companies.map(c => c.id), ['co-selected']);
    const sInv = await d.rpc('api_sync', { rev: 0 }, INV);
    assert.ok(!sInv.tasks.some(x => x.id === 'task-sel-1') && !sInv.lists.some(x => x.id === 'list-sel-1'), 'ネコロボマンの人に Selected のタスクが見える');
    assert.deepStrictEqual((await d.rpc('api_task_detail', { id: 'task-sel-1' }, INV)).notes, []);
    // ほかの会社のデータは変えられない・ほかの会社の人には頼めない・ほかの会社にリストは作れない
    await fails(d.rpc('api_update_task', { id: 'task-sel-1', patch: { title: '書きかえ' } }, INV), /ほかの会社/);
    await fails(d.rpc('api_create_task', { task: { id: 'task-sel-x', listId: 'list-sel-1', title: '勝手に', assignee: invMember, due: '2026-12-01', priority: 'mid' } }, INV), /ほかの会社/);
    const lid = (await d.sql("select id from public.lists where company_id = 'co-nekoroboman' and deleted_at is null order by sort_order limit 1"))[0].id;
    await fails(d.rpc('api_create_task', { task: { id: 'task-cross', listId: lid, title: '別会社の人へ', assignee: selMember, due: '2026-12-01', priority: 'mid' } }, INV), /同じ会社/);
    await fails(d.rpc('api_create_list', { id: 'list-sel-x', name: '勝手', companyId: 'co-selected' }, INV), /この会社/);
    // 会社の管理者にすると、その会社の分も見えて、全部読み直しになる
    const before = await d.rpc('api_sync', { rev: 0 }, INV);
    await d.rpc('api_admin_set_company_admin', { email: INV, companyId: 'co-selected', on: true });
    const after = await d.rpc('api_sync', { rev: before.rev, scope: before.scope }, INV);
    assert.ok(after.full && after.tasks.some(x => x.id === 'task-sel-1'), '会社の管理者になっても見えない');
    await d.rpc('api_update_task', { id: 'task-sel-1', patch: { title: '管理者が直した' } }, INV);
    await d.rpc('api_admin_set_company_admin', { email: INV, companyId: 'co-selected', on: false });
    assert.ok(!(await d.rpc('api_sync', { rev: 0 }, INV)).tasks.some(x => x.id === 'task-sel-1'));
    assert.deepStrictEqual((await d.rpc('api_admin_accounts', {})).accounts.find(x => x.email === INV).adminCompanies, []);
    await d.rpc('api_admin_set_company_admin', { email: INV, companyId: 'co-selected', on: true });
    assert.ok((await d.rpc('api_sync', { rev: 0 }, INV)).tasks.some(x => x.id === 'task-sel-1'), '外したあと、もう一度会社の管理者にできない');
    await d.rpc('api_admin_set_company_admin', { email: INV, companyId: 'co-selected', on: false });
    // 直接読んでも（リアルタイムの通知と同じ決まり）、ほかの会社の分は出ない
    await d.sql('grant select on public.tasks to authenticated'); // Supabase と同じ（読むかどうかは RLS が決める）
    const direct = await d.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ email: INV, role: 'authenticated' })]);
      await tx.exec('set local role authenticated');
      return (await tx.query('select id from public.tasks')).rows.map(x => x.id);
    });
    assert.ok(direct.length > 0 && !direct.includes('task-sel-1'), '直接読むと Selected のタスクが見える');
    // 会社は最低1つのリスト。会社を作ると「マイタスク」ができる
    const selFirst = (await d.sql("select id from public.lists where company_id = 'co-selected' and deleted_at is null and id <> 'list-sel-1'"))[0].id;
    await d.rpc('api_delete_list', { id: 'list-sel-1' }, SEL);
    await fails(d.rpc('api_delete_list', { id: selFirst }, SEL), /会社ごと/);
    const nc = await d.rpc('api_admin_save_company', { name: 'テスト第三会社' });
    assert.strictEqual((await d.sql('select count(*)::int as n from public.lists where company_id = $1', [nc.id]))[0].n, 1);
    await fails(d.rpc('api_admin_save_company', { name: 'テスト第三会社' }), /同じ名前/);
    await fails(d.rpc('api_admin_set_company', { memberId: selMember, companyId: 'co-x' }, SEL), /管理者だけ/);
  });
  await t('Google 連携: 個人のアカウントだけ・設定はつないでから・合言葉は画面に出ない・管理画面で一覧', async () => {
    assert.strictEqual((await d.rpc('api_google_status', {})).available, false, '共有のアカウントでは使えないはず');
    const st = await d.rpc('api_google_status', {}, INV);
    assert.deepStrictEqual([st.available, st.link], [true, null]);
    await fails(d.rpc('api_google_settings', { tasksEnabled: false }, INV), /まだ Google/);
    await d.sql("insert into public.google_links (member_id, google_email, refresh_token, scopes, status, synced_rev) values ($1, 'g@example.com', 'secret-refresh', 'openid https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar.events', 'active', 99)", [invMember]);
    const s2 = await d.rpc('api_google_settings', { tasksEnabled: false }, INV);
    assert.deepStrictEqual([s2.link.email, s2.link.tasksEnabled, s2.link.calendarEnabled, s2.link.canTasks, s2.link.canCalendar], ['g@example.com', false, true, true, true]);
    assert.ok(!JSON.stringify(s2).includes('secret-refresh'), '合言葉が画面に出ている');
    assert.strictEqual(Number((await d.sql('select synced_rev from public.google_links where member_id = $1', [invMember]))[0].synced_rev), 99);
    await d.rpc('api_google_settings', { tasksEnabled: true }, INV);
    assert.strictEqual(Number((await d.sql('select synced_rev from public.google_links where member_id = $1', [invMember]))[0].synced_rev), 0, 'オンにしたら最初から反映し直すはず');
    const adm = await d.rpc('api_admin_google', {});
    assert.ok(adm.members.some(x => x.memberId === invMember && x.status === 'active' && x.email === 'g@example.com'));
    assert.ok(!JSON.stringify(adm).includes('secret-refresh'));
    await fails(d.rpc('api_admin_google', {}, INV), /管理者だけ/);
    for (const table of ['google_links', 'google_map', 'google_oauth_states']) {
      let err = null;
      try {
        await d.db.transaction(async tx => { await tx.exec('set local role authenticated'); await tx.query('select * from public.' + table); });
      } catch (e) { err = e; }
      assert.ok(err && /permission denied/.test(err.message), table + ' が画面から読める');
    }
  });

  console.log(passed + ' 件 OK' + (process.exitCode ? '（NG あり）' : ''));
  await d.close();
})().catch(e => { console.error(e); process.exit(1); });
