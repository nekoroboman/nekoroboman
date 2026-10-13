/**
 * GAS に貼り付ける2ファイルを作る: node dev/build.js
 *   dist/Code.gs    … Apps Script の「コード.gs」に丸ごと貼り付ける
 *   dist/Index.html … 新しく作る HTML ファイル「Index」に丸ごと貼り付ける
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(root, 'gas', f), 'utf8');
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });

const head = '/* 本部タスク（このファイルは gas/ から自動で作っています。直すときは gas/ を直して node dev/build.js） */\n\n';
const code = head + ['Code.gs', 'Db.gs', 'Api.gs', 'Mail.gs'].map(f => '/* ===== ' + f + ' ===== */\n' + src(f).trim() + '\n').join('\n');
let index = src('Index.html').replace(/<\?!= include\('(\w+)'\); \?>/g, (m, name) => src(name + '.html').trim());
if (/<\?/.test(index.replace('<?= initialTask ?>', ''))) throw new Error('まとめた HTML に <? が入っています');

fs.writeFileSync(path.join(out, 'Code.gs'), code);
fs.writeFileSync(path.join(out, 'Index.html'), index);
console.log('dist/Code.gs ' + code.length + ' 文字 / dist/Index.html ' + index.length + ' 文字');
