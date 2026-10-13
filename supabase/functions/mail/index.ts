// 本部タスク: メールの中身を作る処理
// - action "poll"   : 送信用 GAS が毎分たずねてくる。送る時刻なら宛先・件名・本文を返す（合言葉が必要）
// - action "result" : 送信用 GAS が送った結果を知らせる（合言葉が必要）
// - action "preview": 画面の設定から、メールのプレビューを見る（ログインした本部の人だけ）
import { createClient } from 'npm:@supabase/supabase-js@2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-relay-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

/* ---------- 内部の状態 ---------- */

async function getState(key: string): Promise<string> {
  const { data } = await sb.from('app_state').select('value').eq('key', key).maybeSingle();
  return (data && data.value) || '';
}
async function setState(key: string, value: string) {
  await sb.from('app_state').upsert({ key, value, updated_at: new Date().toISOString() });
}

const DEFAULT = {
  mail: {
    enabled: false, recipients: [] as string[], days: [1, 2, 3, 4, 5], startHour: 10, endHour: 17, summaryTime: '17:30',
    skipHolidays: true, skipYearEnd: true, sendWhenNoChange: true,
  },
  soonDays: 3,
  staleDays: 3,
};
type Config = typeof DEFAULT;

async function getConfig(): Promise<Config> {
  const { data } = await sb.from('settings').select('value').eq('key', 'app').maybeSingle();
  const saved = (data && data.value) || {};
  return { ...DEFAULT, ...saved, mail: { ...DEFAULT.mail, ...(saved.mail || {}) } };
}

/* ---------- 日本時間の道具 ---------- */

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;
const ymdStr = (y: number, m: number, d: number) => y + '-' + pad2(m) + '-' + pad2(d);
function jst(date: Date) {
  const d = new Date(date.getTime() + 9 * 3600000);
  const o = { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay(), ymd: '' };
  o.ymd = ymdStr(o.y, o.mo, o.d);
  return o;
}
function addDaysYmd(ymd: string, n: number) {
  const p = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return ymdStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function dowYmd(ymd: string) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}
// deno-lint-ignore no-explicit-any
function dueAt(t: any) {
  if (!t.due) return Infinity;
  return new Date(t.due + 'T' + (t.due_time || '23:59') + ':59+09:00').getTime();
}

/* ---------- 祝日・会社の休み ---------- */

const holidayCache: Record<number, Record<string, boolean>> = {};
function jpHolidays(year: number) {
  if (holidayCache[year]) return holidayCache[year];
  const set: Record<string, boolean> = {};
  const add = (m: number, d: number) => { set[ymdStr(year, m, d)] = true; };
  const nthMonday = (m: number, n: number) => {
    const first = new Date(Date.UTC(year, m - 1, 1)).getUTCDay();
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  };
  const shift = Math.floor((year - 1980) / 4);
  add(1, 1); add(1, nthMonday(1, 2)); add(2, 11); add(2, 23);
  add(3, Math.floor(20.8431 + 0.242194 * (year - 1980) - shift));
  add(4, 29); add(5, 3); add(5, 4); add(5, 5);
  add(7, nthMonday(7, 3)); add(8, 11); add(9, nthMonday(9, 3));
  add(9, Math.floor(23.2488 + 0.242194 * (year - 1980) - shift));
  add(10, nthMonday(10, 2)); add(11, 3); add(11, 23);
  const base = Object.keys(set).sort();
  base.forEach((h) => { // 国民の休日
    const mid = addDaysYmd(h, 1);
    if (!set[mid] && set[addDaysYmd(h, 2)] && dowYmd(mid) !== 0) set[mid] = true;
  });
  base.forEach((h) => { // 振替休日
    if (dowYmd(h) !== 0) return;
    let n = addDaysYmd(h, 1);
    while (set[n]) n = addDaysYmd(n, 1);
    set[n] = true;
  });
  holidayCache[year] = set;
  return set;
}
function isOffDay(ymd: string, m: Config['mail']) {
  if (m.skipYearEnd) {
    const md = ymd.slice(5);
    if (md >= '12-29' || md <= '01-03') return true;
  }
  return !!(m.skipHolidays && jpHolidays(Number(ymd.slice(0, 4)))[ymd]);
}

