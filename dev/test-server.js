/**
 * サーバー側（gas/*.gs）の動作確認。node dev/test-server.js
 */
'use strict';
const assert = require('assert');
const { createGas } = require('./gas-mock');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  NG  ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
const g = createGas();
const C = g.ctx;
const rpc = (n, p) => JSON.parse(C.rpc(n, p));
const tid = () => 'id' + Math.random().toString(36).slice(2, 12);

C.setup();
const boot = rpc('bootstrap', {});
const listId = boot.lists[0].id;

test('最初の設定でリスト「マイタスク」とシートができる', () => {
  assert.strictEqual(boot.lists.length, 1);
  assert.strictEqual(boot.lists[0].name, 'マイタスク');
  assert.ok(g.ss.getSheetByName('タスク'));
  assert.ok(!g.ss.getSheetByName('シート1'));
  assert.strictEqual(g.triggers.length, 1);
});

const A = tid(), B = tid();
rpc('saveMember', { actor: '', member: { id: A, name: 'テストA', active: true } });
rpc('saveMember', { actor: A, member: { id: B, name: 'テストB', active: true } });

test('誰が・いつまでに・何を が無いと登録できない', () => {
  assert.throws(() => C.rpc('createTask', { actor: A, task: { id: tid(), listId, title: 'x', assignee: A } }), /期限/);
  assert.throws(() => C.rpc('createTask', { actor: A, task: { id: tid(), listId, title: 'x', due: '2026-10-20' } }), /担当者/);
  assert.throws(() => C.rpc('createTask', { actor: A, task: { id: tid(), listId, title: ' ', assignee: A, due: '2026-10-20' } }), /タスク名/);
  assert.throws(() => C.rpc('createTask', { actor: A, task: { id: tid(), listId, title: 'x', assignee: 'nobody', due: '2026-10-20' } }), /担当者が見つかりません/);
  assert.throws(() => C.rpc('createTask', { actor: A, task: { id: tid(), listId, title: 'x', assignee: A, due: '2026-02-30' } }), /日付/);
});

const T1 = tid();
const r1 = rpc('createTask', { actor: A, task: { id: T1, listId, title: '研修資料を作る', assignee: B, due: '2026-10-20', dueTime: '15:00', sortOrder: 0 } });
test('登録すると同期番号が進み、変更分が返る', () => {
  assert.strictEqual(r1.tasks.length, 1);
  assert.strictEqual(r1.tasks[0].status, 'todo');
  assert.strictEqual(r1.tasks[0].createdBy, A);
  assert.ok(r1.rev > boot.rev);
});

test('同じIDで2回届いても1件だけ（通信のやり直し対策）', () => {
  rpc('createTask', { actor: A, task: { id: T1, listId, title: '研修資料を作る', assignee: B, due: '2026-10-20' } });
  const all = rpc('sync', { rev: 0 }).tasks.filter(t => t.id === T1);
  assert.strictEqual(all.length, 1);
});

test('同期: 番号が同じならシートを読まずに「変化なし」', () => {
  const cur = rpc('sync', { rev: 0 }).rev;
  assert.ok(cur >= r1.rev);
  const s = rpc('sync', { rev: cur });
  assert.strictEqual(s.unchanged, true);
});

test('同期: 前回より新しい変更だけ返る', () => {
  const before = rpc('sync', { rev: 0 }).rev;
  rpc('updateTask', { actor: B, id: T1, patch: { details: 'スライド10枚' } });
  const s = rpc('sync', { rev: before });
  assert.strictEqual(s.tasks.length, 1);
  assert.strictEqual(s.tasks[0].details, 'スライド10枚');
  assert.strictEqual(s.lists.length, 0);
});

