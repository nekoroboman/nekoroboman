// 本部タスク: Google に送る中身と「何をするか」を決める
// （データベースにも Google にも触らない。渡されたデータから決めるだけ。index.ts と手元の試験 dev/google-test.js から使う）

// deno-lint-ignore no-explicit-any
export type Row = any;
export type Op = {
  op: 'upsert' | 'delete' | 'instance' | 'cancel';
  kind: 'task' | 'event';
  row: Row;
  gid?: string; // いま対応している Google 側の ID
  master?: Row; // 繰り返しの1回のときの、元の予定
};

const DAY = 86400000;
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

// 日本時間の日付（YYYY-MM-DD）
export const jstDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);
const md = (ymd: string) => {
  const p = String(ymd).slice(0, 10).split('-').map(Number);
  return p[1] + '/' + p[2] + '(' + DOW[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()] + ')';
};

// Google カレンダーの予定の色（こちらの11色と同じ）
export const EVENT_COLOR_IDS: Record<string, string> = {
  '#7986cb': '1', '#33b679': '2', '#8e24aa': '3', '#e67c73': '4', '#f6bf26': '5', '#f4511e': '6',
  '#039be5': '7', '#616161': '8', '#3f51b5': '9', '#0b8043': '10', '#d50000': '11',
};