/* ---------- 送る時刻 ---------- */

function mailSlots(m: Config['mail']) {
  const slots: { time: string; summary: boolean }[] = [];
  for (let h = m.startHour; h <= m.endHour; h++) slots.push({ time: pad2(h) + ':00', summary: false });
  if (m.summaryTime) {
    const same = slots.find((s) => s.time === m.summaryTime);
    if (same) same.summary = true;
    else slots.push({ time: m.summaryTime, summary: true });
  }
  return slots.sort((a, b) => (a.time < b.time ? -1 : 1));
}
const toMin = (hhmm: string) => { const p = hhmm.split(':').map(Number); return p[0] * 60 + p[1]; };

/* ---------- 今の状況をまとめる（画面の進捗ボードと同じ考え方） ---------- */

// deno-lint-ignore no-explicit-any
type Row = any;
async function collect(now: Date, sinceIso: string, summary: boolean) {
  const cfg = await getConfig();
  const j = jst(now);
  const today = j.ymd;
  const tomorrow = addDaysYmd(today, 1);
  const soonLimit = addDaysYmd(today, cfg.soonDays);
  const staleLimit = now.getTime() - cfg.staleDays * 86400000;
  const recent = new Date(now.getTime() - 8 * 86400000).toISOString();

  const [{ data: members }, { data: lists }, { data: tasks }] = await Promise.all([
    sb.from('members').select('*'),
    sb.from('lists').select('*').is('deleted_at', null),
    sb.from('tasks').select('*').is('deleted_at', null).is('parent_id', null).or(`status.neq.done,completed_at.gte.${recent},created_at.gte.${recent}`),
  ]);
  const mem: Record<string, Row> = {};
  (members || []).forEach((m: Row) => { mem[m.id] = m; });
  const lst: Record<string, Row> = {};
  (lists || []).forEach((l: Row) => { lst[l.id] = l; });
  const top = (tasks || []).filter((t: Row) => lst[t.list_id]);

  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;
  const hasPrev = !summary && !!sinceMs && now.getTime() - sinceMs < 24 * 3600000;
  const since = summary
    ? new Date(today + 'T00:00:00+09:00').toISOString()
    : hasPrev ? new Date(sinceMs).toISOString() : new Date(now.getTime() - 3600000).toISOString();
  const sinceT = new Date(since).getTime();
  const after = (iso: string) => !!iso && new Date(iso).getTime() >= sinceT;

  const open = top.filter((t: Row) => t.status !== 'done');
  const s = { overdue: [] as Row[], today: [] as Row[], soon: [] as Row[], stale: [] as Row[], tomorrow: [] as Row[] };
  open.forEach((t: Row) => {
    const at = dueAt(t);
    if (at < now.getTime()) s.overdue.push(t);
    else if (t.due === today) s.today.push(t);
    else if (t.due && t.due <= soonLimit) s.soon.push(t);
    if (at >= now.getTime() && t.due === tomorrow) s.tomorrow.push(t);
    const last = Math.max(new Date(t.updated_at || 0).getTime(), new Date(t.note_at || 0).getTime(), new Date(t.created_at || 0).getTime());
    if (last < staleLimit) s.stale.push(t);
  });
  const byDue = (a: Row, b: Row) => dueAt(a) - dueAt(b);
  Object.values(s).forEach((arr) => arr.sort(byDue));

  const created = top.filter((t: Row) => after(t.created_at));
  const completed = top.filter((t: Row) => t.status === 'done' && after(t.completed_at));
  const { data: notes } = await sb.from('task_notes').select('task_id').gte('created_at', since);
  const noteIds: Record<string, boolean> = {};
  (notes || []).forEach((n: Row) => { noteIds[n.task_id] = true; });
  const noted = top.filter((t: Row) => noteIds[t.id]);

  const weekStart = addDaysYmd(today, -((j.dow + 6) % 7));
  const rows: Record<string, Row> = {};
  const row = (id: string) => rows[id] || (rows[id] = { id, overdue: 0, today: 0, soon: 0, doing: 0, todo: 0, doneWeek: 0 });
  s.overdue.forEach((t) => row(t.assignee).overdue++);
  s.today.forEach((t) => row(t.assignee).today++);
  s.soon.forEach((t) => row(t.assignee).soon++);
  open.forEach((t: Row) => row(t.assignee)[t.status === 'doing' ? 'doing' : 'todo']++);
  top.filter((t: Row) => t.status === 'done' && t.completed_at && jst(new Date(t.completed_at)).ymd >= weekStart)
    .forEach((t: Row) => row(t.assignee).doneWeek++);
  const byAssignee = Object.values(rows).sort((a: Row, b: Row) => ((mem[a.id] || {}).sort_order ?? 9999) - ((mem[b.id] || {}).sort_order ?? 9999));

  return {
    cfg, since, hasPrev, mem, openCount: open.length,
    overdue: s.overdue, todayDue: s.today, soon: s.soon, stale: s.stale, tomorrowDue: s.tomorrow,
    created, completed, noted, byAssignee,
  };
}

