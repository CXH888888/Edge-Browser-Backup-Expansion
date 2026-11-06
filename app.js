'use strict';

/* ============================================================
 * 标签与收藏 · 主逻辑
 * 依赖 API：chrome.tabs / chrome.tabGroups / chrome.bookmarks / chrome.storage
 * ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);

const SCHEMA = 'edge-browser-backup';
const LEGACY_SCHEMA = 'edge-tabgroup-backup';   // 1.7.x 及更早的文件仍可导入
const VERSION = 1;

const COLOR_HEX = {
  grey: '#94a3b8', blue: '#3b82f6', red: '#ef4444', yellow: '#eab308',
  green: '#22c55e', pink: '#ec4899', purple: '#a855f7', cyan: '#06b6d4',
  orange: '#f97316'
};

const DEFAULTS = {
  includeUngrouped: true,
  excludeInternal: true,
  restoreVisuals: true,
  discardAfter: false,
  remindDays: 7,
  // 恢复预览里的勾选：单独存一份，重新打开保持上次的选择
  restoreTabs: true,
  restoreMarks: true,
  newWindow: true,
  markMode: 'merge'
};

const state = { backup: null, fileName: '', settings: { ...DEFAULTS }, lastBackupAt: 0 };

/* ---------------- 基础工具 ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pad2(n) { return String(n).padStart(2, '0'); }

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function humanTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '未知时间';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function isInternalUrl(url) {
  return /^(edge|chrome|about|devtools|chrome-extension|extension|view-source|data):/i.test(url || '');
}

function log(msg, type = '') {
  const box = $('#log');
  if (box.dataset.empty === '1') { box.textContent = ''; box.dataset.empty = '0'; }
  const line = document.createElement('div');
  line.className = `log-line ${type}`.trim();
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.appendChild(t);
  line.appendChild(document.createTextNode(msg));
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function browserLabel() {
  const ua = navigator.userAgent;
  const edge = ua.match(/Edg\/(\d+)/);
  if (edge) return `Edge ${edge[1]}`;
  const chrome = ua.match(/Chrome\/(\d+)/);
  if (chrome) return `Chromium ${chrome[1]}`;
  return 'Chromium 内核浏览器';
}

function download(text, filename, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/* ---------------- 设置与备份时效 ---------------- */

async function loadState() {
  try {
    const got = await chrome.storage.local.get({ settings: DEFAULTS, lastBackupAt: 0 });
    state.settings = { ...DEFAULTS, ...(got.settings || {}) };
    state.lastBackupAt = got.lastBackupAt || 0;
  } catch (e) {
    state.settings = { ...DEFAULTS };
  }
  applySettingsToUI();
  renderBackupAge();
}

function applySettingsToUI() {
  const s = state.settings;
  $('#setIncludeUngrouped').checked = !!s.includeUngrouped;
  $('#setExcludeInternal').checked = !!s.excludeInternal;
  $('#setRestoreVisuals').checked = !!s.restoreVisuals;
  $('#setDiscardAfter').checked = !!s.discardAfter;
  $('#setRemindDays').value = s.remindDays;

  // 恢复预览的勾选：默认值也在 DEFAULTS 里，首次打开就是全勾 + 新窗口 + 合并
  const optTabs = $('#optTabs');
  const optMarks = $('#optMarks');
  const optWindow = $('#optNewWindow');
  if (optTabs) optTabs.checked = !!s.restoreTabs;
  if (optMarks) optMarks.checked = !!s.restoreMarks;
  if (optWindow) optWindow.checked = !!s.newWindow;
  const radio = document.querySelector(`input[name="markMode"][value="${s.markMode}"]`);
  if (radio) radio.checked = true;
}

