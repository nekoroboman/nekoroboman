# ウェルビーラーニング 年間研修計画

| ファイル | 内容 |
| --- | --- |
| `index.html` | サイト版。年度を切り替えて何年分でも見られる（`index.html#fy=2026` で年度を指定） |
| `print.html` | PDF版のレイアウト（A4縦1枚）。`print.html#fy=2026` で年度を指定 |
| `data/wellbe-learning.js` | 研修データ。年度ごとに追記する |
| `pdf/wellbe-learning-<年度>.pdf` | 事業所で掲示・保管するPDF（1年度1枚） |
| `tools/make-pdf.js` | `print.html` からPDFを書き出すツール |

外部のライブラリは使っていないので、フォルダごと置けばそのまま開けます（フォントはGoogle Fontsから読み込み、つながらない環境では端末のフォントで表示）。

## 新しい年度を追加する

1. `data/wellbe-learning.js` に年度のブロックを追加する（4月〜3月、各月 研修項目①（必須研修）と研修項目② の2本）
2. PDFを作る
   - ツールで作る: `node nekorobo-calendar/tools/make-pdf.js 2027`（Node.js と Playwright が必要）
   - ブラウザで作る: `print.html#fy=2027` を開き「印刷 / PDFに保存」→ 送信先を「PDFに保存」
3. 追加したブロックに `pdf: 'pdf/wellbe-learning-2027.pdf'` を書くと、サイト版にダウンロードボタンが出る

## データの出典

- 令和8年度、令和7年度（12月〜3月）: Google ドライブの店舗別「研修計画」シート（本部作成）