/* ---------- メールの中身 ---------- */

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const fmtMd = (ymd: string) => { const p = ymd.split('-').map(Number); return p[1] + '/' + p[2] + '(' + DOW[dowYmd(ymd)] + ')'; };
const fmtAt = (iso: string) => { if (!iso) return ''; const j = jst(new Date(iso)); return j.mo + '/' + j.d + ' ' + j.h + ':' + pad2(j.mi); };
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function buildReport(now: Date, sinceIso: string, opts: { slot?: string; summary?: boolean }) {
  const st = await collect(now, sinceIso, !!opts.summary);
  const sum = !!opts.summary;
  const j = jst(now);
  const url = await getState('app_url');
  const name = (id: string) => (st.mem[id] ? st.mem[id].name : '（未設定）');
  const dueText = (t: Row) => fmtMd(t.due) + (t.due_time ? ' ' + t.due_time : '');
  const overDays = (t: Row) => Math.max(1, Math.floor((now.getTime() - dueAt(t)) / 86400000) + 1);
  const statusText = (t: Row) => (t.status === 'doing' ? '進行中' : t.status === 'done' ? '完了' : '未着手');
  const clock = opts.slot ? String(Number(opts.slot.split(':')[0])) + ':' + opts.slot.split(':')[1] : j.h + ':' + pad2(j.mi);
  const timeLabel = j.mo + '/' + j.d + '(' + DOW[j.dow] + ') ' + clock;
  const sinceLabel = sum ? '今日の動き' : st.hasPrev ? '前回のメール（' + fmtAt(st.since) + '）以降の動き' : 'この1時間の動き';
  const subject = sum
    ? '【本部タスク】' + timeLabel + ' 今日のまとめ　完了' + st.completed.length + '件・期限切れ' + st.overdue.length + '件・明日まで' + st.tomorrowDue.length + '件'
    : '【本部タスク】' + timeLabel + '時点　期限切れ' + st.overdue.length + '件・今日まで' + st.todayDue.length + '件';
  const link = (t: Row) => (url ? url + '?task=' + encodeURIComponent(t.id) : '');

  /* 文字だけのメール */
  const lines: string[] = [];
  lines.push(sum ? '本部タスク 今日のまとめ（' + timeLabel + '）' : '本部タスクの状況（' + timeLabel + ' 時点）', '');
  lines.push('■ まとめ');
  lines.push('未完了 ' + st.openCount + '件（期限切れ ' + st.overdue.length + '件／今日まで ' + st.todayDue.length + '件／' + st.cfg.soonDays + '日以内 ' + st.soon.length + '件）');
  lines.push(sinceLabel + ': 新規 ' + st.created.length + '件・完了 ' + st.completed.length + '件・最新状況の更新 ' + st.noted.length + '件', '');
  const textBlock = (title: string, arr: Row[], withOver: boolean) => {
    lines.push('■ ' + title + '（' + arr.length + '件）');
    if (!arr.length) lines.push('なし');
    arr.forEach((t) => {
      lines.push('・' + (withOver ? '[' + overDays(t) + '日超過] ' : '') + t.title + '　担当: ' + name(t.assignee) + '　期限: ' + dueText(t) + '　' + statusText(t));
      lines.push('　最新状況: ' + (t.note_text ? '（' + fmtAt(t.note_at) + '）' + t.note_text : 'まだ入力がありません'));
    });
    lines.push('');
  };
  textBlock('期限切れ', st.overdue, true);
  textBlock(sum ? '今日まで（残り）' : '今日まで', st.todayDue, false);
  if (sum) textBlock('明日まで', st.tomorrowDue, false);
  else textBlock(st.cfg.soonDays + '日以内', st.soon, false);
  lines.push('■ ' + sinceLabel);
  st.completed.forEach((t: Row) => lines.push('・完了: ' + t.title + '（' + name(t.completed_by || t.assignee) + '）'));
  st.created.forEach((t: Row) => lines.push('・新規: ' + t.title + '（担当: ' + name(t.assignee) + '、期限: ' + dueText(t) + '）'));
  st.noted.forEach((t: Row) => lines.push('・最新状況: ' + t.title + ' → ' + t.note_text));
  if (!st.completed.length && !st.created.length && !st.noted.length) lines.push('動きはありませんでした');
  lines.push('');
  lines.push('■ 担当者別（期限切れ／今日まで／' + st.cfg.soonDays + '日以内／進行中／未着手）');
  st.byAssignee.forEach((r: Row) => lines.push('・' + name(r.id) + '　' + r.overdue + '／' + r.today + '／' + r.soon + '／' + r.doing + '／' + r.todo));
  if (st.stale.length) {
    lines.push('', '■ ' + st.cfg.staleDays + '日以上更新が止まっているタスク（' + st.stale.length + '件）');
    st.stale.forEach((t) => lines.push('・' + t.title + '　担当: ' + name(t.assignee) + '　期限: ' + dueText(t)));
  }
  if (url) lines.push('', '▶ アプリで開く: ' + url);

  /* 見やすいメール（HTML） */
  const C = { red: '#b3261e', orange: '#b25e00', blue: '#0b57d0', green: '#146c2e', gray: '#5f6368', line: '#e0e3e7' };
  const h: string[] = [];
  h.push('<div style="font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',\'Yu Gothic UI\',Meiryo,sans-serif;color:#1f1f1f;max-width:680px;margin:0 auto;line-height:1.6">');
  h.push('<div style="padding:16px 20px;background:#0b57d0;color:#fff;border-radius:12px 12px 0 0"><div style="font-size:13px;opacity:.85">本部タスク</div>' +
    '<div style="font-size:20px;font-weight:bold">' + esc(sum ? '今日のまとめ（' + timeLabel + '）' : timeLabel + ' 時点の状況') + '</div></div>');
  h.push('<div style="border:1px solid ' + C.line + ';border-top:0;border-radius:0 0 12px 12px;padding:16px 20px">');
  const tile = (label: string, n: number, color: string) => '<td style="padding:4px"><div style="border:1px solid ' + C.line + ';border-radius:10px;padding:10px;text-align:center">' +
    '<div style="font-size:12px;color:' + C.gray + '">' + label + '</div><div style="font-size:24px;font-weight:bold;color:' + color + '">' + n + '</div></div></td>';
  h.push('<table role="presentation" style="width:100%;border-collapse:collapse"><tr>' +
    (sum ? tile('今日の完了', st.completed.length, C.green) : tile('未完了', st.openCount, '#1f1f1f')) +
    tile('期限切れ', st.overdue.length, st.overdue.length ? C.red : '#1f1f1f') +
    tile(sum ? '今日まで（残り）' : '今日まで', st.todayDue.length, st.todayDue.length ? C.orange : '#1f1f1f') +
    (sum ? tile('明日まで', st.tomorrowDue.length, '#1f1f1f') : tile(st.cfg.soonDays + '日以内', st.soon.length, '#1f1f1f')) + '</tr></table>');
  h.push('<p style="margin:8px 0 0;font-size:13px;color:' + C.gray + '">' + esc(sinceLabel) + ': 新規 ' + st.created.length + '件・完了 ' + st.completed.length + '件・最新状況の更新 ' + st.noted.length + '件</p>');
  const section = (title: string, color: string, arr: Row[], withOver: boolean) => {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + color + ';padding-left:8px">' + esc(title) + '（' + arr.length + '件）</h3>');
    if (!arr.length) { h.push('<div style="color:' + C.gray + ';font-size:14px">なし</div>'); return; }
    arr.forEach((t) => {
      const titleHtml = link(t) ? '<a href="' + esc(link(t)) + '" style="color:#1f1f1f;font-weight:bold;text-decoration:none">' + esc(t.title) + '</a>' : '<b>' + esc(t.title) + '</b>';
      h.push('<div style="padding:8px 0;border-bottom:1px solid ' + C.line + '">' +
        (withOver ? '<span style="color:' + C.red + ';font-weight:bold;font-size:13px">[' + overDays(t) + '日超過] </span>' : '') + titleHtml +
        '<div style="font-size:13px;color:' + C.gray + '">担当: ' + esc(name(t.assignee)) + '　期限: <span style="color:' + (withOver ? C.red : C.gray) + '">' + esc(dueText(t)) + '</span>　' + statusText(t) + '</div>' +
        '<div style="font-size:13px;color:#444">最新状況: ' + (t.note_text ? esc(t.note_text) + ' <span style="color:' + C.gray + '">（' + fmtAt(t.note_at) + '）</span>' : '<span style="color:' + C.gray + '">まだ入力がありません</span>') + '</div></div>');
    });
  };
  const moves = () => {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + (sum ? C.green : C.gray) + ';padding-left:8px">' + esc(sinceLabel) + '</h3><div style="font-size:14px">');
    st.completed.forEach((t: Row) => h.push('<div>✅ 完了: ' + esc(t.title) + '（' + esc(name(t.completed_by || t.assignee)) + '）</div>'));
    st.created.forEach((t: Row) => h.push('<div>🆕 新規: ' + esc(t.title) + '（担当: ' + esc(name(t.assignee)) + '、期限: ' + esc(dueText(t)) + '）</div>'));
    st.noted.forEach((t: Row) => h.push('<div>💬 ' + esc(t.title) + ' → ' + esc(t.note_text) + '</div>'));
    if (!st.completed.length && !st.created.length && !st.noted.length) h.push('<div style="color:' + C.gray + '">動きはありませんでした</div>');
    h.push('</div>');
  };
  if (sum) moves();
  section('期限切れ', C.red, st.overdue, true);
  section(sum ? '今日まで（残り）' : '今日まで', C.orange, st.todayDue, false);
  if (sum) section('明日まで', C.blue, st.tomorrowDue, false);
  else section(st.cfg.soonDays + '日以内', C.blue, st.soon, false);
  if (!sum) moves();
  h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + C.gray + ';padding-left:8px">担当者別</h3>');
  const th = (s: string) => '<th style="padding:6px 8px;border-bottom:2px solid ' + C.line + ';font-size:12px;color:' + C.gray + ';text-align:center">' + s + '</th>';
  const td = (n: number, color?: string) => '<td style="padding:6px 8px;border-bottom:1px solid ' + C.line + ';text-align:center;' + (n && color ? 'color:' + color + ';font-weight:bold' : '') + '">' + n + '</td>';
  h.push('<table style="width:100%;border-collapse:collapse;font-size:14px"><tr>' + th('担当') + th('期限切れ') + th('今日まで') + th(st.cfg.soonDays + '日以内') + th('進行中') + th('未着手') + th('今週の完了') + '</tr>');
  st.byAssignee.forEach((r: Row) => {
    h.push('<tr><td style="padding:6px 8px;border-bottom:1px solid ' + C.line + '">' + esc(name(r.id)) + '</td>' + td(r.overdue, C.red) + td(r.today, C.orange) + td(r.soon) + td(r.doing) + td(r.todo) + td(r.doneWeek) + '</tr>');
  });
  if (!st.byAssignee.length) h.push('<tr><td colspan="7" style="padding:8px;color:' + C.gray + '">タスクはありません</td></tr>');
  h.push('</table>');
  if (st.stale.length) {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + C.gray + ';padding-left:8px">' + st.cfg.staleDays + '日以上更新が止まっているタスク（' + st.stale.length + '件）</h3><div style="font-size:14px">');
    st.stale.forEach((t) => h.push('<div>・' + esc(t.title) + '　<span style="color:' + C.gray + '">担当: ' + esc(name(t.assignee)) + '　期限: ' + esc(dueText(t)) + '</span></div>'));
    h.push('</div>');
  }
  if (url) h.push('<p style="margin:24px 0 4px;text-align:center"><a href="' + esc(url) + '" style="display:inline-block;background:#0b57d0;color:#fff;padding:10px 24px;border-radius:20px;text-decoration:none;font-weight:bold">アプリで開く</a></p>');
  h.push('<p style="font-size:12px;color:' + C.gray + ';margin-top:16px">このメールは本部タスクから自動で送っています。タスク名や最新状況に、利用者さんの個人情報は書かないでください。</p>');
  h.push('</div></div>');
  return { subject, text: lines.join('\n'), html: h.join('') };
}

