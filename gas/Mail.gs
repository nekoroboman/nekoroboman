/**
 * 毎時のメール通知と、夜中の片付け
 * 1分ごとに tick が動き、送る時刻（毎時ちょうど・まとめの時刻）になったら1回だけ送る。
 */

function tick() {
  const now = new Date();
  try {
    maybeSendReport_(now);
  } catch (e) {
    logMail_('', '', 'エラー', e && e.message);
  }
  try {
    dailyCleanup_(now);
  } catch (e) {
    console.error(e);
  }
}

/** その日にメールを送る時刻。毎時ちょうど（startHour〜endHour）と「今日のまとめ」の時刻 */
function mailSlots_(m) {
  const slots = [];
  for (let h = m.startHour; h <= m.endHour; h++) slots.push({ time: pad2_(h) + ':00', summary: false });
  if (m.summaryTime) {
    const same = slots.filter(s => s.time === m.summaryTime)[0];
    if (same) same.summary = true;
    else slots.push({ time: m.summaryTime, summary: true });
  }
  return slots.sort((a, b) => (a.time < b.time ? -1 : 1));
}

function toMin_(hhmm) {
  const p = hhmm.split(':').map(Number);
  return p[0] * 60 + p[1];
}

function maybeSendReport_(now) {
  const m = getConfig_().mail;
  if (!m.enabled || !m.recipients.length) return false;
  const j = jst_(now);
  if (m.days.indexOf(j.dow) < 0) return false;
  // 今の時刻までに来た送信時刻のうち一番新しいもの（20分以上遅れた回は送らない）
  const nowMin = j.h * 60 + j.mi;
  const due = mailSlots_(m).filter(s => toMin_(s.time) <= nowMin && nowMin - toMin_(s.time) < 20).pop();
  if (!due) return false;
  const props = PropertiesService.getScriptProperties();
  const key = j.ymd + ' ' + due.time;
  if (props.getProperty('MAIL_SLOT') === key) return false;
  props.setProperty('MAIL_SLOT', key); // 先に印を付けて二重送信を防ぐ
  if (isOffDay_(j.ymd, m)) return false;
  const rev = publishedRev_();
  if (!due.summary && !m.sendWhenNoChange && String(rev) === props.getProperty('MAIL_REV')) return false;
  try {
    const report = buildReport_(now, props.getProperty('MAIL_AT'), { slot: due.time, summary: due.summary });
    sendReport_(m.recipients, report);
    props.setProperties({ MAIL_REV: String(rev), MAIL_AT: now.toISOString() });
    return true;
  } catch (e) {
    props.deleteProperty('MAIL_SLOT'); // 1分後にやり直す
    throw e;
  }
}

function sendReport_(to, report) {
  try {
    MailApp.sendEmail({
      to: to.join(','),
      subject: report.subject,
      body: report.text,
      htmlBody: report.html,
      name: '本部タスク（自動送信）',
    });
    logMail_(to.join(', '), report.subject, '送信済み', '');
  } catch (e) {
    logMail_(to.join(', '), report.subject, '失敗', e && e.message);
    throw e;
  }
}

function logMail_(to, subject, result, error) {
  const t = new Table('maillog');
  t.insert({ id: newId_(), at: new Date().toISOString(), to: to, subject: subject, result: result, error: error || '' });
}

/* ---------- 祝日・会社の休み ---------- */

function isOffDay_(ymd, mailCfg) {
  if (mailCfg.skipYearEnd) {
    const md = ymd.slice(5);
    if (md >= '12-29' || md <= '01-03') return true;
  }
  if (mailCfg.skipHolidays && jpHolidays_(Number(ymd.slice(0, 4)))[ymd]) return true;
  return false;
}

