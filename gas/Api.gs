/**
 * 画面から呼ばれる操作（リスト・タスク・最新状況・メンバー）
 */

const TASK_FIELDS = ['listId', 'title', 'details', 'assignee', 'due', 'dueTime', 'repeat', 'starred', 'status', 'sortOrder'];
const HISTORY_FIELDS = { title: 1, assignee: 1, due: 1, dueTime: 1, status: 1, listId: 1, repeat: 1 };
const SORT_MODES = ['my', 'date', 'starred', 'title', 'assignee'];
const STATUSES = ['todo', 'doing', 'done'];

/* ---------- 入力チェック ---------- */

function str_(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max);
}

function checkId_(id) {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(id || ''))) throw new Error('IDが正しくありません');
  return String(id);
}

function checkDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('期限の日付が正しくありません');
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  if (d.getUTCMonth() !== p[1] - 1) throw new Error('期限の日付が正しくありません');
  return s;
}

function checkTime_(s) {
  if (s && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error('期限の時刻が正しくありません');
  return s;
}

function checkRepeat_(s) {
  if (!s) return '';
  if (/^(daily|weekdays|weekly|monthly|yearly)$/.test(s)) return s;
  if (/^every:\d{1,3}:(day|week|month|year)(:[0-6](,[0-6]){0,6})?$/.test(s) && Number(s.split(':')[1]) > 0) return s;
  throw new Error('繰り返しの設定が正しくありません');
}

function checkMember_(ctx, id) {
  const m = ctx.table('members').get(id);
  if (!m) throw new Error('担当者が見つかりません。メンバーに登録してください');
  return id;
}

function activeList_(ctx, id) {
  const l = ctx.table('lists').get(id);
  if (!l || l.deletedAt) throw new Error('リストが見つかりません。画面を読み込み直してください');
  return l;
}

function liveTask_(ctx, id) {
  const t = ctx.table('tasks').get(id);
  if (!t || t.deletedAt) throw new Error('このタスクは削除されています');
  return t;
}

function addHistory_(ctx, taskId, action, field, before, after) {
  ctx.table('history').insert({
    id: newId_(), taskId: taskId, action: action, field: field || '',
    before: before === undefined ? '' : String(before), after: after === undefined ? '' : String(after),
    by: ctx.actor, at: ctx.now,
  });
}

function saveTask_(ctx, task) {
  task.version = (Number(task.version) || 0) + 1;
  task.rev = ctx.rev;
  task.updatedAt = ctx.now;
  task.updatedBy = ctx.actor;
  ctx.table('tasks').update(task);
  ctx.mark('tasks', task);
}

/* ---------- リスト ---------- */

function api_createList(p) {
  return tx_(p.actor, ctx => {
    const id = checkId_(p.id);
    const name = str_(p.name, 100);
    if (!name) throw new Error('リスト名を入れてください');
    const lists = ctx.table('lists');
    if (lists.get(id)) { ctx.mark('lists', lists.get(id)); return; }
    const max = lists.all().reduce((a, l) => Math.max(a, l.sortOrder), 0);
    const list = { id: id, name: name, sortMode: 'my', sortOrder: max + 1, createdAt: ctx.now, createdBy: ctx.actor, updatedAt: ctx.now, updatedBy: ctx.actor, deletedAt: '', rev: ctx.rev };
    lists.insert(list);
    ctx.mark('lists', list);
  });
}

function api_updateList(p) {
  return tx_(p.actor, ctx => {
    const list = activeList_(ctx, p.id);
    const patch = p.patch || {};
    if ('name' in patch) {
      const name = str_(patch.name, 100);
      if (!name) throw new Error('リスト名を入れてください');
      list.name = name;
    }
    if ('sortMode' in patch) {
      if (SORT_MODES.indexOf(patch.sortMode) < 0) throw new Error('並べ替えの指定が正しくありません');
      list.sortMode = patch.sortMode;
    }
    list.updatedAt = ctx.now;
    list.updatedBy = ctx.actor;
    list.rev = ctx.rev;
    ctx.table('lists').update(list);
    ctx.mark('lists', list);
  });
}

function api_deleteList(p) {
  return tx_(p.actor, ctx => {
    const list = activeList_(ctx, p.id);
    const lists = ctx.table('lists');
    if (lists.all().filter(l => !l.deletedAt).length <= 1) throw new Error('リストは最低1つ必要です');
    list.deletedAt = ctx.now;
    list.updatedBy = ctx.actor;
    list.rev = ctx.rev;
    lists.update(list);
    ctx.mark('lists', list);
    ctx.table('tasks').all()
      .filter(t => t.listId === list.id && !t.deletedAt)
      .forEach(t => {
        t.deletedAt = ctx.now;
        t.deletedBy = ctx.actor;
        saveTask_(ctx, t);
      });
  });
}

function api_reorderLists(p) {
  return tx_(p.actor, ctx => {
    const lists = ctx.table('lists');
    (p.ids || []).forEach((id, i) => {
      const l = lists.get(id);
      if (!l || l.deletedAt || l.sortOrder === i + 1) return;
      l.sortOrder = i + 1;
      l.rev = ctx.rev;
      l.updatedAt = ctx.now;
      lists.update(l);
      ctx.mark('lists', l);
    });
  });
}

/* ---------- タスク ---------- */

function api_createTask(p) {
  return tx_(p.actor, ctx => {
    const t = p.task || {};
    const id = checkId_(t.id);
    const tasks = ctx.table('tasks');
    const existing = tasks.get(id);
    if (existing) { ctx.mark('tasks', existing); return; } // 通信のやり直しで2回届いたとき
    const task = buildTask_(ctx, t);
    task.id = id;
    tasks.insert(task);
    ctx.mark('tasks', task);
    addHistory_(ctx, id, 'create', '', '', task.title);
  });
}

function buildTask_(ctx, t) {
  const tasks = ctx.table('tasks');
  let parent = null;
  if (t.parentId) {
    parent = liveTask_(ctx, t.parentId);
    if (parent.parentId) throw new Error('サブタスクの中にはサブタスクを作れません');
  }
  const list = activeList_(ctx, parent ? parent.listId : t.listId);
  const title = str_(t.title, 500);
  if (!title) throw new Error('タスク名（何を）を入れてください');
  const assignee = str_(t.assignee, 64);
  const due = str_(t.due, 10);
  if (!parent) {
    if (!assignee) throw new Error('担当者（誰が）を選んでください');
    if (!due) throw new Error('期限（いつまでに）を選んでください');
  }
  if (assignee) checkMember_(ctx, assignee);
  if (due) checkDate_(due);
  const dueTime = due ? checkTime_(str_(t.dueTime, 5)) : '';
  const starred = t.starred === true;
  return {
    id: '', listId: list.id, parentId: parent ? parent.id : '',
    title: title, details: str_(t.details, 5000), assignee: assignee, due: due, dueTime: dueTime,
    repeat: parent ? '' : checkRepeat_(str_(t.repeat, 40)),
    starred: starred, starredAt: starred ? ctx.now : '', status: 'todo',
    sortOrder: isFinite(Number(t.sortOrder)) ? Number(t.sortOrder) : 0,
    createdAt: ctx.now, createdBy: ctx.actor, updatedAt: ctx.now, updatedBy: ctx.actor,
    completedAt: '', completedBy: '', onTime: '', noteText: '', noteAt: '', noteBy: '',
    nextId: '', deletedAt: '', deletedBy: '', version: 1, rev: ctx.rev,
  };
}

function api_updateTask(p) {
  return tx_(p.actor, ctx => {
    const task = liveTask_(ctx, p.id);
    const before = Object.assign({}, task);
    const patch = p.patch || {};
    const merged = !!p.baseVersion && Number(p.baseVersion) !== task.version;
    // ほかの人の変更と重ねて保存したときは、その人を画面に知らせる
    const mergedBy = merged && before.updatedBy && before.updatedBy !== ctx.actor ? before.updatedBy : '';
    const top = !task.parentId;

    TASK_FIELDS.forEach(k => {
      if (!(k in patch)) return;
      const v = patch[k];
      switch (k) {
        case 'title': {
          const s = str_(v, 500);
          if (!s) throw new Error('タスク名（何を）は空にできません');
          task.title = s;
          break;
        }
        case 'details': task.details = str_(v, 5000); break;
        case 'assignee': {
          const s = str_(v, 64);
          if (!s && top) throw new Error('担当者（誰が）は空にできません');
          if (s) checkMember_(ctx, s);
          task.assignee = s;
          break;
        }
        case 'due': {
          const s = str_(v, 10);
          if (!s && top) throw new Error('期限（いつまでに）は空にできません');
          task.due = s ? checkDate_(s) : '';
          if (!s) task.dueTime = '';
          break;
        }
        case 'dueTime': task.dueTime = task.due ? checkTime_(str_(v, 5)) : ''; break;
        case 'repeat': task.repeat = top ? checkRepeat_(str_(v, 40)) : ''; break;
        case 'starred':
          task.starred = v === true;
          task.starredAt = task.starred ? (before.starred ? before.starredAt : ctx.now) : '';
          break;
        case 'status':
          if (STATUSES.indexOf(v) < 0) throw new Error('ステータスが正しくありません');
          task.status = v;
          break;
        case 'sortOrder':
          if (isFinite(Number(v))) task.sortOrder = Number(v);
          break;
        case 'listId':
          if (top && v !== task.listId) task.listId = activeList_(ctx, v).id;
          break;
      }
    });

    const changedKeys = Object.keys(HISTORY_FIELDS).filter(k => String(before[k]) !== String(task[k]));
    const anyChange = TASK_FIELDS.some(k => String(before[k]) !== String(task[k]));
    if (!anyChange) { ctx.mark('tasks', task); return { merged: merged, mergedBy: mergedBy }; }

    if (before.status !== task.status) applyStatus_(ctx, task, before.status);
    saveTask_(ctx, task);
    changedKeys.forEach(k => addHistory_(ctx, task.id, 'update', k, before[k], task[k]));

    if (top && before.listId !== task.listId) {
      childrenOf_(ctx, task.id).forEach(c => { c.listId = task.listId; saveTask_(ctx, c); });
    }
    return { merged: merged, mergedBy: mergedBy };
  });
}

function childrenOf_(ctx, id) {
  return ctx.table('tasks').all().filter(t => t.parentId === id && !t.deletedAt);
}

/** 完了にしたとき・戻したときの後始末（完了日時・サブタスク・繰り返し） */
function applyStatus_(ctx, task, oldStatus) {
  if (task.status === 'done' && oldStatus !== 'done') {
    task.completedAt = ctx.now;
    task.completedBy = ctx.actor;
    task.onTime = task.due ? Date.now() <= dueAt_(task) : '';
    childrenOf_(ctx, task.id).filter(c => c.status !== 'done').forEach(c => {
      c.status = 'done';
      c.completedAt = ctx.now;
      c.completedBy = ctx.actor;
      saveTask_(ctx, c);
    });
    if (task.repeat && !task.parentId && !task.nextId && task.due) {
      const next = Object.assign({}, task, {
        id: newId_(), due: nextDue_(task.due, task.repeat), status: 'todo',
        createdAt: ctx.now, createdBy: ctx.actor, completedAt: '', completedBy: '', onTime: '',
        noteText: '', noteAt: '', noteBy: '', nextId: '', version: 1, rev: ctx.rev,
        updatedAt: ctx.now, updatedBy: ctx.actor, starredAt: task.starred ? ctx.now : '',
      });
      ctx.table('tasks').insert(next);
      ctx.mark('tasks', next);
      addHistory_(ctx, next.id, 'create', 'repeat', task.id, next.title);
      childrenOf_(ctx, task.id).forEach(c => {
        const sub = Object.assign({}, c, {
          id: newId_(), parentId: next.id, status: 'todo', completedAt: '', completedBy: '', onTime: '',
          createdAt: ctx.now, createdBy: ctx.actor, updatedAt: ctx.now, updatedBy: ctx.actor,
          noteText: '', noteAt: '', noteBy: '', version: 1, rev: ctx.rev,
          due: c.due ? nextDue_(c.due, task.repeat) : '',
        });
        ctx.table('tasks').insert(sub);
        ctx.mark('tasks', sub);
      });
      task.nextId = next.id;
    }
  } else if (task.status !== 'done' && oldStatus === 'done') {
    task.completedAt = '';
    task.completedBy = '';
    task.onTime = '';
  }
}

/** 繰り返しの次の期限 */
function nextDue_(due, repeat) {
  const p = due.split('-').map(Number);
  const y = p[0], m = p[1] - 1, d = p[2];
  const fmt = t => ymdStr_(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  const addMonths = n => {
    const last = new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate();
    return fmt(new Date(Date.UTC(y, m + n, Math.min(d, last))));
  };
  switch (repeat) {
    case 'daily': return addDaysYmd_(due, 1);
    case 'weekdays': {
      let n = addDaysYmd_(due, 1);
      while (dowYmd_(n) === 0 || dowYmd_(n) === 6) n = addDaysYmd_(n, 1);
      return n;
    }
    case 'weekly': return addDaysYmd_(due, 7);
    case 'monthly': return addMonths(1);
    case 'yearly': return addMonths(12);
  }
  const parts = repeat.split(':');
  const every = Number(parts[1]);
  const unit = parts[2];
  if (unit === 'day') return addDaysYmd_(due, every);
  if (unit === 'month') return addMonths(every);
  if (unit === 'year') return addMonths(12 * every);
  // week
  const days = parts[3] ? parts[3].split(',').map(Number) : [];
  if (!days.length) return addDaysYmd_(due, 7 * every);
  const weekNo = ymd => Math.floor((Date.UTC.apply(null, ymd.split('-').map((v, i) => i === 1 ? v - 1 : Number(v))) / 86400000 + 3) / 7);
  const base = weekNo(due);
  for (let i = 1; i <= 7 * every + 7; i++) {
    const n = addDaysYmd_(due, i);
    if (days.indexOf(dowYmd_(n)) >= 0 && (weekNo(n) - base) % every === 0) return n;
  }
  return addDaysYmd_(due, 7 * every);
}

function api_deleteTask(p) {
  return tx_(p.actor, ctx => {
    const task = liveTask_(ctx, p.id);
    task.deletedAt = ctx.now;
    task.deletedBy = ctx.actor;
    saveTask_(ctx, task);
    childrenOf_(ctx, task.id).forEach(c => {
      c.deletedAt = ctx.now;
      c.deletedBy = ctx.actor;
      saveTask_(ctx, c);
    });
    addHistory_(ctx, task.id, 'delete', '', '', '');
  });
}

function api_restoreTask(p) {
  return tx_(p.actor, ctx => {
    const tasks = ctx.table('tasks');
    const task = tasks.get(p.id);
    if (!task) throw new Error('このタスクは見つかりません（30日たって完全に削除された可能性があります）');
    if (!task.deletedAt) { ctx.mark('tasks', task); return; }
    if (task.parentId) {
      const parent = tasks.get(task.parentId);
      if (!parent || parent.deletedAt) throw new Error('親タスクが削除されているため戻せません。先に親タスクを戻してください');
    }
    const deletedAt = task.deletedAt;
    const list = ctx.table('lists').get(task.listId);
    let listId = task.listId;
    if (!list || list.deletedAt) {
      const alive = ctx.table('lists').all().filter(l => !l.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder);
      listId = alive[0].id;
    }
    task.deletedAt = '';
    task.deletedBy = '';
    task.listId = listId;
    saveTask_(ctx, task);
    tasks.all().filter(c => c.parentId === task.id && c.deletedAt === deletedAt).forEach(c => {
      c.deletedAt = '';
      c.deletedBy = '';
      c.listId = listId;
      saveTask_(ctx, c);
    });
    addHistory_(ctx, task.id, 'restore', '', '', '');
  });
}

function api_clearCompleted(p) {
  return tx_(p.actor, ctx => {
    const list = activeList_(ctx, p.listId);
    const all = ctx.table('tasks').all().filter(t => t.listId === list.id && !t.deletedAt);
    const doneTop = {};
    all.forEach(t => { if (!t.parentId && t.status === 'done') doneTop[t.id] = true; });
    all.filter(t => t.status === 'done' || doneTop[t.parentId]).forEach(t => {
      t.deletedAt = ctx.now;
      t.deletedBy = ctx.actor;
      saveTask_(ctx, t);
    });
  });
}

function api_trash() {
  const limit = new Date(Date.now() - 30 * 86400000).toISOString();
  const tasks = new Table('tasks').all();
  const byId = {};
  tasks.forEach(t => { byId[t.id] = t; });
  const lists = {};
  new Table('lists').all().forEach(l => { lists[l.id] = l; });
  const items = tasks.filter(t => {
    if (!t.deletedAt || t.deletedAt < limit) return false;
    if (!t.parentId) return true;
    const parent = byId[t.parentId];
    return parent && !parent.deletedAt;
  }).map(t => ({
    id: t.id, title: t.title, parentTitle: t.parentId ? byId[t.parentId].title : '',
    listName: lists[t.listId] ? lists[t.listId].name : '', listDeleted: !lists[t.listId] || !!lists[t.listId].deletedAt,
    assignee: t.assignee, due: t.due, status: t.status, deletedAt: t.deletedAt, deletedBy: t.deletedBy,
  }));
  items.sort((a, b) => a.deletedAt < b.deletedAt ? 1 : -1);
  return { items: items };
}

/* ---------- 最新状況 ---------- */

function api_addNote(p) {
  return tx_(p.actor, ctx => {
    const task = liveTask_(ctx, p.taskId);
    const text = str_(p.text, 2000);
    if (!text) throw new Error('最新状況を入れてください');
    const id = p.id ? checkId_(p.id) : newId_();
    const notes = ctx.table('notes');
    if (notes.get(id)) { ctx.mark('tasks', task); return; }
    notes.insert({ id: id, taskId: task.id, text: text, by: ctx.actor, at: ctx.now });
    task.noteText = text;
    task.noteAt = ctx.now;
    task.noteBy = ctx.actor;
    if (task.status === 'todo') {
      task.status = 'doing';
      addHistory_(ctx, task.id, 'update', 'status', 'todo', 'doing');
    }
    saveTask_(ctx, task);
  });
}

function api_taskDetail(p) {
  const id = String(p.id || '');
  const notes = new Table('notes').all().filter(n => n.taskId === id);
  const history = new Table('history').all().filter(h => h.taskId === id);
  notes.sort((a, b) => a.at < b.at ? 1 : -1);
  history.sort((a, b) => a.at < b.at ? 1 : -1);
  return { id: id, notes: notes.slice(0, 200), history: history.slice(0, 200) };
}

/* ---------- メンバー ---------- */

function api_saveMember(p) {
  return tx_(p.actor, ctx => {
    const m = p.member || {};
    const id = checkId_(m.id);
    const name = str_(m.name, 50);
    if (!name) throw new Error('名前を入れてください');
    const email = str_(m.email, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('メールアドレスの形が正しくありません');
    const members = ctx.table('members');
    const all = members.all();
    if (all.some(x => x.id !== id && x.active && x.name === name)) throw new Error('同じ名前のメンバーがいます');
    const cur = members.get(id);
    const row = {
      id: id, name: name, email: email, active: m.active !== false,
      sortOrder: cur ? cur.sortOrder : all.reduce((a, x) => Math.max(a, x.sortOrder), 0) + 1,
      createdAt: cur ? cur.createdAt : ctx.now, updatedAt: ctx.now, rev: ctx.rev,
    };
    if (cur) members.update(row); else members.insert(row);
    ctx.mark('members', row);
  });
}