// 予定の Google 側の ID（人ごと・予定ごとに決まった値にして、やり直しても二重にならないようにする。0-9a-f だけ）
export function eventGid(memberId: string, eventId: string) {
  return Array.from(new TextEncoder().encode(memberId + ':' + eventId)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 繰り返しの決まりを Google の形に（時刻つきの予定の終了日は、日本時間のその日の終わりを UTC で書く）
export function googleRule(rule: string, allDay: boolean) {
  return 'RRULE:' + rule.split(';').map((part) => {
    const [k, v] = part.split('=');
    return k === 'UNTIL' && !allDay && /^\d{8}$/.test(v) ? 'UNTIL=' + v + 'T145959Z' : part;
  }).join(';');
}

// 繰り返しの1回の Google 側の ID（元の予定の ID ＋ 元の日時）
export function instanceId(masterGid: string, originalStart: string, masterAllDay: boolean) {
  if (masterAllDay) return masterGid + '_' + jstDate(originalStart).replace(/-/g, '');
  return masterGid + '_' + new Date(originalStart).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

export function eventBody(e: Row, appUrl: string) {
  const b: Row = {
    status: 'confirmed', // Google 側で消されていても、こちらにあるうちは戻す
    summary: e.title || '（タイトルなし）',
    description: [e.description || '', appUrl ? '本部タスクで開く: ' + appUrl : ''].filter(Boolean).join('\n\n'),
    location: e.location || '',
    transparency: e.busy === false ? 'transparent' : 'opaque',
    visibility: e.visibility === 'public' || e.visibility === 'private' ? e.visibility : 'default',
    reminders: {
      useDefault: false,
      overrides: (Array.isArray(e.reminders) ? e.reminders : []).slice(0, 5)
        .map((r: Row) => ({ method: r.method === 'email' ? 'email' : 'popup', minutes: Number(r.minutes) || 0 })),
    },
    extendedProperties: { private: { honbuId: String(e.id) } },
  };
  if (e.all_day) {
    b.start = { date: jstDate(e.start_at) };
    b.end = { date: jstDate(e.end_at) };
  } else {
    b.start = { dateTime: new Date(e.start_at).toISOString(), timeZone: 'Asia/Tokyo' };
    b.end = { dateTime: new Date(e.end_at).toISOString(), timeZone: 'Asia/Tokyo' };
  }
  if (e.rrule && !e.recurring_id) b.recurrence = [googleRule(e.rrule, !!e.all_day)];
  const color = EVENT_COLOR_IDS[String(e.color || '').toLowerCase()];
  if (color) b.colorId = color;
  return b;
}

// Google ToDo リストのタスク（日付だけ入る。時刻・いつやる・依頼した人・最新状況はメモに書く）
export function taskBody(t: Row, appUrl: string, names: Record<string, string>) {
  const info: string[] = [];
  if (t.do_date) info.push('いつやる: ' + md(t.do_date) + (t.do_time ? ' ' + t.do_time : ''));
  if (t.due) info.push('期限: ' + md(t.due) + (t.due_time ? ' ' + t.due_time : ''));
  if (t.created_by && t.created_by !== t.assignee && names[t.created_by]) info.push('依頼: ' + names[t.created_by]);
  if (t.note_text) info.push('最新状況: ' + t.note_text);
  const notes = [t.details || '', info.join('\n'), appUrl ? '本部タスクで開く: ' + appUrl + '?task=' + encodeURIComponent(t.id) : '']
    .filter(Boolean).join('\n\n').slice(0, 8000);
  const day = t.due || t.do_date;
  const done = t.status === 'done';
  return {
    title: t.title || '（無題）',
    notes: notes,
    status: done ? 'completed' : 'needsAction',
    due: day ? String(day).slice(0, 10) + 'T00:00:00.000Z' : null,
    completed: done ? new Date(t.completed_at || Date.now()).toISOString() : null,
  };
}

// タスク: 担当のもの（完了したものは、もう Google にあるときだけ直す）を出し、担当でなくなった・消したものは消す
export function planTasks(rows: Row[], maps: Map<string, string>, member: string): Op[] {
  const ops: Op[] = [];
  for (const t of rows) {
    if (t.parent_id) continue;
    const gid = maps.get('task:' + t.id);
    const mine = !t.deleted_at && t.assignee === member;
    if (mine && (gid || t.status !== 'done')) ops.push({ op: 'upsert', kind: 'task', row: t, gid });
    else if (!mine && gid) ops.push({ op: 'delete', kind: 'task', row: t, gid });
  }
  return ops;
}

// 予定: 自分のカレンダーの予定と、ゲストに呼ばれた予定（「いいえ」と答えたものは除く）を出す
export function planEvents(
  rows: Row[], maps: Map<string, string>, member: string,
  calendars: Record<string, Row>, masters: Record<string, Row>, now: number,
): Op[] {
  const want = (e: Row) => {
    if (!e || e.deleted_at) return false;
    const c = calendars[e.calendar_id];
    if (!c || c.deleted_at) return false;
    if (c.owner === member) return true;
    return (Array.isArray(e.attendees) ? e.attendees : []).some((a: Row) => a.id === member && a.response !== 'declined');
  };
  const ops: Op[] = [];
  // 元の予定を先に、繰り返しの1回だけ変えたものは後に
  const sorted = [...rows].sort((a, b) => (a.recurring_id ? 1 : 0) - (b.recurring_id ? 1 : 0) || Number(a.rev) - Number(b.rev));
  for (const e of sorted) {
    const gid = maps.get('event:' + e.id);
    if (!e.recurring_id) {
      if (want(e)) {
        // 30日より前に終わった1回だけの予定は、まだ Google になければ出さない
        if (!gid && !e.rrule && Date.parse(e.end_at) < now - 30 * DAY) continue;
        ops.push({ op: 'upsert', kind: 'event', row: e, gid });
      } else if (gid) {
        ops.push({ op: 'delete', kind: 'event', row: e, gid });
      }
      continue;
    }
    const m = masters[e.recurring_id];
    if (m && want(m) && !e.deleted_at && e.status === 'cancelled') ops.push({ op: 'cancel', kind: 'event', row: e, gid, master: m });
    else if (m && want(m) && !e.deleted_at) ops.push({ op: 'instance', kind: 'event', row: e, gid, master: m });
    else if (gid) ops.push({ op: 'delete', kind: 'event', row: e, gid });
  }
  return ops;
}

// 2つの表から rev の順に読んだとき、どこまで読み終えたことにするか（どちらかが上限で切れたら、そこまで）
export function cutoff(lists: Row[][], limit: number, curRev: number) {
  let cut = Infinity;
  for (const l of lists) if (l.length >= limit) cut = Math.min(cut, Number(l[l.length - 1].rev));
  if (cut !== Infinity) return { truncated: true, upTo: cut };
  let max = curRev;
  for (const l of lists) for (const r of l) max = Math.max(max, Number(r.rev));
  return { truncated: false, upTo: max };
}
