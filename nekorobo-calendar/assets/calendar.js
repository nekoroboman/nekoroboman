// 年間スケジュールの共通処理（サイト版 index.html と PDF版 print.html で共用）
//
// データは config.js の apiUrl（Google Apps Script の Web API）から取得する。
// 未設定・取得失敗のときは data/ に同梱したデータで表示する。
(() => {
  const MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
  const API_TIMEOUT_MS = 10000;

  const yearOf = (fy, m) => (m >= 4 ? fy : fy + 1);
  const fyLabel = (fy) => `令和${fy - 2018}年度`;
  const currentFiscalYear = (d = new Date()) => (d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1);

  const h = (tag, props = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== '') el.append(c);
    return el;
  };

  // 「2026年度第1回身体拘束・虐待防止委員会」→ { round: '第1回', title: '身体拘束・虐待防止委員会' }
  function committeeLabel(name) {
    const s = String(name).replace(/^\s*(?:20\d{2}|令和\s*\d+)\s*年度\s*/, '');
    const m = s.match(/^(第\s*\d+\s*回)\s*(.+)$/);
    return m ? { round: m[1].replace(/\s+/g, ''), title: m[2] } : { round: '', title: s };
  }

  // 年度単位で、API にある年度は API を、ない年度は同梱データを使う
  function mergeWellbe(api, bundled) {
    const byYear = new Map();
    for (const y of bundled) byYear.set(y.fiscalYear, y);
    for (const y of api) byYear.set(y.fiscalYear, y);
    return [...byYear.values()].sort((a, b) => a.fiscalYear - b.fiscalYear);
  }
  function mergeCommittees(api, bundled) {
    const apiYears = new Set(api.map((c) => c.fiscalYear));
    return [...api, ...bundled.filter((c) => !apiYears.has(c.fiscalYear))];
  }

  async function fetchApi(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.wellbe) || !Array.isArray(json.committees)) throw new Error('想定外の形式です');
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async function load() {
    const url = (window.CALENDAR_CONFIG || {}).apiUrl || '';
    let api = null;
    let apiError = '';
    if (url) {
      try { api = await fetchApi(url); } catch (e) { apiError = e.name === 'AbortError' ? 'タイムアウト' : String(e.message || e); }
    }

    const wellbe = mergeWellbe(api ? api.wellbe : [], window.WELLBE_SCHEDULE || []);
    const committees = mergeCommittees(api ? api.committees : [], window.COMMITTEE_SCHEDULE || []);
    const years = [...new Set([...wellbe.map((y) => y.fiscalYear), ...committees.map((c) => c.fiscalYear)])].sort((a, b) => a - b);
    const pdfs = window.CALENDAR_PDFS || {};

    return {
      years,
      source: api ? 'api' : 'bundled',
      apiConfigured: Boolean(url),
      apiError,
      updatedAt: api && api.generatedAt ? new Date(api.generatedAt) : null,
      // items[0] = 研修項目①（必須研修）、items[1] = 研修項目②。空き枠は null
      wellbeOf(fy, m) {
        const y = wellbe.find((x) => x.fiscalYear === fy);
        const entry = y && y.months.find((x) => x.month === m);
        return entry ? entry.items : [];
      },
      committeesOf(fy, m) {
        return committees.filter((c) => c.fiscalYear === fy && c.month === m).map((c) => committeeLabel(c.name));
      },
      pdfOf: (fy) => pdfs[fy] || '',
    };
  }

  // 「データ：…」の一行
  function sourceText(data) {
    if (data.source === 'api') {
      const t = data.updatedAt;
      const stamp = t ? `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} 時点` : '';
      return `データ：スプレッドシートから取得${stamp ? `（${stamp}）` : ''}`;
    }
    if (data.apiConfigured) return `データ：スプレッドシートに接続できなかったため、同梱データを表示しています（${data.apiError}）`;
    return 'データ：同梱データ（スプレッドシート連携は未設定）';
  }

  window.NekoroboCalendar = { MONTHS, yearOf, fyLabel, currentFiscalYear, h, committeeLabel, load, sourceText };
})();
