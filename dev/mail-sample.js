/**
 * メールの見本を作る（架空のデータ）。本物のメールと同じ作り方（supabase/functions/mail/report.ts）を使う。
 * node dev/mail-sample.js [出力ファイル]   … 何も付けなければ docs/mail-sample.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

(async () => {
  const R = await import('../supabase/functions/mail/report.ts');
  const OUT = process.argv[2] || path.join(__dirname, '..', 'docs', 'mail-sample.html');
  // 見本の日時: 2026年10月14日（水）
  const at = (hhmm, dayOffset) => new Date(Date.parse('2026-10-14T' + hhmm + ':00+09:00') + (dayOffset || 0) * 86400000).toISOString();
  const day = n => R.addDaysYmd('2026-10-14', n);

  // 架空のメンバーとタスク
  const members = [
    { id: 'm1', name: '青木', sort_order: 1 }, { id: 'm2', name: '井上', sort_order: 2 },
    { id: 'm3', name: '上田', sort_order: 3 }, { id: 'm4', name: '江藤', sort_order: 4 },
  ];
  const lists = [{ id: 'l1', name: 'マイタスク' }, { id: 'l2', name: '研修' }];
  let n = 0;
  const task = o => Object.assign({
    id: 't' + (++n), list_id: 'l1', parent_id: null, title: '', assignee: 'm1', due: null, due_time: '', do_date: null, do_time: '',
    repeat: '', status: 'todo', created_at: at('09:00', -3), created_by: o.assignee || 'm1', updated_at: at('09:00', -1),
    completed_at: null, completed_by: '', note_text: '', note_at: null, deleted_at: null,
  }, o);
  const tasks = [
    task({ title: '月次報告書の提出', assignee: 'm2', due: day(-1), status: 'doing', created_by: 'm1', note_text: '数字の確認待ち。午前中に仕上げる', note_at: at('16:40', -1) }),
    task({ title: '新店舗の備品発注', assignee: 'm3', due: day(0), due_time: '15:00', do_date: day(0), created_by: 'm1' }),
    task({ title: '加盟店説明会の会場予約', assignee: 'm1', due: day(0), status: 'doing', note_text: '候補を2つに絞った', note_at: at('09:20') }),
    task({ title: '求人広告の原稿確認', assignee: 'm4', do_date: day(0), do_time: '13:00', due: day(2), created_by: 'm2' }),
    task({ title: '週次ミーティングの議事録共有', assignee: 'm2', do_date: day(0), repeat: 'FREQ=WEEKLY;BYDAY=WE' }),
    task({ title: '研修アンケートの集計', list_id: 'l2', assignee: 'm3', do_date: day(-1), due: day(2), status: 'doing', note_text: '半分まで入力済み', note_at: at('17:10', -1) }),
    task({ title: '経費精算の締め', assignee: 'm1', due: day(1), due_time: '12:00', do_date: day(1), repeat: 'FREQ=MONTHLY;BYMONTHDAY=15' }),
    task({ title: '新人研修の資料づくり', list_id: 'l2', assignee: 'm4', due: day(5), do_date: day(1), created_by: 'm1', created_at: at('09:30') }),
    task({ title: '備品の在庫確認', assignee: 'm3', due: day(9), updated_at: at('10:00', -6), created_at: at('10:00', -6) }),
    task({ title: '請求書の発行', assignee: 'm2', due: day(0), status: 'done', completed_at: at('09:40'), completed_by: 'm2' }),
  ];
  const cfg = R.mergeConfig({});
  const url = 'https://example.github.io/honbu-task/web/';
  const hourlyNow = new Date(at('10:00'));
  const w1 = R.reportWindow(hourlyNow, at('09:00'), false);
  const hourly = R.buildReport({ now: hourlyNow, since: w1.since, hasPrev: w1.hasPrev, summary: false, slot: '10:00', cfg, members, lists, tasks, noteTaskIds: ['t3'], url });

  // 17:30 までに少し進んだ状態
  const later = tasks.map(t => Object.assign({}, t));
  const by = id => later.find(t => t.id === id);
  Object.assign(by('t2'), { status: 'done', completed_at: at('14:20'), completed_by: 'm3' });
  Object.assign(by('t3'), { status: 'done', completed_at: at('16:05'), completed_by: 'm1' });
  Object.assign(by('t4'), { status: 'doing', note_text: '修正点を先方に送った', note_at: at('15:30'), updated_at: at('15:30') });
  const sumNow = new Date(at('17:30'));
  const w2 = R.reportWindow(sumNow, at('17:00'), true);
  const summary = R.buildReport({ now: sumNow, since: w2.since, hasPrev: w2.hasPrev, summary: true, slot: '17:30', cfg, members, lists, tasks: later, noteTaskIds: ['t3', 't4'], url });

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const block = (title, rep) => `
  <section>
    <h2>${esc(title)}</h2>
    <div class="subject"><span>件名</span>${esc(rep.subject)}</div>
    <div class="mail">${rep.html}</div>
    <details><summary>文字だけで見る場合（HTML を表示しないメールソフト）</summary><pre>${esc(rep.text)}</pre></details>
  </section>`;
  const page = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>メールの見本</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f1f3f4; font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Yu Gothic UI', Meiryo, sans-serif; color: #1f1f1f; }
  header { background: #fff; border-bottom: 1px solid #e0e3e7; padding: 16px; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; color: #5f6368; font-size: 14px; }
  main { max-width: 760px; margin: 0 auto; padding: 16px; }
  section { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 24px; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
  h2 { margin: 0 0 12px; font-size: 17px; }
  .subject { background: #f8f9fa; border: 1px solid #e0e3e7; border-radius: 8px; padding: 8px 12px; margin-bottom: 16px; font-size: 14px; word-break: break-all; }
  .subject span { display: inline-block; background: #5f6368; color: #fff; border-radius: 4px; font-size: 12px; padding: 0 6px; margin-right: 8px; }
  .mail { overflow-x: auto; }
  details { margin-top: 16px; }
  summary { cursor: pointer; color: #0b57d0; font-size: 14px; }
  pre { white-space: pre-wrap; font-size: 13px; background: #f8f9fa; padding: 12px; border-radius: 8px; }
</style></head>
<body>
<header><h1>本部タスク メールの見本</h1><p>2026年10月14日（水）の例です。名前・タスクはすべて架空のものです。</p></header>
<main>
${block('① 毎時のメール（10:00〜17:00 の毎時ちょうど）', hourly)}
${block('② 今日のまとめ（17:30）', summary)}
</main>
</body></html>
`;
  fs.writeFileSync(OUT, page);
  console.log('書き出しました: ' + OUT);
  console.log('\n--- 毎時 件名 ---\n' + hourly.subject + '\n\n' + hourly.text);
  console.log('\n--- まとめ 件名 ---\n' + summary.subject + '\n\n' + summary.text);
})().catch(e => { console.error(e); process.exit(1); });
