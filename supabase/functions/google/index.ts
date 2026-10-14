// 本部タスク: Google（ToDo リスト・カレンダー）への反映（docs/calendar.md 2章。こちら → Google の一方向）
// - action "config"      : 初期設定が済んでいるか・Google に登録する「承認済みのリダイレクト URI」（ログインした本部の人）
// - action "save_config" : Google のクライアント ID・シークレットを入れる（管理画面から。8時間以内にログインした管理者だけ）
// - action "start"       : 自分の Google をつなぐ。Google の許可画面の URL を返す（個人のアカウントだけ）
// - GET（戻り先）         : Google で許可したあと、ここに戻る。合言葉を確かめ、トークンを保存してアプリに戻す
// - action "disconnect"  : 自分の連携をやめる
// - action "syncme"      : 自分の分を今すぐ反映する
// - action "sync"        : pg_cron が1分ごとに呼ぶ（合言葉が必要）。変わったものがある人の分を反映する
// 何をどう送るかは plan.ts。合言葉（トークン・シークレット）は画面から読めない表にだけ置く
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cutoff, eventBody, eventGid, instanceId, type Op, planEvents, planTasks, type Row, taskBody } from './plan.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';
const sb = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const FN_URL = SB_URL + '/functions/v1';
const REDIRECT = FN_URL + '/google';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/tasks', 'https://www.googleapis.com/auth/calendar.events'];
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const LIMIT = 400; // 1回に読む行の上限（残りは次の回）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

class Transient extends Error {} // 時間をおけば直る（次の回にやり直す）
class Fatal extends Error {} // つなぎ直しが要る

/* ---------- 小さな道具 ---------- */

async function getState(key: string): Promise<string> {
  const { data } = await sb.from('app_state').select('value').eq('key', key).maybeSingle();
  return (data && data.value) || '';
}
async function setState(key: string, value: string) {
  await sb.from('app_state').upsert({ key, value, updated_at: new Date().toISOString() });
}
async function googleConfig() {
  const id = Deno.env.get('GOOGLE_CLIENT_ID') || (await getState('google_client_id'));
  const secret = Deno.env.get('GOOGLE_CLIENT_SECRET') || (await getState('google_client_secret'));
  return { id, secret, ok: !!(id && secret) };
}
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function idTokenEmail(idToken: string) {
  try {
    const p = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p + '==='.slice((p.length + 3) % 4)), (c) => c.charCodeAt(0)))).email || '');
  } catch (_e) {
    return '';
  }
}
const later = (p: Promise<unknown>) => {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && rt.waitUntil) rt.waitUntil(p);
};

// ログインしている人（api_call を通すので、招待制の守りがそのまま効く）
async function me(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth) || !ANON) return null;
  const client = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.rpc('api_call', { p_fn: 'api_me', p: {} });
  if (error || !data) return null;
  return { memberId: String(data.memberId || ''), isAdmin: !!data.isAdmin, client };
}

/* ---------- Google とのやりとり ---------- */

type Ctx = { link: Row; cfg: { id: string; secret: string } };

async function accessToken(ctx: Ctx, force: boolean) {
  const l = ctx.link;
  if (!force && l.access_token && l.access_expires_at && Date.parse(l.access_expires_at) > Date.now() + 60000) return l.access_token as string;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: FORM,
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: l.refresh_token || '', client_id: ctx.cfg.id, client_secret: ctx.cfg.secret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === 'invalid_grant' || j.error === 'unauthorized_client' || j.error === 'invalid_client') {
      throw new Fatal('Google との連携が切れました。設定 →「Google 連携」で、つなぎ直してください');
    }
    throw new Transient('Google に入れませんでした（' + r.status + '）。あとで自動でやり直します');
  }
  l.access_token = j.access_token;
  l.access_expires_at = new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString();
  await sb.from('google_links').update({ access_token: l.access_token, access_expires_at: l.access_expires_at }).eq('member_id', l.member_id);
  return l.access_token as string;
}

