// 本部タスク: メールの中身を作る処理
// - action "poll"   : 送信用 GAS が毎分たずねてくる。送る時刻なら宛先・件名・本文を返す（合言葉が必要）
// - action "result" : 送信用 GAS が送った結果を知らせる（合言葉が必要）
// - action "preview": 画面の設定から、メールのプレビューを見る（ログインした本部の人だけ）
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildReport, type Config, isOffDay, jst, mailSlots, mergeConfig, reportWindow, type Row, toMin } from './report.ts';

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

async function getConfig(): Promise<Config> {
  const { data } = await sb.from('settings').select('value').eq('key', 'app').maybeSingle();
  return mergeConfig(data && data.value);
}

/* ---------- データベースから読んで、メールの中身を作る（中身の作り方は report.ts） ---------- */

async function makeReport(now: Date, lastMailIso: string, opts: { slot?: string; summary?: boolean }) {
  const summary = !!opts.summary;
  const cfg = await getConfig();
  const win = reportWindow(now, lastMailIso, summary);
  const recent = new Date(now.getTime() - 8 * 86400000).toISOString();
  const [{ data: members }, { data: lists }, { data: tasks }, { data: notes }, url] = await Promise.all([
    sb.from('members').select('*'),
    sb.from('lists').select('*').is('deleted_at', null),
    sb.from('tasks').select('*').is('deleted_at', null).is('parent_id', null).or(`status.neq.done,completed_at.gte.${recent},created_at.gte.${recent}`),
    sb.from('task_notes').select('task_id').gte('created_at', win.since),
    getState('app_url'),
  ]);
  return buildReport({
    now, since: win.since, hasPrev: win.hasPrev, summary, slot: opts.slot, cfg,
    members: members || [], lists: lists || [], tasks: tasks || [],
    noteTaskIds: (notes || []).map((n: Row) => n.task_id), url,
  });
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
    const rep = await makeReport(now, await getState('mail_at'), {});
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
  const rep = await makeReport(now, await getState('mail_at'), { slot: due.time, summary: due.summary });
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
      const rep = await makeReport(new Date(), await getState('mail_at'), { summary: !!body.summary });
      return json({ subject: rep.subject, html: rep.html });
    }
    return json({ error: '不明な操作です' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
