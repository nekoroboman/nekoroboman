// PDF版（A4縦1枚）を print.html から書き出す
//
// 使い方（リポジトリのどこからでも可）:
//   node nekorobo-calendar/tools/make-pdf.js 2026      … 令和8年度だけ
//   node nekorobo-calendar/tools/make-pdf.js           … データにある全年度
// 出力先: nekorobo-calendar/pdf/wellbe-learning-<年度>.pdf
// 必要なもの: Node.js と Playwright（npm i playwright && npx playwright install chromium）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'wellbe-learning.js');
const PRINT = pathToFileURL(path.join(ROOT, 'print.html')).href;
const OUT_DIR = path.join(ROOT, 'pdf');

function loadYears() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(DATA, 'utf8'), sandbox, { filename: DATA });
  return (sandbox.window.WELLBE_SCHEDULE || []).map((y) => y.fiscalYear);
}

// Chromium の出力はページオブジェクトを圧縮しないので、/Type /Page の数でページ数がわかる
const countPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) || []).length;

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Playwright が見つかりません。npm i playwright && npx playwright install chromium を実行してください。');
    process.exit(1);
  }

  const available = loadYears();
  const requested = process.argv.slice(2).map(Number);
  const years = requested.length ? requested : available;
  const missing = years.filter((fy) => !available.includes(fy));
  if (missing.length) {
    console.error(`データにない年度です: ${missing.join(', ')}（登録済み: ${available.join(', ')}）`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const fy of years) {
      await page.goto(`${PRINT}#fy=${fy}`);
      await page.waitForSelector('body[data-ready="1"]');
      const file = path.join(OUT_DIR, `wellbe-learning-${fy}.pdf`);
      const buf = await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
      const pages = countPages(buf);
      console.log(`令和${fy - 2018}年度 → ${path.relative(process.cwd(), file)}（${pages}ページ）`);
      if (pages !== 1) console.warn('  ※ 1ページに収まっていません。研修名の長さや行の高さを確認してください。');
    }
  } finally {
    await browser.close();
  }
  console.log('data/wellbe-learning.js の各年度に pdf: \'pdf/wellbe-learning-<年度>.pdf\' があると、サイト版にダウンロードボタンが出ます。');
}

main().catch((e) => { console.error(e); process.exit(1); });