async function saveSettings() {
  const days = parseInt($('#setRemindDays').value, 10);
  const modeEl = document.querySelector('input[name="markMode"]:checked');
  state.settings = {
    includeUngrouped: $('#setIncludeUngrouped').checked,
    excludeInternal: $('#setExcludeInternal').checked,
    restoreVisuals: $('#setRestoreVisuals').checked,
    discardAfter: $('#setDiscardAfter').checked,
    remindDays: Number.isFinite(days) ? Math.min(90, Math.max(1, days)) : DEFAULTS.remindDays,
    restoreTabs: $('#optTabs').checked,
    restoreMarks: $('#optMarks').checked,
    newWindow: $('#optNewWindow').checked,
    markMode: modeEl ? modeEl.value : DEFAULTS.markMode
  };
  $('#setRemindDays').value = state.settings.remindDays;
  renderBackupAge();
  try {
    await chrome.storage.local.set({ settings: state.settings });
  } catch (e) {
    log(`设置保存失败：${e.message}`, 'err');
  }
}

function renderBackupAge() {
  const el = $('#backupAge');
  if (!el) return;
  if (!state.lastBackupAt) {
    el.textContent = '尚未备份';
    el.classList.add('warn');
    return;
  }
  const days = Math.floor((Date.now() - state.lastBackupAt) / 86400000);
  el.textContent = days <= 0 ? '今天已备份' : `${days} 天前备份`;
  el.classList.toggle('warn', days >= (state.settings.remindDays || DEFAULTS.remindDays));
}

async function markBackedUp() {
  state.lastBackupAt = Date.now();
  renderBackupAge();
  try {
    await chrome.storage.local.set({ lastBackupAt: state.lastBackupAt });
  } catch { /* 忽略 */ }
}

/* ---------------- 采集 ---------------- */

async function collectBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0] || { children: [] };
  const serialize = (node) => {
    if (node.url) return { title: node.title || '', url: node.url };
    return {
      id: node.id,
      title: node.title || '',
      children: (node.children || []).map(serialize)
    };
  };
  return (root.children || []).map(serialize);
}

function countUrls(nodes) {
  let n = 0;
  const walk = (list) => list.forEach((x) => {
    if (x.url) n += 1;
    if (x.children) walk(x.children);
  });
  walk(nodes || []);
  return n;
}

async function collectBackup() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const allGroups = await chrome.tabGroups.query({});
  const meta = new Map(allGroups.map((g) => [g.id, g]));
  const selfBase = chrome.runtime.getURL('');
  const s = state.settings;

  const windows = [];
  for (const w of wins) {
    const tabs = [];
    const groups = new Map();

    for (const t of (w.tabs || [])) {
      // 刚打开、尚未提交导航的标签页 url 为空，此时读 pendingUrl，避免漏掉
      const url = t.url || t.pendingUrl || '';
      if (!url) continue;
      if (/^(edge|chrome):\/\/newtab\/?$/i.test(url)) continue;
      if (url.startsWith(selfBase)) continue; // 不把本扩展页面写进备份

      let gkey = null;
      if (typeof t.groupId === 'number' && t.groupId !== -1) {
        const g = meta.get(t.groupId);
        if (g) {
          gkey = `g${g.id}`;
          if (!groups.has(gkey)) {
            groups.set(gkey, {
              key: gkey,
              title: g.title || '',
              color: g.color || 'grey',
              collapsed: !!g.collapsed
            });
          }
        }
      }

      if (!gkey && !s.includeUngrouped) continue;
      if (s.excludeInternal && isInternalUrl(url)) continue;

      tabs.push({ url, title: t.title || '', pinned: !!t.pinned, group: gkey });
    }

    if (!tabs.length) continue;
    windows.push({ focused: !!w.focused, groups: Array.from(groups.values()), tabs });
  }

  const bookmarks = await collectBookmarks();
  const groupTotal = windows.reduce((sum, w) => sum + w.groups.length, 0);
  const tabTotal = windows.reduce((sum, w) => sum + w.tabs.length, 0);

  return {
    schema: SCHEMA,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    browser: browserLabel(),
    platform: navigator.platform || '',
    stats: {
      windows: windows.length,
      groups: groupTotal,
      tabs: tabTotal,
      bookmarkItems: countUrls(bookmarks)
    },
    windows,
    bookmarks
  };
}