/** 日本の祝日（振替休日・国民の休日を含む） */
function jpHolidays_(year) {
  jpHolidays_.cache = jpHolidays_.cache || {};
  if (jpHolidays_.cache[year]) return jpHolidays_.cache[year];
  const set = {};
  const add = (m, d) => { set[ymdStr_(year, m, d)] = true; };
  const nthMonday = (m, n) => {
    const first = new Date(Date.UTC(year, m - 1, 1)).getUTCDay();
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  };
  const shift = Math.floor((year - 1980) / 4);
  add(1, 1);
  add(1, nthMonday(1, 2));
  add(2, 11);
  add(2, 23);
  add(3, Math.floor(20.8431 + 0.242194 * (year - 1980) - shift));
  add(4, 29);
  add(5, 3);
  add(5, 4);
  add(5, 5);
  add(7, nthMonday(7, 3));
  add(8, 11);
  add(9, nthMonday(9, 3));
  add(9, Math.floor(23.2488 + 0.242194 * (year - 1980) - shift));
  add(10, nthMonday(10, 2));
  add(11, 3);
  add(11, 23);
  const base = Object.keys(set).sort();
  // 国民の休日（祝日にはさまれた平日）
  base.forEach(h => {
    const mid = addDaysYmd_(h, 1);
    if (!set[mid] && set[addDaysYmd_(h, 2)] && dowYmd_(mid) !== 0) set[mid] = true;
  });
  // 振替休日（日曜の祝日 → 次の祝日でない日）
  base.forEach(h => {
    if (dowYmd_(h) !== 0) return;
    let n = addDaysYmd_(h, 1);
    while (set[n]) n = addDaysYmd_(n, 1);
    set[n] = true;
  });
  jpHolidays_.cache[year] = set;
  return set;
}

/* ---------- メールの中身 ---------- */

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

function fmtMd_(ymd) {
  const p = ymd.split('-').map(Number);
  return p[1] + '/' + p[2] + '(' + DOW_JA[dowYmd_(ymd)] + ')';
}

function fmtAt_(iso) {
  if (!iso) return '';
  const j = jst_(new Date(iso));
  return j.mo + '/' + j.d + ' ' + j.h + ':' + pad2_(j.mi);
}