/* ---------- 送信用 GAS とのやりとり ---------- */

// deno-lint-ignore no-explicit-any
async function poll(body: any) {
  const now = new Date();
  await setState('relay_seen_at', now.toISOString());
  if (typeof body.quota === 'number') await setState('relay_quota', String(body.quota));
  const cfg = await getConfig();
  const m = cfg.mail;

  if (await getState('test_request')) {
    await setState('test_request', '');
    if (!m.recipients.length) return { send: false };
    const rep = await buildReport(now, await getState('mail_at'), {});
    return { send: true, kind: 'test', key: '', to: m.recipients, subject: '[テスト] ' + rep.subject, html: rep.html, text: rep.text };
  }

  if (!m.enabled || !m.recipients.length) return { send: false };
  const j = jst(now);
  if (m.days.indexOf(j.dow) < 0) return { send: false };
  // 今の時刻までに来た送信時刻のうち一番新しいもの（20分以上遅れた回は送らない）
  const nowMin = j.h * 60 + j.mi;
  const due = mailSlots(m).filter((s) => toMin(s.time) <= nowMin && nowMin - toMin(s.time) < 20).pop();
  if (!due) return { send: false };
  const key = j.ymd + ' ' + due.time;
  if ((await getState('mail_slot')) === key) return { send: false };
  await setState('mail_slot', key); // 先に印を付けて二重送信を防ぐ
  if (isOffDay(j.ymd, m)) return { send: false };
  const rev = await getState('rev');
  if (!due.summary && !m.sendWhenNoChange && rev === (await getState('mail_rev'))) return { send: false };
  const rep = await buildReport(now, await getState('mail_at'), { slot: due.time, summary: due.summary });
  return { send: true, kind: 'slot', key, rev, to: m.recipients, subject: rep.subject, html: rep.html, text: rep.text };
}

