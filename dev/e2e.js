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
async function login(page) {
  if (!process.env.WEB) return;
  await page.waitForSelector('.login-card');
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
  await login(A);
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
  await A.fill('.af-details', '1行目：目次を作る');
  await A.press('.af-details', 'Enter');
  await A.type('.af-details', '2行目：本文を書く');
  check((await A.inputValue('.af-details')).includes('\n') && !(await A.isVisible('.task .t-title:has-text("研修資料を作る")')), '詳細では Enter で改行できる（登録はされない）');
  await A.press('.af-title', 'Enter');
  check(await A.isVisible('.af-err:has-text("優先度")'), '優先度を選ばないと登録できない');
  await A.click('.add-form .prio-btn.p-high');
  await A.press('.af-title', 'Enter');
  await A.waitForSelector('.task .t-title:has-text("研修資料を作る")');
  check(await A.isVisible('.task.prio-high:has(.t-title:has-text("研修資料を作る")) .chip.prio.p-high:has-text("高")'), '優先度「高」が赤い印と左の帯で出る');
  check(await A.isVisible('.task .t-details:has-text("2行目")'), '改行した詳細が一覧に出る');
  check(await A.isVisible('.task .chip:has-text("明日 15:00")'), '期限が「明日 15:00」と出る');
  check(await A.isVisible('.task .chip.who:has-text("佐藤")'), '担当者が出る');

  // 続けてもう1件（期限切れ）
  await A.fill('.af-title', '先週の報告書を出す');
  await A.click('.chip-btn:has-text("明日")');
  await A.fill('.date-pop input[type=date]', '2026-10-01');
  await A.click('.date-pop .btn.primary');
  check(!(await A.isVisible('.add-form .prio-btn.on')), '優先度は1件ごとに選び直す');
  await A.click('.add-form .prio-btn.p-low');
  await A.press('.af-title', 'Enter');
  await A.waitForSelector('.task .t-title:has-text("先週の報告書を出す")');
  check(await A.isVisible('.task .chip.red'), '期限切れは赤く出る');
  await A.click('.topbar .brand');
  await A.waitForTimeout(300);
  await shot(A, 'board');

  /* 4. 最新情報の反映: B の画面に数秒で出る */
  await B.waitForSelector('.task .t-title:has-text("研修資料を作る")', { timeout: 8000 });
  check(true, 'Aが登録したタスクが、Bの画面に自動で出る');
  check(await B.isVisible('.snack:has-text("タスクが届きました")'), 'Bに「タスクが届きました」と知らせる');
  await B.waitForSelector('.inbox .inbox-item:has-text("研修資料を作る")', { timeout: 8000 });
  check(await B.isVisible('.inbox-head:has-text("届いています")'), 'Bの画面に「届いたタスク」が、開くまで出ている');
  check(await B.isVisible('.nav-item:has-text("自分の担当") .badge-new'), '「自分の担当」に新着の数が出る');
  check(await B.isVisible('.task.fresh:has(.t-title:has-text("研修資料を作る")) .chip.new'), '届いたタスクに「新着」が付く');
  check(/^\(\d+\) /.test(await B.title()), 'タブの名前に届いた数が出る');
  check(await A.isVisible('.task:has(.t-title:has-text("研修資料を作る")) .chip.unread'), '頼んだ人（A）には「未確認」と出る');
  await shot(B, 'b-received');

  /* 5. B が開く（確認済みになる）→ 最新状況を書く → A に反映 */
  await B.click('.inbox-item:has-text("研修資料を作る")');
  await B.waitForSelector('.panel');
  await B.waitForSelector('.inbox-item:has-text("研修資料を作る")', { state: 'detached' });
  check(!(await B.isVisible('.task.fresh:has(.t-title:has-text("研修資料を作る"))')), '開くと「新着」が消える');
  await A.waitForSelector('.snack:has-text("佐藤（テスト）さんが「研修資料を作る」を確認しました")', { timeout: 8000 });
  check(!(await A.isVisible('.task:has(.t-title:has-text("研修資料を作る")) .chip.unread')), '相手が開くと、頼んだ人に「確認しました」と知らせ、「未確認」が消える');
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
  await A.click('.panel .field:has(label:has-text("いつまでに")) .field-btn');
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

  /* 8b. 他の人のタスクを見る・頼む */
  await A.click('.nav-member:has-text("佐藤")');
  await A.waitForSelector('.card-title:has-text("佐藤（テスト）さんのタスク")');
  check(await A.isVisible('.task .t-title:has-text("研修資料")'), 'ほかの人（佐藤さん）のタスクが見られる');
  check(await A.isVisible('.member-board .card .card-title:has-text("マイタスク")'), 'メンバーの画面は、リストごとに分けて出る');
  await A.click('.add-task:has-text("さんにタスクを送る")');
  await A.fill('.af-title', '備品の在庫を数える');
  check(await A.isVisible('.af-hint.ask:has-text("佐藤")'), '頼む相手が出る');
  await A.click('.chip-btn:has-text("いつやる")');
  await A.click('.quick button:has-text("今日")');
  await A.click('.date-pop .btn.primary');
  await A.click('.chip-btn:has-text("期限")');
  await A.click('.quick button:has-text("来週の月曜")');
  await A.click('.date-pop .btn.primary');
  await A.click('.add-form .prio-btn.p-mid');
  await A.click('.af-actions .btn.primary:has-text("タスクを送る")');
  await A.waitForSelector('.snack:has-text("佐藤（テスト）さんにタスクを送りました")');
  check(true, '「タスクを送る」で頼める');
  await A.waitForSelector('.task .t-title:has-text("備品の在庫を数える")');
  check(await A.isVisible('.task:has(.t-title:has-text("備品の在庫")) .chip.do:has-text("やる 今日")'), '「いつやる」が出る');
  check(await A.isVisible('.task:has(.t-title:has-text("備品の在庫")) .chip:has-text("期限 ")'), '「いつやる」と期限の両方が出る');
  check(await A.isVisible('.task:has(.t-title:has-text("備品の在庫")) .chip.ask:has-text("田中（テスト）さんから")'), '頼んだ人が出る');
  await shot(A, 'member-view');
  await B.waitForSelector('.snack:has-text("備品の在庫を数える")', { timeout: 8000 });
  check(true, '頼まれた人（B）の画面に知らせが出る');
  check(await B.isVisible('.inbox-item:has-text("備品の在庫を数える")'), '頼まれた人（B）の画面に、開くまで「届いたタスク」が残る');
  await A.click('.nav-member:has-text("田中")');
  await A.click('.member-tabs button:has-text("依頼したタスク")');
  await A.waitForSelector('.task .t-title:has-text("備品の在庫を数える")');
  check(true, '自分が頼んだタスクを一覧で見られる');
  check(await A.isVisible('.task:has(.t-title:has-text("備品の在庫")) .chip.unread'), '相手がまだ開いていないと「未確認」と出る');
  await B.click('.inbox .btn:has-text("すべて確認済みにする")');
  await B.waitForSelector('.inbox', { state: 'detached' });
  await A.waitForSelector('.task:has(.t-title:has-text("備品の在庫")) .chip.unread', { state: 'detached', timeout: 8000 });
  check(true, '「すべて確認済みにする」で、頼んだ人の「未確認」が消える');
  await A.click('.member-tabs button:has-text("担当")');

  /* 8c. 繰り返し（Google ToDo リストと同じ設定）・期限なし */
  await A.click('.nav-item:has-text("すべてのタスク")');
  await A.click('.card:has(.card-title:has-text("マイタスク")) .add-task');
  await A.fill('.af-title', '週次ミーティングの議事録');
  await A.click('.chip-btn:has-text("繰り返し")');
  await A.waitForSelector('.popover .menu-item:has-text("毎日")');
  check(!(await A.isVisible('.popover .menu-item:has-text("毎年")')) && !(await A.isVisible('.popover .menu-item:has-text("第")')), 'すぐ選べる繰り返しに、分かりにくい項目（毎年・第○曜日）が出ない');
  await A.click('.popover .menu-item:has-text("カスタム")');
  await A.waitForSelector('.repeat-dlg');
  const todayDow = new Date(Date.now() + 9 * 3600000).getUTCDay();
  for (const [d, n] of [['月', 1], ['水', 3]]) if (n !== todayDow) await A.click('.repeat-dlg .dows button:has-text("' + d + '")');
  if ([1, 3].indexOf(todayDow) < 0) await A.click('.repeat-dlg .dows button:has-text("' + '日月火水木金土'[todayDow] + '")');
  await A.click('.repeat-dlg label.rp-radio:has-text("期限なし") input');
  await A.click('.repeat-dlg label.rp-radio:has-text("回繰り返したら終了") input');
  await A.fill('.repeat-dlg label.rp-radio:has-text("回繰り返したら終了") input[type=number]', '5');
  await A.waitForTimeout(300);
  await shot(A, 'repeat-dialog');
  check(await A.isVisible('.repeat-dlg .rp-sum:has-text("毎週 月・水曜日（5回）")'), '繰り返しの内容が文章で出る');
  await A.click('.repeat-dlg .btn.primary:has-text("完了")');
  check(await A.isVisible('.chip-btn:has-text("毎週 月・水曜日")'), '追加欄に繰り返しが出る');
  check(await A.isVisible('.chip-btn:has-text("期限なし")'), '繰り返しのタスクは期限なしにできる');
  await A.click('.add-form .prio-btn.p-mid');
  await A.press('.af-title', 'Enter');
  await A.waitForSelector('.task .t-title:has-text("週次ミーティングの議事録")');
  const rep = '.card:has(.card-title:has-text("マイタスク")) .task:has(.t-title:has-text("週次ミーティング"))';
  check(await A.isVisible(rep + ' .chip.muted-chip:has-text("期限なし")'), '一覧に「期限なし」と出る');
  await A.press('.af-title', 'Escape');
  await A.click(rep + ' .t-title');
  await A.waitForSelector('.panel .field:has-text("繰り返し") .field-btn:has-text("毎週 月・水曜日（5回）")');
  check(await A.isVisible('.panel .field:has-text("繰り返し") :text("次の回")'), '詳細に次の回の日が出る');
  await shot(A, 'repeat-detail');
  await A.click('.panel .p-title-row .check');
  await A.waitForSelector('.panel .p-title-row .check.armed', { timeout: 2000 });
  check(true, '1回押すと「もう一度押すと完了」の状態になる（まだ完了しない）');
  await A.click('.panel .p-title-row .check');
  await A.waitForFunction(() => [...document.querySelectorAll('.card .task-list .task .t-title')].some(e => e.textContent.includes('週次ミーティング')), null, { timeout: 8000 });
  await A.waitForTimeout(400);
  check(await A.isVisible(rep + ' .chip.do'), '繰り返しのタスクを完了すると、次の回ができる');
  await A.click('.panel-head .icon-btn');

  /* 9. 完了の演出 → 完了セクションへ、元に戻す */
  const row = A.locator('.task:has(.t-title:has-text("先週の報告書を出す")) .check');
  await row.click();
  await A.waitForSelector('.task.armed:has(.t-title:has-text("先週の報告書を出す")) .arm-hint:has-text("もう一度押すと完了")', { timeout: 2000 });
  check(true, '完了は1回目で「もう一度押すと完了」と出る');
  await A.waitForTimeout(3300);
  check(!(await A.isVisible('.task.armed')), '3秒たつと元に戻る（完了しない）');
  await row.click();
  await row.click();
  await A.waitForTimeout(200);
  check(await A.isVisible('.task.completing'), '2回押すと完了の演出（チェック→消える）が出る');
  await A.waitForSelector('.stamp img[src="stamps/nyaa.png"]', { timeout: 3000 });
  check(/にゃ！/.test(await A.textContent('.stamp .stamp-text')), '完了するとネコロボマンのスタンプ（〜にゃ！）が出る');
  await shot(A, 'completing');
  await A.waitForSelector('.card:has(.card-title:has-text("マイタスク")) .done-head:has-text("完了（2件）")', { timeout: 5000 });
  check(true, '完了セクションに入る');
  await A.click('.snack:has-text("タスクを完了しました") .s-act');
  await A.waitForTimeout(600);
  check(await A.isVisible('.card:has(.card-title:has-text("マイタスク")) .done-head:has-text("完了（1件）")'), '「元に戻す」で未完了に戻る');

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
  await A.click('.add-form .prio-btn.p-high');
  await A.press('.af-title', 'Enter');
  await A.waitForSelector('.task .t-title:has-text("物件の候補")');
  await A.click('.nav-item:has-text("すべてのタスク")');
  await A.waitForTimeout(300);
  // リストのカードをつかんで並べ替える
  const cardOrder = () => A.$$eval('.board > .card .card-title', els => els.map(e => e.textContent));
  check((await cardOrder()).join() === 'マイタスク,出店準備', 'リストのカードが作った順に並ぶ');
  await A.dragAndDrop('.card:has(.card-title:has-text("出店準備")) .card-grip', '.card:has(.card-title:has-text("マイタスク"))', { targetPosition: { x: 30, y: 60 } });
  await A.waitForFunction(() => [...document.querySelectorAll('.board > .card .card-title')].map(e => e.textContent).join() === '出店準備,マイタスク', null, { timeout: 5000 });
  check(true, 'リストのカードをつかんで動かすと、並び順が変わる');
  await A.waitForFunction(() => [...document.querySelectorAll('.nav-list')].map(e => e.textContent).join().indexOf('出店準備') < [...document.querySelectorAll('.nav-list')].map(e => e.textContent).join().indexOf('マイタスク'));
  check(true, '左のリスト一覧の順番も同じになる');
  await A.click('.card:has(.card-title:has-text("出店準備")) .card-head .icon-btn');
  await A.click('.popover .menu-item:has-text("右（下）へ動かす")');
  await A.waitForFunction(() => [...document.querySelectorAll('.board > .card .card-title')].map(e => e.textContent).join() === 'マイタスク,出店準備', null, { timeout: 5000 });
  check(true, 'リストのメニューの「右へ動かす」でも並べ替えられる（スマホ向け）');
  await A.click('.card:has(.card-title:has-text("マイタスク")) .card-head .icon-btn');
  await A.waitForSelector('.popover .menu-item:has-text("期限")');
  await shot(A, 'list-menu');
  await A.click('.popover .menu-item:has-text("期限")');
  await A.waitForSelector('.card .card-sub:has-text("期限")');
  check(await A.isVisible('.group-head:has-text("期限切れ")') || await A.isVisible('.group-head'), '期限で並べ替えると見出しで分かれる');
  await A.click('.card:has(.card-title:has-text("マイタスク")) .card-head .icon-btn');
  await A.click('.popover .menu-item:has-text("いつやる")');
  await A.waitForSelector('.card .card-sub:has-text("いつやる")');
  check(await A.isVisible('.group-head:has-text("いつやるが未定")'), '「いつやる」で並べ替えられる');
  await A.click('.card:has(.card-title:has-text("マイタスク")) .card-head .icon-btn');
  await A.click('.popover .menu-item:has-text("優先度")');
  await A.waitForSelector('.card .card-sub:has-text("優先度")');
  check(await A.isVisible('.card:has(.card-title:has-text("マイタスク")) .group-head:has-text("優先度 高")'), '優先度で並べ替えると「高」から見出しで分かれる');
  await A.click('.card:has(.card-title:has-text("マイタスク")) .card-head .icon-btn');
  await A.click('.popover .menu-item:has-text("自分の並べ替え順")');

  /* 11. 進捗ボード */
  await A.click('.nav-item:has-text("進捗ボード")');
  await A.waitForSelector('.page h1:has-text("進捗ボード")');
  await shot(A, 'progress');
  check(await A.isVisible('.tbl td:has-text("佐藤")'), '担当者別の表が出る');
  check(await A.isVisible('.tile:has-text("今日やる")'), '進捗ボードに「今日やる」が出る');

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
  check(await A.frameLocator('.preview-frame').locator('h3:has-text("今日やる予定")').count() > 0, 'メールに「今日やる予定」が載る');
  await shot(A, 'mail-preview');
  await A.click('.dialog .btn.primary:has-text("閉じる")');
  await A.click('.dialog .btn:has-text("テスト送信")');
  await A.waitForSelector('.snack:has-text("テスト")');
  await A.waitForSelector('.log-table td:has-text("送信済み")', { timeout: 10000 });
  check(true, 'テスト送信が履歴に残る');
  await A.keyboard.press('Escape');

  /* 14b. カレンダー（Google カレンダーと同じ操作） */
  await A.click('.mode-switch button:has-text("カレンダー")');
  await A.waitForSelector('.time-grid');
  check(await A.isVisible('.tg-day.today'), 'カレンダー（週）が開き、今日が分かる');
  await A.locator('.tg-scroll').evaluate(el => { el.scrollTop = 13 * 48; });
  const colBox = await A.locator('.tg-col.today').boundingBox();
  await A.mouse.move(colBox.x + 30, colBox.y + 14 * 48 + 4);
  await A.mouse.down();
  await A.mouse.move(colBox.x + 30, colBox.y + 15.5 * 48 + 4, { steps: 6 });
  await A.mouse.up();
  await A.waitForSelector('.qpop');
  check(await A.inputValue('.qpop select[aria-label="開始の時刻"]') === '14:00' && await A.inputValue('.qpop select[aria-label="終了の時刻"]') === '15:30', 'ドラッグした時間で予定を作り始められる');
  const selBox = await A.locator('.tg-ev.sel-ghost').boundingBox();
  await A.mouse.move(selBox.x + selBox.width / 2, selBox.y + 12);
  await A.mouse.down();
  await A.mouse.move(selBox.x + selBox.width / 2, selBox.y + 12 + 48, { steps: 6 });
  await A.mouse.up();
  await A.waitForFunction(() => { const e = document.querySelector('.qpop select[aria-label="開始の時刻"]'); return e && e.value === '15:00'; });
  check(await A.inputValue('.qpop select[aria-label="終了の時刻"]') === '16:30', '作りかけの枠をドラッグでずらすと、小さな画面の時刻も変わる');
  await A.selectOption('.qpop select[aria-label="終了の時刻"]', '17:00');
  check(await A.isVisible('.tg-ev.sel-ghost:has-text("15:00～17:00")'), '小さな画面で時刻を変えると、カレンダーの枠も変わる');
  await A.fill('.qp-title', '週次会議（テスト）');
  await A.press('.qp-title', 'Enter');
  await A.waitForSelector('.tg-ev:has-text("週次会議（テスト）"):has-text("15:00～17:00")');
  check(true, 'その場でタイトルを入れて予定を作れる（変えた時刻で）');
  await A.click('.tg-ev:has-text("週次会議（テスト）")');
  await A.waitForSelector('.cal-pop .cp-title:has-text("週次会議")');
  await A.click('.cal-pop .icon-btn[aria-label="予定を編集"]');
  await A.waitForSelector('.cal-editor');
  await A.click('.ce-quick-guests .chip-btn:has-text("佐藤")');
  await A.fill('.ce-field input[placeholder="場所を追加"]', '本部 会議室');
  await shot(A, 'cal-editor');
  await A.click('.ce-head .btn.primary');
  await A.waitForSelector('.cal-editor', { state: 'detached' });
  await B.click('.mode-switch button:has-text("カレンダー")');
  await B.waitForSelector('.tg-ev:has-text("週次会議（テスト）")', { timeout: 8000 });
  check(true, 'ゲストにした人（B）のカレンダーに予定が出る');
  check(await B.isVisible('.tg-ev.invite:has-text("週次会議")'), '返事をしていない招待は枠だけで出る');
  check(await B.isVisible('.cal-chip.task:has-text("備品の在庫")'), '自分のタスク（いつやる）もカレンダーに出る');
  await B.click('.tg-ev:has-text("週次会議（テスト）")');
  await B.click('.cp-rsvp button:has-text("はい")');
  await B.keyboard.press('Escape');
  await A.waitForTimeout(1500);
  await A.click('.tg-ev:has-text("週次会議（テスト）")');
  await A.waitForSelector('.cal-pop .cp-sub:has-text("はい 2")', { timeout: 8000 });
  check(true, 'B の出欠（はい）が A に届く');
  await shot(A, 'cal-week');
  await A.keyboard.press('Escape');
  // 予定をドラッグでずらす・下の端で長さを変える（Google カレンダーと同じ）
  const evBox = await A.locator('.tg-ev:has-text("週次会議（テスト）")').boundingBox();
  await A.mouse.move(evBox.x + evBox.width / 2, evBox.y + 12);
  await A.mouse.down();
  await A.mouse.move(evBox.x + evBox.width / 2, evBox.y + 12 + 48, { steps: 8 });
  await A.mouse.up();
  await A.waitForSelector('.tg-ev:has-text("週次会議（テスト）"):has-text("16:00～18:00")');
  check(true, '予定をドラッグで1時間後にずらせる（消えない）');
  const evBox2 = await A.locator('.tg-ev:has-text("週次会議（テスト）")').boundingBox();
  await A.mouse.move(evBox2.x + evBox2.width / 2, evBox2.y + evBox2.height - 3);
  await A.mouse.down();
  await A.mouse.move(evBox2.x + evBox2.width / 2, evBox2.y + evBox2.height - 3 + 24, { steps: 6 });
  await A.mouse.up();
  await A.waitForSelector('.tg-ev:has-text("週次会議（テスト）"):has-text("16:00～18:30")');
  check(true, '予定の下の端を引っぱって長さを変えられる');
  // 繰り返し: 毎日の予定を作り、1回だけ消す
  await A.keyboard.press('x');
  await A.waitForSelector('.time-grid[style*="--days: 4"]');
  await A.click('.create-btn');
  await A.click('.popover .menu-item:has-text("予定")');
  await A.fill('.ce-title', '朝の確認（テスト）');
  await A.selectOption('.ce-when select[aria-label="開始時刻"]', '08:00');
  await A.selectOption('.ce-when select[aria-label="繰り返し"]', 'FREQ=DAILY');
  await A.click('.ce-head .btn.primary');
  await A.waitForSelector('.cal-editor', { state: 'detached' });
  await A.waitForTimeout(600);
  const n1 = await A.locator('.tg-ev:has-text("朝の確認")').count();
  check(n1 === 4, '毎日の予定が4日分出る（4日表示）');
  await A.locator('.tg-ev:has-text("朝の確認")').last().click();
  await A.click('.cal-pop .icon-btn[aria-label="予定を削除"]');
  await A.waitForSelector('.dialog:has-text("繰り返し予定の削除")');
  await shot(A, 'cal-scope');
  await A.click('.dialog .btn.primary');
  await A.waitForTimeout(800);
  check(await A.locator('.tg-ev:has-text("朝の確認")').count() === n1 - 1, '繰り返しの「この予定」だけを削除できる');
  await A.keyboard.press('m');
  await A.waitForSelector('.month-view');
  check(await A.isVisible('.mv-cell .cal-chip:has-text("週次会議")'), '月の表示に切り替えられる（キーボードの M）');
  await shot(A, 'cal-month');
  await A.keyboard.press('a');
  await A.waitForSelector('.schedule-view .sv-item:has-text("週次会議")');
  check(true, 'スケジュールの表示');
  await A.keyboard.press('y');
  await A.waitForSelector('.year-view');
  check(true, '年の表示');
  await A.keyboard.press('w');
  await A.click('.mode-switch button:has-text("タスク")');
  await B.click('.mode-switch button:has-text("タスク")');

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
  await M.click('.panel .field:has(label:has-text("繰り返し")) .field-btn');
  await M.click('.popover .menu-item:has-text("カスタム")');
  await M.waitForSelector('.repeat-dlg');
  await M.click('.repeat-dlg select >> nth=0');
  await M.selectOption('.repeat-dlg select >> nth=0', 'MONTHLY');
  await M.click('.repeat-dlg label.rp-radio:has-text("曜日で") input');
  await M.selectOption('.repeat-dlg select[aria-label="第何"]', '3');
  await M.selectOption('.repeat-dlg select[aria-label="曜日"]', '3');
  check(await M.isVisible('.repeat-dlg .rp-sum:has-text("毎月 第3水曜日")'), '「毎月 第3水曜日」のように、第何と曜日をじかに選べる');
  await M.selectOption('.repeat-dlg select[aria-label="第何"]', '-1');
  await M.selectOption('.repeat-dlg select[aria-label="曜日"]', '5');
  check(await M.isVisible('.repeat-dlg .rp-sum:has-text("毎月 最終金曜日")'), '「毎月 最終金曜日」も選べる');
  await M.waitForTimeout(300);
  await shot(M, 'mobile-repeat');
  await M.click('.repeat-dlg .btn.text:has-text("キャンセル")');
  await M.waitForSelector('.repeat-dlg', { state: 'hidden', timeout: 3000 }).catch(() => {});
  check(!(await M.isVisible('.repeat-dlg')), 'スマホでも繰り返しの設定を開ける');

  /* 16. ダーク */
  await A.click('.topbar .icon-btn[aria-label="設定"]');
  await A.click('.radios button:has-text("ダーク")');
  await A.keyboard.press('Escape');
  await A.click('.task .t-title:has-text("研修資料")');
  await A.waitForSelector('.panel');
  await shot(A, 'dark');

  /* 17. 招待制のアカウントと管理画面 */
  if (process.env.WEB) {
    const newPage = async (name, opts) => {
      const p = await (await browser.newContext(Object.assign({ viewport: { width: 1280, height: 820 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' }, opts || {}))).newPage();
      p.on('pageerror', e => errors.push(name + ': ' + e.message));
      return p;
    };
    const C = await newPage('C');
    await C.goto(BASE);
    await C.waitForSelector('.login-card');
    check(!(await C.isVisible('text=はじめての方')), 'ログイン画面から自分でアカウントを作れない（招待制）');
    await shot(C, 'login-invite-only');
    // 管理画面（A の端末。アプリにログインしていても、もう一度ログインが要る）
    const AD = await ctxA.newPage();
    AD.on('pageerror', e => errors.push('AD: ' + e.message));
    await AD.goto(BASE + 'admin.html');
    await AD.waitForSelector('.login-card');
    check(await AD.isVisible('text=管理者のログイン'), 'アプリにログインしていても、管理画面はもう一度ログインが要る');
    await AD.fill('.login-card input[type=email]', 'honbu-test@example.com');
    await AD.fill('.login-card input[type=password]', 'test-pass-1234');
    await AD.click('.login-card button[type=submit]');
    await AD.waitForSelector('.adm-table');
    check(await AD.isVisible('.adm-table td:has-text("共有のアカウント")'), '管理画面にアカウントの一覧が出る');
    await AD.fill('.adm-invite input >> nth=0', '鈴木（テスト）');
    await AD.fill('.adm-invite input[type=email]', 'suzuki@example.com');
    await AD.click('.adm-invite button[type=submit]');
    await AD.waitForSelector('.dialog .adm-link input');
    const url = await AD.inputValue('.dialog .adm-link input');
    check(/#invite=[A-Za-z0-9_-]{30,}$/.test(url), '招待するとリンクができる');
    await shot(AD, 'admin-link');
    await AD.click('.dialog .btn.primary:has-text("閉じる")');
    await AD.waitForSelector('.adm-table tr:has-text("鈴木") .adm-chip.wait');
    await AD.waitForFunction(() => /メール送信済み/.test((document.querySelector('.adm-table') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    await AD.reload();
    await AD.waitForSelector('.adm-table tr:has-text("鈴木"):has-text("メール送信済み")', { timeout: 8000 });
    check(true, '招待中として一覧に出て、招待メールが送られる');
    await shot(AD, 'admin');
    // 招待された人がリンクを開いて、パスワードを決める
    await C.goto('about:blank');
    await C.goto(url);
    await C.waitForSelector('.login-card input[readonly]');
    check((await C.inputValue('.login-card input[readonly]')) === 'suzuki@example.com', 'リンクを開くと、招待されたメールアドレスが出る');
    await shot(C, 'invite-accept');
    const pws = await C.$$('.login-card input[type=password]');
    await pws[0].fill('suzuki-pass-1');
    await pws[1].fill('suzuki-pass-1');
    await C.click('.login-card button[type=submit]');
    await C.waitForSelector('.topbar');
    await C.waitForTimeout(500);
    check(!(await C.isVisible('text=操作する人を選んでください')), '本人のアカウントは「操作する人」を聞かれない');
    check((await C.textContent('.topbar .who-chip')).includes('鈴木'), '右上に本人の名前が出る');
    check(!/#invite=/.test(C.url()), 'リンクの合言葉はアドレス欄から消える');
    await C.click('.topbar .icon-btn[aria-label="設定"]');
    await C.click('.tabs button:has-text("メンバー")');
    check(!(await C.isVisible('.dialog input[placeholder="新しいメンバーの名前"]')), 'メンバーの追加は管理画面だけ');
    check(!(await C.isVisible('text=管理画面を開く')), '管理者でない人には管理画面の入り口が出ない');
    await C.click('.tabs button:has-text("メール通知")');
    check(await C.isDisabled('.dialog .btn.primary:has-text("保存")'), 'メール通知の設定は管理者だけが変えられる');
    await C.keyboard.press('Escape');
    // 一度使ったリンクは使えない
    const C2 = await newPage('C2');
    await C2.goto(url);
    await C2.waitForSelector('.login-card .af-err');
    check((await C2.textContent('.login-card .af-err')).includes('もう使われています'), '招待のリンクは1回だけ使える');
    // 管理者でない人は、管理画面に入れない
    await C2.goto(BASE + 'admin.html');
    await C2.waitForSelector('.login-card');
    await C2.fill('.login-card input[type=email]', 'suzuki@example.com');
    await C2.fill('.login-card input[type=password]', 'suzuki-pass-1');
    await C2.click('.login-card button[type=submit]');
    await C2.waitForSelector('.login-card .notice.bad');
    check((await C2.textContent('.login-card .notice.bad')).includes('管理者ではない'), '管理者でない人は管理画面に入れない');
    // 停止すると、すぐに使えなくなる
    await AD.click('.adm-card .icon-btn[aria-label="最新にする"]');
    await AD.waitForSelector('.adm-table tr:has-text("鈴木") .adm-chip.ok');
    check(true, '本人がパスワードを決めると「使用中」になる');
    await AD.click('.adm-table tr:has-text("鈴木") button:has-text("停止")');
    await AD.click('.dialog .btn.danger');
    await AD.waitForSelector('.adm-table tr:has-text("鈴木") .adm-chip.bad');
    await C.reload();
    await C.waitForSelector('.boot-error');
    check((await C.textContent('.boot-error')).includes('使えません'), '停止したアカウントは、すぐに使えなくなる');
    await AD.click('.adm-table tr:has-text("鈴木") button:has-text("再開")');
    await AD.waitForSelector('.adm-table tr:has-text("鈴木") .adm-chip.ok');
    await C.reload();
    await C.waitForSelector('.topbar');
    check(true, '再開すると、また使える');
    // 会社（所属）: 鈴木さんを Selected Group にすると、ネコロボマンのタスクは見えなくなる
    const coNames = await AD.$$eval('.adm-card', cards => { const c = cards.find(x => x.textContent.includes('会社（所属）') && x.querySelector('.adm-mem')); return c ? [...c.querySelectorAll('.adm-mem input')].map(i => i.value) : []; });
    check(coNames.join() === '株式会社ネコロボマン,Selected Group 株式会社', '管理画面に会社が2つ出る');
    await AD.selectOption('.adm-table tr:has-text("鈴木") select.adm-co', { label: 'Selected Group 株式会社' });
    await AD.waitForFunction(() => { const r = [...document.querySelectorAll('.adm-table tr')].find(x => x.textContent.includes('鈴木')); const sel = r && r.querySelector('select.adm-co'); return sel && sel.options[sel.selectedIndex].text === 'Selected Group 株式会社'; });
    await C.reload();
    await C.waitForSelector('.board .card .card-title');
    check(!(await C.isVisible('.task .t-title:has-text("研修資料")')) && await C.isVisible('.board .card-title:has-text("マイタスク")'), 'ほかの会社（ネコロボマン）のタスクは見えない');
    // 共有のアカウントを Selected Group の「会社の管理者」にすると、左上で会社を切り替えて見られる
    await AD.click('.adm-table tr:has-text("共有のアカウント") label:has-text("Selected Group 株式会社") input');
    await AD.waitForSelector('.adm-table tr:has-text("共有のアカウント") label:has-text("Selected Group 株式会社") input:checked');
    await A.reload();
    await A.waitForSelector('.co-switch select', { timeout: 10000 });
    check(true, '会社の管理者には、会社の切り替えが出る');
    await A.selectOption('.co-switch select', { label: 'Selected Group 株式会社' });
    await A.waitForTimeout(300);
    check(!(await A.isVisible('.task .t-title:has-text("研修資料")')), '会社を切り替えると、その会社のタスクだけになる');
    await A.selectOption('.co-switch select', { label: 'すべての会社' });
    await A.waitForSelector('.task .t-title:has-text("研修資料")');
    check(await A.isVisible('.board .card-head .co-tag:has-text("Selected Group")'), '「すべての会社」では、リストに会社の名前が出る');
    await shot(A, 'companies');
    await shot(AD, 'admin-after');

    /* 18. Google 連携（管理者の初期設定 → 一人ずつつなぐ） */
    const GC = '.adm-card:has-text("Google 連携")';
    await AD.waitForSelector(GC + ' .adm-chip.wait');
    check((await AD.inputValue(GC + ' .adm-link input')).includes('/google-callback'), '管理画面に、Google に登録する戻り先の URL が出る');
    await C.click('.topbar .icon-btn[aria-label="設定"]');
    await C.click('.tabs button:has-text("Google 連携")');
    await C.waitForSelector('.dialog .error-text:has-text("まだ使えません")');
    check(true, '初期設定の前は、まだ使えないと出る');
    await C.keyboard.press('Escape');
    await AD.fill(GC + ' input[placeholder="…apps.googleusercontent.com"]', '1234-test.apps.googleusercontent.com');
    await AD.fill(GC + ' input[type=password]', 'GOCSPX-test-secret');
    await AD.click(GC + ' button[type=submit]');
    await AD.waitForSelector(GC + ' .adm-chip.ok:has-text("初期設定済み")');
    check(!(await AD.isVisible(GC + ' input[type=password]')), '管理者が初期設定をすると「初期設定済み」になり、シークレットは画面に残らない');
    await shot(AD, 'admin-google');
    await C.click('.topbar .icon-btn[aria-label="設定"]');
    await C.click('.tabs button:has-text("Google 連携")');
    await C.click('.dialog .btn.primary:has-text("Google と連携する")');
    await C.waitForSelector('.dialog .chip.ok:has-text("連携中")');
    check((await C.textContent('.dialog')).includes('google.user@example.com'), 'Google で許可したあと、設定に戻って「連携中」とつないだアカウントが出る');
    check(!/#google=/.test(C.url()), '戻ってきた印はアドレス欄から消える');
    await shot(C, 'settings-google');
    await C.click('.dialog .set-row:has-text("Google ToDo リストに出す") .switch');
    await C.waitForFunction(() => { const i = document.querySelector('.dialog .set-row .switch input'); return i && !i.checked; });
    check(true, 'ToDo リストに出すかどうかを切り替えられる');
    await C.click('.dialog button:has-text("今すぐ反映")');
    await C.waitForSelector('.snack:has-text("Google に反映しました")');
    check(true, '「今すぐ反映」できる');
    await AD.reload();
    await AD.waitForSelector(GC + ' tr:has-text("鈴木") .adm-chip.ok');
    check(true, '管理画面に、みんなの連携の状態が出る');
    await C.click('.dialog button:has-text("連携をやめる")');
    await C.click('.dialog .btn.danger');
    await C.waitForSelector('.dialog .btn.primary:has-text("Google と連携する")');
    check(true, '連携をやめられる');
    await C.keyboard.press('Escape');
    // 共有のアカウントでは使えない
    const A3 = await ctxA.newPage();
    A3.on('pageerror', e => errors.push('A3: ' + e.message));
    await A3.goto(BASE);
    await A3.waitForSelector('.login-card');
    await A3.fill('.login-card input[type=email]', 'honbu-test@example.com');
    await A3.fill('.login-card input[type=password]', 'test-pass-1234');
    await A3.click('.login-card button[type=submit]');
    await A3.waitForSelector('.topbar');
    await A3.keyboard.press('Escape');
    await A3.click('.topbar .icon-btn[aria-label="設定"]');
    await A3.click('.tabs button:has-text("Google 連携")');
    await A3.waitForSelector('.dialog .error-text:has-text("一人ずつのアカウント")');
    check(true, '共有のアカウントでは、Google 連携は使えないと出る');
  }

  await browser.close();
  if (errors.length) { console.error('画面のエラー:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nすべて確認できました。画面写真: ' + OUT);
})().catch(async e => {
  console.error(e);
  if (errors.length) console.error('画面のエラー:\n' + errors.join('\n'));
  process.exit(1);
});