async function gfetch(ctx: Ctx, method: string, url: string, body?: unknown) {
  for (let i = 0; i < 2; i++) {
    const token = await accessToken(ctx, i === 1);
    const r = await fetch(url, {
      method,
      headers: body ? { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } : { Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && i === 0) continue;
    const text = await r.text();
    let data: Row = null;
    try { data = text ? JSON.parse(text) : null; } catch (_e) { data = null; }
    if (r.status === 429 || r.status >= 500 || (r.status === 403 && /rateLimit|quota/i.test(text))) {
      throw new Transient('Google が混み合っています（' + r.status + '）。あとで自動でやり直します');
    }
    if (r.status === 401) throw new Fatal('Google に入れませんでした。設定 →「Google 連携」で、つなぎ直してください');
    return { status: r.status, data };
  }
  throw new Fatal('Google に入れませんでした');
}
const gone = (s: number) => s === 404 || s === 410;
const problem = (what: string, r: { status: number; data: Row }) =>
  what + ': Google が受け付けませんでした（' + r.status + (r.data && r.data.error && r.data.error.message ? ' ' + r.data.error.message : '') + '）';

async function saveMap(kind: string, localId: string, memberId: string, gid: string, maps: Map<string, string>) {
  await sb.from('google_map').upsert({ kind, local_id: localId, member_id: memberId, google_id: gid, synced_at: new Date().toISOString() });
  maps.set(kind + ':' + localId, gid);
}
async function dropMap(kind: string, localId: string, memberId: string, maps: Map<string, string>) {
  await sb.from('google_map').delete().eq('kind', kind).eq('local_id', localId).eq('member_id', memberId);
  maps.delete(kind + ':' + localId);
}

// Google ToDo の「本部タスク」リスト（なければ作る）
async function ensureTaskList(ctx: Ctx) {
  if (ctx.link.tasklist_id) return;
  const r = await gfetch(ctx, 'POST', TASKS + '/users/@me/lists', { title: '本部タスク' });
  if (r.status >= 300 || !r.data || !r.data.id) throw new Transient(problem('ToDo リスト「本部タスク」を作る', r));
  ctx.link.tasklist_id = r.data.id;
  await sb.from('google_links').update({ tasklist_id: r.data.id }).eq('member_id', ctx.link.member_id);
}
// リストが Google 側で消されていたら、作り直して最初から入れ直す
async function resetTaskList(ctx: Ctx) {
  await sb.from('google_links').update({ tasklist_id: '', synced_rev: 0 }).eq('member_id', ctx.link.member_id);
  await sb.from('google_map').delete().eq('kind', 'task').eq('member_id', ctx.link.member_id);
  throw new Transient('Google の「本部タスク」リストが見つからないため、作り直して入れ直します');
}

async function runTask(ctx: Ctx, op: Op, appUrl: string, names: Record<string, string>, maps: Map<string, string>) {
  const M = ctx.link.member_id;
  const t = op.row;
  const base = TASKS + '/lists/' + encodeURIComponent(ctx.link.tasklist_id) + '/tasks';
  const what = 'タスク「' + (t.title || '') + '」';
  if (op.op === 'delete') {
    const r = await gfetch(ctx, 'DELETE', base + '/' + encodeURIComponent(op.gid!));
    if (r.status >= 300 && !gone(r.status)) return problem(what + 'を消す', r);
    await dropMap('task', t.id, M, maps);
    return '';
  }
  const body = taskBody(t, appUrl, names);
  if (op.gid) {
    const r = await gfetch(ctx, 'PATCH', base + '/' + encodeURIComponent(op.gid), body);
    if (r.status < 300) return '';
    if (!gone(r.status)) return problem(what + 'を直す', r);
  }
  const r = await gfetch(ctx, 'POST', base, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)));
  if (gone(r.status)) await resetTaskList(ctx);
  if (r.status >= 300 || !r.data || !r.data.id) return problem(what + 'を入れる', r);
  await saveMap('task', t.id, M, r.data.id, maps);
  return '';
}