// deno-lint-ignore no-explicit-any
async function result(body: any) {
  await sb.from('mail_log').insert({
    to_addr: Array.isArray(body.to) ? body.to.join(', ') : String(body.to || ''),
    subject: String(body.subject || ''),
    result: body.ok ? '送信済み' : '失敗',
    error: String(body.error || ''),
  });
  if (body.kind === 'slot') {
    if (body.ok) {
      await setState('mail_rev', String(body.rev || ''));
      await setState('mail_at', new Date().toISOString());
    } else if ((await getState('mail_slot')) === body.key) {
      await setState('mail_slot', ''); // 1分後にやり直す
    }
  }
  return { ok: true };
}

async function isStaff(req: Request) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return false;
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data.user || !data.user.email) return false;
  const { data: rows } = await sb.from('app_access').select('email');
  const email = data.user.email.toLowerCase();
  return (rows || []).some((r: Row) => String(r.email).toLowerCase() === email);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === 'poll' || body.action === 'result') {
      const token = req.headers.get('x-relay-token') || body.token || '';
      const saved = await getState('relay_token');
      if (!saved || token !== saved) return json({ error: '合言葉が違います' }, 403);
      return json(body.action === 'poll' ? await poll(body) : await result(body));
    }
    if (body.action === 'preview') {
      if (!(await isStaff(req))) return json({ error: 'ログインしてください' }, 401);
      const rep = await buildReport(new Date(), await getState('mail_at'), { summary: !!body.summary });
      return json({ subject: rep.subject, html: rep.html });
    }
    return json({ error: '不明な操作です' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