function esc_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 今の状況をまとめる（メールと「進捗ボード」で同じ考え方） */
function collectStatus_(now, sinceIso, summary) {
  const cfg = getConfig_();
  const j = jst_(now);
  const today = j.ymd;
  const tomorrow = addDaysYmd_(today, 1);
  const soonLimit = addDaysYmd_(today, cfg.soonDays);
  const staleLimit = now.getTime() - cfg.staleDays * 86400000;
  const members = {};
  new Table('members').all().forEach(m => { members[m.id] = m; });
  const lists = {};
  new Table('lists').all().filter(l => !l.deletedAt).forEach(l => { lists[l.id] = l; });
  const all = new Table('tasks').all().filter(t => !t.deletedAt && lists[t.listId]);
  const top = all.filter(t => !t.parentId);
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;
  const hasPrev = !summary && !!sinceMs && now.getTime() - sinceMs < 24 * 3600000;
  const startOfDay = new Date(today + 'T00:00:00+09:00').toISOString();
  const since = summary ? startOfDay : hasPrev ? sinceIso : new Date(now.getTime() - 3600000).toISOString();

  const open = top.filter(t => t.status !== 'done');
  const s = { overdue: [], today: [], soon: [], stale: [], tomorrow: [] };
  open.forEach(t => {
    const at = dueAt_(t);
    if (at < now.getTime()) s.overdue.push(t);
    else if (t.due === today) s.today.push(t);
    else if (t.due && t.due <= soonLimit) s.soon.push(t);
    if (at >= now.getTime() && t.due === tomorrow) s.tomorrow.push(t);
    const last = Math.max(new Date(t.updatedAt || 0).getTime(), new Date(t.noteAt || 0).getTime(), new Date(t.createdAt || 0).getTime());
    if (last < staleLimit) s.stale.push(t);
  });
  const byDue = (a, b) => dueAt_(a) - dueAt_(b);
  s.overdue.sort(byDue);
  s.today.sort(byDue);
  s.soon.sort(byDue);
  s.stale.sort(byDue);
  s.tomorrow.sort(byDue);

  const created = top.filter(t => t.createdAt >= since);
  const completed = top.filter(t => t.status === 'done' && t.completedAt >= since);
  const noteTasks = {};
  new Table('notes').all().forEach(n => { if (n.at >= since) noteTasks[n.taskId] = true; });
  const noted = top.filter(t => noteTasks[t.id]);

  const weekStart = addDaysYmd_(today, -((j.dow + 6) % 7));
  const rows = {};
  const row = id => rows[id] || (rows[id] = { id: id, overdue: 0, today: 0, soon: 0, doing: 0, todo: 0, doneWeek: 0 });
  s.overdue.forEach(t => row(t.assignee).overdue++);
  s.today.forEach(t => row(t.assignee).today++);
  s.soon.forEach(t => row(t.assignee).soon++);
  open.forEach(t => row(t.assignee)[t.status === 'doing' ? 'doing' : 'todo']++);
  top.filter(t => t.status === 'done' && t.completedAt && jst_(new Date(t.completedAt)).ymd >= weekStart)
    .forEach(t => row(t.assignee).doneWeek++);
  const byAssignee = Object.keys(rows).map(k => rows[k]).sort((a, b) => {
    const ma = members[a.id], mb = members[b.id];
    return (ma ? ma.sortOrder : 9999) - (mb ? mb.sortOrder : 9999);
  });

  return {
    now: now, today: today, cfg: cfg, since: since, hasPrev: hasPrev, members: members, lists: lists,
    openCount: open.length, overdue: s.overdue, todayDue: s.today, soon: s.soon, stale: s.stale, tomorrowDue: s.tomorrow, summary: !!summary,
    created: created, completed: completed, noted: noted, byAssignee: byAssignee,
  };
}

/**
 * メールの中身を作る。opts.slot は送る時刻（"14:00" など）、opts.summary は「今日のまとめ」
 */
