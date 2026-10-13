// 本部タスク: メールの中身を作る（データベースには触らない。渡されたデータから件名・本文を作るだけ）
// 送信用の処理（index.ts）と、手元の見本づくり（dev/mail-sample.js）の両方から使う

// deno-lint-ignore no-explicit-any
export type Row = any;

export const DEFAULT = {
  mail: {
    enabled: false, recipients: [] as string[], days: [1, 2, 3, 4, 5], startHour: 10, endHour: 17, summaryTime: '17:30',
    skipHolidays: true, skipYearEnd: true, sendWhenNoChange: true,
  },
  soonDays: 3,
  staleDays: 3,
};
export type Config = typeof DEFAULT;

export function mergeConfig(saved: Row): Config {
  const s = saved || {};
  return { ...DEFAULT, ...s, mail: { ...DEFAULT.mail, ...(s.mail || {}) } };
}

/* ---------- 日本時間の道具 ---------- */

export const pad2 = (n: number) => (n < 10 ? '0' : '') + n;
const ymdStr = (y: number, m: number, d: number) => y + '-' + pad2(m) + '-' + pad2(d);
export function jst(date: Date) {
  const d = new Date(date.getTime() + 9 * 3600000);
  const o = { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay(), ymd: '' };
  o.ymd = ymdStr(o.y, o.mo, o.d);
  return o;
}
export function addDaysYmd(ymd: string, n: number) {
  const p = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return ymdStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function dowYmd(ymd: string) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}
const dayNum = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86400000;
const ymdOf = (v: unknown) => (v ? String(v).slice(0, 10) : '');
export function dueAt(t: Row) {
  if (!t.due) return Infinity;
  return new Date(ymdOf(t.due) + 'T' + (t.due_time || '23:59') + ':59+09:00').getTime();
}

/* ---------- 祝日・会社の休み ---------- */