test('別の人が同時に別の項目を変えても、両方残る（上書きしない）', () => {
  const v = rpc('sync', { rev: 0 }).tasks.find(t => t.id === T1).version;
  rpc('updateTask', { actor: A, id: T1, patch: { title: '研修資料を作って送る' }, baseVersion: v });
  const r = rpc('updateTask', { actor: B, id: T1, patch: { starred: true }, baseVersion: v });
  assert.strictEqual(r.merged, true);
  assert.strictEqual(r.mergedBy, A);
  const t = r.tasks[0];
  assert.strictEqual(t.title, '研修資料を作って送る');
  assert.strictEqual(t.starred, true);
  assert.ok(t.starredAt);
});

test('担当者・期限は空にできない', () => {
  assert.throws(() => C.rpc('updateTask', { actor: A, id: T1, patch: { due: '' } }), /期限/);
  assert.throws(() => C.rpc('updateTask', { actor: A, id: T1, patch: { assignee: '' } }), /担当者/);
});

test('最新状況を書くと履歴に残り、未着手→進行中になる', () => {
  const r = rpc('addNote', { actor: B, taskId: T1, text: '下書きまで完了', id: tid() });
  assert.strictEqual(r.tasks[0].status, 'doing');
  assert.strictEqual(r.tasks[0].noteText, '下書きまで完了');
  const d = rpc('taskDetail', { id: T1 });
  assert.strictEqual(d.notes.length, 1);
  assert.strictEqual(d.notes[0].by, B);
  assert.ok(d.history.some(h => h.field === 'status' && h.after === 'doing'));
});

test('期限の変更は「誰が・何から何に」で記録される', () => {
  rpc('updateTask', { actor: A, id: T1, patch: { due: '2026-10-22' } });
  const h = rpc('taskDetail', { id: T1 }).history.find(x => x.field === 'due');
  assert.strictEqual(h.before, '2026-10-20');
  assert.strictEqual(h.after, '2026-10-22');
  assert.strictEqual(h.by, A);
});

test('サブタスクは担当・期限なしで作れて、親を完了すると一緒に完了する', () => {
  const S1 = tid();
  rpc('createTask', { actor: A, task: { id: S1, parentId: T1, title: '表紙', sortOrder: 1 } });
  const r = rpc('updateTask', { actor: B, id: T1, patch: { status: 'done' } });
  const sub = r.tasks.find(t => t.id === S1);
  assert.strictEqual(sub.status, 'done');
  const parent = r.tasks.find(t => t.id === T1);
  assert.strictEqual(parent.completedBy, B);
  assert.strictEqual(parent.onTime, true);
  rpc('updateTask', { actor: B, id: T1, patch: { status: 'doing' } });
  const p2 = rpc('sync', { rev: 0 }).tasks.find(t => t.id === T1);
  assert.strictEqual(p2.completedAt, '');
});

test('繰り返しタスクは完了すると次の回ができる', () => {
  const R = tid();
  rpc('createTask', { actor: A, task: { id: R, listId, title: '週報', assignee: A, due: '2026-10-16', repeat: 'weekly' } });
  const r = rpc('updateTask', { actor: A, id: R, patch: { status: 'done' } });
  const next = r.tasks.find(t => t.id !== R && t.title === '週報');
  assert.ok(next, '次の回がない');
  assert.strictEqual(next.due, '2026-10-23');
  assert.strictEqual(next.status, 'todo');
  // もう一度完了→未完了→完了でも、次の回は増えない
  rpc('updateTask', { actor: A, id: R, patch: { status: 'todo' } });
  rpc('updateTask', { actor: A, id: R, patch: { status: 'done' } });
  assert.strictEqual(rpc('sync', { rev: 0 }).tasks.filter(t => t.title === '週報').length, 2);
});