/* ---------------- 界面统计 ---------------- */

async function refreshStats() {
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const groups = await chrome.tabGroups.query({});
    let tabs = 0;
    for (const w of wins) tabs += (w.tabs || []).length;

    $('#statWindows').textContent = wins.length;
    $('#statGroups').textContent = groups.length;
    $('#statTabs').textContent = tabs;

    const tree = await chrome.bookmarks.getTree();
    const root = tree[0] || { children: [] };
    let marks = 0;
    const walk = (list) => list.forEach((x) => { if (x.url) marks += 1; if (x.children) walk(x.children); });
    walk(root.children || []);
    $('#statMarks').textContent = marks;

    renderChips($('#groupPreview'), groups);
  } catch (e) {
    log(`读取浏览器数据失败：${e.message}`, 'err');
  }
}

function renderChips(box, groups, limit = 24) {
  if (!box) return;
  box.textContent = '';
  if (!groups.length) return;
  groups.slice(0, limit).forEach((g) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const dot = document.createElement('i');
    dot.style.background = COLOR_HEX[g.color] || COLOR_HEX.grey;
    const name = document.createElement('span');
    name.textContent = g.title || '未命名组';
    chip.append(dot, name);
    box.appendChild(chip);
  });
  if (groups.length > limit) {
    const more = document.createElement('span');
    more.className = 'chip';
    more.textContent = `+${groups.length - limit}`;
    box.appendChild(more);
  }
}

/* ---------------- 导出 ---------------- */

async function exportJson() {
  const data = await collectBackup();
  download(JSON.stringify(data, null, 2), `edge-backup-${stamp()}.json`, 'application/json');
  await markBackedUp();
  log(`已导出完整备份：${data.stats.windows} 个窗口 / ${data.stats.groups} 个组 / ${data.stats.tabs} 个标签 / ${data.stats.bookmarkItems} 条收藏`, 'ok');
}

function bookmarksToHtml(roots) {
  const out = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ];
  const walk = (nodes, depth) => {
    const pad = '    '.repeat(depth);
    for (const n of nodes) {
      if (n.url) {
        out.push(`${pad}<DT><A HREF="${escHtml(n.url)}">${escHtml(n.title || n.url)}</A>`);
      } else {
        out.push(`${pad}<DT><H3>${escHtml(n.title || '')}</H3>`);
        out.push(`${pad}<DL><p>`);
        walk(n.children || [], depth + 1);
        out.push(`${pad}</DL><p>`);
      }
    }
  };
  walk(roots, 1);
  out.push('</DL><p>');
  return out.join('\n');
}

async function exportHtml() {
  const roots = await collectBookmarks();
  download(bookmarksToHtml(roots), `edge-bookmarks-${stamp()}.html`, 'text/html');
  log('已导出收藏夹 HTML（可直接被 Edge / Chrome / Safari 导入）', 'ok');
}

function bookmarksToMarkdown(roots) {
  const lines = ['# 收藏夹结构', ''];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const pad = '  '.repeat(depth);
      if (n.url) lines.push(`${pad}- [${n.title || n.url}](${n.url})`);
      else {
        lines.push(`${pad}- **${n.title || '未命名文件夹'}**`);
        walk(n.children || [], depth + 1);
      }
    }
  };
  walk(roots, 0);
  return lines.join('\n');
}