const holidayCache: Record<number, Record<string, boolean>> = {};
export function jpHolidays(year: number) {
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
export function isOffDay(ymd: string, m: Config['mail']) {
  if (m.skipYearEnd) {
    const md = ymd.slice(5);
    if (md >= '12-29' || md <= '01-03') return true;
  }
  return !!(m.skipHolidays && jpHolidays(Number(ymd.slice(0, 4)))[ymd]);
}

/* ---------- 送る時刻 ---------- */

export function mailSlots(m: Config['mail']) {
  const slots: { time: string; summary: boolean }[] = [];
  for (let h = m.startHour; h <= m.endHour; h++) slots.push({ time: pad2(h) + ':00', summary: false });
  if (m.summaryTime) {
    const same = slots.find((s) => s.time === m.summaryTime);
    if (same) same.summary = true;
    else slots.push({ time: m.summaryTime, summary: true });
  }
  return slots.sort((a, b) => (a.time < b.time ? -1 : 1));
}
export const toMin = (hhmm: string) => { const p = hhmm.split(':').map(Number); return p[0] * 60 + p[1]; };

/* ---------- 「どこから後の動き」を載せるか ---------- */

export function reportWindow(now: Date, lastMailIso: string, summary: boolean) {
  const lastMs = lastMailIso ? new Date(lastMailIso).getTime() : 0;
  const hasPrev = !summary && !!lastMs && now.getTime() - lastMs < 24 * 3600000;
  const since = summary
    ? new Date(jst(now).ymd + 'T00:00:00+09:00').toISOString()
    : hasPrev ? new Date(lastMs).toISOString() : new Date(now.getTime() - 3600000).toISOString();
  return { since, hasPrev };
}

/* ---------- 繰り返しの言い方（画面と同じ） ---------- */

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const RR_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export function repeatText(rule: string, anchor: string) {
  if (!rule) return '';
  const get = (k: string) => { const m = rule.split(';').find((x) => x.split('=')[0] === k); return m ? m.split('=')[1] : ''; };
  const n = Number(get('INTERVAL') || 1);
  const byday = get('BYDAY');
  const mday = get('BYMONTHDAY');
  let s = '';
  const freq = get('FREQ');
  if (freq === 'DAILY') s = n > 1 ? n + '日ごと' : '毎日';
  else if (freq === 'WEEKLY') {
    const days = byday ? byday.split(',') : [];
    const label = days.join(',') === 'MO,TU,WE,TH,FR' ? '平日' : days.map((x) => DOW[RR_DAYS.indexOf(x)]).join('・') + '曜日';
    s = (n > 1 ? n + '週間ごと ' : '毎週 ') + (days.length ? label : '');
  } else if (freq === 'MONTHLY') {
    let on = '';
    if (byday) {
      const nth = Number(byday.replace(/[A-Z]/g, ''));
      on = (nth === -1 ? '最終' : '第' + nth) + DOW[RR_DAYS.indexOf(byday.replace(/[-0-9]/g, ''))] + '曜日';
    } else if (mday === '-1') on = '最終日';
    else on = (mday || (anchor ? String(Number(anchor.slice(8, 10))) : '')) + '日';
    s = (n > 1 ? n + 'か月ごと ' : '毎月 ') + on;
  } else if (freq === 'YEARLY') {
    s = (n > 1 ? n + '年ごと ' : '毎年 ') + (anchor ? Number(anchor.slice(5, 7)) + '月' + Number(anchor.slice(8, 10)) + '日' : '');
  }
  const until = get('UNTIL');
  const count = get('COUNT');
  if (until) s += '（' + Number(until.slice(4, 6)) + '/' + Number(until.slice(6, 8)) + 'まで）';
  if (count) s += '（' + count + '回）';
  return s.trim();
}

/* ---------- 今の状況をまとめる（画面の進捗ボードと同じ考え方） ---------- */

export type ReportInput = {
  now: Date;
  since: string;
  hasPrev: boolean;
  summary: boolean;
  slot?: string;
  cfg: Config;
  members: Row[];
  lists: Row[];
  tasks: Row[]; // 親タスクだけ（削除されていないもの）
  noteTaskIds: string[]; // since 以降に最新状況が書かれたタスク
  url: string;
};

function collect(inp: ReportInput) {
  const { now, cfg } = inp;
  const j = jst(now);
  const today = j.ymd;
  const tomorrow = addDaysYmd(today, 1);
  const soonLimit = addDaysYmd(today, cfg.soonDays);
  const staleLimit = now.getTime() - cfg.staleDays * 86400000;
  const mem: Record<string, Row> = {};
  inp.members.forEach((m) => { mem[m.id] = m; });
  const lst: Record<string, Row> = {};
  inp.lists.forEach((l) => { if (!l.deleted_at) lst[l.id] = l; });
  const top = inp.tasks.filter((t) => lst[t.list_id] && !t.parent_id && !t.deleted_at)
    .map((t) => ({ ...t, due: ymdOf(t.due), do_date: ymdOf(t.do_date) }));

  const sinceT = new Date(inp.since).getTime();
  const after = (iso: string) => !!iso && new Date(iso).getTime() >= sinceT;
  const open = top.filter((t) => t.status !== 'done');
  const s = { overdue: [] as Row[], today: [] as Row[], todayDo: [] as Row[], soon: [] as Row[], stale: [] as Row[], tomorrow: [] as Row[], tomorrowDo: [] as Row[] };
  open.forEach((t) => {
    const at = dueAt(t);
    if (at < now.getTime()) s.overdue.push(t);
    else if (t.due === today) s.today.push(t);
    else if (t.do_date && t.do_date <= today) s.todayDo.push(t);
    else if (t.due && t.due <= soonLimit) s.soon.push(t);
    if (at >= now.getTime() && t.due === tomorrow) s.tomorrow.push(t);
    else if (at >= now.getTime() && t.do_date === tomorrow) s.tomorrowDo.push(t);
    const last = Math.max(new Date(t.updated_at || 0).getTime(), new Date(t.note_at || 0).getTime(), new Date(t.created_at || 0).getTime());
    if (last < staleLimit) s.stale.push(t);
  });
  const byDue = (a: Row, b: Row) => dueAt(a) - dueAt(b);
  const byDo = (a: Row, b: Row) => (a.do_date + (a.do_time || '99') < b.do_date + (b.do_time || '99') ? -1 : 1) || byDue(a, b);
  [s.overdue, s.today, s.soon, s.stale, s.tomorrow].forEach((arr) => arr.sort(byDue));
  [s.todayDo, s.tomorrowDo].forEach((arr) => arr.sort(byDo));

  const created = top.filter((t) => after(t.created_at));
  const completed = top.filter((t) => t.status === 'done' && after(t.completed_at));
  const noteIds: Record<string, boolean> = {};
  inp.noteTaskIds.forEach((id) => { noteIds[id] = true; });
  const noted = top.filter((t) => noteIds[t.id]);

  const weekStart = addDaysYmd(today, -((j.dow + 6) % 7));
  const rows: Record<string, Row> = {};
  const row = (id: string) => rows[id] || (rows[id] = { id, overdue: 0, today: 0, todayDo: 0, soon: 0, doing: 0, todo: 0, doneWeek: 0 });
  s.overdue.forEach((t) => row(t.assignee).overdue++);
  s.today.forEach((t) => row(t.assignee).today++);
  s.todayDo.forEach((t) => row(t.assignee).todayDo++);
  s.soon.forEach((t) => row(t.assignee).soon++);
  open.forEach((t) => row(t.assignee)[t.status === 'doing' ? 'doing' : 'todo']++);
  top.filter((t) => t.status === 'done' && t.completed_at && jst(new Date(t.completed_at)).ymd >= weekStart)
    .forEach((t) => row(t.assignee).doneWeek++);
  const byAssignee = Object.values(rows).sort((a: Row, b: Row) => ((mem[a.id] || {}).sort_order ?? 9999) - ((mem[b.id] || {}).sort_order ?? 9999));

  return {
    today, mem, openCount: open.length,
    overdue: s.overdue, todayDue: s.today, todayDo: s.todayDo, soon: s.soon, stale: s.stale, tomorrowDue: s.tomorrow, tomorrowDo: s.tomorrowDo,
    created, completed, noted, byAssignee,
  };
}

/* ---------- メールの中身 ---------- */

const fmtMd = (ymd: string) => { const p = ymd.split('-').map(Number); return p[1] + '/' + p[2] + '(' + DOW[dowYmd(ymd)] + ')'; };
const fmtAt = (iso: string) => { if (!iso) return ''; const j = jst(new Date(iso)); return j.mo + '/' + j.d + ' ' + j.h + ':' + pad2(j.mi); };
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildReport(inp: ReportInput) {
  const st = collect(inp);
  const { now, cfg, url } = inp;
  const sum = inp.summary;
  const j = jst(now);
  const name = (id: string) => (st.mem[id] ? st.mem[id].name : '（未設定）');
  const dueText = (t: Row) => (t.due ? fmtMd(t.due) + (t.due_time ? ' ' + t.due_time : '') : '期限なし');
  const doText = (t: Row) => (t.do_date ? fmtMd(t.do_date) + (t.do_time ? ' ' + t.do_time : '') : '');
  const overDays = (t: Row) => Math.max(1, Math.floor((now.getTime() - dueAt(t)) / 86400000) + 1);
  const lateDays = (t: Row) => (t.do_date ? dayNum(st.today) - dayNum(t.do_date) : 0);
  const statusText = (t: Row) => (t.status === 'doing' ? '進行中' : t.status === 'done' ? '完了' : '未着手');
  const askedBy = (t: Row) => (t.created_by && t.created_by !== t.assignee && st.mem[t.created_by] ? st.mem[t.created_by].name : '');
  const clock = inp.slot ? String(Number(inp.slot.split(':')[0])) + ':' + inp.slot.split(':')[1] : j.h + ':' + pad2(j.mi);
  const timeLabel = j.mo + '/' + j.d + '(' + DOW[j.dow] + ') ' + clock;
  const sinceLabel = sum ? '今日の動き' : inp.hasPrev ? '前回のメール（' + fmtAt(inp.since) + '）以降の動き' : 'この1時間の動き';
  const subject = sum
    ? '【本部タスク】' + timeLabel + ' 今日のまとめ　完了' + st.completed.length + '件・期限切れ' + st.overdue.length + '件・明日まで' + st.tomorrowDue.length + '件'
    : '【本部タスク】' + timeLabel + '時点　期限切れ' + st.overdue.length + '件・今日まで' + st.todayDue.length + '件・今日やる' + st.todayDo.length + '件';
  const link = (t: Row) => (url ? url + '?task=' + encodeURIComponent(t.id) : '');
  // 1件ごとの説明（担当・いつやる・期限・状況・頼んだ人・繰り返し）
  const metaParts = (t: Row) => {
    const a = ['担当: ' + name(t.assignee)];
    if (t.do_date) a.push('いつやる: ' + doText(t));
    a.push('期限: ' + dueText(t));
    a.push(statusText(t));
    if (askedBy(t)) a.push('依頼: ' + askedBy(t));
    if (t.repeat) a.push('繰り返し: ' + repeatText(t.repeat, t.do_date || t.due));
    return a;
  };
  type Kind = 'over' | 'do' | '';
  const badge = (t: Row, kind: Kind) => (kind === 'over' ? '[' + overDays(t) + '日超過] ' : kind === 'do' && lateDays(t) > 0 ? '[やる日を' + lateDays(t) + '日過ぎ] ' : '');

  /* 文字だけのメール */
  const lines: string[] = [];
  lines.push(sum ? '本部タスク 今日のまとめ（' + timeLabel + '）' : '本部タスクの状況（' + timeLabel + ' 時点）', '');
  lines.push('■ まとめ');
  lines.push('未完了 ' + st.openCount + '件（期限切れ ' + st.overdue.length + '件／今日まで ' + st.todayDue.length + '件／今日やる ' + st.todayDo.length + '件／' + cfg.soonDays + '日以内 ' + st.soon.length + '件）');
  lines.push(sinceLabel + ': 新規 ' + st.created.length + '件・完了 ' + st.completed.length + '件・最新状況の更新 ' + st.noted.length + '件', '');
  const textBlock = (title: string, arr: Row[], kind: Kind) => {
    lines.push('■ ' + title + '（' + arr.length + '件）');
    if (!arr.length) lines.push('なし');
    arr.forEach((t) => {
      lines.push('・' + badge(t, kind) + t.title);
      lines.push('　' + metaParts(t).join('　'));
      lines.push('　最新状況: ' + (t.note_text ? '（' + fmtAt(t.note_at) + '）' + t.note_text : 'まだ入力がありません'));
    });
    lines.push('');
  };
  const textMoves = () => {
    lines.push('■ ' + sinceLabel);
    st.completed.forEach((t: Row) => lines.push('・完了: ' + t.title + '（' + name(t.completed_by || t.assignee) + '）'));
    st.created.forEach((t: Row) => lines.push('・新規: ' + t.title + '（担当: ' + name(t.assignee) + (askedBy(t) ? '、依頼: ' + askedBy(t) : '') + '、期限: ' + dueText(t) + '）'));
    st.noted.forEach((t: Row) => lines.push('・最新状況: ' + t.title + ' → ' + t.note_text));
    if (!st.completed.length && !st.created.length && !st.noted.length) lines.push('動きはありませんでした');
    lines.push('');
  };
  if (sum) textMoves();
  textBlock('期限切れ', st.overdue, 'over');
  textBlock(sum ? '今日まで（残り）' : '今日まで', st.todayDue, '');
  textBlock(sum ? '今日やる予定（残り）' : '今日やる予定', st.todayDo, 'do');
  if (sum) {
    textBlock('明日まで', st.tomorrowDue, '');
    textBlock('明日やる予定', st.tomorrowDo, '');
  } else {
    textBlock(cfg.soonDays + '日以内', st.soon, '');
    textMoves();
  }
  lines.push('■ 担当者別（期限切れ／今日まで／今日やる／' + cfg.soonDays + '日以内／進行中／未着手）');
  st.byAssignee.forEach((r: Row) => lines.push('・' + name(r.id) + '　' + r.overdue + '／' + r.today + '／' + r.todayDo + '／' + r.soon + '／' + r.doing + '／' + r.todo));
  if (!st.byAssignee.length) lines.push('タスクはありません');
  if (st.stale.length) {
    lines.push('', '■ ' + cfg.staleDays + '日以上更新が止まっているタスク（' + st.stale.length + '件）');
    st.stale.forEach((t) => lines.push('・' + t.title + '　担当: ' + name(t.assignee) + '　期限: ' + dueText(t)));
  }
  if (url) lines.push('', '▶ アプリで開く: ' + url);
  lines.push('', 'このメールは本部タスクから自動で送っています。タスク名や最新状況に、利用者さんの個人情報は書かないでください。');

  /* 見やすいメール（HTML） */
  const C = { red: '#b3261e', orange: '#b25e00', blue: '#0b57d0', teal: '#00696d', green: '#146c2e', gray: '#5f6368', line: '#e0e3e7' };
  const h: string[] = [];
  h.push('<div style="font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',\'Yu Gothic UI\',Meiryo,sans-serif;color:#1f1f1f;max-width:680px;margin:0 auto;line-height:1.6">');
  h.push('<div style="padding:16px 20px;background:#0b57d0;color:#fff;border-radius:12px 12px 0 0"><div style="font-size:13px;opacity:.85">本部タスク</div>' +
    '<div style="font-size:20px;font-weight:bold">' + esc(sum ? '今日のまとめ（' + timeLabel + '）' : timeLabel + ' 時点の状況') + '</div></div>');
  h.push('<div style="border:1px solid ' + C.line + ';border-top:0;border-radius:0 0 12px 12px;padding:16px 20px">');
  const tile = (label: string, n: number, color: string) => '<td style="padding:4px;width:25%"><div style="border:1px solid ' + C.line + ';border-radius:10px;padding:10px 4px;text-align:center">' +
    '<div style="font-size:12px;color:' + C.gray + '">' + label + '</div><div style="font-size:24px;font-weight:bold;color:' + color + '">' + n + '</div></div></td>';
  h.push('<table role="presentation" style="width:100%;border-collapse:collapse"><tr>' +
    (sum ? tile('今日の完了', st.completed.length, C.green) : tile('未完了', st.openCount, '#1f1f1f')) +
    tile('期限切れ', st.overdue.length, st.overdue.length ? C.red : '#1f1f1f') +
    tile(sum ? '今日まで（残り）' : '今日まで', st.todayDue.length, st.todayDue.length ? C.orange : '#1f1f1f') +
    (sum ? tile('明日まで', st.tomorrowDue.length, '#1f1f1f') : tile('今日やる', st.todayDo.length, st.todayDo.length ? C.teal : '#1f1f1f')) + '</tr></table>');
  h.push('<p style="margin:8px 0 0;font-size:13px;color:' + C.gray + '">' + esc(sinceLabel) + ': 新規 ' + st.created.length + '件・完了 ' + st.completed.length + '件・最新状況の更新 ' + st.noted.length + '件</p>');
  const section = (title: string, color: string, arr: Row[], kind: Kind) => {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + color + ';padding-left:8px">' + esc(title) + '（' + arr.length + '件）</h3>');
    if (!arr.length) { h.push('<div style="color:' + C.gray + ';font-size:14px">なし</div>'); return; }
    arr.forEach((t) => {
      const titleHtml = link(t) ? '<a href="' + esc(link(t)) + '" style="color:#1f1f1f;font-weight:bold;text-decoration:none">' + esc(t.title) + '</a>' : '<b>' + esc(t.title) + '</b>';
      const b = badge(t, kind);
      const meta = metaParts(t).map((x) => esc(x)).join('　')
        .replace('期限: ' + esc(dueText(t)), '期限: <span style="color:' + (kind === 'over' ? C.red : C.gray) + '">' + esc(dueText(t)) + '</span>');
      h.push('<div style="padding:8px 0;border-bottom:1px solid ' + C.line + '">' +
        (b ? '<span style="color:' + (kind === 'over' ? C.red : C.orange) + ';font-weight:bold;font-size:13px">' + esc(b) + '</span>' : '') + titleHtml +
        '<div style="font-size:13px;color:' + C.gray + '">' + meta + '</div>' +
        '<div style="font-size:13px;color:#444">最新状況: ' + (t.note_text ? esc(t.note_text) + ' <span style="color:' + C.gray + '">（' + fmtAt(t.note_at) + '）</span>' : '<span style="color:' + C.gray + '">まだ入力がありません</span>') + '</div></div>');
    });
  };
  const moves = () => {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + (sum ? C.green : C.gray) + ';padding-left:8px">' + esc(sinceLabel) + '</h3><div style="font-size:14px">');
    st.completed.forEach((t: Row) => h.push('<div>✅ 完了: ' + esc(t.title) + '（' + esc(name(t.completed_by || t.assignee)) + '）</div>'));
    st.created.forEach((t: Row) => h.push('<div>🆕 新規: ' + esc(t.title) + '（担当: ' + esc(name(t.assignee)) + (askedBy(t) ? '、依頼: ' + esc(askedBy(t)) : '') + '、期限: ' + esc(dueText(t)) + '）</div>'));
    st.noted.forEach((t: Row) => h.push('<div>💬 ' + esc(t.title) + ' → ' + esc(t.note_text) + '</div>'));
    if (!st.completed.length && !st.created.length && !st.noted.length) h.push('<div style="color:' + C.gray + '">動きはありませんでした</div>');
    h.push('</div>');
  };
  if (sum) moves();
  section('期限切れ', C.red, st.overdue, 'over');
  section(sum ? '今日まで（残り）' : '今日まで', C.orange, st.todayDue, '');
  section(sum ? '今日やる予定（残り）' : '今日やる予定', C.teal, st.todayDo, 'do');
  if (sum) {
    section('明日まで', C.blue, st.tomorrowDue, '');
    section('明日やる予定', C.teal, st.tomorrowDo, '');
  } else {
    section(cfg.soonDays + '日以内', C.blue, st.soon, '');
    moves();
  }
  h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + C.gray + ';padding-left:8px">担当者別</h3>');
  const th = (s: string) => '<th style="padding:6px 4px;border-bottom:2px solid ' + C.line + ';font-size:12px;color:' + C.gray + ';text-align:center">' + s + '</th>';
  const td = (n: number, color?: string) => '<td style="padding:6px 4px;border-bottom:1px solid ' + C.line + ';text-align:center;' + (n && color ? 'color:' + color + ';font-weight:bold' : '') + '">' + n + '</td>';
  h.push('<table style="width:100%;border-collapse:collapse;font-size:14px"><tr>' + th('担当') + th('期限切れ') + th('今日まで') + th('今日やる') + th(cfg.soonDays + '日以内') + th('進行中') + th('未着手') + th('今週の完了') + '</tr>');
  st.byAssignee.forEach((r: Row) => {
    h.push('<tr><td style="padding:6px 4px;border-bottom:1px solid ' + C.line + '">' + esc(name(r.id)) + '</td>' + td(r.overdue, C.red) + td(r.today, C.orange) + td(r.todayDo, C.teal) + td(r.soon) + td(r.doing) + td(r.todo) + td(r.doneWeek) + '</tr>');
  });
  if (!st.byAssignee.length) h.push('<tr><td colspan="8" style="padding:8px;color:' + C.gray + '">タスクはありません</td></tr>');
  h.push('</table>');
  if (st.stale.length) {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + C.gray + ';padding-left:8px">' + cfg.staleDays + '日以上更新が止まっているタスク（' + st.stale.length + '件）</h3><div style="font-size:14px">');
    st.stale.forEach((t) => h.push('<div>・' + esc(t.title) + '　<span style="color:' + C.gray + '">担当: ' + esc(name(t.assignee)) + '　期限: ' + esc(dueText(t)) + '</span></div>'));
    h.push('</div>');
  }
  if (url) h.push('<p style="margin:24px 0 4px;text-align:center"><a href="' + esc(url) + '" style="display:inline-block;background:#0b57d0;color:#fff;padding:10px 24px;border-radius:20px;text-decoration:none;font-weight:bold">アプリで開く</a></p>');
  h.push('<p style="font-size:12px;color:' + C.gray + ';margin-top:16px">このメールは本部タスクから自動で送っています。タスク名や最新状況に、利用者さんの個人情報は書かないでください。</p>');
  h.push('</div></div>');
  return { subject, text: lines.join('\n'), html: h.join('') };
}