async function runEvent(ctx: Ctx, op: Op, appUrl: string, maps: Map<string, string>) {
  const M = ctx.link.member_id;
  const e = op.row;
  const what = '予定「' + (e.title || '') + '」';
  const at = (id: string) => CAL + '/' + encodeURIComponent(id) + '?sendUpdates=none';
  if (op.op === 'delete') {
    const r = await gfetch(ctx, 'DELETE', at(op.gid!));
    if (r.status >= 300 && !gone(r.status)) return problem(what + 'を消す', r);
    await dropMap('event', e.id, M, maps);
    return '';
  }
  if (op.op === 'upsert') {
    const gid = op.gid || eventGid(M, e.id);
    const body = eventBody(e, appUrl);
    let r = await gfetch(ctx, 'PUT', at(gid), body);
    if (gone(r.status)) r = await gfetch(ctx, 'POST', CAL + '?sendUpdates=none', Object.assign({ id: gid }, body));
    if (r.status >= 300) return problem(what + 'を入れる', r);
    await saveMap('event', e.id, M, gid, maps);
    return '';
  }
  // 繰り返しの1回だけ変えた・消した予定（元の予定が Google にあるときだけ）
  const mg = maps.get('event:' + op.master.id);
  if (!mg) return '';
  const iid = instanceId(mg, e.original_start, !!op.master.all_day);
  if (op.op === 'cancel') {
    const r = await gfetch(ctx, 'DELETE', at(iid));
    if (r.status >= 300 && !gone(r.status)) return problem(what + '（この回）を消す', r);
    if (op.gid) await dropMap('event', e.id, M, maps);
    return '';
  }
  const r = await gfetch(ctx, 'PUT', at(iid), eventBody(e, appUrl));
  if (gone(r.status)) return ''; // Google 側にその回がない
  if (r.status >= 300) return problem(what + '（この回）を直す', r);
  await saveMap('event', e.id, M, iid, maps);
  return '';
}

async function rowsAfter(table: string, since: number, onlyTop: boolean) {
  let q = sb.from(table).select('*').gt('rev', since).order('rev').limit(LIMIT);
  if (onlyTop) q = q.is('parent_id', null);
  const { data, error } = await q;
  if (error) throw new Transient('データを読めませんでした: ' + error.message);
  return (data || []) as Row[];
}