async function exportMarkdown() {  const data = await collectBackup();
  const lines = [
    '# 标签页组备份清单',
    '',
    `- 导出时间：${humanTime(data.exportedAt)}`,
    `- 浏览器：${data.browser}`,
    `- 合计：${data.stats.windows} 个窗口 / ${data.stats.groups} 个组 / ${data.stats.tabs} 个标签`,
    ''
  ];

  data.windows.forEach((w, wi) => {
    lines.push(`## 窗口 ${wi + 1}（${w.tabs.length} 个标签）`, '');
    for (const g of w.groups) {
      const members = w.tabs.filter((t) => t.group === g.key);
      if (!members.length) continue;
      lines.push(`### ${g.title || '未命名组'} · ${g.color}${g.collapsed ? ' · 已折叠' : ''}（${members.length}）`, '');
      for (const t of members) lines.push(`- [${t.title || t.url}](${t.url})`);
      lines.push('');
    }
    const loose = w.tabs.filter((t) => !t.group);
    if (loose.length) {
      lines.push('### 未分组', '');
      for (const t of loose) lines.push(`- ${t.pinned ? '📌 ' : ''}[${t.title || t.url}](${t.url})`);
      lines.push('');
    }
  });

  lines.push('---', '', bookmarksToMarkdown(data.bookmarks));
  download(lines.join('\n'), `edge-backup-${stamp()}.md`, 'text/markdown');
  log('已导出可读清单（Markdown）', 'ok');
}

/* ---------------- 存入备份文件夹（与扩展页签共用同一目录） ---------------- */

async function saveBackupToFolder() {
  const store = window.ExtStore;
  if (!store || typeof store.ready !== 'function' || !store.ready()) {
    log('还没授权插件目录：到「备份管理」页签，点一次「授权插件目录」', 'err');
    if (typeof switchView === 'function') switchView('backup', true);
    return;
  }
  const data = await collectBackup();
  // 带秒，避免同一分钟内连点两次互相覆盖
  const d = new Date();
  const filename = `edge-backup-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.json`;
  const where = await store.writeText(JSON.stringify(data, null, 2), filename);
  await markBackedUp();
  log(`已备份到插件目录：${where}`, 'ok');
}

/* ---------------- 导入：预览 ---------------- */

function renderPreview(data, fileName) {
  const card = $('#restoreCard');
  card.hidden = false;

  $('#previewStamp').textContent = `导出于 ${humanTime(data.exportedAt)}`;

  const stats = data.stats || {};
  const winCount = stats.windows ?? (data.windows || []).length;
  const groupCount = stats.groups ?? (data.windows || []).reduce((n, w) => n + (w.groups || []).length, 0);
  const tabCount = stats.tabs ?? (data.windows || []).reduce((n, w) => n + (w.tabs || []).length, 0);
  const markCount = countUrls(data.bookmarks || []);

  $('#previewMeta').textContent =
    `${fileName} · ${data.browser || '未知浏览器'} · ${winCount} 窗口 / ${groupCount} 组 / ${tabCount} 标签 / ${markCount} 条收藏`;

  const groups = (data.windows || []).flatMap((w) => w.groups || []);
  renderChips($('#previewGroups'), groups, 16);

  // 明细：窗口构成 / 标签构成
  const allTabs = (data.windows || []).flatMap((w) => w.tabs || []);
  const ungrouped = allTabs.filter((t) => !t.group).length;
  const pinned = allTabs.filter((t) => t.pinned).length;
  const internal = allTabs.filter((t) => isInternalUrl(t.url)).length;

  const detail = $('#previewDetail');
  detail.textContent = '';
  const lines = [];
  if ((data.windows || []).length > 1) {
    lines.push('窗口构成：' + data.windows.map((w, i) =>
      `窗口 ${i + 1} · ${(w.groups || []).length} 组 / ${(w.tabs || []).length} 标签`).join('；'));
  }
  const parts = [];
  if (ungrouped) parts.push(`未分组 ${ungrouped} 个`);
  if (pinned) parts.push(`固定 ${pinned} 个`);
  if (internal) parts.push(`内部页面 ${internal} 个（还原时跳过）`);
  lines.push(`标签构成：${parts.length ? parts.join(' · ') : '全部已分组'}`);
  lines.forEach((text) => {
    const div = document.createElement('div');
    div.textContent = text;
    detail.appendChild(div);
  });

  const roots = (data.bookmarks || []).map((r) => r.title).filter(Boolean);
  $('#previewBookmarks').textContent = roots.length
    ? `收藏夹根目录：${roots.join(' / ')}`
    : '备份中不含收藏夹';

  $('#fileName').textContent = fileName;
  $('#btnImport').disabled = false;
}

