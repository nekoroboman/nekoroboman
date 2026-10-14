// 本部タスク: 招待・パスワード再設定のリンクを開いた人が、パスワードを決める
// - action "info"  : リンクが使えるか確かめ、メールアドレスと名前を返す
// - action "accept": パスワードを決める（招待ならログインを作り、再設定ならパスワードを変える）。リンクは1回だけ使える
// リンクの確かめ方・使ったことの記録は、データベースの _invite_lookup / _invite_complete が行う（管理用の鍵でだけ呼べる）
import { createClient } from 'npm:@supabase/supabase-js@2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

type Lookup = { ok: boolean; error?: string; email?: string; name?: string; kind?: string; expiresAt?: string; userId?: string | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: '不明な操作です' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || '');
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) return json({ error: 'リンクが正しくありません。メールのリンクをもう一度開いてください' }, 400);

    const { data, error } = await sb.rpc('_invite_lookup', { p_token: token });
    if (error) return json({ error: 'リンクを確かめられませんでした。時間をおいてもう一度お試しください' }, 500);
    const inv = data as Lookup;
    if (!inv || !inv.ok) return json({ error: (inv && inv.error) || 'このリンクは使えません' }, 410);

    if (body.action === 'info') {
      return json({ email: inv.email, name: inv.name, kind: inv.kind, expiresAt: inv.expiresAt });
    }
    if (body.action !== 'accept') return json({ error: '不明な操作です' }, 400);

    const password = String(body.password || '');
    if (password.length < 8) return json({ error: 'パスワードは8文字以上にしてください' }, 400);
    if (new TextEncoder().encode(password).length > 72) return json({ error: 'パスワードが長すぎます（72文字まで）' }, 400);
    if (password.toLowerCase() === String(inv.email).toLowerCase()) return json({ error: 'メールアドレスと同じパスワードは使えません' }, 400);

    if (inv.userId) {
      const { error: e } = await sb.auth.admin.updateUserById(inv.userId, { password, email_confirm: true });
      if (e) return json({ error: 'パスワードを設定できませんでした: ' + e.message }, 400);
    } else {
      const { error: e } = await sb.auth.admin.createUser({ email: inv.email!, password, email_confirm: true });
      if (e) return json({ error: 'ログインを作れませんでした: ' + e.message }, 400);
    }
    const { data: done, error: e2 } = await sb.rpc('_invite_complete', { p_token: token });
    if (e2 || !done || !(done as Lookup).ok) return json({ error: 'リンクを使い終えられませんでした。管理者に新しいリンクを頼んでください' }, 409);
    return json({ ok: true, email: inv.email });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