test('繰り返しの次の期限の計算', () => {
  assert.strictEqual(C.nextDue_('2026-10-16', 'daily'), '2026-10-17');
  assert.strictEqual(C.nextDue_('2026-10-16', 'weekdays'), '2026-10-19'); // 金→月
  assert.strictEqual(C.nextDue_('2026-01-31', 'monthly'), '2026-02-28');
  assert.strictEqual(C.nextDue_('2028-02-29', 'yearly'), '2029-02-28');
  assert.strictEqual(C.nextDue_('2026-10-13', 'every:3:day'), '2026-10-16');
  assert.strictEqual(C.nextDue_('2026-10-13', 'every:2:week'), '2026-10-27');
  assert.strictEqual(C.nextDue_('2026-10-13', 'every:1:week:1,4'), '2026-10-15'); // 火→木
  assert.strictEqual(C.nextDue_('2026-10-15', 'every:2:week:1,4'), '2026-10-26'); // 木→2週後の月
});

test('祝日（振替休日・国民の休日を含む）', () => {
  const h = C.jpHolidays_(2026);
  ['2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06',
    '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23'].forEach(d => assert.ok(h[d], d));
  assert.ok(!h['2026-10-13']);
  assert.strictEqual(Object.keys(h).length, 18);
  const h27 = C.jpHolidays_(2027);
  assert.ok(h27['2027-03-22'], '2027 振替（春分の日が日曜）');
});

test('削除→ごみ箱→元に戻す', () => {
  const D = tid();
  rpc('createTask', { actor: A, task: { id: D, listId, title: '消すタスク', assignee: A, due: '2026-10-30' } });
  rpc('deleteTask', { actor: B, id: D });
  assert.ok(!rpc('sync', { rev: 0 }).tasks.some(t => t.id === D));
  const trash = rpc('trash', {});
  assert.ok(trash.items.some(t => t.id === D && t.deletedBy === B));
  rpc('restoreTask', { actor: A, id: D });
  assert.ok(rpc('sync', { rev: 0 }).tasks.some(t => t.id === D));
});

test('リスト: 作成・名前変更・削除（最後の1つは消せない）', () => {
  const L = tid();
  rpc('createList', { actor: A, id: L, name: '研修' });
  rpc('updateList', { actor: A, id: L, patch: { name: '研修・教育', sortMode: 'date' } });
  const X = tid();
  rpc('createTask', { actor: A, task: { id: X, listId: L, title: 'リスト内', assignee: A, due: '2026-10-30' } });
  rpc('deleteList', { actor: A, id: L });
  const s = rpc('sync', { rev: 0 });
  assert.ok(!s.lists.some(l => l.id === L));
  assert.ok(!s.tasks.some(t => t.id === X));
  assert.throws(() => C.rpc('deleteList', { actor: A, id: listId }), /最低1つ/);
});

test('メール設定の入力チェック', () => {
  assert.throws(() => C.rpc('saveConfig', { config: { mail: { enabled: true, recipients: ['abc'] } } }), /メールアドレス/);
  assert.throws(() => C.rpc('saveConfig', { config: { mail: { enabled: true, recipients: [] } } }), /送信先/);
  const r = rpc('saveConfig', { actor: A, config: { mail: { enabled: true, recipients: ['honbu@example.com'], days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18, skipHolidays: true, skipYearEnd: true, sendWhenNoChange: true }, soonDays: 3, staleDays: 3 } });
  assert.strictEqual(r.config.mail.recipients[0], 'honbu@example.com');
});

test('毎時メール: 時間帯・曜日・祝日・同じ時間に二重送信しない', () => {
  const at = s => new Date(s);
  g.mails.length = 0;
  assert.strictEqual(C.maybeSendReport_(at('2026-10-13T00:02:00Z')), true);  // 火 9:02 JST
  assert.strictEqual(C.maybeSendReport_(at('2026-10-13T00:07:00Z')), false); // 同じ時間
  assert.strictEqual(C.maybeSendReport_(at('2026-10-13T08:50:00Z')), false); // 17:50 は遅すぎ
  assert.strictEqual(C.maybeSendReport_(at('2026-10-13T10:01:00Z')), false); // 19時は時間外
  assert.strictEqual(C.maybeSendReport_(at('2026-10-12T01:01:00Z')), false); // 10/12 スポーツの日
  assert.strictEqual(C.maybeSendReport_(at('2026-10-17T01:01:00Z')), false); // 土曜
  assert.strictEqual(C.maybeSendReport_(at('2026-10-13T01:03:00Z')), true);  // 10時
  assert.strictEqual(g.mails.length, 2);
  const m = g.mails[0];
  assert.strictEqual(m.to, 'honbu@example.com');
  assert.ok(/【本部タスク】10\/13\(火\) 9:02時点/.test(m.subject), m.subject);
  assert.ok(m.htmlBody.indexOf('担当者別') > 0);
  assert.ok(m.body.indexOf('研修資料を作って送る') >= 0 || m.body.indexOf('週報') >= 0);
});