function resetPreview() {
  state.backup = null;
  state.fileName = '';
  $('#restoreCard').hidden = true;
  $('#previewMeta').textContent = '';
  $('#previewGroups').textContent = '';
  $('#previewDetail').textContent = '';
  $('#previewBookmarks').textContent = '';
  $('#previewStamp').textContent = '';
  $('#fileName').textContent = '尚未选择文件';
  $('#btnImport').disabled = true;
  const input = $('#fileInput');
  if (input) input.value = '';
}

async function handleFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('文件不是合法 JSON，请确认选的是 .json 备份');
    }
    if (!data || (data.schema !== SCHEMA && data.schema !== LEGACY_SCHEMA)) {
      throw new Error('这不是本扩展导出的备份文件');
    }
    if (!Array.isArray(data.windows) && !Array.isArray(data.bookmarks)) throw new Error('备份内容为空或格式不完整');

    state.backup = data;
    state.fileName = file.name;
    renderPreview(data, file.name);
    log(`已载入备份：${file.name}`, 'ok');
  } catch (e) {
    resetPreview();
    log(`读取失败：${e.message}`, 'err');
  }
}

/* ---------------- 导入：还原标签组 ---------------- */

function isRestorableUrl(url) {
  if (!url) return false;
  return !isInternalUrl(url);
}

async function restoreTabs(backup, useNewWindow) {
  const targets = (backup.windows || []).filter((w) => Array.isArray(w.tabs) && w.tabs.length);
  const s = state.settings;
  let winCount = 0, tabCount = 0, groupCount = 0, skipped = 0, discarded = 0;

  for (let wi = 0; wi < targets.length; wi++) {
    const w = targets[wi];
    const usable = w.tabs.filter((t) => isRestorableUrl(t.url));
    skipped += w.tabs.length - usable.length;
    if (!usable.length) continue;

    const metaByKey = new Map((w.groups || []).map((g) => [g.key, g]));

    let windowId;
    let firstId;
    if (useNewWindow) {
      const created = await chrome.windows.create({ url: usable[0].url, focused: false });
      windowId = created.id;
      firstId = created.tabs[0].id;
    } else {
      const cur = await chrome.windows.getCurrent();
      windowId = cur.id;
      const t = await chrome.tabs.create({ windowId, url: usable[0].url, active: false });
      firstId = t.id;
    }
    if (usable[0].pinned) {
      try { await chrome.tabs.update(firstId, { pinned: true }); } catch { /* 忽略 */ }
    }

    const ids = [firstId];
    tabCount += 1;

    for (let i = 1; i < usable.length; i++) {
      try {
        const t = await chrome.tabs.create({
          windowId,
          url: usable[i].url,
          active: false,
          pinned: !!usable[i].pinned
        });
        ids.push(t.id);
        tabCount += 1;
      } catch (e) {
        ids.push(null);
        skipped += 1;
      }
      if (i % 10 === 0) await sleep(50);
    }

    // 按连续区间还原分组
    const runs = [];
    let run = null;
    usable.forEach((t, i) => {
      const key = t.pinned ? null : t.group;
      const id = ids[i];
      if (!key || id == null) { run = null; return; }
      if (run && run.key === key) run.ids.push(id);
      else { run = { key, ids: [id] }; runs.push(run); }
    });

    for (const r of runs) {
      if (!r.ids.length) continue;
      try {
        const gid = await chrome.tabs.group({ tabIds: r.ids, createProperties: { windowId } });
        const g = metaByKey.get(r.key) || {};
        await chrome.tabGroups.update(gid, {
          title: g.title || '',
          color: s.restoreVisuals ? (g.color || 'grey') : 'grey',
          collapsed: s.restoreVisuals ? !!g.collapsed : false
        });
        groupCount += 1;
      } catch (e) {
        log(`组「${metaByKey.get(r.key)?.title || '未命名'}」还原失败：${e.message}`, 'err');
      }
    }

    if (s.discardAfter) {
      await sleep(600);
      for (const id of ids) {
        if (id == null) continue;
        try { await chrome.tabs.discard(id); discarded += 1; } catch { /* 加载中的标签无法休眠 */ }
      }
    }

    winCount += 1;
    if (wi % 3 === 2) await sleep(60);
  }

  if (skipped) log(`跳过 ${skipped} 个无法由扩展打开的页面（edge:// 等内部页面）`, '');
  if (discarded) log(`已让 ${discarded} 个标签进入休眠，点击时才加载`, '');
  return { winCount, tabCount, groupCount };
}

