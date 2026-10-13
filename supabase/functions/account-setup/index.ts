// 本部タスク: 最初に1回だけ、本部の共有アカウント（ログイン）を作る
// 使ってよいメールアドレス（app_access）に入っているものだけ作れる。すでにあれば何もしない。
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || password.length < 8) return json({ error: 'メールアドレスと、8文字以上のパスワードを入れてください' }, 400);
    const { data: rows } = await sb.from('app_access').select('email');
    if (!(rows || []).some((r: { email: string }) => r.email.toLowerCase() === email)) {
      return json({ error: 'このメールアドレスは登録できません。本部の共有アカウントのアドレスを入れてください' }, 403);
    }
    const { error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) return json({ error: 'すでに設定済みです。「ログイン」から入ってください' }, 409);
      return json({ error: error.message }, 400);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