test('メール: 期限切れ・今日まで・担当者別が正しく数えられる', () => {
  const O = tid(), TD = tid();
  rpc('createTask', { actor: A, task: { id: O, listId, title: '期限切れのタスク', assignee: B, due: '2026-10-10' } });
  rpc('createTask', { actor: A, task: { id: TD, listId, title: '今日のタスク', assignee: A, due: '2026-10-13', dueTime: '18:00' } });
  const st = C.collectStatus_(new Date('2026-10-13T05:00:00Z'), null); // 14:00 JST
  assert.ok(st.overdue.some(t => t.id === O));
  assert.ok(st.todayDue.some(t => t.id === TD));
  const rb = st.byAssignee.find(r => r.id === B);
  assert.ok(rb.overdue >= 1);
  const rep = C.buildReport_(new Date('2026-10-13T05:00:00Z'), null);
  assert.ok(rep.subject.indexOf('期限切れ') > 0);
  assert.ok(rep.html.indexOf('期限切れのタスク') > 0);
  assert.ok(rep.html.indexOf('日超過') > 0);
});

test('送信に失敗したら、次の回にやり直す', () => {
  const g2 = createGas({ failMail: true });
  g2.ctx.setup();
  JSON.parse(g2.ctx.rpc('saveConfig', { config: { mail: { enabled: true, recipients: ['a@example.com'], days: [2], startHour: 9, endHour: 18, sendWhenNoChange: true } } }));
  assert.throws(() => g2.ctx.maybeSendReport_(new Date('2026-10-13T00:02:00Z')));
  assert.ok(!g2.props.MAIL_HOUR, '失敗したのに送信済みの印が残っている');
});

test('ごみ箱の片付けで30日たったものを消し、古い画面は全部読み直す', () => {
  const g3 = createGas();
  g3.ctx.setup();
  const r = x => JSON.parse(g3.ctx.rpc(x[0], x[1]));
  const L = r(['bootstrap', {}]).lists[0].id;
  const M = tid();
  r(['saveMember', { member: { id: M, name: 'M', active: true } }]);
  const K = tid();
  r(['createTask', { actor: M, task: { id: K, listId: L, title: '古い', assignee: M, due: '2026-01-01' } }]);
  const del = r(['deleteTask', { actor: M, id: K }]);
  g3.clock.offset = 31 * 86400000;
  const now = new Date(Date.now() + g3.clock.offset);
  const j = g3.ctx.jst_(now);
  const at3 = new Date(now.getTime() + ((3 - j.h + 24) % 24) * 3600000);
  g3.ctx.dailyCleanup_(at3);
  const s = r(['sync', { rev: del.rev - 1 }]);
  assert.strictEqual(s.full, true);
  assert.strictEqual(r(['trash', {}]).items.length, 0);
});

test('シートを人が直接いじって日付型になっても読める', () => {
  const sh = g.ss.getSheetByName('タスク');
  const row = sh.data.findIndex(r => r && r[0] === T1);
  sh.data[row][6] = new Date('2026-10-25T00:00:00+09:00');
  const t = rpc('sync', { rev: 0 }).tasks.find(x => x.id === T1);
  assert.strictEqual(t.due, '2026-10-25');
});

console.log('\n' + passed + ' 件 OK' + (process.exitCode ? '（失敗あり）' : ''));
