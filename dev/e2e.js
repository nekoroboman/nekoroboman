/**
 * 画面の動作確認（2人が同じアカウントで同時に使う場面を含む）
 * 先に node dev/server.js 8080 を起動しておき、node dev/e2e.js [出力フォルダ]
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:8080/';
const OUT = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
let step = 0;
const errors = [];

async function shot(page, name) {
  step++;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, String(step).padStart(2, '0') + '-' + name + '.png') });
}
// WEB=1 のときは Supabase 版の画面（ログインあり）を確かめる
async function login(page, setup) {
  if (!process.env.WEB) return;
  await page.waitForSelector('.login-card');
  if (setup) await page.click('.login-switch');
  await page.fill('.login-card input[type=email]', 'honbu-test@example.com');
  for (const box of await page.$$('.login-card input[type=password]')) await box.fill('test-pass-1234');
  await page.click('.login-card button[type=submit]');
}
function check(cond, msg) {
  if (!cond) throw new Error('確認NG: ' + msg);
  console.log('  ok  ' + msg);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctxA = await browser.newContext({ viewport: { width: 1400, height: 860 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const ctxB = await browser.newContext({ viewport: { width: 1400, height: 860 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const [p, who] of [[A, 'A'], [B, 'B']]) {
    p.on('pageerror', e => errors.push(who + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push(who + ' console: ' + m.text()); });
  }

  /* 1. 最初の人: 操作する人を登録 */
  await A.goto(BASE);
  if (process.env.WEB) {
    await A.waitForSelector('.login-card');
    await shot(A, 'login');
  }
  await login(A, true);
  await A.waitForSelector('.dialog');
  check(await A.isVisible('text=操作する人を選んでください'), '初回は「操作する人」を聞かれる');
  await shot(A, 'who-dialog');
  await A.fill('.dialog input', '田中（テスト）');
  await A.click('text=追加して選ぶ');
  await A.waitForSelector('.dialog', { state: 'detached' });
  check((await A.textContent('.who-chip')).includes('田中'), '右上に操作する人が出る');

  /* 2. 2人目（同じアカウントの別の端末） */
  await B.goto(BASE);
  await login(B);
  await B.waitForSelector('.dialog');
  await B.waitForSelector('.who-btn');
  check(await B.isVisible('.who-btn:has-text("田中")'), '別の端末にも、登録済みのメンバーが出る');
  await B.fill('.dialog input', '佐藤（テスト）');
  await B.click('text=追加して選ぶ');
  await B.waitForSelector('.dialog', { state: 'detached' });

  /* 3. 登録: 期限がないと登録できない */
  await A.click('.card .add-task');
  await A.fill('.af-title', '研修資料を作る');
  await A.press('.af-title', 'Enter');
  check(await A.isVisible('text=期限（いつまでに）を選んでください'), '期限がないと登録できない');
  await shot(A, 'need-due');
  await A.click('.chip-btn:has-text("期限")');
  await A.click('.quick button:has-text("明日")');
  await A.fill('.date-pop input[type=time]', '15:00');
  await A.click('.date-pop .btn.primary');
  await A.click('.chip-btn:has-text("田中")');
  await A.waitForSelector('.popover .menu-item');
  await A.waitForTimeout(800); // 佐藤さんが同期で届くのを待つ
  await A.click('.popover .menu-item:has-text("佐藤")');
  await A.press('.af-title', 'Enter');
  await A.waitForSelector('.task .t-title:has-text("研修資料を作る")');
  check(await A.isVisible('.task .chip:has-text("明日 15:00")'), '期限が「明日 15:00」と出る');
  check(await A.isVisible('.task .chip.who:has-text("佐藤")'), '担当者が出る');

  // 続けてもう1件（期限切れ）
  await A.fill('.af-title', '先週の報告書を出す');
  await A.click('.chip-btn:has-text("明日")');
  await A.fill('.date-pop input[type=date]', '2026-10-01');
  await A.click('.date-pop .btn.primary');
  await A.press('.af-title', 'Enter');
  await A.waitForSelector('.task .t-title:has-text("先週の報告書を出す")');
  check(await A.isVisible('.task .chip.red'), '期限切れは赤く出る');
  await A.click('.topbar .brand');
  await A.waitForTimeout(300);
  await shot(A, 'board');

  /* 4. 最新情報の反映: B の画面に数秒で出る */
  await B.waitForSelector('.task .t-title:has-text("研修資料を作る")', { timeout: 8000 });
  check(true, 'Aが登録したタスクが、Bの画面に自動で出る');
  check(await B.isVisible('.snack:has-text("担当タスクが届きました")'), 'Bに「担当タスクが届きました」と知らせる');
  await shot(B, 'b-received');

  /* 5. B が最新状況を書く → A に反映 */
  await B.click('.task .t-title:has-text("研修資料を作る")');
  await B.waitForSelector('.panel');
  await B.fill('.note-input', '下書きまで完了。明日の午前に送ります');
  await B.click('.note-actions .btn.primary');
  await B.waitForSelector('.tl-item.latest:has-text("下書きまで完了")');
  await B.waitForFunction(() => !document.querySelector('.tl-head') || !document.querySelector('.tl-head').textContent.includes('保存中'), null, { timeout: 8000 });
  await shot(B, 'b-note');
  await A.waitForSelector('.task .t-note:has-text("下書きまで完了")', { timeout: 8000 });
  check(await A.isVisible('.task .chip.doing'), 'Bが書いた最新状況と「進行中」が、Aの画面に出る');
  await shot(A, 'a-sees-note');

  /* 6. 同時編集: A がタイトル、B がスター → 両方残る */
  await A.click('.task .t-title:has-text("研修資料を作る")');
  await A.waitForSelector('.panel .p-title');
  await A.click('.panel .p-title');
  await A.fill('.panel .p-title', '研修資料を作って送る');
  await B.click('.panel-head .star');
  await A.press('.panel .p-title', 'Enter');
  await A.waitForTimeout(500);
  await A.waitForFunction(() => document.querySelector('.panel-head .star.on'), null, { timeout: 8000 });
  await B.waitForSelector('.panel .p-title', { timeout: 8000 });
  await B.waitForFunction(() => document.querySelector('.panel .p-title').value === '研修資料を作って送る', null, { timeout: 8000 });
  check(true, '同じタスクの別々の項目を同時に変えても、両方残る');
  check(await B.isVisible('.remote'), 'Bに「ほかの人が更新しました」と出る');
  await shot(B, 'b-remote-banner');

  /* 7. 期限を延ばすと理由を聞く */
  await A.click('.panel .field-btn:has-text("月")');
  await A.click('.quick button:has-text("来週の月曜")');
  await A.click('.date-pop .btn.primary');
  check(await A.isVisible('.reason'), '期限を延ばすと理由の入力欄が出る');
  await A.fill('.reason textarea', '先方の確認待ちのため');
  await A.click('.reason .btn.primary');
  await A.waitForSelector('.tl-item.latest:has-text("延長")');
  await shot(A, 'reason');

  /* 8. サブタスク */
  await A.fill('.sub-add input', '表紙を作る');
  await A.press('.sub-add input', 'Enter');
  await A.fill('.sub-add input', '目次を作る');
  await A.press('.sub-add input', 'Enter');
  await A.waitForSelector('.sub-row:has-text("")');
  await A.waitForTimeout(400);
  check((await A.$$('.sub-row')).length === 2, 'サブタスクを2つ追加できる');
  await A.click('.panel-head .icon-btn');
  await A.waitForTimeout(300);
  check(await A.isVisible('.task .chip:has-text("0/2")'), '一覧にサブタスクの数が出る');

  /* 9. 完了の演出 → 完了セクションへ、元に戻す */
  const row = A.locator('.task:has(.t-title:has-text("先週の報告書を出す")) .check');
  await row.click();
  await A.waitForTimeout(200);
  check(await A.isVisible('.task.completing'), '完了の演出（チェック→消える）が出る');
  await shot(A, 'completing');
  await A.waitForSelector('.snack:has-text("タスクを完了しました")');
  check(await A.isVisible('.done-head:has-text("完了（1件）")'), '完了セクションに入る');
  await A.click('.snack .s-act');
  await A.waitForTimeout(600);
  check(!(await A.isVisible('.done-head')), '「元に戻す」で未完了に戻る');

  /* 10. リストの作成・並べ替え・印刷メニュー */
  await A.click('.nav-item:has-text("新しいリストを作成")');
  await A.fill('.dialog input', '出店準備');
  await A.click('.dialog .btn.primary');
  await A.waitForSelector('.card-title:has-text("出店準備")');
  await A.click('.card .add-task');
  await A.fill('.af-title', '物件の候補を3つ出す');
  await A.click('.chip-btn:has-text("期限")');
  await A.click('.quick button:has-text("今日")');
  await A.click('.date-pop .btn.primary');
  await A.press('.af-title', 'Enter');
  await A.waitForSelector('.task .t-title:has-text("物件の候補")');
  await A.click('.nav-item:has-text("すべてのタスク")');
  await A.waitForTimeout(300);
  await A.click('.card:has(.card-title:has-text("マイタスク")) .card-head .icon-btn');
  await A.waitForSelector('.popover .menu-item:has-text("日付")');
  await shot(A, 'list-menu');
  await A.click('.popover .menu-item:has-text("日付")');
  await A.waitForSelector('.card .card-sub:has-text("日付")');
  check(await A.isVisible('.group-head:has-text("期限切れ")') || await A.isVisible('.group-head'), '日付で並べ替えると見出しで分かれる');

  /* 11. 進捗ボード */
  await A.click('.nav-item:has-text("進捗ボード")');
  await A.waitForSelector('.page h1:has-text("進捗ボード")');
  await shot(A, 'progress');
  check(await A.isVisible('.tbl td:has-text("佐藤")'), '担当者別の表が出る');

  /* 12. 自分の担当・スター付き・検索 */
  await B.click('.nav-item:has-text("自分の担当")');
  await B.waitForSelector('.card-title:has-text("自分の担当")');
  check(await B.isVisible('.task .t-title:has-text("研修資料を作って送る")'), '「自分の担当」に佐藤さんのタスクが出る');
  await B.click('.nav-item:has-text("スター付き")');
  check(await B.isVisible('.task .t-title:has-text("研修資料を作って送る")'), 'スター付きに出る');
  await B.fill('.search input', '物件');
  await B.waitForSelector('.card-title:has-text("検索")');
  check(await B.isVisible('.task .t-title:has-text("物件の候補")'), '検索できる');
  await B.fill('.search input', '');

  /* 13. 削除→ごみ箱→戻す */
  await A.click('.nav-item:has-text("すべてのタスク")');
  await A.click('.task:has(.t-title:has-text("物件の候補")) .more');
  await A.click('.popover .menu-item.danger');
  await A.waitForSelector('.snack:has-text("削除しました")');
  await A.click('.nav-item:has-text("ごみ箱")');
  await A.waitForSelector('.task .t-title:has-text("物件の候補")');
  await shot(A, 'trash');
  await A.click('.task:has(.t-title:has-text("物件の候補")) .btn');
  await A.waitForSelector('.snack:has-text("元に戻しました")');
  await A.click('.nav-item:has-text("すべてのタスク")');
  await A.waitForSelector('.task .t-title:has-text("物件の候補")', { timeout: 5000 });
  check(true, 'ごみ箱から元に戻せる');

  /* 14. 設定: メール通知 */
  await A.click('.topbar .icon-btn[aria-label="設定"]');
  await A.click('.tabs button:has-text("メール通知")');
  await A.waitForSelector('text=送信履歴');
  await A.fill('.dialog textarea', 'honbu@example.com');
  await A.click('.dialog .switch >> nth=0');
  await A.click('.dialog .btn.primary:has-text("保存")');
  await A.waitForSelector('.snack:has-text("保存しました")');
  await shot(A, 'mail-settings');
  await A.click('.dialog .btn:has-text("プレビュー")');
  await A.waitForSelector('.preview-frame');
  await A.waitForTimeout(400);
  await shot(A, 'mail-preview');
  await A.click('.dialog .btn.primary:has-text("閉じる")');
  await A.click('.dialog .btn:has-text("テスト送信")');
  await A.waitForSelector('.snack:has-text("テスト")');
  check(await A.isVisible('.log-table td:has-text("送信済み")'), 'テスト送信が履歴に残る');
  await A.keyboard.press('Escape');

  /* 15. スマホの画面 */
  const M = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', isMobile: true, hasTouch: true })).newPage();
  M.on('pageerror', e => errors.push('M: ' + e.message));
  await M.goto(BASE);
  await login(M);
  await M.waitForSelector('.who-btn');
  await M.click('.who-btn:has-text("佐藤")');
  await M.waitForSelector('.card');
  await shot(M, 'mobile-board');
  await M.click('.topbar .icon-btn[aria-label="メニュー"]');
  await M.waitForTimeout(300);
  await shot(M, 'mobile-nav');
  await M.click('.nav-item:has-text("自分の担当")');
  await M.click('.task .t-title:has-text("研修資料")');
  await M.waitForSelector('.panel');
  await shot(M, 'mobile-detail');

  /* 16. ダーク */
  await A.click('.topbar .icon-btn[aria-label="設定"]');
  await A.click('.radios button:has-text("ダーク")');
  await A.keyboard.press('Escape');
  await A.click('.task .t-title:has-text("研修資料")');
  await A.waitForSelector('.panel');
  await shot(A, 'dark');

  await browser.close();
  if (errors.length) { console.error('画面のエラー:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nすべて確認できました。画面写真: ' + OUT);
})().catch(async e => {
  console.error(e);
  if (errors.length) console.error('画面のエラー:\n' + errors.join('\n'));
  process.exit(1);
});
