// 本部タスク: 以前の「はじめての方（共有アカウントのパスワードを決める）」の入り口。
// アカウントは招待制になったため、使えないようにしてある（招待は管理画面から。リンクを開いた人の処理は account）
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  return new Response(JSON.stringify({ error: 'アカウントは招待制になりました。管理者から届いた招待のリンクを開いてください' }), {
    status: 410,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
});
