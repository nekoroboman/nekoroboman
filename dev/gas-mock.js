/**
 * 動作確認用: Google Apps Script のサービスを Node.js でまねする（本番では使わない）
 * gas/*.gs をそのまま読み込み、スプレッドシートはメモリ上の表で代用する。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeRange(sheet, r, c, nr, nc) {
  return {
    getValues() {
      const out = [];
      for (let i = 0; i < nr; i++) {
        const row = sheet.data[r - 1 + i] || [];
        const line = [];
        for (let j = 0; j < nc; j++) line.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
        out.push(line);
      }
      return out;
    },
    setValues(values) {
      if (r - 1 + nr > sheet.maxRows) throw new Error('範囲がシートの外です');
      for (let i = 0; i < nr; i++) {
        const idx = r - 1 + i;
        sheet.data[idx] = sheet.data[idx] || [];
        for (let j = 0; j < nc; j++) sheet.data[idx][c - 1 + j] = values[i][j];
      }
      return this;
    },
    clearContent() {
      for (let i = 0; i < nr; i++) {
        const idx = r - 1 + i;
        if (!sheet.data[idx]) continue;
        for (let j = 0; j < nc; j++) sheet.data[idx][c - 1 + j] = '';
      }
      return this;
    },
    setNumberFormat() { return this; },
    setFontWeight() { return this; },
    setBackground() { return this; },
  };
}

function makeSheet(name) {
  const sheet = {
    name, data: [], maxRows: 1000, maxCols: 26,
    getName: () => name,
    getLastRow() {
      for (let i = sheet.data.length - 1; i >= 0; i--) {
        if ((sheet.data[i] || []).some(v => v !== '' && v !== undefined && v !== null)) return i + 1;
      }
      return 0;
    },
    getMaxRows: () => sheet.maxRows,
    getMaxColumns: () => sheet.maxCols,
    insertRowsAfter(after, n) { sheet.maxRows += n; },
    insertColumnsAfter(after, n) { sheet.maxCols += n; },
    getRange(r, c, nr, nc) { return makeRange(sheet, r, c, nr || 1, nc || 1); },
    setFrozenRows() {},
  };
  return sheet;
}

function makeSpreadsheet() {
  const sheets = [makeSheet('シート1')];
  return {
    sheets,
    getId: () => 'mock-sheet-id',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/mock',
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet(n) { const s = makeSheet(n); sheets.push(s); return s; },
    getSheets: () => sheets.slice(),
    deleteSheet(s) { sheets.splice(sheets.indexOf(s), 1); },
  };
}

function createGas(opts) {
  opts = opts || {};
  const ss = makeSpreadsheet();
  const props = {};
  const cache = {};
  const mails = [];
  const triggers = [];
  const clock = { offset: 0 };
  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + clock.offset); }
    static now() { return RealDate.now() + clock.offset; }
  }
  const ctx = {
    console, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, isFinite, encodeURIComponent, Infinity,
    Date: MockDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss,
      create: () => ss,
      flush() {},
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty(k, v) { props[k] = String(v); return this; },
        setProperties(o) { Object.keys(o).forEach(k => { props[k] = String(o[k]); }); return this; },
        deleteProperty(k) { delete props[k]; return this; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (k in cache ? cache[k] : null),
        put(k, v) { cache[k] = String(v); },
        remove(k) { delete cache[k]; },
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => crypto.randomUUID() },
    MailApp: {
      sendEmail(o) { if (opts.failMail) throw new Error('メール送信に失敗（試験）'); mails.push(Object.assign({ at: new MockDate().toISOString() }, o)); },
      getRemainingDailyQuota: () => 100 - mails.length,
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'http://localhost:' + (opts.port || 8080) + '/' }),
      getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t.fn })),
      deleteTrigger(t) { const i = triggers.findIndex(x => x.fn === t.getHandlerFunction()); if (i >= 0) triggers.splice(i, 1); },
      newTrigger(fn) {
        const b = { timeBased: () => b, everyMinutes: () => b, everyHours: () => b, create: () => { triggers.push({ fn }); } };
        return b;
      },
    },
    HtmlService: {},
  };
  vm.createContext(ctx);
  // DIST=1 のときは、貼り付け用にまとめた dist/Code.gs を読み込む
  const files = process.env.DIST
    ? [path.join(__dirname, '..', 'dist', 'Code.gs')]
    : ['Code.gs', 'Db.gs', 'Api.gs', 'Mail.gs'].map(f => path.join(__dirname, '..', 'gas', f));
  files.forEach(f => vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: path.basename(f) }));
  return { ctx, ss, props, cache, mails, triggers, clock };
}

module.exports = { createGas };
