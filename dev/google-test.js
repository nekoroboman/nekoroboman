// Google 連携の「何をどう送るか」（supabase/functions/google/plan.ts）の試験。Google にもデータベースにもつながない
// 使い方: node dev/google-test.js
const assert = require('assert');

(async () => {
  const P = await import('../supabase/functions/google/plan.ts');
  let passed = 0;
  const t = (name, fn) => {
    try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { process.exitCode = 1; console.log('  NG  ' + name + '\n      ' + e.message); }
  };
  const ME = 'mem-me', OTHER = 'mem-other';
  const now = Date.parse('2026-10-14T03:00:00Z');

  t('繰り返しの決まり: 時刻つきの予定の終了日は、日本時間のその日の終わり（UTC）にする', () => {
    assert.strictEqual(P.googleRule('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231', false), 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T145959Z');
    assert.strictEqual(P.googleRule('FREQ=MONTHLY;BYDAY=2TU;UNTIL=20261231', true), 'RRULE:FREQ=MONTHLY;BYDAY=2TU;UNTIL=20261231');
    assert.strictEqual(P.googleRule('FREQ=DAILY;INTERVAL=3;COUNT=10', false), 'RRULE:FREQ=DAILY;INTERVAL=3;COUNT=10');
  });
  t('繰り返しの1回の ID（時刻つきは UTC の日時、終日は日本時間の日付）', () => {
    assert.strictEqual(P.instanceId('abc123', '2026-10-14T01:00:00Z', false), 'abc123_20261014T010000Z');
    assert.strictEqual(P.instanceId('abc123', '2026-10-13T15:00:00Z', true), 'abc123_20261014');
  });
  t('予定の ID は人ごと・予定ごとに決まっていて、Google で使える文字だけ', () => {
    const a = P.eventGid(ME, 'ev1');
    assert.match(a, /^[0-9a-f]{5,1024}$/);
    assert.strictEqual(a, P.eventGid(ME, 'ev1'));
    assert.notStrictEqual(a, P.eventGid(OTHER, 'ev1'));
  });
  t('予定の中身: 終日・色・予定あり／空き・通知・繰り返し・リンク', () => {
    const b = P.eventBody({
      id: 'ev1', title: '研修', description: 'メモ', location: '本部', all_day: true,
      start_at: '2026-10-13T15:00:00Z', end_at: '2026-10-15T15:00:00Z', rrule: 'FREQ=WEEKLY;BYDAY=WE', color: '#D50000', busy: false,
      visibility: 'private', reminders: [{ method: 'popup', minutes: 10 }, { method: 'email', minutes: 60 }],
    }, 'https://example.com/honbu-task/');
    assert.deepStrictEqual([b.start, b.end], [{ date: '2026-10-14' }, { date: '2026-10-16' }]);
    assert.deepStrictEqual([b.colorId, b.transparency, b.visibility, b.status], ['11', 'transparent', 'private', 'confirmed']);
    assert.deepStrictEqual(b.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }, { method: 'email', minutes: 60 }] });
    assert.deepStrictEqual(b.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=WE']);
    assert.ok(b.description.includes('メモ') && b.description.includes('https://example.com/honbu-task/'));
    const timed = P.eventBody({ id: 'ev2', title: '', all_day: false, start_at: '2026-10-14T01:00:00Z', end_at: '2026-10-14T02:00:00Z', rrule: '', color: '' }, '');
    assert.deepStrictEqual(timed.start, { dateTime: '2026-10-14T01:00:00.000Z', timeZone: 'Asia/Tokyo' });
    assert.deepStrictEqual([timed.summary, timed.colorId, timed.recurrence, timed.transparency], ['（タイトルなし）', undefined, undefined, 'opaque']);
    const inst = P.eventBody({ id: 'ev3', recurring_id: 'ev1', rrule: '', all_day: false, start_at: '2026-10-14T01:00:00Z', end_at: '2026-10-14T02:00:00Z' }, '');
    assert.strictEqual(inst.recurrence, undefined);
  });
  t('タスクの中身: 期限（なければいつやる）の日付・完了・メモに時刻と依頼した人と最新状況とリンク', () => {
    const names = { [OTHER]: '依頼 花子' };
    const b = P.taskBody({ id: 't1', title: '報告書', details: '詳しく', assignee: ME, created_by: OTHER, due: '2026-10-20', due_time: '15:00',
      do_date: '2026-10-16', do_time: '', note_text: '半分できた', status: 'doing' }, 'https://example.com/honbu-task/', names);
    assert.deepStrictEqual([b.title, b.status, b.due, b.completed], ['報告書', 'needsAction', '2026-10-20T00:00:00.000Z', null]);
    assert.ok(b.notes.includes('詳しく') && b.notes.includes('期限: 10/20(火) 15:00') && b.notes.includes('いつやる: 10/16(金)'));
    assert.ok(b.notes.includes('依頼: 依頼 花子') && b.notes.includes('最新状況: 半分できた') && b.notes.includes('https://example.com/honbu-task/?task=t1'));
    const d = P.taskBody({ id: 't2', title: '', assignee: ME, do_date: '2026-10-21', status: 'done', completed_at: '2026-10-14T01:00:00Z' }, '', {});
    assert.deepStrictEqual([d.title, d.status, d.due, d.completed], ['（無題）', 'completed', '2026-10-21T00:00:00.000Z', '2026-10-14T01:00:00.000Z']);
  });
  t('タスク: 担当のものを出し、完了は Google にあるときだけ直し、担当でなくなった・消したものは消す', () => {
    const maps = new Map([['task:t3', 'g3'], ['task:t4', 'g4'], ['task:t5', 'g5']]);
    const ops = P.planTasks([
      { id: 't1', assignee: ME, status: 'todo' },
      { id: 't2', assignee: ME, status: 'done' },
      { id: 't3', assignee: ME, status: 'done' },
      { id: 't4', assignee: OTHER, status: 'todo' },
      { id: 't5', assignee: ME, status: 'todo', deleted_at: '2026-10-14T00:00:00Z' },
      { id: 't6', assignee: OTHER, status: 'todo' },
      { id: 't7', assignee: ME, status: 'todo', parent_id: 't1' },
    ], maps, ME);
    assert.deepStrictEqual(ops.map(o => o.row.id + ':' + o.op + ':' + (o.gid || '')), ['t1:upsert:', 't3:upsert:g3', 't4:delete:g4', 't5:delete:g5']);
  });
  t('予定: 自分のカレンダー・ゲストの予定を出し、断った・外された・消したものは消す。1回だけ変えたものは元の予定の後', () => {
    const calendars = { 'cal-me': { id: 'cal-me', owner: ME }, 'cal-o': { id: 'cal-o', owner: OTHER }, 'cal-x': { id: 'cal-x', owner: null, deleted_at: '2026-10-01T00:00:00Z' } };
    const base = { start_at: '2026-10-14T01:00:00Z', end_at: '2026-10-14T02:00:00Z', rrule: '', attendees: [], status: 'confirmed' };
    const rows = [
      Object.assign({}, base, { id: 'x1', rev: 10, recurring_id: 'e1', original_start: '2026-10-21T01:00:00Z', calendar_id: 'cal-me' }),
      Object.assign({}, base, { id: 'e1', rev: 11, calendar_id: 'cal-me', rrule: 'FREQ=WEEKLY' }),
      Object.assign({}, base, { id: 'e2', rev: 12, calendar_id: 'cal-o', attendees: [{ id: ME, response: 'accepted' }] }),
      Object.assign({}, base, { id: 'e3', rev: 13, calendar_id: 'cal-o', attendees: [{ id: ME, response: 'declined' }] }),
      Object.assign({}, base, { id: 'e4', rev: 14, calendar_id: 'cal-o', attendees: [] }),
      Object.assign({}, base, { id: 'e5', rev: 15, calendar_id: 'cal-me', start_at: '2026-08-01T01:00:00Z', end_at: '2026-08-01T02:00:00Z' }),
      Object.assign({}, base, { id: 'e6', rev: 16, calendar_id: 'cal-x' }),
      Object.assign({}, base, { id: 'x2', rev: 17, recurring_id: 'e1', original_start: '2026-10-28T01:00:00Z', calendar_id: 'cal-me', status: 'cancelled' }),
      Object.assign({}, base, { id: 'x3', rev: 18, recurring_id: 'e9', original_start: '2026-10-28T01:00:00Z', calendar_id: 'cal-o' }),
    ];
    const masters = { e1: rows[1], e9: Object.assign({}, base, { id: 'e9', calendar_id: 'cal-o', rrule: 'FREQ=DAILY' }) };
    const maps = new Map([['event:e4', 'g4'], ['event:e6', 'g6'], ['event:x3', 'g9_1']]);
    const ops = P.planEvents(rows, maps, ME, calendars, masters, now);
    assert.deepStrictEqual(ops.map(o => o.row.id + ':' + o.op), ['e1:upsert', 'e2:upsert', 'e4:delete', 'e6:delete', 'x1:instance', 'x2:cancel', 'x3:delete']);
  });
  t('読む行の上限で切れたときは、切れたところまでを読み終えたことにする', () => {
    const r = n => ({ rev: n });
    assert.deepStrictEqual(P.cutoff([[r(5), r(9)], [r(7)]], 3, 20), { truncated: false, upTo: 20 });
    assert.deepStrictEqual(P.cutoff([[r(5), r(9)], [r(7)]], 3, 8), { truncated: false, upTo: 9 });
    assert.deepStrictEqual(P.cutoff([[r(5), r(6), r(9)], [r(7)]], 3, 20), { truncated: true, upTo: 9 });
    assert.deepStrictEqual(P.cutoff([[r(5), r(6), r(9)], [r(2), r(3), r(4)]], 3, 20), { truncated: true, upTo: 4 });
  });

  console.log(passed + ' 件 OK' + (process.exitCode ? '（NG あり）' : ''));
})().catch(e => { console.error(e); process.exit(1); });
