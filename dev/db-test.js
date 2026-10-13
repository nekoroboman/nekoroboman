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
  const create = (task, actor) => d.rpc('api_create_task', { actor: actor || 'memberA', task: Object.assign({ listId: list, assignee: 'memberA' }, task) });
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

  console.log(passed + ' 件 OK' + (process.exitCode ? '（NG あり）' : ''));
  await d.close();
})().catch(e => { console.error(e); process.exit(1); });