function buildReport_(now, sinceIso, opts) {
  opts = opts || {};
  const st = collectStatus_(now, sinceIso, opts.summary);
  const sum = st.summary;
  const j = jst_(now);
  const url = appUrl_();
  const name = id => (st.members[id] ? st.members[id].name : '（未設定）');
  const dueText = t => fmtMd_(t.due) + (t.dueTime ? ' ' + t.dueTime : '');
  const overDays = t => Math.max(1, Math.floor((now.getTime() - dueAt_(t)) / 86400000) + 1);
  const statusText = t => (t.status === 'doing' ? '進行中' : t.status === 'done' ? '完了' : '未着手');
  const clock = opts.slot ? String(Number(opts.slot.split(':')[0])) + ':' + opts.slot.split(':')[1] : j.h + ':' + pad2_(j.mi);
  const timeLabel = j.mo + '/' + j.d + '(' + DOW_JA[j.dow] + ') ' + clock;
  const sinceLabel = sum ? '今日の動き' : st.hasPrev ? '前回のメール（' + fmtAt_(st.since) + '）以降の動き' : 'この1時間の動き';
  const subject = sum
    ? '【本部タスク】' + timeLabel + ' 今日のまとめ　完了' + st.completed.length + '件・期限切れ' + st.overdue.length + '件・明日まで' + st.tomorrowDue.length + '件'
    : '【本部タスク】' + timeLabel + '時点　期限切れ' + st.overdue.length + '件・今日まで' + st.todayDue.length + '件';
  const link = t => url ? url + '?task=' + encodeURIComponent(t.id) : '';

  /* ----- 文字だけのメール ----- */
  const lines = [];
  lines.push(sum ? '本部タスク 今日のまとめ（' + timeLabel + '）' : '本部タスクの状況（' + timeLabel + ' 時点）', '');
  lines.push('■ まとめ');
  lines.push('未完了 ' + st.openCount + '件（期限切れ ' + st.overdue.length + '件／今日まで ' + st.todayDue.length +
    '件／' + st.cfg.soonDays + '日以内 ' + st.soon.length + '件）');
  lines.push(sinceLabel + ': 新規 ' + st.created.length + '件・完了 ' + st.completed.length + '件・最新状況の更新 ' + st.noted.length + '件', '');
  const textBlock = (title, arr, withOver) => {
    lines.push('■ ' + title + '（' + arr.length + '件）');
    if (!arr.length) lines.push('なし');
    arr.forEach(t => {
      lines.push('・' + (withOver ? '[' + overDays(t) + '日超過] ' : '') + t.title + '　担当: ' + name(t.assignee) +
        '　期限: ' + dueText(t) + '　' + statusText(t));
      lines.push('　最新状況: ' + (t.noteText ? '（' + fmtAt_(t.noteAt) + '）' + t.noteText : 'まだ入力がありません'));
    });
    lines.push('');
  };
  textBlock('期限切れ', st.overdue, true);
  textBlock(sum ? '今日まで（残り）' : '今日まで', st.todayDue, false);
  if (sum) textBlock('明日まで', st.tomorrowDue, false);
  else textBlock(st.cfg.soonDays + '日以内', st.soon, false);
  lines.push('■ ' + sinceLabel);
  st.completed.forEach(t => lines.push('・完了: ' + t.title + '（' + name(t.completedBy || t.assignee) + '）'));
  st.created.forEach(t => lines.push('・新規: ' + t.title + '（担当: ' + name(t.assignee) + '、期限: ' + dueText(t) + '）'));
  st.noted.forEach(t => lines.push('・最新状況: ' + t.title + ' → ' + t.noteText));
  if (!st.completed.length && !st.created.length && !st.noted.length) lines.push('動きはありませんでした');
  lines.push('');
  lines.push('■ 担当者別（期限切れ／今日まで／' + st.cfg.soonDays + '日以内／進行中／未着手）');
  st.byAssignee.forEach(r => lines.push('・' + name(r.id) + '　' + r.overdue + '／' + r.today + '／' + r.soon + '／' + r.doing + '／' + r.todo));
  if (st.stale.length) {
    lines.push('');
    lines.push('■ ' + st.cfg.staleDays + '日以上更新が止まっているタスク（' + st.stale.length + '件）');
    st.stale.forEach(t => lines.push('・' + t.title + '　担当: ' + name(t.assignee) + '　期限: ' + dueText(t)));
  }
  if (url) lines.push('', '▶ アプリで開く: ' + url);

  /* ----- 見やすいメール（HTML） ----- */
  const C = { red: '#b3261e', orange: '#b25e00', blue: '#0b57d0', gray: '#5f6368', line: '#e0e3e7' };
  const h = [];
  h.push('<div style="font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',\'Yu Gothic UI\',Meiryo,sans-serif;color:#1f1f1f;max-width:680px;margin:0 auto;line-height:1.6">');
  h.push('<div style="padding:16px 20px;background:#0b57d0;color:#fff;border-radius:12px 12px 0 0">' +
    '<div style="font-size:13px;opacity:.85">本部タスク</div>' +
    '<div style="font-size:20px;font-weight:bold">' + esc_(sum ? '今日のまとめ（' + timeLabel + '）' : timeLabel + ' 時点の状況') + '</div></div>');
  h.push('<div style="border:1px solid ' + C.line + ';border-top:0;border-radius:0 0 12px 12px;padding:16px 20px">');
  const tile = (label, n, color) => '<td style="padding:4px"><div style="border:1px solid ' + C.line + ';border-radius:10px;padding:10px;text-align:center">' +
    '<div style="font-size:12px;color:' + C.gray + '">' + label + '</div><div style="font-size:24px;font-weight:bold;color:' + color + '">' + n + '</div></div></td>';
  h.push('<table role="presentation" style="width:100%;border-collapse:collapse"><tr>' +
    (sum ? tile('今日の完了', st.completed.length, '#146c2e') : tile('未完了', st.openCount, '#1f1f1f')) +
    tile('期限切れ', st.overdue.length, st.overdue.length ? C.red : '#1f1f1f') +
    tile(sum ? '今日まで（残り）' : '今日まで', st.todayDue.length, st.todayDue.length ? C.orange : '#1f1f1f') +
    (sum ? tile('明日まで', st.tomorrowDue.length, '#1f1f1f') : tile(st.cfg.soonDays + '日以内', st.soon.length, '#1f1f1f')) +
    '</tr></table>');
  h.push('<p style="margin:8px 0 0;font-size:13px;color:' + C.gray + '">' + esc_(sinceLabel) + ': 新規 ' + st.created.length +
    '件・完了 ' + st.completed.length + '件・最新状況の更新 ' + st.noted.length + '件</p>');

  const section = (title, color, arr, withOver) => {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + color + ';padding-left:8px">' + esc_(title) + '（' + arr.length + '件）</h3>');
    if (!arr.length) { h.push('<div style="color:' + C.gray + ';font-size:14px">なし</div>'); return; }
    arr.forEach(t => {
      const titleHtml = link(t) ? '<a href="' + esc_(link(t)) + '" style="color:#1f1f1f;font-weight:bold;text-decoration:none">' + esc_(t.title) + '</a>' : '<b>' + esc_(t.title) + '</b>';
      h.push('<div style="padding:8px 0;border-bottom:1px solid ' + C.line + '">' +
        (withOver ? '<span style="color:' + C.red + ';font-weight:bold;font-size:13px">[' + overDays(t) + '日超過] </span>' : '') + titleHtml +
        '<div style="font-size:13px;color:' + C.gray + '">担当: ' + esc_(name(t.assignee)) + '　期限: <span style="color:' + (withOver ? C.red : C.gray) + '">' +
        esc_(dueText(t)) + '</span>　' + statusText(t) + '</div>' +
        '<div style="font-size:13px;color:#444">最新状況: ' + (t.noteText ? esc_(t.noteText) + ' <span style="color:' + C.gray + '">（' + fmtAt_(t.noteAt) + '）</span>' : '<span style="color:' + C.gray + '">まだ入力がありません</span>') + '</div></div>');
    });
  };
  const moves = () => {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + (sum ? '#146c2e' : C.gray) + ';padding-left:8px">' + esc_(sinceLabel) + '</h3><div style="font-size:14px">');
    st.completed.forEach(t => h.push('<div>✅ 完了: ' + esc_(t.title) + '（' + esc_(name(t.completedBy || t.assignee)) + '）</div>'));
    st.created.forEach(t => h.push('<div>🆕 新規: ' + esc_(t.title) + '（担当: ' + esc_(name(t.assignee)) + '、期限: ' + esc_(dueText(t)) + '）</div>'));
    st.noted.forEach(t => h.push('<div>💬 ' + esc_(t.title) + ' → ' + esc_(t.noteText) + '</div>'));
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
  const th = s => '<th style="padding:6px 8px;border-bottom:2px solid ' + C.line + ';font-size:12px;color:' + C.gray + ';text-align:center">' + s + '</th>';
  const td = (n, color) => '<td style="padding:6px 8px;border-bottom:1px solid ' + C.line + ';text-align:center;' + (n && color ? 'color:' + color + ';font-weight:bold' : '') + '">' + n + '</td>';
  h.push('<table style="width:100%;border-collapse:collapse;font-size:14px"><tr>' + th('担当') + th('期限切れ') + th('今日まで') +
    th(st.cfg.soonDays + '日以内') + th('進行中') + th('未着手') + th('今週の完了') + '</tr>');
  st.byAssignee.forEach(r => {
    h.push('<tr><td style="padding:6px 8px;border-bottom:1px solid ' + C.line + '">' + esc_(name(r.id)) + '</td>' + td(r.overdue, C.red) + td(r.today, C.orange) +
      td(r.soon) + td(r.doing) + td(r.todo) + td(r.doneWeek) + '</tr>');
  });
  if (!st.byAssignee.length) h.push('<tr><td colspan="7" style="padding:8px;color:' + C.gray + '">タスクはありません</td></tr>');
  h.push('</table>');

  if (st.stale.length) {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + C.gray + ';padding-left:8px">' + st.cfg.staleDays + '日以上更新が止まっているタスク（' + st.stale.length + '件）</h3><div style="font-size:14px">');
    st.stale.forEach(t => h.push('<div>・' + esc_(t.title) + '　<span style="color:' + C.gray + '">担当: ' + esc_(name(t.assignee)) + '　期限: ' + esc_(dueText(t)) + '</span></div>'));
    h.push('</div>');
  }
  if (url) {
    h.push('<p style="margin:24px 0 4px;text-align:center"><a href="' + esc_(url) + '" style="display:inline-block;background:#0b57d0;color:#fff;padding:10px 24px;border-radius:20px;text-decoration:none;font-weight:bold">アプリで開く</a></p>');
  }
  h.push('<p style="font-size:12px;color:' + C.gray + ';margin-top:16px">このメールは本部タスクから自動で送っています。タスク名や最新状況に、利用者さんの個人情報は書かないでください。</p>');
  h.push('</div></div>');

  return { subject: subject, text: lines.join('\n'), html: h.join('') };
}

