/**
 * 動作確認用: supabase/migrations の SQL を、手元の PostgreSQL（PGlite。ブラウザ用の小さな PostgreSQL）でそのまま動かす。
 * 本番の Supabase には接続しない。Supabase にしかない部分（ログイン情報・拡張機能など）は、ここで形だけ用意する。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');
const TEST_EMAIL = 'honbu-test@example.com';

// Supabase にあって PGlite にないものの代わり
const SHIM = `
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create schema extensions;
create function extensions.gen_random_bytes(n int) returns bytea language sql volatile as $$
  select decode(string_agg(lpad(to_hex(floor(random() * 256)::int), 2, '0'), ''), 'hex') from generate_series(1, n)
$$;
create publication supabase_realtime;
`;

function migrationSql(file) {
  return fs.readFileSync(path.join(MIGRATIONS, file), 'utf8')
    .replace(/create extension if not exists pg_cron;/g, '')
    .replace(/create extension if not exists pg_net[^;]*;/g, '');
}

async function createDb(opts) {
  const o = opts || {};
  const db = new PGlite();
  await db.exec(SHIM);
  for (const f of fs.readdirSync(MIGRATIONS).filter(x => x.endsWith('.sql')).sort()) {
    try {
      await db.exec(migrationSql(f));
    } catch (e) {
      throw new Error(f + ': ' + e.message);
    }
  }
  await db.query('insert into public.app_access (email) values ($1) on conflict do nothing', [o.email || TEST_EMAIL]);

  // 画面からの呼び出しと同じ形（ログインした人の権限）で api_* 関数を呼ぶ
  async function rpc(name, payload, email) {
    if (!/^api_[a-z_]+$/.test(name)) throw new Error('不明な操作です: ' + name);
    return db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ email: email || o.email || TEST_EMAIL, role: 'authenticated' })]);
      await tx.exec('set local role authenticated');
      const r = await tx.query('select public.' + name + '($1::jsonb) as r', [JSON.stringify(payload || {})]);
      return r.rows[0].r;
    });
  }
  // 管理者の権限で読む（メールの中身を作る処理の代わり）
  async function sql(text, params) {
    const r = await db.query(text, params || []);
    return r.rows;
  }
  async function rev() {
    const r = await db.query("select value from public.app_state where key = 'rev'");
    return r.rows[0] ? r.rows[0].value : '0';
  }
  return { db, rpc, sql, rev, close: () => db.close() };
}

module.exports = { createDb, TEST_EMAIL };