// 1人分を反映する（同時に2つ動かないよう、少しのあいだ鍵をかける）
async function syncMember(memberId: string, deadline: number): Promise<string> {
  const nowIso = new Date().toISOString();
  const { data: locked } = await sb.from('google_links').update({ sync_lock_until: new Date(Date.now() + 170000).toISOString() })
    .eq('member_id', memberId).eq('status', 'active').or('sync_lock_until.is.null,sync_lock_until.lt.' + nowIso).select('*');
  if (!locked || !locked.length) return 'skip';
  const link = locked[0];
  const errors: string[] = [];
  try {
    const cfg = await googleConfig();
    if (!cfg.ok) throw new Transient('Google 連携の初期設定（クライアント ID・シークレット）が見つかりません。管理者に連絡してください');
    const ctx: Ctx = { link, cfg };
    const curRev = Number(await getState('rev')) || 0;
    const since = Number(link.synced_rev) || 0;
    const appUrl = (await getState('app_url')).replace(/#.*$/, '');
    const maps = new Map<string, string>();
    const { data: mapRows } = await sb.from('google_map').select('kind, local_id, google_id').eq('member_id', memberId);
    (mapRows || []).forEach((m: Row) => maps.set(m.kind + ':' + m.local_id, m.google_id));
    const scopes = String(link.scopes || '');
    const doTasks = link.tasks_enabled && scopes.includes('/auth/tasks');
    const doCal = link.calendar_enabled && scopes.includes('/auth/calendar');
    const tasks = doTasks ? await rowsAfter('tasks', since, true) : [];
    const events = doCal ? await rowsAfter('events', since, false) : [];
    const cut = cutoff([tasks, events], LIMIT, curRev);
    const inRange = (r: Row) => Number(r.rev) <= cut.upTo;

    let ops: Op[] = [];
    const names: Record<string, string> = {};
    if (doTasks) {
      const { data: mem } = await sb.from('members').select('id, name');
      (mem || []).forEach((m: Row) => { names[m.id] = m.name; });
      ops = ops.concat(planTasks(tasks.filter(inRange), maps, memberId));
    }
    if (doCal) {
      const evs = events.filter(inRange);
      const { data: cals } = await sb.from('calendars').select('id, owner, deleted_at');
      const calendars: Record<string, Row> = {};
      (cals || []).forEach((c: Row) => { calendars[c.id] = c; });
      const masters: Record<string, Row> = {};
      evs.forEach((e) => { if (!e.recurring_id) masters[e.id] = e; });
      const missing = [...new Set(evs.filter((e) => e.recurring_id && !masters[e.recurring_id]).map((e) => e.recurring_id))];
      if (missing.length) {
        const { data } = await sb.from('events').select('*').in('id', missing);
        (data || []).forEach((m: Row) => { masters[m.id] = m; });
      }
      ops = ops.concat(planEvents(evs, maps, memberId, calendars, masters, Date.now()));
    }
    if (ops.some((o) => o.kind === 'task' && o.op === 'upsert')) await ensureTaskList(ctx);

    let complete = true;
    for (const op of ops) {
      if (Date.now() > deadline) { complete = false; break; }
      const p = op.kind === 'task' ? await runTask(ctx, op, appUrl, names, maps) : await runEvent(ctx, op, appUrl, maps);
      if (p && errors.length < 5) errors.push(p);
    }
    await sb.from('google_links').update(Object.assign(complete ? { synced_rev: cut.upTo } : {}, {
      last_synced_at: new Date().toISOString(), last_error: errors.join('\n'), sync_lock_until: null, updated_at: new Date().toISOString(),
    })).eq('member_id', memberId);
    return errors.length ? 'partial' : complete ? 'ok' : 'more';
  } catch (e) {
    await sb.from('google_links').update(Object.assign(e instanceof Fatal ? { status: 'error' } : {}, {
      last_error: String((e as Error)?.message || e), sync_lock_until: null, updated_at: new Date().toISOString(),
    })).eq('member_id', memberId);
    return 'error';
  }
}

/* ---------- Google の許可画面から戻ってきたとき ---------- */

async function callback(url: URL) {
  const appUrl = (await getState('app_url')).replace(/#.*$/, '');
  const back = (hash: string) =>
    appUrl ? Response.redirect(appUrl + '#google=' + hash, 302) : new Response('本部タスクに戻ってください（' + decodeURIComponent(hash) + '）', { status: 200 });
  const fail = (msg: string) => back('error:' + encodeURIComponent(msg));
  const state = url.searchParams.get('state') || '';
  if (!state) return fail('リンクが正しくありません');
  const now = new Date().toISOString();
  const { data: rows } = await sb.from('google_oauth_states').update({ used_at: now })
    .eq('state_hash', await sha256(state)).is('used_at', null).gt('expires_at', now).select('member_id');
  if (!rows || !rows.length) return fail('時間が切れたか、もう使われたリンクです。もう一度「Google と連携する」を押してください');
  const member = rows[0].member_id as string;
  if (url.searchParams.get('error')) return fail('Google で許可されませんでした');
  const cfg = await googleConfig();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: FORM,
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: cfg.id, client_secret: cfg.secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) return fail('Google から許可を受け取れませんでした' + (j.error ? '（' + j.error + '）' : ''));
  const email = idTokenEmail(j.id_token || '');
  const scopes = String(j.scope || '');
  const { data: old } = await sb.from('google_links').select('google_email').eq('member_id', member).maybeSingle();
  const same = !!(old && old.google_email && old.google_email === email);
  if (old && !same) await sb.from('google_map').delete().eq('member_id', member); // 前は別の Google アカウントだった
  const row: Row = {
    member_id: member, google_email: email, refresh_token: j.refresh_token, access_token: j.access_token,
    access_expires_at: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString(),
    scopes, tasks_enabled: scopes.includes('/auth/tasks'), calendar_enabled: scopes.includes('/auth/calendar'),
    status: 'active', last_error: '', synced_rev: 0, sync_lock_until: null, connected_at: now, updated_at: now,
  };
  if (!same) row.tasklist_id = '';
  const { error } = await sb.from('google_links').upsert(row);
  if (error) return fail('連携を保存できませんでした');
  later(syncMember(member, Date.now() + 100000));
  return back('connected');
}

/* ---------- 入り口 ---------- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method === 'GET') return await callback(new URL(req.url));
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'sync') {
      const token = req.headers.get('x-sync-token') || '';
      const saved = await getState('sync_token');
      if (!saved || token !== saved) return json({ error: '合言葉が違います' }, 403);
      const rev = Number(await getState('rev')) || 0;
      const { data: links } = await sb.from('google_links').select('member_id').eq('status', 'active').lt('synced_rev', rev);
      const deadline = Date.now() + 110000;
      const results: Record<string, string> = {};
      for (const l of links || []) {
        if (Date.now() > deadline) break;
        results[l.member_id] = await syncMember(l.member_id, deadline);
      }
      return json({ ok: true, results });
    }

    const m = await me(req);
    if (!m) return json({ error: 'ログインしてください' }, 401);

    if (action === 'config') {
      const cfg = await googleConfig();
      return json({ configured: cfg.ok, redirectUri: REDIRECT, clientId: cfg.id ? cfg.id.slice(0, 12) + '…' : '', fromSecrets: !!Deno.env.get('GOOGLE_CLIENT_ID') });
    }
    if (action === 'save_config') {
      const gate = await m.client.rpc('api_call', { p_fn: 'api_admin_google', p: {} });
      if (gate.error) return json({ error: gate.error.message }, 403);
      const id = String(body.clientId || '').trim();
      const secret = String(body.clientSecret || '').trim();
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) return json({ error: 'クライアント ID の形が正しくありません（「.apps.googleusercontent.com」で終わるものです）' }, 400);
      if (secret.length < 10 || secret.length > 200 || /\s/.test(secret)) return json({ error: 'クライアント シークレットが正しくありません' }, 400);
      await setState('google_client_id', id);
      await setState('google_client_secret', secret);
      await setState('functions_url', FN_URL);
      return json({ configured: true, redirectUri: REDIRECT, clientId: id.slice(0, 12) + '…' });
    }
    if (!m.memberId) return json({ error: 'Google 連携は、一人ずつのアカウント（個人のアカウント）で使えます' }, 400);
    if (action === 'start') {
      const cfg = await googleConfig();
      if (!cfg.ok) return json({ error: '管理者が Google 連携の初期設定をまだしていません（管理画面の「Google 連携」）' }, 400);
      const state = newToken();
      await sb.from('google_oauth_states').insert({ state_hash: await sha256(state), member_id: m.memberId, expires_at: new Date(Date.now() + 15 * 60000).toISOString() });
      await setState('functions_url', FN_URL);
      const q = new URLSearchParams({
        client_id: cfg.id, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES.join(' '),
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
      });
      return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString() });
    }
    if (action === 'disconnect') {
      const { data: l } = await sb.from('google_links').select('refresh_token').eq('member_id', m.memberId).maybeSingle();
      if (l && l.refresh_token) {
        await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: FORM, body: new URLSearchParams({ token: l.refresh_token }) }).catch(() => null);
      }
      await sb.from('google_links').update({
        status: 'off', refresh_token: null, access_token: null, access_expires_at: null, tasklist_id: '', synced_rev: 0,
        last_error: '', sync_lock_until: null, updated_at: new Date().toISOString(),
      }).eq('member_id', m.memberId);
      await sb.from('google_map').delete().eq('member_id', m.memberId);
      return json({ ok: true });
    }
    if (action === 'syncme') {
      const result = await syncMember(m.memberId, Date.now() + 60000);
      return json({ ok: true, result });
    }
    return json({ error: '不明な操作です' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