/* ---------- 設定画面から呼ばれるもの ---------- */

function api_previewReport(p) {
  const r = buildReport_(new Date(), PropertiesService.getScriptProperties().getProperty('MAIL_AT'), { summary: !!(p && p.summary) });
  return { subject: r.subject, html: r.html };
}

function api_sendTestMail() {
  const cfg = getConfig_();
  if (!cfg.mail.recipients.length) throw new Error('送信先を入れて保存してから、テスト送信してください');
  const r = buildReport_(new Date(), PropertiesService.getScriptProperties().getProperty('MAIL_AT'));
  r.subject = '[テスト] ' + r.subject;
  sendReport_(cfg.mail.recipients, r);
  return api_mailStatus({});
}

function api_mailStatus() {
  const log = new Table('maillog').all().slice(-30).reverse();
  let quota = null;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = null; }
  let trigger = false;
  try { trigger = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'tick'); } catch (e) { trigger = false; }
  return {
    log: log,
    quota: quota,
    trigger: trigger,
    lastSentAt: PropertiesService.getScriptProperties().getProperty('MAIL_AT') || '',
  };
}

/* ---------- 夜中の片付け（ごみ箱で30日たったものを消す） ---------- */

function dailyCleanup_(now) {
  const j = jst_(now);
  if (j.h !== 3) return;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('CLEAN_DAY') === j.ymd) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const limit = new Date(now.getTime() - 30 * 86400000).toISOString();
    let purgeRev = Number(props.getProperty('PURGE_REV') || 0);
    ['tasks', 'lists'].forEach(key => {
      const t = new Table(key);
      const all = t.all();
      const keep = all.filter(o => !o.deletedAt || o.deletedAt >= limit);
      if (keep.length === all.length) return;
      all.filter(o => o.deletedAt && o.deletedAt < limit).forEach(o => { purgeRev = Math.max(purgeRev, o.rev); });
      t.rewrite(keep);
    });
    const log = new Table('maillog');
    if (log.rows.length > 2000) log.rewrite(log.all().slice(-1000));
    SpreadsheetApp.flush();
    props.setProperties({ PURGE_REV: String(purgeRev), CLEAN_DAY: j.ymd });
  } finally {
    lock.releaseLock();
  }
}
