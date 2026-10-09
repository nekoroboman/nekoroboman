// PDF版（A4縦1枚）を print.html から書き出す
//
// 使い方（リポジトリのどこからでも可）:
//   node nekorobo-calendar/tools/make-pdf.js          … 今年度
//   node nekorobo-calendar/tools/make-pdf.js 2027     … 令和9年度
//   node nekorobo-calendar/tools/make-pdf.js all      … データにある全年度
// 出力先: nekorobo-calendar/pdf/schedule-<年度>.pdf（pdf/index.js の一覧も更新し、サイト版にダウンロードボタンが出る）
// データは print.html と同じく config.js の apiUrl（スプレッドシート）→ なければ同梱データ から読む
// 必要なもの: Node.js と Playwright（npm i playwright && npx playwright install chromium）
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PRINT = pathToFileURL(path.join(ROOT, 'print.html')).href;
const OUT_DIR = path.join(ROOT, 'pdf');
const MANIFEST = path.join(OUT_DIR, 'index.js');

// Chromium の出力はページオブジェクトを圧縮しないので、/Type /Page の数でページ数がわかる
const countPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) || []).length;

const currentFiscalYear = (d = new Date()) => (d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1);

function writeManifest() {
  const entries = fs.readdirSync(OUT_DIR)
    .map((f) => f.match(/^schedule-(\d{4})\.pdf$/))
    .filter(Boolean)
    .map((m) => [m[1], `pdf/${m[0]}`])
    .sort();
  const body = entries.map(([fy, p]) => `  "${fy}": "${p}"`).join(',\n');
  fs.writeFileSync(MANIFEST,
    '// 書き出し済みのPDF一覧（tools/make-pdf.js が自動で更新する）\n' +
    `window.CALENDAR_PDFS = {\n${body}${body ? '\n' : ''}};\n`);
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Playwright が見つかりません。npm i playwright && npx playwright install chromium を実行してください。');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(PRINT);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
    console.log((await page.textContent('#source')).trim());
    const available = (await page.getAttribute('body', 'data-years')).split(',').map(Number);

    const args = process.argv.slice(2);
    const years = args.includes('all') ? available : args.length ? args.map(Number) : [currentFiscalYear()];
    const missing = years.filter((fy) => !available.includes(fy));
    if (missing.length) {
      console.error(`データにない年度です: ${missing.join(', ')}（登録済み: ${available.join(', ')}）`);
      process.exitCode = 1;
      return;
    }

    for (const fy of years) {
      await page.goto(`${PRINT}#fy=${fy}`);
      await page.reload(); // ハッシュだけの移動では再読み込みされないため
      await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
      const file = path.join(OUT_DIR, `schedule-${fy}.pdf`);
      const buf = await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
      const pages = countPages(buf);
      console.log(`令和${fy - 2018}年度 → ${path.relative(process.cwd(), file)}（${pages}ページ）`);
      if (pages !== 1) console.warn('  ※ 1ページに収まっていません。研修名の長さや行の高さを確認してください。');
    }
    writeManifest();
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