/* ---------------- 导入：还原收藏夹 ---------------- */

async function restoreBookmarks(backup, mode) {
  const roots = Array.isArray(backup.bookmarks) ? backup.bookmarks : [];
  if (!roots.length) return { added: 0, skipped: 0 };

  const tree = await chrome.bookmarks.getTree();
  const rootNode = tree[0] || { children: [] };
  const currentRoots = new Map((rootNode.children || []).map((n) => [n.id, n]));
  const currentByTitle = new Map((rootNode.children || []).map((n) => [n.title, n]));

  const urlIndex = new Map();    // parentId -> Set(url)
  const folderIndex = new Map(); // parentId -> Map(title -> id)

  async function urlsIn(parentId) {
    if (!urlIndex.has(parentId)) {
      const kids = await chrome.bookmarks.getChildren(parentId);
      urlIndex.set(parentId, new Set(kids.filter((k) => k.url).map((k) => k.url)));
    }
    return urlIndex.get(parentId);
  }

  async function foldersIn(parentId) {
    if (!folderIndex.has(parentId)) {
      const kids = await chrome.bookmarks.getChildren(parentId);
      const map = new Map();
      kids.filter((k) => !k.url).forEach((k) => { if (!map.has(k.title)) map.set(k.title, k.id); });
      folderIndex.set(parentId, map);
    }
    return folderIndex.get(parentId);
  }

  async function ensureFolder(parentId, title) {
    const map = await foldersIn(parentId);
    if (map.has(title)) return map.get(title);
    const created = await chrome.bookmarks.create({ parentId, title });
    map.set(title, created.id);
    return created.id;
  }

  let added = 0, skipped = 0;

  async function addNodes(parentId, nodes) {
    const seen = await urlsIn(parentId);
    for (const n of nodes || []) {
      if (n.url) {
        if (seen.has(n.url)) { skipped += 1; continue; }
        try {
          await chrome.bookmarks.create({ parentId, title: n.title || n.url, url: n.url });
          seen.add(n.url);
          added += 1;
        } catch {
          skipped += 1;
        }
      } else {
        const fid = await ensureFolder(parentId, n.title || '未命名文件夹');
        await addNodes(fid, n.children || []);
      }
    }
  }

  let container = null;
  if (mode === 'folder') {
    const host = currentRoots.get('2') || currentByTitle.get('其他收藏夹') || currentByTitle.get('其他书签')
      || (rootNode.children || [])[0];
    if (!host) throw new Error('找不到可写入的收藏夹根目录');
    container = await chrome.bookmarks.create({ parentId: host.id, title: `导入备份 ${stamp()}` });
  }

  for (const r of roots) {
    const children = r.children || [];
    if (!children.length) continue;

    let targetId;
    if (mode === 'folder') {
      targetId = await ensureFolder(container.id, r.title || '收藏夹');
    } else {
      const cur = currentRoots.get(r.id) || currentByTitle.get(r.title);
      if (cur) targetId = cur.id;
      else {
        const fallback = currentRoots.get('2') || (rootNode.children || [])[0];
        targetId = (await chrome.bookmarks.create({ parentId: fallback.id, title: r.title || '导入' })).id;
      }
    }
    await addNodes(targetId, children);
  }

  return { added, skipped };
}

