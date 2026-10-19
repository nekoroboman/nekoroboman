/*
 * 本部タスク — カレンダー（Google カレンダーと同じ操作感。Meet はなし）
 * app.js から道具（K）を受け取り、画面の部品を返す。データの読み書きは app.js の送信待ちの列（enqueue）を使う
 *
 * - 表示: 日・4日・週・月・年・スケジュール。左に小さな月のカレンダーとカレンダーの一覧
 * - 予定: クリック／ドラッグで作成、ドラッグで移動・長さ変更、繰り返し（この予定／これ以降／すべて）、ゲストと出欠、通知、色
 * - タスク（いつやる・期限）と日本の祝日も表示する
 */
(function () {
  'use strict';
  window.HONBU_CALENDAR = function (K) {
    const { html, useState, useEffect, useRef, useLayoutEffect, S, update, Icon, Avatar, Switch, memberName, activeMembers, listName,
      enqueue, call, uid, snack, local, errText, DOW, p2, ymd, todayYmd, parseYmd, addDays, mdLabel,
      rrParse, rrFormat, rrLabel, rrPresets, rrStep, nthOf, isLastWeek, daysInMonth, openPop, openPopAt, closePop, confirmDlg,
      openTask, complete, uncomplete, act, newSortOrder, openRepeatDialog, setPref, setMode, isOverdue, PRIO, PRIO_PICK, armOrComplete } = K;
    const cur = () => K.cur();

    /* ================= 決まりごと ================= */
    const DAY = 86400000;
    const MIN = 60000;
    const HOUR_PX = 48;
    const SNAP = 15;
    const TASKS_ID = 'tasks';
    const HOLIDAY_ID = 'holidays';
    const HOLIDAY_COLOR = '#0b8043';
    const EVENT_COLORS = [['#d50000', 'トマト'], ['#e67c73', 'フラミンゴ'], ['#f4511e', 'ミカン'], ['#f6bf26', 'バナナ'], ['#33b679', 'セージ'],
      ['#0b8043', 'バジル'], ['#039be5', 'ピーコック'], ['#3f51b5', 'ブルーベリー'], ['#7986cb', 'ラベンダー'], ['#8e24aa', 'ブドウ'], ['#616161', 'グラファイト']];
    const CAL_COLORS = EVENT_COLORS.concat([['#ad1457', 'チェリー'], ['#795548', 'ココア'], ['#009688', 'ユーカリ'], ['#c0ca33', 'アボカド']]);
    const VIEWS = [['day', '日', 'D'], ['week', '週', 'W'], ['month', '月', 'M'], ['year', '年', 'Y'], ['schedule', 'スケジュール', 'A'], ['4days', '4日', 'X']];
    const RESP_LABEL = { accepted: 'はい', declined: 'いいえ', tentative: '未定', needsAction: '未回答' };
    const PREF_DEFAULTS = { calWeekStart: 0, calDefaultMinutes: 60, calShowWeekends: true, calShowDeclined: true, calWeekNumbers: false, calBrowserNotify: false };
    const pref = k => (S.prefs[k] === undefined ? PREF_DEFAULTS[k] : S.prefs[k]);

    /* ================= 日付の道具 ================= */
    const dayMs = s => parseYmd(s).getTime();
    const msYmd = ms => ymd(new Date(ms));
    const hm = ms => { const d = new Date(ms); return d.getHours() + ':' + p2(d.getMinutes()); };
    const iso = ms => new Date(ms).toISOString();
    const minutesOf = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
    const atMinutes = (s, m) => { const d = parseYmd(s); d.setMinutes(m); return d.getTime(); };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    function startOfWeek(s) { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() - pref('calWeekStart') + 7) % 7)); return ymd(d); }
    function addMonths(s, n) { const d = parseYmd(s); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return ymd(d); }
    function isoWeek(s) {
      const t = parseYmd(s);
      t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
      const w1 = new Date(t.getFullYear(), 0, 4);
      return 1 + Math.round(((t - w1) / DAY - 3 + ((w1.getDay() + 6) % 7)) / 7);
    }
    const mdShort = s => { const d = parseYmd(s); return (d.getMonth() + 1) + '月' + d.getDate() + '日(' + DOW[d.getDay()] + ')'; };
    function timeRange(inst) {
      if (inst.allDay) {
        const last = msYmd(inst.end - 1);
        return msYmd(inst.start) === last ? mdShort(msYmd(inst.start)) + '・終日' : mdShort(msYmd(inst.start)) + '～' + mdShort(last);
      }
      const sd = msYmd(inst.start);
      const ed = msYmd(inst.end - 1);
      if (sd === ed) return mdShort(sd) + '・' + hm(inst.start) + '～' + hm(inst.end);
      return mdShort(sd) + ' ' + hm(inst.start) + '～' + mdShort(ed) + ' ' + hm(inst.end);
    }
    const durLabel = m => (m < 60 ? m + '分' : m % 60 ? Math.floor(m / 60) + '時間' + (m % 60) + '分' : m / 60 + '時間');

    /* 日本の祝日（名前つき） */
    const holidayCache = {};
    function jpHolidays(year) {
      if (holidayCache[year]) return holidayCache[year];
      const set = {};
      const add = (m, d, name) => { set[year + '-' + p2(m) + '-' + p2(d)] = name; };
      const nthMonday = (m, n) => 1 + ((8 - new Date(year, m - 1, 1).getDay()) % 7) + (n - 1) * 7;
      const shift = Math.floor((year - 1980) / 4);
      add(1, 1, '元日'); add(1, nthMonday(1, 2), '成人の日'); add(2, 11, '建国記念の日'); add(2, 23, '天皇誕生日');
      add(3, Math.floor(20.8431 + 0.242194 * (year - 1980) - shift), '春分の日');
      add(4, 29, '昭和の日'); add(5, 3, '憲法記念日'); add(5, 4, 'みどりの日'); add(5, 5, 'こどもの日');
      add(7, nthMonday(7, 3), '海の日'); add(8, 11, '山の日'); add(9, nthMonday(9, 3), '敬老の日');
      add(9, Math.floor(23.2488 + 0.242194 * (year - 1980) - shift), '秋分の日');
      add(10, nthMonday(10, 2), 'スポーツの日'); add(11, 3, '文化の日'); add(11, 23, '勤労感謝の日');
      const base = Object.keys(set).sort();
      base.forEach(h => { const mid = addDays(h, 1); if (!set[mid] && set[addDays(h, 2)] && parseYmd(mid).getDay() !== 0) set[mid] = '国民の休日'; });
      base.forEach(h => { if (parseYmd(h).getDay() !== 0) return; let n = addDays(h, 1); while (set[n]) n = addDays(n, 1); set[n] = '振替休日'; });
      holidayCache[year] = set;
      return set;
    }

    /* ================= カレンダーと表示 ================= */
    const calById = id => cur().calendars[id];
    const myCalId = () => { const c = Object.values(cur().calendars).find(x => x.owner === S.operator && !x.deletedAt); return c ? c.id : ''; };
    function calList() {
      const all = Object.values(cur().calendars).filter(c => !c.deletedAt);
      const ord = c => (c.owner ? ((cur().members[c.owner] || {}).sortOrder || 9999) : c.sortOrder || 0);
      return {
        mine: all.filter(c => c.owner === S.operator),
        shared: all.filter(c => !c.owner).sort((a, b) => ord(a) - ord(b)),
        others: all.filter(c => c.owner && c.owner !== S.operator && (cur().members[c.owner] || {}).active !== false).sort((a, b) => ord(a) - ord(b)),
      };
    }
    function isShown(id) {
      const v = S.cal.vis[id];
      if (v !== undefined) return v;
      if (id === TASKS_ID || id === HOLIDAY_ID) return true;
      const c = calById(id);
      return !!c && (!c.owner || c.owner === S.operator);
    }
    function setShown(id, on) { update(s => { s.cal.vis = Object.assign({}, s.cal.vis, { [id]: on }); local.set('calVis', s.cal.vis); }); }
    function onlyShow(id) {
      const vis = {};
      Object.values(cur().calendars).forEach(c => { vis[c.id] = c.id === id; });
      vis[TASKS_ID] = false;
      vis[HOLIDAY_ID] = false;
      update(s => { s.cal.vis = vis; local.set('calVis', vis); s.pop = null; });
    }
    const evColor = e => e.color || (calById(e.calendarId) || {}).color || '#039be5';
    const myResp = e => { const a = (e.attendees || []).find(x => x.id === S.operator); return a ? a.response : ''; };
    const ownerOf = e => (calById(e.calendarId) || {}).owner || '';
    const evTitle = e => e.title || '（タイトルなし）';

    /* ================= 予定を、見ている期間の「回」に広げる ================= */
    function instances(fromMs, toMs, opt) {
      const o = opt || {};
      const evs = Object.values(cur().events);
      const exc = {};
      evs.forEach(e => { if (e.recurringId && !e.deletedAt) (exc[e.recurringId] = exc[e.recurringId] || {})[Date.parse(e.originalStart)] = 1; });
      const out = [];
      const showDeclined = pref('calShowDeclined');
      const push = (e, s, en, masterId, instStart) => {
        const resp = myResp(e);
        if (resp === 'declined' && !showDeclined && !o.all) return;
        out.push({
          key: (masterId || e.id) + '|' + (instStart || s), kind: 'event', ev: e, start: s, end: en, allDay: !!e.allDay,
          masterId: masterId || '', instanceStart: instStart || 0, title: evTitle(e), calId: e.calendarId, resp: resp,
          color: e.color || (!isShown(e.calendarId) && myColor ? myColor : evColor(e)),
        });
      };
      const mine = myCalId();
      const mineShown = mine && isShown(mine);
      const myColor = mine ? (calById(mine) || {}).color : '';
      evs.forEach(e => {
        if (e.deletedAt) return;
        // 招待された予定は、主催者のカレンダーを隠していても自分のカレンダーに出す（Google と同じ）
        const viaInvite = !o.all && !isShown(e.calendarId) && mineShown && (e.attendees || []).some(a => a.id === S.operator);
        if (!o.all && !isShown(e.calendarId) && !viaInvite) return;
        if (o.filter && !o.filter(e)) return;
        const s = Date.parse(e.startAt);
        const en = Date.parse(e.endAt);
        if (e.recurringId) {
          if (e.status !== 'cancelled' && s < toMs && en > fromMs) push(e, s, en, e.recurringId, Date.parse(e.originalStart));
          return;
        }
        if (!e.rrule) { if (s < toMs && en > fromMs) push(e, s, en); return; }
        const rule = rrParse(e.rrule);
        const dur = en - s;
        const sd = new Date(s);
        const tm = sd.getHours() * 60 + sd.getMinutes();
        let dateStr = ymd(sd);
        let idx = 1;
        for (let g = 0; g < 6000; g++) {
          const os = atMinutes(dateStr, tm);
          if (os >= toMs) break;
          if (rule.until && dateStr > rule.until) break;
          if (rule.count && idx > rule.count) break;
          if (os + dur > fromMs && !(exc[e.id] && exc[e.id][os])) push(e, os, os + dur, e.id, os);
          const nx = rrStep(rule, dateStr);
          if (!nx) break;
          dateStr = nx;
          idx++;
        }
      });
      if (!o.noTasks && (o.all || isShown(TASKS_ID))) {
        Object.values(cur().tasks).forEach(t => {
          if (t.deletedAt || t.parentId || !cur().lists[t.listId]) return;
          const d = t.doDate || t.due;
          if (!d) return;
          if (!o.all && t.assignee !== S.operator && !isShown('cal-' + t.assignee)) return;
          if (o.taskFilter && !o.taskFilter(t)) return;
          const tm = t.doDate ? t.doTime : t.dueTime;
          let s;
          let en;
          if (tm) { const p = tm.split(':').map(Number); s = atMinutes(d, p[0] * 60 + p[1]); en = s + 30 * MIN; } else { s = dayMs(d); en = s + DAY; }
          if (s >= toMs || en <= fromMs) return;
          const c = calById('cal-' + t.assignee);
          const mc = (cur().members[t.assignee] || {}).color;
          out.push({ key: 'task|' + t.id, kind: 'task', task: t, start: s, end: en, allDay: !tm, title: t.title, color: mc || (c ? c.color : '#1a73e8'), calId: TASKS_ID, done: t.status === 'done' });
        });
      }
      if (!o.noHolidays && (o.all || isShown(HOLIDAY_ID))) {
        for (let y = new Date(fromMs).getFullYear(); y <= new Date(toMs - 1).getFullYear(); y++) {
          const hs = jpHolidays(y);
          Object.keys(hs).forEach(d => {
            const s = dayMs(d);
            if (s < toMs && s + DAY > fromMs) out.push({ key: 'hol|' + d, kind: 'holiday', start: s, end: s + DAY, allDay: true, title: hs[d], color: HOLIDAY_COLOR, calId: HOLIDAY_ID });
          });
        }
      }
      out.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || (a.title < b.title ? -1 : 1));
      return out;
    }
    const isSpan = i => i.allDay || i.end - i.start >= DAY;

    /* 何日にもまたがる予定を、段（lane）に並べる */
    function laneLayout(items, days) {
      const idx = {};
      days.forEach((d, i) => { idx[d] = i; });
      const firstMs = dayMs(days[0]);
      const lastMs = dayMs(days[days.length - 1]) + DAY;
      const rows = [];
      items.forEach(it => {
        const s = Math.max(it.start, firstMs);
        const e = Math.min(it.end, lastMs);
        let a = -1;
        let b = -1;
        for (let d = msYmd(s); dayMs(d) < e; d = addDays(d, 1)) { if (idx[d] !== undefined) { if (a < 0) a = idx[d]; b = idx[d]; } }
        if (a < 0) return;
        rows.push({ inst: it, a: a, b: b, contL: it.start < firstMs, contR: it.end > lastMs });
      });
      rows.sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a));
      const lanes = [];
      rows.forEach(r => {
        let l = 0;
        while (lanes[l] && lanes[l].some(o => !(r.b < o.a || r.a > o.b))) l++;
        (lanes[l] = lanes[l] || []).push(r);
        r.lane = l;
      });
      return { rows: rows, count: lanes.length };
    }

    /* 1日の中で重なる予定を、横に並べる */
    function dayLayout(items) {
      const sorted = items.slice().sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
      let cluster = [];
      let clusterEnd = -Infinity;
      const flush = () => { const n = cluster.reduce((m, x) => Math.max(m, x.col + 1), 0); cluster.forEach(x => { x.cols = n; }); cluster = []; };
      const colsEnd = [];
      sorted.forEach(it => {
        if (it.s >= clusterEnd && cluster.length) { flush(); colsEnd.length = 0; }
        let c = 0;
        while (colsEnd[c] !== undefined && colsEnd[c] > it.s) c++;
        colsEnd[c] = Math.max(it.e, it.s + 20 * MIN);
        it.col = c;
        cluster.push(it);
        clusterEnd = Math.max(clusterEnd, it.e, it.s + 20 * MIN);
      });
      flush();
      return sorted;
    }

    /* ================= 送る（データベースへ） ================= */
    const toRowKeys = { start: 'startAt', end: 'endAt' };
    function rowPatch(e, patch) {
      const out = {};
      Object.keys(patch).forEach(k => {
        if (k === 'attendees') {
          const own = (S.calendars[patch.calendarId || e.calendarId] || {}).owner || '';
          out.attendees = patch.attendees.map(a => {
            const old = (e.attendees || []).find(x => x.id === a.id);
            return { id: a.id, optional: !!a.optional, response: old ? old.response : a.id === own ? 'accepted' : 'needsAction' };
          });
        } else out[toRowKeys[k] || k] = patch[k];
      });
      return out;
    }
    // 送信待ちの間も、画面には先に出しておく
    function overlay(op, events, calendars) {
      const p = op.payload;
      switch (op.fn) {
        case 'createEvent': {
          const e = p.event;
          events[e.id] = Object.assign({
            id: e.id, title: '', description: '', location: '', allDay: false, rrule: '', status: 'confirmed', color: '', busy: true, visibility: 'default',
            reminders: [{ method: 'popup', minutes: 10 }], attendees: [], guestsCanModify: false, guestsCanInvite: true, guestsCanSee: true,
            createdBy: S.operator, updatedBy: S.operator, version: 0, rev: 0, recurringId: e.recurringId || null, originalStart: e.originalStart || null,
          }, rowPatch({}, Object.assign({}, e, { id: undefined })), { id: e.id, _pending: true });
          break;
        }
        case 'updateEvent': {
          const e = events[p.id];
          if (!e) break;
          if (p.scope === 'this' && p.instanceStart && e.rrule) {
            const ms = Date.parse(p.instanceStart);
            const ex = Object.values(events).find(x => x.recurringId === e.id && Date.parse(x.originalStart) === ms);
            const base = ex || Object.assign({}, e, { id: 'tmp-' + e.id + '-' + ms, rrule: '', recurringId: e.id, originalStart: iso(ms), startAt: iso(ms), endAt: iso(ms + Date.parse(e.endAt) - Date.parse(e.startAt)) });
            const pp = Object.assign({}, p.patch);
            delete pp.rrule;
            events[base.id] = Object.assign({}, base, rowPatch(base, pp), { _pending: true });
          } else if (p.scope === 'following' && p.instanceStart && e.rrule) {
            const until = addDays(msYmd(Date.parse(p.instanceStart)), -1).replace(/-/g, '');
            events[p.id] = Object.assign({}, e, { rrule: e.rrule.replace(/;(UNTIL|COUNT)=[^;]*/g, '') + ';UNTIL=' + until });
          } else {
            events[p.id] = Object.assign({}, e, rowPatch(e, p.patch), { _pending: true });
          }
          break;
        }
        case 'deleteEvent': {
          const e = events[p.id];
          if (!e) break;
          if (e.recurringId) events[p.id] = Object.assign({}, e, { status: 'cancelled' });
          else if (e.rrule && p.instanceStart && p.scope === 'this') {
            const ms = Date.parse(p.instanceStart);
            const ex = Object.values(events).find(x => x.recurringId === e.id && Date.parse(x.originalStart) === ms);
            if (ex) events[ex.id] = Object.assign({}, ex, { status: 'cancelled' });
            else events['tmp-' + e.id + '-' + ms] = Object.assign({}, e, { id: 'tmp-' + e.id + '-' + ms, rrule: '', recurringId: e.id, originalStart: iso(ms), status: 'cancelled' });
          } else if (e.rrule && p.instanceStart && p.scope === 'following' && Date.parse(p.instanceStart) > Date.parse(e.startAt)) {
            const until = addDays(msYmd(Date.parse(p.instanceStart)), -1).replace(/-/g, '');
            events[p.id] = Object.assign({}, e, { rrule: e.rrule.replace(/;(UNTIL|COUNT)=[^;]*/g, '') + ';UNTIL=' + until });
          } else {
            delete events[p.id];
            Object.keys(events).forEach(k => { if (events[k].recurringId === p.id) delete events[k]; });
          }
          break;
        }
        case 'respondEvent': {
          const e = events[p.id];
          if (e && !(p.scope === 'this' && p.instanceStart && e.rrule)) {
            events[p.id] = Object.assign({}, e, { attendees: (e.attendees || []).map(a => (a.id === p.member ? Object.assign({}, a, { response: p.response }) : a)) });
          }
          break;
        }
        case 'saveCalendar': {
          const c = p.calendar;
          calendars[c.id] = Object.assign({ sortOrder: 1e9, owner: null, description: '', color: '#039be5' }, calendars[c.id] || {}, c, { _pending: true });
          break;
        }
        case 'deleteCalendar':
          delete calendars[p.id];
          break;
      }
    }

    // 繰り返しの曜日・日にちを、動かした日数だけずらす
    function shiftRule(rule, days) {
      if (!rule || !days) return rule;
      const o = rrParse(rule);
      if (o.freq === 'WEEKLY' && o.days.length) o.days = o.days.map(d => (((d + days) % 7) + 7) % 7);
      else if (o.freq === 'MONTHLY' && o.mday > 0) o.mday = clamp(o.mday + days, 1, 31);
      else if (o.freq === 'MONTHLY' && o.nth) o.nthDow = (((o.nthDow + days) % 7) + 7) % 7;
      return rrFormat(o);
    }
    const dayDiff = (a, b) => Math.round((dayMs(msYmd(b)) - dayMs(msYmd(a))) / DAY);

    function createEvent(ev) { enqueue('createEvent', { event: ev }); }
    // 予定（またはその回）を変える。scope: this / following / all
    function updateInst(inst, patch, scope) {
      const e = inst.ev;
      const master = e.recurringId ? cur().events[e.recurringId] : e.rrule ? e : null;
      if (!master || (!e.recurringId && !inst.instanceStart)) { enqueue('updateEvent', { id: e.id, patch: patch }); return; }
      const instStart = e.recurringId ? Date.parse(e.originalStart) : inst.instanceStart;
      if (scope === 'this') {
        if (e.recurringId) enqueue('updateEvent', { id: e.id, patch: patch });
        else enqueue('updateEvent', { id: master.id, scope: 'this', instanceStart: iso(instStart), patch: patch });
        return;
      }
      const p = Object.assign({}, patch);
      const moved = 'start' in p ? Date.parse(p.start) - inst.start : 0;
      const days = moved ? dayDiff(inst.start, Date.parse(p.start)) : 0;
      if (days && !('rrule' in p)) p.rrule = shiftRule(master.rrule, days);
      if (scope === 'all') {
        if ('start' in p || 'end' in p) {
          const ns = Date.parse(master.startAt) + moved;
          const len = ('end' in p ? Date.parse(p.end) : inst.end) - ('start' in p ? Date.parse(p.start) : inst.start);
          p.start = iso(ns);
          p.end = iso(ns + len);
        }
        enqueue('updateEvent', { id: master.id, scope: 'all', patch: p });
      } else {
        enqueue('updateEvent', { id: master.id, scope: 'following', instanceStart: iso(instStart), patch: p });
      }
    }
    function deleteInst(inst, scope) {
      const e = inst.ev;
      const undo = () => enqueue('restoreEvent', { id: e.recurringId || e.id });
      if (e.recurringId && scope !== 'this') enqueue('deleteEvent', { id: e.recurringId, scope: scope, instanceStart: e.originalStart });
      else if (!e.recurringId && e.rrule && inst.instanceStart) enqueue('deleteEvent', { id: e.id, scope: scope, instanceStart: iso(inst.instanceStart) });
      else enqueue('deleteEvent', { id: e.id });
      const whole = scope === 'all' || (!e.rrule && !e.recurringId);
      snack('予定を削除しました', whole ? { action: { label: '元に戻す', fn: undo } } : null);
    }
    function respond(inst, response, scope) {
      const e = inst.ev;
      if (e.recurringId) {
        if (scope === 'this') enqueue('respondEvent', { id: e.id, member: S.operator, response: response });
        else enqueue('respondEvent', { id: e.recurringId, member: S.operator, response: response, scope: 'all' });
      } else if (e.rrule && inst.instanceStart && scope === 'this') {
        enqueue('respondEvent', { id: e.id, member: S.operator, response: response, scope: 'this', instanceStart: iso(inst.instanceStart) });
      } else enqueue('respondEvent', { id: e.id, member: S.operator, response: response, scope: 'all' });
    }
    // 繰り返しの予定なら「この予定／これ以降／すべて」を聞いてから行う
    function withScope(inst, action, fn, only) {
      const rec = inst.kind === 'event' && (inst.ev.recurringId || (inst.ev.rrule && inst.instanceStart));
      if (!rec) { fn('this'); return; }
      update(s => { s.pop = null; s.dialog = { type: 'calScope', action: action, only: only, onPick: fn }; });
    }
    function moveTask(t, start, allDay) {
      const d = msYmd(start);
      const time = allDay ? '' : hm(start).padStart(5, '0');
      if (t.doDate || !t.due) act.updateTask(t.id, { doDate: d, doTime: time });
      else act.updateTask(t.id, { due: d, dueTime: time });
    }

    /* ================= 移動 ================= */
    function setView(v) { update(s => { s.cal.view = v; s.cal.search = ''; local.set('calView', v); }); }
    function setDate(d) { update(s => { s.cal.date = d; s.cal.search = ''; }); }
    function nav(dir) {
      const v = S.cal.view;
      const d = S.cal.date;
      const nd = v === 'day' ? addDays(d, dir) : v === '4days' ? addDays(d, 4 * dir) : v === 'week' ? addDays(d, 7 * dir)
        : v === 'month' ? addMonths(d, dir) : v === 'year' ? addMonths(d, 12 * dir) : addDays(d, 30 * dir);
      setDate(nd);
    }
    function viewDays() {
      const v = S.cal.view;
      const d = S.cal.date;
      let days = [];
      if (v === 'day') days = [d];
      else if (v === '4days') days = [0, 1, 2, 3].map(i => addDays(d, i));
      else { const s = startOfWeek(d); days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(s, i)); }
      if (v === 'week' && !pref('calShowWeekends')) days = days.filter(x => { const w = parseYmd(x).getDay(); return w !== 0 && w !== 6; });
      return days;
    }
    function periodLabel() {
      const v = S.cal.view;
      const d = parseYmd(S.cal.date);
      if (S.cal.search) return '検索結果';
      if (v === 'year') return d.getFullYear() + '年';
      if (v === 'day') return d.getFullYear() + '年 ' + (d.getMonth() + 1) + '月 ' + d.getDate() + '日';
      if (v === 'week' || v === '4days') {
        const days = viewDays();
        const a = parseYmd(days[0]);
        const b = parseYmd(days[days.length - 1]);
        if (a.getFullYear() !== b.getFullYear()) return a.getFullYear() + '年 ' + (a.getMonth() + 1) + '月～' + b.getFullYear() + '年 ' + (b.getMonth() + 1) + '月';
        if (a.getMonth() !== b.getMonth()) return a.getFullYear() + '年 ' + (a.getMonth() + 1) + '月～' + (b.getMonth() + 1) + '月';
      }
      return d.getFullYear() + '年 ' + (d.getMonth() + 1) + '月';
    }
    // 400日より前を見るときは、その期間の予定を取りに行く
    function ensureRange(fromMs) {
      if (fromMs >= Date.now() - 390 * DAY) return;
      const key = msYmd(fromMs).slice(0, 7);
      if (S.cal.range[key]) return;
      S.cal.range[key] = 1;
      const from = dayMs(key + '-01') - 7 * DAY;
      call('eventsRange', { from: iso(from), to: iso(from + 50 * DAY) }).then(r => update(s => {
        (r.events || []).forEach(e => { if (!s.events[e.id]) s.events[e.id] = e; });
      })).catch(() => { delete S.cal.range[key]; });
    }

    /* ================= 新しい予定・エディタ ================= */
    function defaultCalendarId() {
      const mine = myCalId();
      if (mine) return mine;
      const l = calList();
      return (l.shared[0] || l.others[0] || {}).id || '';
    }
    function blankDraft(start, end, allDay, extra) {
      const s = start;
      const e = end;
      return Object.assign({
        key: uid(), mode: 'new', id: '', title: '', allDay: !!allDay,
        startDate: msYmd(s), startTime: allDay ? '09:00' : hm(s).padStart(5, '0'),
        endDate: allDay ? msYmd(e - 1) : msYmd(e), endTime: allDay ? '10:00' : hm(e).padStart(5, '0'),
        rrule: '', location: '', description: '', calendarId: defaultCalendarId(), color: '', busy: !allDay, visibility: 'default',
        reminders: allDay ? [] : [{ method: 'popup', minutes: 10 }], attendees: [], guestsCanModify: false, guestsCanInvite: true, guestsCanSee: true,
        tab: 'detail',
      }, extra || {});
    }
    function nextHour() { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d.getTime(); }
    function openNewEditor(extra) {
      const s = (extra && extra.start) || nextHour();
      const e = (extra && extra.end) || s + pref('calDefaultMinutes') * MIN;
      update(st => { st.pop = null; st.cal.editor = blankDraft(s, e, extra && extra.allDay, extra && extra.fields); });
    }
    function draftFromInst(inst) {
      const e = inst.ev;
      const master = e.recurringId ? cur().events[e.recurringId] : e;
      const d = {
        key: uid(), mode: 'edit', id: e.id, inst: inst, title: e.title, allDay: !!e.allDay,
        startDate: msYmd(inst.start), startTime: e.allDay ? '09:00' : hm(inst.start).padStart(5, '0'),
        endDate: e.allDay ? msYmd(inst.end - 1) : msYmd(inst.end), endTime: e.allDay ? '10:00' : hm(inst.end).padStart(5, '0'),
        rrule: (master && master.rrule) || '', location: e.location || '', description: e.description || '', calendarId: e.calendarId, color: e.color || '',
        busy: e.busy !== false, visibility: e.visibility || 'default', reminders: (e.reminders || []).map(r => Object.assign({}, r)),
        attendees: (e.attendees || []).map(a => Object.assign({}, a)), guestsCanModify: !!e.guestsCanModify, guestsCanInvite: e.guestsCanInvite !== false,
        guestsCanSee: e.guestsCanSee !== false, tab: 'detail',
      };
      d.orig = toPayload(d);
      return d;
    }
    function openEditor(inst) { update(s => { s.pop = null; s.cal.editor = draftFromInst(inst); }); }
    function draftTimes(d) {
      if (d.allDay) return { s: dayMs(d.startDate), e: dayMs(d.endDate) + DAY };
      const sp = d.startTime.split(':').map(Number);
      const ep = d.endTime.split(':').map(Number);
      return { s: atMinutes(d.startDate, sp[0] * 60 + sp[1]), e: atMinutes(d.endDate, ep[0] * 60 + ep[1]) };
    }
    function toPayload(d) {
      const t = draftTimes(d);
      return {
        title: d.title.trim(), allDay: d.allDay, start: iso(t.s), end: iso(t.e), rrule: d.rrule, location: d.location.trim(), description: d.description,
        calendarId: d.calendarId, color: d.color, busy: d.busy, visibility: d.visibility, reminders: d.reminders.map(r => ({ method: r.method, minutes: Number(r.minutes) || 0 })),
        attendees: d.attendees.map(a => ({ id: a.id, optional: !!a.optional })), guestsCanModify: d.guestsCanModify, guestsCanInvite: d.guestsCanInvite, guestsCanSee: d.guestsCanSee,
      };
    }
    function saveDraft(d) {
      const t = draftTimes(d);
      if (t.e <= t.s) { snack('終了は開始より後にしてください', { kind: 'error' }); return; }
      if (!d.calendarId) { snack('カレンダーを選んでください', { kind: 'error' }); return; }
      const payload = toPayload(d);
      const close = () => update(s => { s.cal.editor = null; });
      if (d.mode === 'new') {
        createEvent(Object.assign({ id: uid() }, payload));
        close();
        snack('予定を保存しました');
        return;
      }
      const patch = {};
      Object.keys(payload).forEach(k => { if (JSON.stringify(payload[k]) !== JSON.stringify(d.orig[k])) patch[k] = payload[k]; });
      if (!Object.keys(patch).length) { close(); return; }
      if ('allDay' in patch || 'start' in patch || 'end' in patch) { patch.start = payload.start; patch.end = payload.end; patch.allDay = payload.allDay; }
      withScope(d.inst, 'edit', scope => { updateInst(d.inst, patch, scope); close(); snack('予定を保存しました'); }, 'rrule' in patch ? ['following', 'all'] : null);
    }

    /* ================= 通知（この端末で開いている間） ================= */
    function tick() {
      if (!S.ready || !S.operator) return;
      const now = Date.now();
      const fired = local.get('calFired', {});
      let changed = false;
      Object.keys(fired).forEach(k => { if (fired[k] < now - 2 * DAY) { delete fired[k]; changed = true; } });
      instances(now - 10 * MIN, now + 29 * DAY, { all: true, noTasks: true, noHolidays: true,
        filter: e => ownerOf(e) === S.operator || (e.attendees || []).some(a => a.id === S.operator && a.response !== 'declined') }).forEach(i => {
        (i.ev.reminders || []).forEach(r => {
          if (r.method !== 'popup') return;
          const at = i.start - r.minutes * MIN;
          const key = i.key + '|' + r.minutes;
          if (at > now || now - at > 10 * MIN || fired[key]) return;
          fired[key] = now;
          changed = true;
          const when = i.allDay ? '終日' : hm(i.start) + '～' + hm(i.end);
          snack('予定: ' + i.title + '（' + when + '）', { ms: 15000, action: { label: '開く', fn: () => { setMode('calendar'); setDate(msYmd(i.start)); } } });
          if (pref('calBrowserNotify') && window.Notification && Notification.permission === 'granted') {
            try { new Notification(i.title, { body: mdShort(msYmd(i.start)) + ' ' + when + (i.ev.location ? '　' + i.ev.location : ''), tag: key }); } catch (e) { /* 通知が出せない環境 */ }
          }
        });
      });
      if (changed) local.set('calFired', fired);
    }
    function noticeRemote(res) {
      const me = S.operator;
      (res.events || []).forEach(e => {
        if (e.deletedAt || e.recurringId || !e.updatedBy || e.updatedBy === me) return;
        const mine = (e.attendees || []).find(a => a.id === me);
        if (!mine || mine.response !== 'needsAction') return;
        const old = S.events[e.id];
        if (old && (old.attendees || []).some(a => a.id === me)) return;
        const who = (S.members[e.updatedBy] || {}).name || 'ほかの人';
        snack(who + 'さんから予定の招待が届きました：「' + evTitle(e) + '」', { ms: 8000, action: { label: '開く', fn: () => { setMode('calendar'); setDate(msYmd(Date.parse(e.startAt))); } } });
      });
    }

    /* ================= キーボード ================= */
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || S.dialog || S.pop || S.cal.editor || S.repeatDlg) return;
      if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
      const k = e.key.toLowerCase();
      const views = { d: 'day', w: 'week', m: 'month', y: 'year', a: 'schedule', x: '4days' };
      if (views[k]) setView(views[k]);
      else if (k === 't') setDate(todayYmd());
      else if (k === 'j' || k === 'n') nav(1);
      else if (k === 'k' || k === 'p') nav(-1);
      else if (k === 'c') openNewEditor();
      else if (k === '/') { e.preventDefault(); const el = document.querySelector('.cal-search input'); if (el) el.focus(); }
      else return;
    }

    /* ======================================================================
     * 画面
     * ==================================================================== */

    function TopControls() {
      const [open, setOpen] = useState(false);
      return html`<div class="cal-top">
        <button class="btn outline sm cal-today" title="今日（T）" onClick=${() => setDate(todayYmd())}>今日</button>
        <button class="icon-btn" aria-label="前の期間" title="前へ（K）" onClick=${() => nav(-1)}><${Icon} n="chevron_left" /></button>
        <button class="icon-btn" aria-label="次の期間" title="次へ（J）" onClick=${() => nav(1)}><${Icon} n="chevron_right" /></button>
        <h1 class="cal-period">${periodLabel()}</h1>
        <span class="grow"></span>
        <label class=${'search cal-search' + (open || S.cal.search ? ' open' : '')}>
          <button class="icon-btn sm" aria-label="予定を検索" onClick=${() => setOpen(true)}><${Icon} n="search" /></button>
          <input placeholder="予定を検索" value=${S.cal.search} onInput=${e => update(s => { s.cal.search = e.target.value; })} onBlur=${() => setOpen(false)} />
          ${S.cal.search && html`<button class="icon-btn sm" aria-label="検索を消す" onClick=${() => update(s => { s.cal.search = ''; })}><${Icon} n="close" /></button>`}
        </label>
        <select class="input cal-view-select" aria-label="表示" value=${S.cal.view} onChange=${e => setView(e.target.value)}>
          ${VIEWS.map(v => html`<option value=${v[0]}>${v[1]}</option>`)}
        </select>
      </div>`;
    }

    /* ---------- 左の欄 ---------- */
    function Sidebar() {
      const l = calList();
      const row = (id, name, color, menu) => html`<div key=${id} class="cal-row">
        <label class="cal-cb" style=${{ '--c': color }} title=${name}>
          <input type="checkbox" checked=${isShown(id)} onChange=${e => setShown(id, e.target.checked)} /><span class="box"></span><span class="nm">${name}</span>
        </label>
        ${menu && html`<button class="icon-btn sm cal-row-more" aria-label=${name + 'のメニュー'} onClick=${e => openPop(e, 'calMenu', { calId: id })}><${Icon} n="more_vert" /></button>`}
      </div>`;
      return html`<nav class=${'nav cal-nav' + (S.drawer ? ' open' : '')}>
        <button class="create-btn" onClick=${e => openPop(e, 'calCreate', {})}><${Icon} n="add" />作成<${Icon} n="arrow_drop_down" /></button>
        <${MiniMonth} />
        <div class="cal-sec">マイカレンダー</div>
        ${l.mine.map(c => row(c.id, c.name, c.color, true))}
        ${row(TASKS_ID, 'タスク', '#1a73e8', false)}
        <div class="cal-sec">共有のカレンダー
          <button class="icon-btn sm" aria-label="新しい共有カレンダーを作る" title="新しい共有カレンダー" onClick=${() => update(s => { s.dialog = { type: 'calCalendar' }; s.drawer = false; })}><${Icon} n="add" /></button></div>
        ${l.shared.map(c => row(c.id, c.name, c.color, true))}
        ${!l.shared.length && html`<div class="muted cal-empty">（会議室・本部行事など、みんなで使うカレンダー）</div>`}
        <div class="cal-sec">ほかのメンバー</div>
        ${l.others.map(c => row(c.id, c.name, c.color, true))}
        <div class="cal-sec">そのほか</div>
        ${row(HOLIDAY_ID, '日本の祝日', HOLIDAY_COLOR, false)}
        <div class="nav-sep"></div>
        <button class="nav-item" onClick=${() => update(s => { s.dialog = { type: 'calTrash' }; s.drawer = false; })}><${Icon} n="delete" /><span class="label">予定のごみ箱</span></button>
      </nav>`;
    }

    function MiniMonth() {
      const [ym, setYm] = useState(S.cal.date.slice(0, 7));
      useEffect(() => { setYm(S.cal.date.slice(0, 7)); }, [S.cal.date]);
      const first = ym + '-01';
      const start = startOfWeek(first);
      const td = todayYmd();
      const vd = S.cal.view === 'month' ? null : viewDays();
      const inView = d => (vd ? vd.indexOf(d) >= 0 : d.slice(0, 7) === S.cal.date.slice(0, 7));
      const head = [0, 1, 2, 3, 4, 5, 6].map(i => DOW[(pref('calWeekStart') + i) % 7]);
      const dt = parseYmd(first);
      return html`<div class="mini-month">
        <div class="mm-head"><span class="grow">${dt.getFullYear()}年${dt.getMonth() + 1}月</span>
          <button class="icon-btn sm" aria-label="前の月" onClick=${() => setYm(addMonths(first, -1).slice(0, 7))}><${Icon} n="chevron_left" /></button>
          <button class="icon-btn sm" aria-label="次の月" onClick=${() => setYm(addMonths(first, 1).slice(0, 7))}><${Icon} n="chevron_right" /></button></div>
        <div class="mm-grid">
          ${head.map(h => html`<div class="mm-dow">${h}</div>`)}
          ${Array.from({ length: 42 }, (_, i) => addDays(start, i)).map(d => html`<button key=${d}
            class=${'mm-day' + (d.slice(0, 7) !== ym ? ' out' : '') + (d === td ? ' today' : '') + (d === S.cal.date ? ' sel' : '') + (inView(d) && S.cal.view !== 'year' ? ' inview' : '')}
            onClick=${() => { setDate(d); update(s => { s.drawer = false; }); }}>${parseYmd(d).getDate()}</button>`)}
        </div>
      </div>`;
    }

    /* ---------- 真ん中 ---------- */
    function Main() {
      if (S.cal.search.trim()) return html`<${SearchView} />`;
      switch (S.cal.view) {
        case 'month': return html`<${MonthView} />`;
        case 'year': return html`<${YearView} />`;
        case 'schedule': return html`<${ScheduleView} />`;
        default: return html`<${TimeGrid} days=${viewDays()} />`;
      }
    }

    // 予定の小さな札（月・終日の欄）
    function Chip({ inst, onDown, style, cls, timeFirst }) {
      const e = inst.ev;
      const resp = inst.resp;
      const bg = inst.kind === 'holiday' || inst.allDay || isSpan(inst);
      const klass = ['cal-chip', bg ? 'solid' : 'dot', inst.kind, resp === 'needsAction' && 'invite', resp === 'tentative' && 'tentative', resp === 'declined' && 'declined',
        inst.done && 'done', e && e._pending && 'pending', cls].filter(Boolean).join(' ');
      return html`<div class=${klass} style=${Object.assign({ '--c': inst.color }, style || {})} data-key=${inst.key}
        onPointerDown=${onDown} onClick=${ev => { ev.stopPropagation(); if (!ev.currentTarget.dataset.dragged) openInst(ev, inst); }}>
        ${inst.kind === 'task' && html`<${Icon} n=${inst.done ? 'check_circle' : 'radio_button_unchecked'} cls="chip-ic" />`}
        ${!bg && inst.kind === 'event' && html`<span class="cdot"></span>`}
        ${!bg && timeFirst !== false && !inst.allDay && html`<span class="ctime">${hm(inst.start)}</span>`}
        <span class="ctitle">${inst.title}</span>
      </div>`;
    }
    function openInst(ev, inst) {
      const r = ev.currentTarget.getBoundingClientRect();
      if (inst.kind === 'task') openPopAt(r, 'calTask', { taskId: inst.task.id }, true);
      else if (inst.kind === 'holiday') openPopAt(r, 'calHoliday', { inst: inst }, true);
      else openPopAt(r, 'calEvent', { inst: inst }, true);
    }

    /* ---------- 月 ---------- */
    function MonthView() {
      const d0 = parseYmd(S.cal.date);
      const first = ymd(new Date(d0.getFullYear(), d0.getMonth(), 1));
      const start = startOfWeek(first);
      const nDays = daysInMonth(first);
      const offset = (parseYmd(first).getDay() - pref('calWeekStart') + 7) % 7;
      const weeks = Math.ceil((offset + nDays) / 7);
      const hideWE = !pref('calShowWeekends');
      const td = todayYmd();
      const from = dayMs(start);
      const to = from + weeks * 7 * DAY;
      ensureRange(from);
      const all = instances(from, to);
      const drag = useRef(null);
      const [over, setOver] = useState(null);
      const maxRows = window.innerWidth < 600 ? 2 : 4;
      const head = [0, 1, 2, 3, 4, 5, 6].map(i => (pref('calWeekStart') + i) % 7).filter(w => !hideWE || (w !== 0 && w !== 6));
      const onDown = inst => ev => {
        if (ev.pointerType !== 'mouse' || ev.button !== 0 || inst.kind === 'holiday') return;
        drag.current = { inst: inst, x: ev.clientX, y: ev.clientY, moved: false, el: ev.currentTarget };
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.currentTarget.onpointermove = mv => {
          const g = drag.current;
          if (!g) return;
          if (!g.moved && Math.abs(mv.clientX - g.x) + Math.abs(mv.clientY - g.y) < 5) return;
          g.moved = true;
          const cell = document.elementFromPoint(mv.clientX, mv.clientY);
          const c = cell && cell.closest && cell.closest('[data-date]');
          if (c) setOver(c.getAttribute('data-date'));
        };
        ev.currentTarget.onpointerup = up => {
          const g = drag.current;
          drag.current = null;
          up.currentTarget.onpointermove = null;
          up.currentTarget.onpointerup = null;
          if (!g || !g.moved) return;
          up.currentTarget.dataset.dragged = '1';
          setTimeout(() => { if (g.el) delete g.el.dataset.dragged; }, 50);
          const cell = document.elementFromPoint(up.clientX, up.clientY);
          const c = cell && cell.closest && cell.closest('[data-date]');
          setOver(null);
          if (!c) return;
          const days = dayDiff(g.inst.start, dayMs(c.getAttribute('data-date')));
          if (!days) return;
          if (g.inst.kind === 'task') { moveTask(g.inst.task, g.inst.start + days * DAY, g.inst.allDay); return; }
          const patch = { start: iso(g.inst.start + days * DAY), end: iso(g.inst.end + days * DAY) };
          withScope(g.inst, 'edit', scope => updateInst(g.inst, patch, scope));
        };
      };
      const clickCell = (ev, d) => {
        if (ev.target.closest('.cal-chip, .more-btn, .mday')) return;
        const r = ev.currentTarget.getBoundingClientRect();
        openPopAt(r, 'calQuick', { start: dayMs(d), end: dayMs(d) + DAY, allDay: true }, true);
      };
      return html`<div class=${'month-view' + (hideWE ? ' no-we' : '')} style=${{ '--rows': weeks, '--cols': head.length }}>
        <div class="mv-head">${head.map(w => html`<div class=${'mv-dow' + (w === 0 ? ' sun' : w === 6 ? ' sat' : '')}>${DOW[w]}</div>`)}</div>
        <div class="mv-body">
          ${Array.from({ length: weeks }, (_, w) => {
            const days = Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)).filter(x => !hideWE || (parseYmd(x).getDay() % 6 !== 0));
            const ws = dayMs(addDays(start, w * 7));
            const we = ws + 7 * DAY;
            const inWeek = all.filter(i => i.start < we && i.end > ws);
            const lay = laneLayout(inWeek.filter(isSpan), days);
            const singles = inWeek.filter(i => !isSpan(i));
            const perDay = days.map(d => singles.filter(i => msYmd(i.start) === d));
            const laneCountAt = di => lay.rows.filter(r => r.a <= di && r.b >= di).reduce((m, r) => Math.max(m, r.lane + 1), 0);
            const needs = days.map((d, di) => laneCountAt(di) + perDay[di].length);
            const overflow = needs.some(n => n > maxRows);
            const lanesShown = overflow ? maxRows - 1 : maxRows;
            return html`<div class="mv-week" key=${w}>
              ${days.map((d, di) => {
                const lanesHere = Math.min(laneCountAt(di), lanesShown);
                const hiddenLanes = lay.rows.filter(r => r.a <= di && r.b >= di && r.lane >= lanesShown).length;
                const room = Math.max(0, (needs[di] > maxRows ? maxRows - 1 : maxRows) - lanesHere);
                const shown = perDay[di].slice(0, room);
                const hidden = hiddenLanes + perDay[di].length - shown.length;
                const isOut = d.slice(0, 7) !== first.slice(0, 7);
                return html`<div key=${d} class=${'mv-cell' + (isOut ? ' out' : '') + (over === d ? ' over' : '')} data-date=${d} onClick=${ev => clickCell(ev, d)}>
                  <button class=${'mday' + (d === td ? ' today' : '')} onClick=${() => { setDate(d); setView('day'); }}>${parseYmd(d).getDate() === 1 ? (parseYmd(d).getMonth() + 1) + '月' + 1 + '日' : parseYmd(d).getDate()}</button>
                  <div class="mv-lanes" style=${{ height: lanesHere * 22 + 'px' }}></div>
                  ${shown.map(i => html`<${Chip} key=${i.key} inst=${i} onDown=${onDown(i)} />`)}
                  ${hidden > 0 && html`<button class="more-btn" onClick=${ev => { ev.stopPropagation(); openPop(ev, 'calDay', { date: d }, true); }}>他 ${hidden} 件</button>`}
                </div>`;
              })}
              ${lay.rows.filter(r => r.lane < lanesShown).map(r => html`<${Chip} key=${r.inst.key + '|w' + w} inst=${r.inst} onDown=${onDown(r.inst)} cls=${'span' + (r.contL ? ' cont-l' : '') + (r.contR ? ' cont-r' : '')}
                style=${{ left: 'calc(' + (r.a / days.length * 100) + '% + 2px)', width: 'calc(' + ((r.b - r.a + 1) / days.length * 100) + '% - 6px)', top: (26 + r.lane * 22) + 'px' }} />`)}
              ${pref('calWeekNumbers') && html`<span class="wk-no">${isoWeek(days[0])}週</span>`}
            </div>`;
          })}
        </div>
      </div>`;
    }

    /* ---------- 日・4日・週（時間の表） ---------- */
    function TimeGrid({ days }) {
      const scrollRef = useRef(null);
      const colsRef = useRef([]);
      const g = useRef(null);
      const [drag, setDrag] = useState(null);
      const [, setNow] = useState(0);
      const td = todayYmd();
      const from = dayMs(days[0]);
      const to = dayMs(days[days.length - 1]) + DAY;
      ensureRange(from);
      useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const showsToday = days.indexOf(td) >= 0;
        el.scrollTop = showsToday ? Math.max(0, (minutesOf(Date.now()) / 60 - 1.5) * HOUR_PX) : 7 * HOUR_PX;
      }, [S.cal.view]);
      useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t); }, []);
      const all = instances(from, to);
      const spans = all.filter(isSpan);
      const timed = all.filter(i => !isSpan(i));
      const lay = laneLayout(spans, days);
      const quick = S.pop && S.pop.type === 'calQuick' && !S.pop.ctx.allDay ? S.pop.ctx : null;
      const colAt = x => colsRef.current.findIndex(c => c && (() => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; })());
      const minAt = (col, y) => { const r = colsRef.current[col].getBoundingClientRect(); return clamp((y - r.top) / HOUR_PX * 60, 0, 24 * 60); };
      const snap = m => Math.round(m / SNAP) * SNAP;
      // 空いているところを押す・ドラッグ → 新しい予定
      const downCol = (ev, di) => {
        if (ev.target.closest('.tg-ev')) return;
        if (ev.pointerType !== 'mouse') return;
        if (ev.button !== 0) return;
        const m = Math.floor(minAt(di, ev.clientY) / SNAP) * SNAP;
        g.current = { type: 'create', di: di, a: m, b: m + SNAP, moved: false, y: ev.clientY };
        ev.currentTarget.setPointerCapture(ev.pointerId);
        setDrag(Object.assign({}, g.current));
      };
      const tapCol = (ev, di) => {
        if (ev.target.closest('.tg-ev') || (g.current && g.current.done)) return;
        if (ev.pointerType === 'mouse' || ev.detail === 0) return;
        const m = Math.floor(minAt(di, ev.clientY) / 30) * 30;
        openQuick(di, m, m + pref('calDefaultMinutes'));
      };
      const openQuick = (di, a, b) => {
        const s = atMinutes(days[di], a);
        const e = atMinutes(days[di], Math.min(b, 24 * 60));
        const col = colsRef.current[di].getBoundingClientRect();
        const r = { left: col.left, right: col.right, top: col.top + a / 60 * HOUR_PX, bottom: col.top + b / 60 * HOUR_PX };
        openPopAt(r, 'calQuick', { start: s, end: e, allDay: false, di: di }, true);
      };
      // 作りかけの枠（小さな画面が開いているとき）も、ドラッグで動かす・下の端で長さを変える
      const downSel = (ev, di, mode) => {
        ev.stopPropagation();
        if (ev.button !== 0 || !quick) return;
        const a = minutesOf(quick.start);
        const b = quick.end - quick.start >= DAY ? 1440 : minutesOf(quick.end) || 1440;
        g.current = { type: mode, di: di, x: ev.clientX, y: ev.clientY, moved: false, a: a, b: b };
        ev.currentTarget.setPointerCapture(ev.pointerId);
      };
      const setQuick = (di, a, b) => update(s => {
        if (s.pop && s.pop.type === 'calQuick') s.pop.ctx = Object.assign({}, s.pop.ctx, { start: atMinutes(days[di], a), end: atMinutes(days[di], Math.min(b, 1440)), allDay: false, di: di });
      });
      // 予定を押す・ドラッグ → 開く・動かす・長さを変える
      const downEv = (ev, inst, di, mode) => {
        ev.stopPropagation();
        if (ev.pointerType !== 'mouse' || ev.button !== 0 || inst.kind === 'holiday') return;
        g.current = { type: mode, inst: inst, di: di, x: ev.clientX, y: ev.clientY, moved: false, s: inst.start, e: inst.end };
        ev.currentTarget.setPointerCapture(ev.pointerId);
      };
      const move = ev => {
        const st = g.current;
        if (!st) return;
        if (!st.moved && Math.abs(ev.clientX - (st.x || 0)) + Math.abs(ev.clientY - st.y) < 5) return;
        st.moved = true;
        if (st.type === 'create') {
          const m = snap(minAt(st.di, ev.clientY));
          st.b = m;
          setDrag({ type: 'create', di: st.di, a: Math.min(st.a, m), b: Math.max(st.a + SNAP, m) });
        } else if (st.type === 'move') {
          const dm = snap((ev.clientY - st.y) / HOUR_PX * 60);
          const ci = colAt(ev.clientX);
          const dd = ci >= 0 ? dayDiff(dayMs(days[st.di]), dayMs(days[ci])) : 0;
          const s = st.s + dm * MIN + dd * DAY;
          setDrag({ type: 'move', key: st.inst.key, s: s, e: s + (st.e - st.s), inst: st.inst });
        } else if (st.type === 'qmove') {
          const dm = snap((ev.clientY - st.y) / HOUR_PX * 60);
          const ci = colAt(ev.clientX);
          const len = st.b - st.a;
          const a = clamp(st.a + dm, 0, 24 * 60 - len);
          setDrag({ type: 'qsel', di: ci >= 0 ? ci : st.di, a: a, b: a + len });
        } else if (st.type === 'qresize') {
          const m = snap(minAt(st.di, ev.clientY));
          setDrag({ type: 'qsel', di: st.di, a: st.a, b: Math.max(st.a + SNAP, m) });
        } else if (st.type === 'resize') {
          const day = msYmd(st.s);
          const di = days.indexOf(day);
          const m = snap(minAt(di >= 0 ? di : st.di, ev.clientY));
          const e = Math.max(st.s + SNAP * MIN, atMinutes(day, m));
          setDrag({ type: 'resize', key: st.inst.key, s: st.s, e: e, inst: st.inst });
        }
      };
      const up = ev => {
        const st = g.current;
        if (!st) return;
        g.current = { done: true };
        setTimeout(() => { if (g.current && g.current.done) g.current = null; }, 0);
        setDrag(null);
        if (st.type === 'create') {
          if (!st.moved) openQuick(st.di, st.a, st.a + pref('calDefaultMinutes'));
          else openQuick(st.di, Math.min(st.a, st.b), Math.max(st.a + SNAP, st.b));
          return;
        }
        if (st.type === 'qmove' || st.type === 'qresize') {
          if (st.moved && drag && drag.type === 'qsel') setQuick(drag.di, drag.a, drag.b);
          return;
        }
        if (!st.moved) {
          const el = document.querySelector('.time-grid [data-key="' + (window.CSS && CSS.escape ? CSS.escape(st.inst.key) : st.inst.key) + '"]');
          openInst({ currentTarget: el || ev.target }, st.inst);
          return;
        }
        const d = drag;
        if (!d || (d.s === st.s && d.e === st.e)) return;
        if (st.inst.kind === 'task') { moveTask(st.inst.task, d.s, false); return; }
        withScope(st.inst, 'edit', scope => updateInst(st.inst, { start: iso(d.s), end: iso(d.e) }, scope));
      };
      const nowM = minutesOf(Date.now());
      const hideWE = !pref('calShowWeekends');
      return html`<div class=${'time-grid' + (days.length === 1 ? ' one-day' : '')} style=${{ '--days': days.length }} onPointerMove=${move} onPointerUp=${up}>
        <div class="tg-head">
          <div class="tg-corner">${pref('calWeekNumbers') ? isoWeek(days[0]) + '週' : 'GMT+09'}</div>
          ${days.map(d => {
            const dt = parseYmd(d);
            const hol = jpHolidays(dt.getFullYear())[d];
            return html`<button key=${d} class=${'tg-day' + (d === td ? ' today' : '') + (d < td ? ' past' : '')} onClick=${() => { setDate(d); setView('day'); }}>
              <span class=${'dw' + (dt.getDay() === 0 || hol ? ' sun' : dt.getDay() === 6 ? ' sat' : '')}>${DOW[dt.getDay()]}</span><span class="dn">${dt.getDate()}</span></button>`;
          })}
        </div>
        <div class="tg-allday" style=${{ height: Math.max(1, lay.count) * 22 + 6 + 'px' }}
          onClick=${ev => {
            if (ev.target.closest('.cal-chip')) return;
            const r = ev.currentTarget.getBoundingClientRect();
            const di = clamp(Math.floor((ev.clientX - r.left - 56) / ((r.width - 56) / days.length)), 0, days.length - 1);
            const cr = colsRef.current[di] ? colsRef.current[di].getBoundingClientRect() : r;
            openPopAt({ left: cr.left, right: cr.right, top: r.top, bottom: r.bottom }, 'calQuick', { start: dayMs(days[di]), end: dayMs(days[di]) + DAY, allDay: true }, true);
          }}>
          <div class="tg-ad-label">終日</div>
          ${lay.rows.map(r => html`<${Chip} key=${r.inst.key} inst=${r.inst} cls=${'span' + (r.contL ? ' cont-l' : '') + (r.contR ? ' cont-r' : '')}
            style=${{ left: 'calc(56px + (100% - 56px) * ' + (r.a / days.length) + ' + 2px)', width: 'calc((100% - 56px) * ' + ((r.b - r.a + 1) / days.length) + ' - 6px)', top: (3 + r.lane * 22) + 'px' }} />`)}
        </div>
        <div class="tg-scroll" ref=${scrollRef}>
          <div class="tg-body" style=${{ height: 24 * HOUR_PX + 'px' }}>
            <div class="tg-hours">${Array.from({ length: 24 }, (_, h) => html`<div class="tg-hour" style=${{ top: h * HOUR_PX + 'px' }}>${h ? h + ':00' : ''}</div>`)}</div>
            ${days.map((d, di) => {
              const ds = dayMs(d);
              const items = dayLayout(timed.filter(i => i.start < ds + DAY && i.end > ds).map(i => ({ inst: i, s: Math.max(i.start, ds), e: Math.min(i.end, ds + DAY) })));
              const dragHere = drag && (drag.type === 'move' || drag.type === 'resize') && msYmd(drag.s) === d ? drag : null;
              const selDrag = drag && (drag.type === 'create' || drag.type === 'qsel');
              const selHere = selDrag ? (drag.di === di ? { a: drag.a, b: drag.b } : null)
                : quick && msYmd(quick.start) === d ? { a: minutesOf(quick.start), b: quick.end - quick.start >= DAY ? 1440 : minutesOf(quick.end) || 1440 } : null;
              return html`<div key=${d} class=${'tg-col' + (d === td ? ' today' : '') + (hideWE && false ? '' : '')} ref=${el => { colsRef.current[di] = el; }}
                onPointerDown=${ev => downCol(ev, di)} onClick=${ev => tapCol(ev, di)}>
                ${items.map(it => {
                  const i = it.inst;
                  const top = (it.s - ds) / MIN / 60 * HOUR_PX;
                  const h = Math.max(18, (it.e - it.s) / MIN / 60 * HOUR_PX - 2);
                  const ghost = drag && drag.key === i.key;
                  const short = h < 36;
                  const klass = ['tg-ev', i.kind, i.resp === 'needsAction' && 'invite', i.resp === 'tentative' && 'tentative', i.resp === 'declined' && 'declined', i.done && 'done',
                    ghost && 'ghost', i.ev && i.ev._pending && 'pending', short && 'short'].filter(Boolean).join(' ');
                  const w = 100 / it.cols;
                  return html`<div key=${i.key} class=${klass} data-key=${i.key}
                    style=${{ '--c': i.color, top: top + 'px', height: h + 'px', left: 'calc(' + (it.col * w) + '% + 1px)', width: 'calc(' + (it.col === it.cols - 1 ? w : w * 1.5) + '% - 4px)', zIndex: 2 + it.col }}
                    onPointerDown=${ev => downEv(ev, i, di, 'move')}
                    onClick=${ev => { ev.stopPropagation(); if (ev.pointerType !== 'mouse' && ev.detail !== 0) openInst(ev, i); }}>
                    ${i.kind === 'task' && html`<${Icon} n=${i.done ? 'check_circle' : 'radio_button_unchecked'} cls="chip-ic" />`}
                    ${short ? html`<span class="et">${i.title}<span class="tm">、${hm(i.start)}</span></span>` : html`<span class="et">${i.title}</span><span class="tm">${hm(i.start)}～${hm(i.end)}</span>`}
                    ${!short && i.ev && i.ev.location && html`<span class="tm">${i.ev.location}</span>`}
                    ${i.kind === 'event' && html`<span class="rz" onPointerDown=${ev => downEv(ev, i, di, 'resize')}></span>`}
                  </div>`;
                })}
                ${dragHere && html`<div class="tg-ev drag-ghost" style=${{ '--c': dragHere.inst.color, top: (dragHere.s - ds) / MIN / 60 * HOUR_PX + 'px', height: Math.max(18, (dragHere.e - dragHere.s) / MIN / 60 * HOUR_PX - 2) + 'px', left: '1px', width: 'calc(100% - 4px)' }}>
                  <span class="et">${dragHere.inst.title}</span><span class="tm">${hm(dragHere.s)}～${hm(dragHere.e)}</span></div>`}
                ${selHere && html`<div class=${'tg-ev sel-ghost' + (quick ? ' movable' : '')} style=${{ top: selHere.a / 60 * HOUR_PX + 'px', height: Math.max(18, (selHere.b - selHere.a) / 60 * HOUR_PX - 2) + 'px', left: '1px', width: 'calc(100% - 4px)' }}
                  onPointerDown=${ev => quick && downSel(ev, di, 'qmove')}>
                  <span class="et">${(quick && quick.title) || '（タイトルなし）'}</span><span class="tm">${Math.floor(selHere.a / 60)}:${p2(selHere.a % 60)}～${Math.floor(selHere.b / 60)}:${p2(selHere.b % 60)}</span>
                  ${quick && html`<span class="rz" onPointerDown=${ev => downSel(ev, di, 'qresize')}></span>`}</div>`}
                ${d === td && html`<div class="now-line" style=${{ top: nowM / 60 * HOUR_PX + 'px' }}></div>`}
              </div>`;
            })}
          </div>
        </div>
      </div>`;
    }

    /* ---------- 年 ---------- */
    function YearView() {
      const y = parseYmd(S.cal.date).getFullYear();
      const from = dayMs(y + '-01-01');
      const to = dayMs((y + 1) + '-01-01');
      const has = {};
      instances(from, to, { noHolidays: true }).forEach(i => { for (let d = msYmd(Math.max(i.start, from)); dayMs(d) < Math.min(i.end, to); d = addDays(d, 1)) has[d] = (has[d] || 0) + 1; });
      const hol = jpHolidays(y);
      const td = todayYmd();
      const head = [0, 1, 2, 3, 4, 5, 6].map(i => DOW[(pref('calWeekStart') + i) % 7]);
      return html`<div class="year-view">${Array.from({ length: 12 }, (_, m) => {
        const first = y + '-' + p2(m + 1) + '-01';
        const start = startOfWeek(first);
        return html`<div class="yv-month" key=${m}>
          <button class="yv-title" onClick=${() => { setDate(first); setView('month'); }}>${m + 1}月</button>
          <div class="mm-grid">
            ${head.map(h => html`<div class="mm-dow">${h}</div>`)}
            ${Array.from({ length: 42 }, (_, i) => addDays(start, i)).map(d => d.slice(0, 7) !== first.slice(0, 7)
              ? html`<div class="mm-day out"></div>`
              : html`<button key=${d} class=${'mm-day' + (d === td ? ' today' : '') + (has[d] ? ' has' : '') + (hol[d] ? ' hol' : '')} title=${hol[d] || ''}
                  onClick=${ev => openPop(ev, 'calDay', { date: d }, true)}>${parseYmd(d).getDate()}</button>`)}
          </div>
        </div>`;
      })}</div>`;
    }

    /* ---------- スケジュール ---------- */
    function ScheduleView() {
      const days = 60 * (1 + S.cal.more);
      const from = dayMs(S.cal.date);
      const to = from + days * DAY;
      const all = instances(from, to);
      const byDay = [];
      const idx = {};
      all.forEach(i => {
        for (let d = msYmd(Math.max(i.start, from)); dayMs(d) < Math.min(i.end, to); d = addDays(d, 1)) {
          if (!(d in idx)) { idx[d] = byDay.length; byDay.push({ d: d, items: [] }); }
          byDay[idx[d]].items.push(i);
        }
      });
      byDay.sort((a, b) => (a.d < b.d ? -1 : 1));
      const td = todayYmd();
      return html`<div class="schedule-view">
        ${byDay.map(g => {
          const dt = parseYmd(g.d);
          return html`<div class="sv-day" key=${g.d}>
            <button class=${'sv-date' + (g.d === td ? ' today' : '')} onClick=${() => { setDate(g.d); setView('day'); }}><span class="dn">${dt.getDate()}</span><span class="dm">${dt.getMonth() + 1}月、${DOW[dt.getDay()]}</span></button>
            <div class="sv-items">${g.items.map(i => html`<button key=${i.key + g.d} class=${'sv-item' + (i.done ? ' done' : '') + (i.resp === 'declined' ? ' declined' : '')} onClick=${ev => openInst(ev, i)}>
              <span class="sv-dot" style=${{ background: i.color }}></span>
              <span class="sv-time">${i.allDay || isSpan(i) ? '終日' : i.kind === 'task' ? hm(i.start) : hm(i.start) + '～' + hm(i.end)}</span>
              <span class="sv-title">${i.kind === 'task' ? html`<${Icon} n=${i.done ? 'check_circle' : 'radio_button_unchecked'} cls="chip-ic" />` : ''}${i.title}</span>
            </button>`)}</div>
          </div>`;
        })}
        ${!byDay.length && html`<div class="empty"><div class="em-title">予定はありません</div><div>${mdLabel(S.cal.date)}から${days}日間</div></div>`}
        <div style="text-align:center;padding:16px"><button class="btn outline sm" onClick=${() => update(s => { s.cal.more++; })}>さらに60日分を表示</button></div>
      </div>`;
    }

    /* ---------- 検索 ---------- */
    function SearchView() {
      const words = S.cal.search.trim().toLowerCase().split(/\s+/);
      const hits = Object.values(cur().events).filter(e => {
        if (e.deletedAt || e.status === 'cancelled' || !calById(e.calendarId)) return false;
        const hay = [e.title, e.description, e.location, (calById(e.calendarId) || {}).name].concat((e.attendees || []).map(a => memberName(a.id))).join(' ').toLowerCase();
        return words.every(w => hay.indexOf(w) >= 0);
      }).sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
      return html`<div class="schedule-view">
        <div class="muted" style="padding:12px 16px">${hits.length}件見つかりました（予定のタイトル・説明・場所・ゲスト・カレンダーから探します）</div>
        ${hits.map(e => {
          const s = Date.parse(e.startAt);
          const inst = { key: e.id, kind: 'event', ev: e, start: s, end: Date.parse(e.endAt), allDay: e.allDay, masterId: e.recurringId || (e.rrule ? e.id : ''), instanceStart: e.rrule ? s : 0, title: evTitle(e), color: evColor(e), calId: e.calendarId, resp: myResp(e) };
          const dt = new Date(s);
          return html`<div class="sv-day" key=${e.id}>
            <button class="sv-date" onClick=${() => { update(st => { st.cal.search = ''; st.cal.date = msYmd(s); st.cal.view = 'day'; }); }}><span class="dn">${dt.getDate()}</span><span class="dm">${dt.getFullYear()}年${dt.getMonth() + 1}月、${DOW[dt.getDay()]}</span></button>
            <div class="sv-items"><button class="sv-item" onClick=${ev => openInst(ev, inst)}>
              <span class="sv-dot" style=${{ background: inst.color }}></span>
              <span class="sv-time">${e.allDay ? '終日' : hm(s) + '～' + hm(inst.end)}</span>
              <span class="sv-title">${inst.title}${e.rrule ? html`<span class="muted">（${rrLabel(e.rrule, msYmd(s))}）</span>` : ''}</span>
            </button></div>
          </div>`;
        })}
      </div>`;
    }

    /* ======================================================================
     * ポップアップ
     * ==================================================================== */

    function respCount(e) {
      const c = { accepted: 0, declined: 0, tentative: 0, needsAction: 0 };
      (e.attendees || []).forEach(a => { c[a.response] = (c[a.response] || 0) + 1; });
      return c;
    }
    function respIcon(r) {
      if (r === 'accepted') return html`<span class="resp ok" title="はい"><${Icon} n="check_circle" /></span>`;
      if (r === 'declined') return html`<span class="resp ng" title="いいえ"><${Icon} n="cancel" /></span>`;
      if (r === 'tentative') return html`<span class="resp maybe" title="未定"><${Icon} n="help" /></span>`;
      return '';
    }
    function reminderText(r) {
      const m = r.minutes;
      const t = m === 0 ? '開始時' : m % 10080 === 0 ? (m / 10080) + '週間前' : m % 1440 === 0 ? (m / 1440) + '日前' : m % 60 === 0 ? (m / 60) + '時間前' : m + '分前';
      return t + (r.method === 'email' ? '（メール）' : '');
    }

    function EventPop({ ctx }) {
      const i0 = ctx.inst;
      const e = cur().events[i0.ev.id];
      const [menu, setMenu] = useState(false);
      if (!e || e.deletedAt) return html`<div class="cal-pop"><div class="muted" style="padding:16px">この予定は削除されました</div></div>`;
      const inst = Object.assign({}, i0, { ev: e, title: evTitle(e), color: evColor(e) });
      const master = e.recurringId ? cur().events[e.recurringId] : e.rrule ? e : null;
      const c = calById(e.calendarId) || {};
      const owner = c.owner;
      const me = (e.attendees || []).find(a => a.id === S.operator);
      const cnt = respCount(e);
      const isOwner = owner === S.operator;
      return html`<div class="cal-pop">
        <div class="cp-actions">
          <button class="icon-btn" aria-label="予定を編集" title="編集" onClick=${() => openEditor(inst)}><${Icon} n="edit" /></button>
          <button class="icon-btn" aria-label="予定を削除" title="削除" onClick=${() => withScope(inst, 'delete', scope => { closePop(); deleteInst(inst, scope); })}><${Icon} n="delete" /></button>
          <button class="icon-btn" aria-label="その他" title="その他" onClick=${() => setMenu(!menu)}><${Icon} n="more_vert" /></button>
          <button class="icon-btn" aria-label="閉じる" onClick=${closePop}><${Icon} n="close" /></button>
        </div>
        ${menu && html`<div class="cp-menu">
          <div class="menu-label">色</div>
          <div class="swatches">
            <button class=${'sw cal' + (!e.color ? ' on' : '')} style=${{ background: c.color }} title="カレンダーの色" onClick=${() => withScope(inst, 'edit', scope => updateInst(inst, { color: '' }, scope))}></button>
            ${EVENT_COLORS.map(x => html`<button class=${'sw' + (e.color === x[0] ? ' on' : '')} style=${{ background: x[0] }} title=${x[1]} aria-label=${x[1]}
              onClick=${() => withScope(inst, 'edit', scope => updateInst(inst, { color: x[0] }, scope))}></button>`)}
          </div>
          <button class="menu-item" onClick=${() => { const d = draftFromInst(inst); update(s => { s.pop = null; s.cal.editor = Object.assign(d, { mode: 'new', id: '', inst: null, key: uid(), title: d.title, rrule: '' }); }); }}><${Icon} n="content_copy" />複製</button>
        </div>`}
        <div class="cp-row title-row"><span class="sq" style=${{ background: inst.color }}></span>
          <div><div class="cp-title">${inst.title}</div><div class="cp-sub">${timeRange(inst)}</div>
            ${master && html`<div class="cp-sub"><${Icon} n="repeat" cls="xs" />${rrLabel(master.rrule, msYmd(Date.parse(master.startAt)))}</div>`}</div></div>
        ${e.location && html`<div class="cp-row"><${Icon} n="place" /><div>${e.location}</div></div>`}
        ${(e.attendees || []).length > 0 && html`<div class="cp-row"><${Icon} n="group" /><div class="grow">
          <div>ゲスト ${e.attendees.length}人</div>
          <div class="cp-sub">はい ${cnt.accepted}、いいえ ${cnt.declined}、未定 ${cnt.tentative}、未回答 ${cnt.needsAction}</div>
          ${(e.guestsCanSee || isOwner) && e.attendees.map(a => html`<div class="cp-guest" key=${a.id}><span class="av-wrap"><${Avatar} id=${a.id} size=${24} />${respIcon(a.response)}</span>
            <span>${memberName(a.id) || '（不明）'}</span>${a.id === owner && html`<span class="muted">主催者</span>`}${a.optional && html`<span class="muted">任意</span>`}</div>`)}
        </div></div>`}
        ${e.description && html`<div class="cp-row"><${Icon} n="notes" /><div class="cp-desc">${e.description}</div></div>`}
        ${(e.reminders || []).length > 0 && html`<div class="cp-row"><${Icon} n="notifications" /><div>${e.reminders.map(reminderText).join('、')}</div></div>`}
        <div class="cp-row"><${Icon} n="calendar_month" /><div>${c.name || ''}${owner ? html`<div class="cp-sub">主催者: ${memberName(owner)}</div>` : ''}
          ${e.visibility === 'private' ? html`<div class="cp-sub"><${Icon} n="lock" cls="xs" />非公開</div>` : ''}${e.busy === false ? html`<div class="cp-sub">空き時間として表示</div>` : ''}</div></div>
        ${me && !isOwner && html`<div class="cp-rsvp"><span>出席しますか？</span>
          ${[['accepted', 'はい'], ['declined', 'いいえ'], ['tentative', '未定']].map(x => html`<button class=${'chip-btn' + (me.response === x[0] ? ' set' : '')}
            onClick=${() => withScope(inst, 'respond', scope => respond(inst, x[0], scope), ['this', 'all'])}>${x[1]}</button>`)}</div>`}
      </div>`;
    }

    function TaskPop({ ctx }) {
      const t = cur().tasks[ctx.taskId];
      if (!t) return html`<div class="cal-pop"><div class="muted" style="padding:16px">このタスクは削除されました</div></div>`;
      const done = t.status === 'done';
      return html`<div class="cal-pop">
        <div class="cp-actions">
          <button class="icon-btn" aria-label="閉じる" onClick=${closePop}><${Icon} n="close" /></button>
        </div>
        <div class="cp-row title-row"><span class="sq task"><${Icon} n="task_alt" /></span>
          <div><div class=${'cp-title' + (done ? ' strike' : '')}>${t.title}</div>
            ${t.doDate && html`<div class="cp-sub">いつやる: ${mdLabel(t.doDate)}${t.doTime ? ' ' + t.doTime : ''}</div>`}
            ${t.due && html`<div class=${'cp-sub' + (isOverdue(t) ? ' red' : '')}>期限: ${mdLabel(t.due)}${t.dueTime ? ' ' + t.dueTime : ''}${isOverdue(t) ? '（期限切れ）' : ''}</div>`}</div></div>
        ${t.details && html`<div class="cp-row"><${Icon} n="notes" /><div class="cp-desc">${t.details}</div></div>`}
        <div class="cp-row"><${Icon} n="person" /><div>${memberName(t.assignee)}${t.createdBy && t.createdBy !== t.assignee ? html`<div class="cp-sub">依頼: ${memberName(t.createdBy)}</div>` : ''}</div></div>
        <div class="cp-row"><${Icon} n="format_list_bulleted" /><div>${listName(t.listId)}</div></div>
        ${t.noteText && html`<div class="cp-row"><${Icon} n="chat" /><div class="cp-desc">${t.noteText}</div></div>`}
        <div class="dlg-actions" style="margin:8px 16px 12px">
          <button class="btn text sm" onClick=${() => { closePop(); setMode('tasks'); openTask(t.id); }}>タスクで開く</button>
          <button class=${'btn primary sm' + (S.arm === t.id ? ' armed' : '')} onClick=${() => { if (done || S.arm === t.id) closePop(); armOrComplete(t); }}>${done ? '未完了に戻す' : S.arm === t.id ? 'もう一度押すと完了' : '完了にする'}</button>
        </div>
      </div>`;
    }

    function HolidayPop({ ctx }) {
      return html`<div class="cal-pop">
        <div class="cp-actions"><button class="icon-btn" aria-label="閉じる" onClick=${closePop}><${Icon} n="close" /></button></div>
        <div class="cp-row title-row"><span class="sq" style=${{ background: HOLIDAY_COLOR }}></span><div><div class="cp-title">${ctx.inst.title}</div><div class="cp-sub">${mdShort(msYmd(ctx.inst.start))}・終日</div></div></div>
        <div class="cp-row"><${Icon} n="calendar_month" /><div>日本の祝日</div></div>
      </div>`;
    }

    function QuickPop({ ctx }) {
      const [tab, setTab] = useState('event');
      const [title, setTitle] = useState('');
      const [calId, setCalId] = useState(defaultCalendarId());
      const [assignee, setAssignee] = useState(S.operator || '');
      const [lid, setLid] = useState((cur().listArr[0] || {}).id || '');
      const [prio, setPrio] = useState('');
      const [prioErr, setPrioErr] = useState(false);
      const ref = useRef(null);
      useEffect(() => { if (ref.current) ref.current.focus(); }, [tab]);
      const l = calList();
      const cals = l.mine.concat(l.shared, l.others);
      // 日付・時刻をこの画面で変える（変えると、カレンダーの枠も動く）
      const setRange = (st, en, allDay) => update(s => { if (s.pop && s.pop.type === 'calQuick') s.pop.ctx = Object.assign({}, s.pop.ctx, { start: st, end: en, allDay: allDay }); });
      const day0 = msYmd(ctx.start);
      const toM = v => Number(v.split(':')[0]) * 60 + Number(v.split(':')[1]);
      const onDate = v => { if (v) { const sh = dayMs(v) - dayMs(day0); setRange(ctx.start + sh, ctx.end + sh, ctx.allDay); } };
      const onEndDate = v => { if (v && v >= day0) setRange(ctx.start, dayMs(v) + DAY, true); };
      const onStart = v => { const st = atMinutes(day0, toM(v)); setRange(st, st + (ctx.end - ctx.start), false); };
      const onEnd = v => { let en = atMinutes(day0, toM(v)); if (en <= ctx.start) en += DAY; setRange(ctx.start, en, false); };
      const onAllDay = on => {
        if (on) setRange(dayMs(day0), dayMs(day0) + DAY, true);
        else { const st = atMinutes(day0, 9 * 60); setRange(st, st + pref('calDefaultMinutes') * MIN, false); }
      };
      const startV = pad(hm(ctx.start));
      const endV = pad(hm(ctx.end));
      const opts = v => (TIMES.map(pad).indexOf(v) >= 0 ? TIMES.map(pad) : [v].concat(TIMES.map(pad)));
      const endLabel = x => { const m = (toM(x) - minutesOf(ctx.start) + 1440) % 1440 || 1440; return x + '（' + durLabel(m) + '）'; };
      const more = () => {
        update(s => { s.pop = null; s.cal.editor = blankDraft(ctx.start, ctx.end, ctx.allDay, { title: title, calendarId: calId }); });
      };
      const save = () => {
        if (tab === 'event') {
          createEvent({ id: uid(), title: title.trim(), allDay: !!ctx.allDay, start: iso(ctx.start), end: iso(ctx.end), calendarId: calId,
            reminders: ctx.allDay ? [] : [{ method: 'popup', minutes: 10 }], busy: !ctx.allDay });
          closePop();
          snack('予定を保存しました');
        } else {
          if (!title.trim()) { if (ref.current) ref.current.focus(); return; }
          if (!prio) { setPrioErr(true); return; }
          const d = msYmd(ctx.start);
          const tm = ctx.allDay ? '' : hm(ctx.start).padStart(5, '0');
          act.createTask({ id: uid(), listId: lid, title: title.trim(), details: '', assignee: assignee, priority: prio, doDate: d, doTime: tm, due: d, dueTime: tm, repeat: '', sortOrder: newSortOrder(lid) });
          closePop();
          snack(assignee !== S.operator ? memberName(assignee) + 'さんにタスクを送りました。相手の画面にすぐ出ます' : 'タスクを作成しました');
        }
      };
      return html`<div class="cal-pop qpop">
        <div class="cp-actions"><button class="icon-btn" aria-label="閉じる" onClick=${closePop}><${Icon} n="close" /></button></div>
        <input ref=${ref} class="qp-title" placeholder=${tab === 'event' ? 'タイトルを追加' : 'タスクのタイトル（何を）'} value=${title}
          onInput=${e => { const v = e.target.value; setTitle(v); update(st => { if (st.pop && st.pop.type === 'calQuick') st.pop.ctx = Object.assign({}, st.pop.ctx, { title: v }); }); }}
          onKeyDown=${e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); } }} />
        <div class="qp-tabs">
          <button class=${tab === 'event' ? 'on' : ''} onClick=${() => setTab('event')}>予定</button>
          <button class=${tab === 'task' ? 'on' : ''} onClick=${() => setTab('task')}>タスク</button>
        </div>
        <div class="cp-row qp-when"><${Icon} n="schedule" /><div class="qp-when-ctl">
          <input class="input" type="date" aria-label="日付" value=${day0} onChange=${e => onDate(e.target.value)} />
          ${!ctx.allDay && html`<select class="input" aria-label="開始の時刻" value=${startV} onChange=${e => onStart(e.target.value)}>${opts(startV).map(x => html`<option value=${x}>${x}</option>`)}</select>
            <span>～</span>
            <select class="input" aria-label="終了の時刻" value=${endV} onChange=${e => onEnd(e.target.value)}>${opts(endV).map(x => html`<option value=${x}>${endLabel(x)}</option>`)}</select>`}
          ${ctx.allDay && html`<span>～</span><input class="input" type="date" aria-label="終了日" value=${msYmd(ctx.end - 1)} onChange=${e => onEndDate(e.target.value)} />`}
          <label class="qp-allday"><input type="checkbox" checked=${!!ctx.allDay} onChange=${e => onAllDay(e.target.checked)} />終日</label>
        </div></div>
        ${tab === 'event' ? html`
          <div class="cp-row"><${Icon} n="group" /><button class="link-btn" onClick=${more}>ゲストを追加</button></div>
          <div class="cp-row"><${Icon} n="place" /><button class="link-btn" onClick=${more}>場所を追加</button></div>
          <div class="cp-row"><${Icon} n="calendar_month" /><select class="input" value=${calId} onChange=${e => setCalId(e.target.value)}>
            ${cals.map(c => html`<option value=${c.id}>${c.name}</option>`)}</select></div>`
        : html`
          <div class="cp-row"><${Icon} n="person" /><select class="input" value=${assignee} onChange=${e => setAssignee(e.target.value)}>
            ${activeMembers().map(m => html`<option value=${m.id}>${m.name}${m.id === S.operator ? '（自分）' : ''}</option>`)}</select></div>
          <div class="cp-row"><${Icon} n="format_list_bulleted" /><select class="input" value=${lid} onChange=${e => setLid(e.target.value)}>
            ${cur().listArr.map(x => html`<option value=${x.id}>${x.name}</option>`)}</select></div>
          <div class="cp-row"><${Icon} n="flag" /><div class=${'prio-pick' + (prioErr ? ' error' : '')} role="radiogroup" aria-label="優先度">
            ${PRIO_PICK.map(k => html`<button type="button" role="radio" aria-checked=${prio === k} class=${'prio-btn p-' + k + (prio === k ? ' on' : '')}
              onClick=${() => { setPrio(k); setPrioErr(false); }}>${PRIO[k].label}</button>`)}
            <span class="pp-label">${prioErr ? '優先度を選んでください' : '優先度（必須）'}</span></div></div>
          <div class="cp-sub" style="padding:0 16px">この日を「いつやる」と「期限」にします</div>`}
        <div class="dlg-actions" style="margin:8px 16px 12px">
          ${tab === 'event' && html`<button class="btn text sm" onClick=${more}>その他のオプション</button>`}
          <button class="btn primary sm" onClick=${save}>保存</button>
        </div>
      </div>`;
    }

    function DayPop({ ctx }) {
      const s = dayMs(ctx.date);
      const items = instances(s, s + DAY);
      const dt = parseYmd(ctx.date);
      return html`<div class="cal-pop day-pop">
        <div class="cp-actions"><button class="icon-btn" aria-label="閉じる" onClick=${closePop}><${Icon} n="close" /></button></div>
        <div class="dp-head"><div class="muted">${DOW[dt.getDay()]}</div><button class="dp-num" onClick=${() => { closePop(); setDate(ctx.date); setView('day'); }}>${dt.getDate()}</button></div>
        <div class="dp-list">
          ${items.map(i => html`<${Chip} key=${i.key} inst=${i} />`)}
          ${!items.length && html`<div class="muted" style="padding:8px">予定はありません</div>`}
        </div>
        <div class="dlg-actions" style="margin:8px 12px 12px"><button class="btn text sm" onClick=${() => openNewEditor({ start: s + 9 * 60 * MIN, end: s + 9 * 60 * MIN + pref('calDefaultMinutes') * MIN })}><${Icon} n="add" />予定を作成</button></div>
      </div>`;
    }

    function CreatePop() {
      return html`<div>
        <button class="menu-item" onClick=${() => openNewEditor()}><${Icon} n="event" />予定</button>
        <button class="menu-item" onClick=${() => update(s => { s.pop = null; s.dialog = { type: 'create' }; s.drawer = false; })}><${Icon} n="task_alt" />タスク</button>
      </div>`;
    }

    function CalMenuPop({ ctx }) {
      const c = calById(ctx.calId);
      if (!c) return null;
      return html`<div style="min-width:240px">
        <button class="menu-item" onClick=${() => onlyShow(c.id)}>このカレンダーのみ表示</button>
        ${!c.owner && html`<button class="menu-item" onClick=${() => update(s => { s.pop = null; s.dialog = { type: 'calCalendar', id: c.id }; })}>名前・説明を変更</button>`}
        ${!c.owner && html`<button class="menu-item danger" onClick=${() => { closePop(); confirmDlg('カレンダーを削除しますか？', '「' + c.name + '」と、その中の予定が削除されます（予定は30日間ごみ箱から戻せます）。', '削除', () => enqueue('deleteCalendar', { id: c.id }), true); }}>削除</button>`}
        <div class="menu-sep"></div>
        <div class="swatches" style="padding:4px 12px 8px">
          ${CAL_COLORS.map(x => html`<button class=${'sw' + (c.color === x[0] ? ' on' : '')} style=${{ background: x[0] }} title=${x[1]} aria-label=${x[1]}
            onClick=${() => { enqueue('saveCalendar', { calendar: { id: c.id, color: x[0] } }); closePop(); }}></button>`)}
        </div>
      </div>`;
    }

    /* ======================================================================
     * ダイアログ
     * ==================================================================== */

    function ScopeDialog({ d, close }) {
      const opts = (d.only || ['this', 'following', 'all']).map(k => [k, { this: 'この予定', following: 'これ以降のすべての予定', all: 'すべての予定' }[k]]);
      const [pick, setPick] = useState(opts[0][0]);
      const title = { edit: '繰り返し予定の変更', delete: '繰り返し予定の削除', respond: '繰り返し予定への返答' }[d.action];
      return html`<div class="dialog" style="max-width:360px"><h2>${title}</h2>
        ${opts.map(o => html`<label class="rp-radio" key=${o[0]}><input type="radio" name="scope" checked=${pick === o[0]} onChange=${() => setPick(o[0])} /><span>${o[1]}</span></label>`)}
        <div class="dlg-actions"><button class="btn text" onClick=${close}>キャンセル</button>
          <button class="btn primary" onClick=${() => { close(); d.onPick(pick); }}>OK</button></div>
      </div>`;
    }

    function CalendarDialog({ d, close }) {
      const c = d.id ? calById(d.id) : null;
      const [name, setName] = useState(c ? c.name : '');
      const [desc, setDesc] = useState(c ? c.description || '' : '');
      const [color, setColor] = useState(c ? c.color : '#039be5');
      const ok = () => {
        if (!name.trim()) return;
        enqueue('saveCalendar', { calendar: { id: c ? c.id : uid(), name: name.trim(), description: desc, color: color } });
        close();
      };
      return html`<div class="dialog"><h2>${c ? '共有のカレンダーを変更' : '新しい共有カレンダー'}</h2>
        <p>会議室・本部行事など、みんなで使うカレンダーです。だれでも予定を入れられます。</p>
        <div class="form-grid">
          <div><label class="lbl">名前</label><input class="input" value=${name} placeholder="例: 会議室、本部行事" onInput=${e => setName(e.target.value)} /></div>
          <div><label class="lbl">説明（任意）</label><textarea class="textarea" rows="2" value=${desc} onInput=${e => setDesc(e.target.value)}></textarea></div>
          <div><label class="lbl">色</label><div class="swatches">${CAL_COLORS.map(x => html`<button class=${'sw' + (color === x[0] ? ' on' : '')} style=${{ background: x[0] }} title=${x[1]} aria-label=${x[1]} onClick=${() => setColor(x[0])}></button>`)}</div></div>
        </div>
        <div class="dlg-actions"><button class="btn text" onClick=${close}>キャンセル</button><button class="btn primary" disabled=${!name.trim()} onClick=${ok}>${c ? '保存' : '作成'}</button></div>
      </div>`;
    }

    function TrashDialog({ close }) {
      const [items, setItems] = useState(null);
      const load = () => call('eventTrash', {}).then(r => setItems(r.items)).catch(e => snack(errText(e), { kind: 'error' }));
      useEffect(() => { load(); }, []);
      return html`<div class="dialog wide"><h2>予定のごみ箱</h2>
        <p>削除した予定は30日間ここに残り、元に戻せます。</p>
        ${!items ? html`<div class="muted">読み込み中…</div>` : items.map(it => html`<div class="mem-row" key=${it.id}>
          <span class="sq" style=${{ background: (calById(it.calendarId) || {}).color || '#999', width: '12px', height: '12px', borderRadius: '3px' }}></span>
          <div class="grow"><div>${it.title || '（タイトルなし）'}${it.rrule ? html`<span class="muted">（繰り返し）</span>` : ''}</div>
            <div class="muted" style="font-size:12px">${mdShort(msYmd(Date.parse(it.start)))}・${(calById(it.calendarId) || {}).name || ''}・削除: ${memberName(it.deletedBy) || '不明'}</div></div>
          <button class="btn text sm" onClick=${() => enqueue('restoreEvent', { id: it.id }, () => { snack('元に戻しました'); load(); })}><${Icon} n="restore_from_trash" />元に戻す</button>
        </div>`)}
        ${items && !items.length && html`<div class="muted">ごみ箱は空です</div>`}
        <div class="dlg-actions"><button class="btn primary" onClick=${close}>閉じる</button></div>
      </div>`;
    }

    function Settings() {
      const p = (k, label, sub) => html`<div class="set-row"><div class="set-text">${label}${sub ? html`<small>${sub}</small>` : ''}</div><${Switch} checked=${!!pref(k)} onChange=${v => setPref(k, v)} /></div>`;
      const notify = v => {
        if (v && window.Notification && Notification.permission !== 'granted') {
          Notification.requestPermission().then(r => { setPref('calBrowserNotify', r === 'granted'); if (r !== 'granted') snack('ブラウザの通知が許可されませんでした', { kind: 'error' }); });
        } else setPref('calBrowserNotify', v);
      };
      return html`<div>
        <div class="set-row"><div class="set-text">週の始まり</div>
          <div class="radios">${[[0, '日曜日'], [1, '月曜日'], [6, '土曜日']].map(x => html`<button class=${pref('calWeekStart') === x[0] ? 'on' : ''} onClick=${() => setPref('calWeekStart', x[0])}>${x[1]}</button>`)}</div></div>
        <div class="set-row"><div class="set-text">予定の長さ（最初の値）</div>
          <select class="input" style="width:auto" value=${pref('calDefaultMinutes')} onChange=${e => setPref('calDefaultMinutes', Number(e.target.value))}>
            ${[15, 30, 45, 60, 90, 120].map(m => html`<option value=${m}>${durLabel(m)}</option>`)}</select></div>
        ${p('calShowWeekends', '週末を表示する', '週の表示と月の表示に、土曜・日曜を出します')}
        ${p('calShowDeclined', '「いいえ」と答えた予定を表示する')}
        ${p('calWeekNumbers', '週番号を表示する')}
        <div class="set-row"><div class="set-text">ブラウザの通知<small>予定の通知（○分前）を、画面の外にも出します（このアプリを開いている間）</small></div><${Switch} checked=${!!pref('calBrowserNotify')} onChange=${notify} /></div>
        <div class="set-row"><div class="set-text">キーボードの操作<small>T 今日／J・K 次・前／D 日・X 4日・W 週・M 月・Y 年・A スケジュール／C 予定を作成／/ 検索</small></div></div>
        <p class="muted" style="margin-top:12px;font-size:12px">ここの設定は、この端末（このブラウザ）だけに保存されます。</p>
      </div>`;
    }

    /* ======================================================================
     * 予定の編集（全体の画面）
     * ==================================================================== */
    const TIMES = Array.from({ length: 96 }, (_, i) => Math.floor(i / 4) + ':' + p2((i % 4) * 15));
    const pad = t => (t.length === 4 ? '0' + t : t);

    function Editor() {
      const d0 = S.cal.editor;
      const [d, setD] = useState(d0);
      const [guest, setGuest] = useState('');
      const set = patch => setD(Object.assign({}, d, patch));
      const close = () => {
        const changed = d.mode === 'new' ? !!(d.title || d.description || d.location || d.attendees.length) : JSON.stringify(toPayload(d)) !== JSON.stringify(d.orig);
        if (changed) confirmDlg('変更を破棄しますか？', '保存していない変更は失われます。', '破棄', () => update(s => { s.cal.editor = null; }), true);
        else update(s => { s.cal.editor = null; });
      };
      const t = draftTimes(d);
      const durMin = Math.round((t.e - t.s) / MIN);
      // 開始を動かしたら、長さを保ったまま終了も動かす（Google と同じ）
      const setStart = (date, time) => {
        const nd = Object.assign({}, d, date !== undefined ? { startDate: date } : {}, time !== undefined ? { startTime: time } : {});
        const ns = draftTimes(Object.assign({}, nd, { endDate: nd.startDate, endTime: nd.startTime }));
        const len = d.allDay ? dayMs(d.endDate) - dayMs(d.startDate) : t.e - t.s;
        const ne = d.allDay ? dayMs(nd.startDate) + len : ns.s + len;
        setD(Object.assign(nd, d.allDay ? { endDate: msYmd(ne) } : { endDate: msYmd(ne), endTime: pad(hm(ne)) }));
      };
      const sameDay = d.startDate === d.endDate;
      const endOptions = TIMES.map(x => {
        const m = Number(x.split(':')[0]) * 60 + Number(x.split(':')[1]);
        const sm = Number(d.startTime.split(':')[0]) * 60 + Number(d.startTime.split(':')[1]);
        return [pad(x), sameDay && m > sm ? x + '（' + durLabel(m - sm) + '）' : x, sameDay && m <= sm];
      });
      const presets = rrPresets(d.startDate);
      const known = presets.some(x => x[0] === d.rrule);
      const cals = (() => { const l = calList(); return l.mine.concat(l.shared, l.others); })();
      const cal = calById(d.calendarId) || {};
      const owner = cal.owner;
      const addGuest = id => {
        if (!id || d.attendees.some(a => a.id === id)) return;
        const list = d.attendees.slice();
        if (!list.length && owner && owner !== id) list.push({ id: owner, optional: false, response: 'accepted' });
        list.push({ id: id, optional: false, response: id === owner ? 'accepted' : 'needsAction' });
        set({ attendees: list });
        setGuest('');
      };
      const cands = activeMembers().filter(m => !d.attendees.some(a => a.id === m.id) && (!guest.trim() || m.name.toLowerCase().indexOf(guest.trim().toLowerCase()) >= 0));
      const unit = r => (r.minutes && r.minutes % 10080 === 0 ? 10080 : r.minutes && r.minutes % 1440 === 0 ? 1440 : r.minutes && r.minutes % 60 === 0 ? 60 : 1);
      const setRem = (i, patch) => set({ reminders: d.reminders.map((r, j) => (j === i ? Object.assign({}, r, patch) : r)) });
      return html`<div class="cal-editor" role="dialog" aria-label="予定の編集">
        <div class="ce-head">
          <button class="icon-btn" aria-label="閉じる" onClick=${close}><${Icon} n="close" /></button>
          <input class="ce-title" placeholder="タイトルを追加" value=${d.title} onInput=${e => set({ title: e.target.value })} />
          <button class="btn primary" onClick=${() => saveDraft(d)}>保存</button>
        </div>
        <div class="ce-body">
          <div class="ce-main">
            <div class="ce-when">
              <input class="input" type="date" value=${d.startDate} onInput=${e => { if (e.target.value) setStart(e.target.value); }} aria-label="開始日" />
              ${!d.allDay && html`<select class="input" value=${d.startTime} onChange=${e => setStart(undefined, e.target.value)} aria-label="開始時刻">
                ${TIMES.map(x => html`<option value=${pad(x)}>${x}</option>`)}${TIMES.indexOf(d.startTime.replace(/^0/, '')) < 0 && html`<option value=${d.startTime}>${d.startTime}</option>`}</select>`}
              <span>～</span>
              ${!d.allDay && html`<select class="input" value=${d.endTime} onChange=${e => set({ endTime: e.target.value })} aria-label="終了時刻">
                ${endOptions.map(x => html`<option value=${x[0]}>${x[1]}</option>`)}${TIMES.indexOf(d.endTime.replace(/^0/, '')) < 0 && html`<option value=${d.endTime}>${d.endTime}</option>`}</select>`}
              <input class="input" type="date" value=${d.endDate} onInput=${e => { if (e.target.value) set({ endDate: e.target.value }); }} aria-label="終了日" />
            </div>
            ${durMin <= 0 && html`<div class="af-err">終了は開始より後にしてください</div>`}
            <div class="ce-when">
              <label class="ce-check"><input type="checkbox" checked=${d.allDay} onChange=${e => set({ allDay: e.target.checked, busy: !e.target.checked ? true : d.busy, endDate: e.target.checked && d.endDate < d.startDate ? d.startDate : d.endDate })} />終日</label>
              <select class="input" style="width:auto" value=${d.rrule && !known ? 'cur' : d.rrule} aria-label="繰り返し" onChange=${e => {
                const x = e.target.value;
                if (x === 'custom') {
                  openRepeatDialog({ doDate: d.startDate, repeat: d.rrule }, v => {
                    setD(dd => {
                      const days = dayDiff(dayMs(dd.startDate), dayMs(v.doDate || dd.startDate));
                      return Object.assign({}, dd, { rrule: v.repeat, startDate: addDays(dd.startDate, days), endDate: addDays(dd.endDate, days) });
                    });
                  }, 'event');
                } else if (x !== 'cur') set({ rrule: x });
              }}>
                ${presets.map(x => html`<option value=${x[0]}>${x[1]}</option>`)}
                ${d.rrule && !known && html`<option value="cur">${rrLabel(d.rrule, d.startDate)}</option>`}
                <option value="custom">カスタム…</option>
              </select>
            </div>
            <div class="tabs ce-tabs">
              <button class=${d.tab === 'detail' ? 'on' : ''} onClick=${() => set({ tab: 'detail' })}>予定の詳細</button>
              <button class=${d.tab === 'find' ? 'on' : ''} onClick=${() => set({ tab: 'find' })}>時間を探す</button>
            </div>
            ${d.tab === 'find' ? html`<${FindTime} d=${d} set=${set} />` : html`<div class="ce-fields">
              <div class="ce-field"><${Icon} n="place" /><input class="input" placeholder="場所を追加" value=${d.location} onInput=${e => set({ location: e.target.value })} /></div>
              <div class="ce-field top"><${Icon} n="notifications" /><div class="grow">
                ${d.reminders.map((r, i) => html`<div class="ce-rem" key=${i}>
                  <select class="input" value=${r.method} onChange=${e => setRem(i, { method: e.target.value })}><option value="popup">通知</option><option value="email">メール</option></select>
                  <input class="input num" type="number" min="0" max="40320" value=${r.minutes / unit(r)} onInput=${e => setRem(i, { minutes: Math.max(0, Number(e.target.value) || 0) * unit(r) })} />
                  <select class="input" value=${unit(r)} onChange=${e => setRem(i, { minutes: Math.round(r.minutes / unit(r)) * Number(e.target.value) })}>
                    <option value="1">分前</option><option value="60">時間前</option><option value="1440">日前</option><option value="10080">週間前</option></select>
                  <button class="icon-btn sm" aria-label="通知を削除" onClick=${() => set({ reminders: d.reminders.filter((_, j) => j !== i) })}><${Icon} n="close" /></button>
                </div>`)}
                ${d.reminders.length < 5 && html`<button class="link-btn" onClick=${() => set({ reminders: d.reminders.concat([{ method: 'popup', minutes: d.allDay ? 1440 : 30 }]) })}>通知を追加</button>`}
                ${d.reminders.some(r => r.method === 'email') && html`<div class="cp-sub">メールの通知は、Google カレンダーとの連携後に届くようになります</div>`}
              </div></div>
              <div class="ce-field"><${Icon} n="calendar_month" />
                <select class="input" style="width:auto" value=${d.calendarId} onChange=${e => set({ calendarId: e.target.value })} aria-label="カレンダー">
                  ${cals.map(c => html`<option value=${c.id}>${c.name}</option>`)}</select>
                <span class="ce-colors">
                  <button class=${'sw' + (!d.color ? ' on' : '')} style=${{ background: cal.color || '#039be5' }} title="カレンダーの色" onClick=${() => set({ color: '' })}></button>
                  ${EVENT_COLORS.map(x => html`<button class=${'sw' + (d.color === x[0] ? ' on' : '')} style=${{ background: x[0] }} title=${x[1]} aria-label=${x[1]} onClick=${() => set({ color: x[0] })}></button>`)}
                </span></div>
              <div class="ce-field"><${Icon} n="event" />
                <select class="input" style="width:auto" value=${d.busy ? 'busy' : 'free'} onChange=${e => set({ busy: e.target.value === 'busy' })}><option value="busy">予定あり</option><option value="free">空き時間</option></select>
                <select class="input" style="width:auto" value=${d.visibility} onChange=${e => set({ visibility: e.target.value })}><option value="default">デフォルトの公開設定</option><option value="public">一般公開</option><option value="private">非公開</option></select></div>
              <div class="ce-field top"><${Icon} n="notes" /><textarea class="textarea" rows="6" placeholder="説明を追加" value=${d.description} onInput=${e => set({ description: e.target.value })}></textarea></div>
            </div>`}
          </div>
          <aside class="ce-side">
            <div class="sec-title">ゲスト</div>
            <div class="ce-guest-add">
              <input class="input" placeholder="ゲストを追加（名前）" value=${guest} onInput=${e => setGuest(e.target.value)}
                onKeyDown=${e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && cands[0]) addGuest(cands[0].id); }} />
              ${guest && cands.length > 0 && html`<div class="ce-cands">${cands.slice(0, 8).map(m => html`<button key=${m.id} class="menu-item" onClick=${() => addGuest(m.id)}><${Avatar} id=${m.id} size=${24} />${m.name}</button>`)}</div>`}
            </div>
            ${!guest && html`<div class="ce-quick-guests">${activeMembers().filter(m => !d.attendees.some(a => a.id === m.id)).slice(0, 12).map(m => html`<button key=${m.id} class="chip-btn" onClick=${() => addGuest(m.id)}><${Avatar} id=${m.id} size=${18} />${m.name}</button>`)}</div>`}
            ${d.attendees.length > 0 && html`<div class="cp-sub" style="margin:8px 0">ゲスト ${d.attendees.length}人</div>`}
            ${d.attendees.map(a => html`<div class="ce-guest" key=${a.id}>
              <span class="av-wrap"><${Avatar} id=${a.id} size=${28} />${respIcon(a.response)}</span>
              <div class="grow"><div>${memberName(a.id)}</div><div class="cp-sub">${a.id === owner ? '主催者' : (a.optional ? '任意・' : '') + RESP_LABEL[a.response || 'needsAction']}</div></div>
              ${a.id !== owner && html`<button class="icon-btn sm" title=${a.optional ? '必須にする' : '任意にする'} aria-label="任意の出席" onClick=${() => set({ attendees: d.attendees.map(x => (x.id === a.id ? Object.assign({}, x, { optional: !x.optional }) : x)) })}><${Icon} n="person" /></button>`}
              <button class="icon-btn sm" aria-label="ゲストを外す" onClick=${() => set({ attendees: d.attendees.filter(x => x.id !== a.id) })}><${Icon} n="close" /></button>
            </div>`)}
            <div class="sec-title" style="margin-top:16px">ゲストの権限</div>
            <label class="ce-check"><input type="checkbox" checked=${d.guestsCanModify} onChange=${e => set({ guestsCanModify: e.target.checked })} />予定を変更する</label>
            <label class="ce-check"><input type="checkbox" checked=${d.guestsCanInvite} onChange=${e => set({ guestsCanInvite: e.target.checked })} />他のユーザーを招待する</label>
            <label class="ce-check"><input type="checkbox" checked=${d.guestsCanSee} onChange=${e => set({ guestsCanSee: e.target.checked })} />ゲストリストを表示する</label>
          </aside>
        </div>
      </div>`;
    }

    // 時間を探す: ゲストの予定を並べて、空いている時間を選ぶ
    function FindTime({ d, set }) {
      const cal = calById(d.calendarId) || {};
      const people = [cal.owner].concat(d.attendees.map(a => a.id)).filter((x, i, a) => x && a.indexOf(x) === i);
      const ds = dayMs(d.startDate);
      const scroll = useRef(null);
      useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 8 * 40; }, []);
      const t = draftTimes(d);
      const H = 40;
      const busy = id => instances(ds, ds + DAY, { all: true, noTasks: true, noHolidays: true,
        filter: e => e.id !== d.id && e.busy !== false && (ownerOf(e) === id || (e.attendees || []).some(a => a.id === id && a.response !== 'declined')) }).filter(i => !isSpan(i));
      const pick = (ev) => {
        const r = ev.currentTarget.getBoundingClientRect();
        const m = Math.floor((ev.clientY - r.top) / H * 60 / 30) * 30;
        const len = t.e - t.s;
        const ns = atMinutes(d.startDate, m);
        set({ startTime: pad(hm(ns)), endDate: msYmd(ns + len), endTime: pad(hm(ns + len)), allDay: false });
      };
      return html`<div class="find-time">
        <div class="ft-head"><input class="input" type="date" value=${d.startDate} onInput=${e => { if (e.target.value) set({ startDate: e.target.value, endDate: addDays(e.target.value, dayDiff(dayMs(d.startDate), dayMs(d.endDate))) }); }} />
          <span class="muted">空いている時間を押すと、その時刻にします</span></div>
        <div class="ft-cols" style=${{ '--n': people.length || 1 }}>
          <div class="ft-names"><div></div>${people.map(id => html`<div key=${id} class="ft-name"><${Avatar} id=${id} size=${22} />${memberName(id)}</div>`)}</div>
          <div class="ft-scroll" ref=${scroll}>
            <div class="ft-grid" style=${{ height: 24 * H + 'px' }}>
              <div class="tg-hours">${Array.from({ length: 24 }, (_, h) => html`<div class="tg-hour" style=${{ top: h * H + 'px' }}>${h ? h + ':00' : ''}</div>`)}</div>
              ${people.map(id => html`<div key=${id} class="ft-col" style=${{ '--h': H + 'px' }} onClick=${pick}>
                ${busy(id).map(i => html`<div key=${i.key} class="ft-busy" style=${{ top: (Math.max(i.start, ds) - ds) / MIN / 60 * H + 'px', height: Math.max(12, (Math.min(i.end, ds + DAY) - Math.max(i.start, ds)) / MIN / 60 * H - 2) + 'px' }}>
                  ${i.ev.visibility === 'private' ? '予定あり' : i.title}</div>`)}
                ${!d.allDay && msYmd(t.s) === d.startDate && html`<div class="ft-sel" style=${{ top: minutesOf(t.s) / 60 * H + 'px', height: Math.max(12, (t.e - t.s) / MIN / 60 * H - 2) + 'px' }}></div>`}
              </div>`)}
            </div>
          </div>
        </div>
      </div>`;
    }

    return {
      Sidebar, Main, TopControls, Editor, Settings, overlay, noticeRemote, onKey, tick,
      pops: { calEvent: EventPop, calTask: TaskPop, calHoliday: HolidayPop, calQuick: QuickPop, calDay: DayPop, calCreate: CreatePop, calMenu: CalMenuPop },
      dialogs: { calScope: ScopeDialog, calCalendar: CalendarDialog, calTrash: TrashDialog },
      // 試験用
      _test: { instances, laneLayout, dayLayout, jpHolidays, shiftRule },
    };
  };
})();