/* ---------------- 导入：执行 ---------------- */

function setBusy(busy) {
  ['#btnExportJson', '#btnExportHtml', '#btnExportMd', '#btnSaveToFolder', '#btnRefresh', '#btnImport', '#btnClearFile'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    if (sel === '#btnImport') el.disabled = busy || !state.backup;
    else el.disabled = busy;
  });
}

async function doImport() {
  const b = state.backup;
  if (!b) return;

  const wantTabs = $('#optTabs').checked;
  const wantMarks = $('#optMarks').checked;
  const newWindow = $('#optNewWindow').checked;
  const mode = ($('input[name="markMode"]:checked') || {}).value || 'merge';

  if (!wantTabs && !wantMarks) {
    log('请至少勾选「还原标签组」或「还原收藏夹」', 'err');
    return;
  }

  setBusy(true);
  log('开始还原…', '');
  try {
    if (wantTabs) {
      const r = await restoreTabs(b, newWindow);
      log(`标签组还原完成：${r.winCount} 个窗口 / ${r.groupCount} 个组 / ${r.tabCount} 个标签`, 'ok');
    }
    if (wantMarks) {
      const r = await restoreBookmarks(b, mode);
      log(`收藏夹还原完成：新增 ${r.added} 条，跳过 ${r.skipped} 条（已存在）`, 'ok');
    }
    log('全部完成。若新窗口在后台，按 Alt/Cmd+Tab 切换查看。', 'ok');
  } catch (e) {
    log(`还原中断：${e.message}`, 'err');
  } finally {
    setBusy(false);
    refreshStats();
  }
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  $('#browserInfo').textContent = browserLabel();

  $('#btnRefresh').addEventListener('click', refreshStats);

  $('#btnExportJson').addEventListener('click', async () => {
    try { await exportJson(); refreshStats(); } catch (e) { log(`导出失败：${e.message}`, 'err'); }
  });
  $('#btnExportHtml').addEventListener('click', () => exportHtml().catch((e) => log(`导出失败：${e.message}`, 'err')));
  $('#btnExportMd').addEventListener('click', () => exportMarkdown().catch((e) => log(`导出失败：${e.message}`, 'err')));
  $('#btnSaveToFolder').addEventListener('click', () => {
    saveBackupToFolder().catch((e) => log(`备份失败：${e.message}`, 'err'));
  });

  $('#btnImport').addEventListener('click', doImport);
  $('#btnClearFile').addEventListener('click', () => {
    resetPreview();
    log('已移除载入的备份文件', '');
  });

  const input = $('#fileInput');
  const drop = $('#drop');

  input.addEventListener('change', () => handleFile(input.files && input.files[0]));

  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  ['#setIncludeUngrouped', '#setExcludeInternal', '#setRestoreVisuals', '#setDiscardAfter'].forEach((sel) => {
    $(sel).addEventListener('change', saveSettings);
  });
  $('#setRemindDays').addEventListener('change', saveSettings);

  // 恢复预览的勾选也要记住，下次打开保持上次状态
  ['#optTabs', '#optMarks', '#optNewWindow'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('change', saveSettings);
  });
  document.querySelectorAll('input[name="markMode"]').forEach((el) => {
    el.addEventListener('change', saveSettings);
  });

  $('#btnClearLog').addEventListener('click', () => {
    const box = $('#log');
    box.textContent = '';
    box.dataset.empty = '1';
  });
}

bind();
$('#log').dataset.empty = '1';
$('#log').textContent = '';
log('就绪', '');
loadState().then(refreshStats);

// 预取扩展页签状态，让「备份文件夹」这一行在打开时就显示真实位置
window.addEventListener('load', () => {
  if (typeof initExtModule === 'function') {
    initExtModule().catch((e) => console.warn('扩展页签初始化失败', e));
  }
});
