'use strict';

/* ============================================================
 * 「扩展」页签：只读盘点
 * 「备份管理」页签：备份位置 / 备份列表 / 删除
 *
 * 备份写在插件目录里，拷走整个插件文件夹 = 带走全部备份：
 *   <插件目录>/backups/扩展源码/<扩展名>-<ID前8位>/
 *   <插件目录>/backups/完整备份/edge-backup-*.json   （标签组 + 收藏夹）
 *   <插件目录>/backups/位置.txt      脚本写入，记录绝对路径
 * ============================================================ */

const INSTALL_TYPE = {
  normal: { label: '商店', cls: '' },
  development: { label: '本地', cls: 'local' },
  sideload: { label: '外部', cls: '' },
  admin: { label: '策略', cls: '' },
  other: { label: '其他', cls: '' }
};

const BACKUP_ROOT = 'backups';
const DIR_EXT = '扩展源码';
const DIR_FULL = '完整备份';
const LEGACY_DIR_FULL = '标签组备份';   // 1.7.1 及更早的目录名
const TRASH_DIR = '.回收站';

const extState = {
  list: [],
  picked: new Set(),
  base: null,         // 插件目录句柄（含 manifest.json）
  dst: null,          // 备份根目录 = base/backups
  dstReady: false,
  pluginPath: '',
  backups: [],
  tabFiles: [],
  trash: [],
  ready: false
};

/* ---------------- IndexedDB：持久化目录句柄 ---------------- */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tabgroup-backup-fs', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const req = db.transaction('handles', 'readonly').objectStore('handles').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbSet(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch { /* 忽略 */ }
}

/* ---------------- 工具 ---------------- */

function extHuman(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function extTime(ms) {
  const d = ms ? new Date(ms) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setStatus(text, kind = '') {
  const el = document.getElementById('extSummary');
  if (!el) return;
  el.textContent = text;
  el.title = kind === 'err' ? text : '';
  el.style.color = kind === 'err' ? 'var(--danger)' : kind === 'ok' ? 'var(--ok)' : '';
}

function setBackupStatus(text, kind = '') {
  const el = document.getElementById('backupStatus');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  el.title = kind === 'err' ? text : '';
  el.style.color = kind === 'err' ? 'var(--danger)' : kind === 'ok' ? 'var(--ok)' : '';
}

function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'note';
  p.style.margin = '0';
  p.textContent = text;
  return p;
}

/* ---------------- 勾选记忆 ---------------- */

async function loadPicked() {
  try {
    const got = await chrome.storage.local.get({ extPicked: [] });
    extState.picked = new Set(Array.isArray(got.extPicked) ? got.extPicked : []);
  } catch {
    extState.picked = new Set();
  }
}

async function savePicked() {
  try {
    await chrome.storage.local.set({ extPicked: Array.from(extState.picked) });
  } catch { /* 忽略 */ }
}

/* ---------------- 盘点 ---------------- */

async function loadExtensions() {
  try {
    const all = await chrome.management.getAll();
    extState.list = all
      .filter((e) => e.type === 'extension')
      .map((e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        enabled: e.enabled,
        installType: e.installType || 'other',
        icons: Array.isArray(e.icons) ? e.icons : []
      }))
      .sort((a, b) => {
        const rank = (x) => (x.installType === 'development' ? 0 : x.installType === 'normal' ? 1 : 2);
        const d = rank(a) - rank(b);
        return d !== 0 ? d : a.name.localeCompare(b.name, 'zh');
      });

    const alive = new Set(extState.list.map((e) => e.id));
    const before = extState.picked.size;
    extState.picked = new Set(Array.from(extState.picked).filter((id) => alive.has(id)));
    if (extState.picked.size !== before) savePicked();

    renderExtTable();
    const local = extState.list.filter((e) => e.installType === 'development').length;
    setStatus(`共 ${extState.list.length} 个 · 本地 ${local} 个`);
  } catch (e) {
    setStatus(`读取失败：${e.message}（可能缺少 management 权限）`, 'err');
  }
}

function pickIconUrl(icons) {
  if (!Array.isArray(icons) || !icons.length) return '';
  const sorted = icons.slice().sort((a, b) => (b.size || 0) - (a.size || 0));
  return (sorted[0] && sorted[0].url) || '';
}

function iconHue(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function makeIcon(item, small) {
  const wrap = document.createElement('span');
  wrap.className = small ? 'ext-icon sm' : 'ext-icon';

  const letter = document.createElement('i');
  letter.textContent = (item.name || '?').trim().charAt(0).toUpperCase();
  letter.style.background = `hsl(${iconHue(item.id)} 34% 34%)`;
  wrap.appendChild(letter);

  const url = pickIconUrl(item.icons);
  if (url) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = url;
    // 跨扩展图标可能被浏览器拦下，失败就保留字母块
    img.addEventListener('error', () => img.remove());
    img.addEventListener('load', () => { letter.style.display = 'none'; });
    wrap.appendChild(img);
  }
  return wrap;
}

function renderExtTable() {
  const tbody = document.getElementById('extTbody');
  const frag = document.createDocumentFragment();

  if (!extState.list.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'meta';
    td.textContent = '没有读到扩展。';
    tr.appendChild(td);
    frag.appendChild(tr);
    tbody.replaceChildren(frag);
    updateExtToolbar();
    return;
  }

  for (const item of extState.list) {
    const tr = document.createElement('tr');

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = extState.picked.has(item.id);
    box.addEventListener('change', () => {
      if (box.checked) extState.picked.add(item.id);
      else extState.picked.delete(item.id);
      savePicked();
      updateExtToolbar();
    });
    tdCheck.appendChild(box);

    const tdIcon = document.createElement('td');
    tdIcon.className = 'col-icon';
    tdIcon.appendChild(makeIcon(item));

    const tdName = document.createElement('td');
    tdName.className = 'cell-name';
    const nameLine = document.createElement('span');
    nameLine.className = 'name-line';
    nameLine.textContent = item.name;
    const idLine = document.createElement('small');
    idLine.className = 'id-line';
    idLine.textContent = item.id.slice(0, 16) + '…';
    idLine.title = item.id;
    tdName.append(nameLine, idLine);

    const tdVer = document.createElement('td');
    tdVer.className = 'col-ver';
    tdVer.textContent = item.version;

    const tdType = document.createElement('td');
    tdType.className = 'col-type';
    const badge = document.createElement('span');
    const meta = INSTALL_TYPE[item.installType] || INSTALL_TYPE.other;
    badge.className = `badge ${meta.cls}`.trim();
    badge.textContent = meta.label;
    tdType.appendChild(badge);

    const tdState = document.createElement('td');
    tdState.className = 'col-state';
    if (item.enabled) {
      tdState.textContent = '启用';
    } else {
      const off = document.createElement('span');
      off.className = 'badge off';
      off.textContent = '停用';
      tdState.appendChild(off);
    }

    tr.append(tdCheck, tdIcon, tdName, tdVer, tdType, tdState);
    frag.appendChild(tr);
  }

  tbody.replaceChildren(frag);
  updateExtToolbar();
}

function updateExtToolbar() {
  const picked = document.getElementById('extPicked');
  if (picked) picked.textContent = `已选 ${extState.picked.size} 个`;
  const all = document.getElementById('extSelectAll');
  if (all) all.checked = extState.list.length > 0 && extState.picked.size === extState.list.length;
}

/* ---------------- 权限与位置 ---------------- */

async function ensurePermission(handle, mode, interactive) {
  if (!handle) return false;
  const opts = { mode };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!interactive) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}

function renderLocation() {
  const ready = !!(extState.base && extState.dstReady);
  const abs = extState.pluginPath;

  const pill = document.getElementById('locationPill');
  if (pill) {
    pill.textContent = ready ? '已授权' : '未授权';
    pill.classList.toggle('ok', ready);
    pill.classList.toggle('warn', !ready);
  }

  const btn = document.getElementById('btnPickDst');
  if (btn) btn.textContent = ready ? '更换插件目录' : '授权插件目录';

  const retry = document.getElementById('btnRetryDst');
  if (retry) retry.hidden = !(extState.base && !extState.dstReady);

  const pathRow = document.getElementById('dstPath');
  if (pathRow) {
    if (!extState.base) {
      pathRow.textContent = '未授权';
      pathRow.classList.remove('ok', 'warn');
    } else {
      pathRow.textContent = extState.dstReady
        ? `${extState.base.name} / ${BACKUP_ROOT}`
        : `${extState.base.name}（需要恢复授权）`;
      pathRow.classList.toggle('ok', extState.dstReady);
      pathRow.classList.toggle('warn', !extState.dstReady);
    }
  }

  const pathHint = document.getElementById('pathHint');
  if (pathHint) {
    pathHint.textContent = abs ? `插件目录：${abs}` : '';
    pathHint.hidden = !abs;
  }

  const destHint = document.getElementById('destHint');
  if (destHint) {
    destHint.textContent = ready
      ? `备份位置：${abs ? `${abs}/${BACKUP_ROOT}/${DIR_FULL}/` : `插件目录 / ${BACKUP_ROOT}/${DIR_FULL}/`}`
      : '备份位置：未授权（去「备份管理」授权插件目录）';
  }

  const where = document.getElementById('backupWhere');
  if (where) {
    where.textContent = ready
      ? `${abs || `插件目录「${extState.base.name}」`} / ${BACKUP_ROOT}/`
      : '';
    where.hidden = !ready;
  }
}

async function pickDest() {
  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite',
      id: 'edge-ext-base',
      startIn: 'downloads'
    });
    const granted = await ensurePermission(handle, 'readwrite', true);
    if (!granted) {
      setBackupStatus('没有拿到写入权限，备份无法进行', 'err');
      return;
    }

    // 认一下是不是插件自己的目录：里面有 manifest.json 就对上了
    let isPlugin = false;
    try {
      await handle.getFileHandle('manifest.json');
      isPlugin = true;
    } catch { /* 不是插件目录，下面再确认 */ }

    if (!isPlugin) {
      const alsoOk = window.confirm(
        '这个目录里没有 manifest.json，看起来不是插件文件夹。\n\n'
        + `备份会写在它下面的 ${BACKUP_ROOT}/ 里。仍要用这个目录吗？`
      );
      if (!alsoOk) return;
    }

    extState.base = handle;
    await idbSet('base', handle);

    try {
      extState.dst = await handle.getDirectoryHandle(BACKUP_ROOT, { create: true });
      extState.dstReady = true;
    } catch (e) {
      extState.dst = null;
      extState.dstReady = false;
      renderLocation();
      setBackupStatus(`这个文件夹不可写（${e.message}）：请把插件移到可写位置，或换一个目录`, 'err');
      return;
    }

    await ensureStructure();
    renderLocation();
    await loadBackups();
    setBackupStatus(isPlugin
      ? `已授权：${handle.name}，备份在 ${BACKUP_ROOT}/`
      : `已授权：${handle.name}（其中没有 manifest.json）`, 'ok');
  } catch (e) {
    if (e.name !== 'AbortError') setBackupStatus(`选择失败：${e.message}`, 'err');
  }
}

async function retryPermission() {
  if (!extState.base) return;
  const granted = await ensurePermission(extState.base, 'readwrite', true);
  if (!granted) {
    setBackupStatus('授权被拒绝，可以重新选择目录', 'err');
    return;
  }
  try {
    extState.dst = await extState.base.getDirectoryHandle(BACKUP_ROOT, { create: true });
    extState.dstReady = true;
    await ensureStructure();
    await loadBackups();
    renderLocation();
    setBackupStatus('授权已恢复', 'ok');
  } catch (e) {
    setBackupStatus(`目录不可写：${e.message}`, 'err');
  }
}

async function ensureStructure() {
  if (!extState.dst || !extState.dstReady) return;
  await extState.dst.getDirectoryHandle(DIR_EXT, { create: true });
  await extState.dst.getDirectoryHandle(DIR_FULL, { create: true });
}

/* ---------------- 扫描磁盘 ---------------- */

async function readManifestMeta(dir) {
  try {
    const fh = await dir.getFileHandle('manifest.json');
    const file = await fh.getFile();
    const data = JSON.parse(await file.text());
    let name = typeof data.name === 'string' ? data.name : '';
    if (name.startsWith('__MSG_') && name.endsWith('__')) name = name.slice(6, -2);
    return { name, version: data.version || '', mtime: file.lastModified };
  } catch {
    return null;
  }
}

async function listBackupFolders() {
  if (!extState.dst || !extState.dstReady) return [];
  try {
    const dir = await extState.dst.getDirectoryHandle(DIR_EXT);
    const out = [];
    for await (const [folder, handle] of dir.entries()) {
      if (handle.kind !== 'directory') continue;
      if (folder.startsWith('.')) continue;
      const meta = await readManifestMeta(handle);
      out.push({
        path: `${DIR_EXT}/${folder}`,
        folder,
        name: (meta && meta.name) || folder,
        version: (meta && meta.version) || '',
        mtime: meta ? meta.mtime : 0,
        backedAt: meta ? extTime(meta.mtime) : ''
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function listTabFiles() {
  if (!extState.dst || !extState.dstReady) return [];
  try {
    const dir = await extState.dst.getDirectoryHandle(DIR_FULL);
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      if (!/\.json$/i.test(name)) continue;
      const f = await handle.getFile();
      out.push({ name, size: f.size, mtime: f.lastModified });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/* 脚本会把插件目录的绝对路径写进 backups/位置.txt，浏览器自己拿不到 */
async function readPluginPath() {
  if (!extState.dst || !extState.dstReady) return '';
  try {
    const fh = await extState.dst.getFileHandle('位置.txt');
    const text = await (await fh.getFile()).text();
    return (text.split('\n')[0] || '').trim();
  } catch {
    return '';
  }
}

/* ---------------- 备份列表 ---------------- */

const OPEN_KEY = 'backupOpen';
const SIZE_CACHE_KEY = 'sizeCache';

let openState = { ext: false, full: false };
let sizeCache = {};
let sizeCacheDirty = false;

async function loadOpenState() {
  try {
    const got = await chrome.storage.local.get({
      backupOpen: { ext: false, full: false },
      sizeCache: {}
    });
    const o = got.backupOpen || {};
    openState = { ext: !!o.ext, full: !!o.full };
    sizeCache = (got.sizeCache && typeof got.sizeCache === 'object') ? got.sizeCache : {};
  } catch {
    openState = { ext: false, full: false };
    sizeCache = {};
  }
}

function applyOpenState() {
  [['ext', 'extBackupToggle', 'extBackupBody'], ['full', 'fullBackupToggle', 'fullBackupBody']]
    .forEach(([key, btnId, bodyId]) => {
      const btn = document.getElementById(btnId);
      const body = document.getElementById(bodyId);
      if (!btn || !body) return;
      btn.setAttribute('aria-expanded', openState[key] ? 'true' : 'false');
      const section = btn.closest('.section');
      if (section) section.classList.toggle('open', openState[key]);
      body.hidden = !openState[key];
    });
}

async function toggleSection(key) {
  openState[key] = !openState[key];
  applyOpenState();
  fitAllLists();
  fitAllLists();
  try { await chrome.storage.local.set({ backupOpen: openState }); } catch { /* 忽略 */ }
}

/* 备份文件夹名尾部是 <ID前8位>，用它把已安装扩展的图标对上 */
function findExtForFolder(folder) {
  const m = /-([0-9a-f]{8})$/i.exec(String(folder || ''));
  if (!m) return null;
  const head = m[1].toLowerCase();
  return extState.list.find((e) => e.id.toLowerCase().startsWith(head)) || null;
}

function backupRow({ title, meta, where, icon, onDelete }) {
  const row = document.createElement('div');
  row.className = 'backup-item';

  if (icon) row.appendChild(makeIcon(icon, true));

  const grow = document.createElement('div');
  grow.className = 'grow';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = title;
  const m = document.createElement('div');
  m.className = 'meta';
  m.textContent = meta;
  grow.append(name, m);

  const w = document.createElement('div');
  w.className = 'where';
  w.textContent = where;
  w.title = where;
  grow.appendChild(w);

  const del = document.createElement('button');
  del.className = 'btn ghost sm';
  del.type = 'button';
  del.textContent = '删除';
  del.addEventListener('click', onDelete);

  row.append(grow, del);
  return row;
}

function backupMetaLine(item) {
  const parts = [];
  if (item.version) parts.push(`v${item.version}`);
  if (item.size != null) parts.push(extHuman(item.size));
  if (item.files) parts.push(`${item.files} 个文件`);
  if (item.backedAt) parts.push(item.backedAt);
  return parts.join(' · ');
}

function trashRow(item) {
  const row = document.createElement('div');
  row.className = 'backup-item';

  const grow = document.createElement('div');
  grow.className = 'grow';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.name || item.leaf;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `原位置 ${BACKUP_ROOT}/${item.path} · ${item.at || ''}`;
  grow.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const restore = document.createElement('button');
  restore.className = 'btn ghost sm';
  restore.type = 'button';
  restore.textContent = '恢复';
  restore.addEventListener('click', async () => {
    restore.disabled = true;
    try {
      const info = await restoreTrash(item.entryName);
      setBackupStatus(`已恢复：${info.name || info.leaf}`, 'ok');
    } catch (e) {
      setBackupStatus(`恢复失败：${e.message}`, 'err');
    }
    await loadBackups();
  });

  const purge = document.createElement('button');
  purge.className = 'btn ghost sm danger';
  purge.type = 'button';
  purge.textContent = '彻底删除';
  purge.addEventListener('click', async () => {
    if (!window.confirm(`彻底删除「${item.name || item.leaf}」？\n\n不经过回收站，直接消失。`)) return;
    try {
      await deleteTrashEntry(item.entryName);
      setBackupStatus('已彻底删除', 'ok');
    } catch (e) {
      setBackupStatus(`删除失败：${e.message}`, 'err');
    }
    await loadBackups();
  });

  actions.append(restore, purge);
  row.append(grow, actions);
  return row;
}

function renderTrash() {
  const box = document.getElementById('trashList');
  if (!box) return;
  const count = document.getElementById('trashCount');
  if (count) count.textContent = extState.trash.length ? `${extState.trash.length} 项` : '';
  const btn = document.getElementById('btnEmptyTrash');
  if (btn) btn.disabled = !extState.trash.length;

  const frag = document.createDocumentFragment();
  if (!extState.trash.length) {
    frag.appendChild(emptyNote('回收站是空的。删除的备份会先放这里，可随时恢复。'));
  } else {
    extState.trash.forEach((item) => frag.appendChild(trashRow(item)));
  }
  box.replaceChildren(frag);
}

/* ---------------- 体积统计（实测 + 缓存） ---------------- */

function saveSizeCache() {
  sizeCacheDirty = false;
  chrome.storage.local.set({ sizeCache }).catch(() => {});
}

async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  for await (const [, h] of dir.entries()) {
    if (h.kind === 'file') {
      const f = await h.getFile();
      files += 1;
      bytes += f.size;
    } else {
      const s = await dirStats(h);
      files += s.files;
      bytes += s.bytes;
    }
  }
  return { files, bytes };
}

async function ensureSizes() {
  if (!extState.dst || !extState.dstReady) return;
  let changed = false;
  let rootExt = null;

  for (const item of extState.backups) {
    if (item.size != null) continue;

    const cached = sizeCache[item.path];
    if (cached && cached.mtime === item.mtime) {
      item.size = cached.bytes;
      item.files = cached.files;
      changed = true;
      continue;
    }

    try {
      if (!rootExt) rootExt = await extState.dst.getDirectoryHandle(DIR_EXT);
      const dir = await rootExt.getDirectoryHandle(item.folder);
      const s = await dirStats(dir);
      item.size = s.bytes;
      item.files = s.files;
      sizeCache[item.path] = { mtime: item.mtime, bytes: s.bytes, files: s.files };
      sizeCacheDirty = true;
      changed = true;
    } catch { /* 目录不可读就留空 */ }
  }

  if (sizeCacheDirty) saveSizeCache();
  if (changed) {
    renderExtList();
    updateSummary();
  }
}

/* ---------------- 渲染 ---------------- */

function fitAllLists() {
  fitListHeight(document.getElementById('extBackupList'));
  fitListHeight(document.getElementById('fullBackupList'));
}

function fitAllLists() {
  fitListHeight(document.getElementById('extBackupList'));
  fitListHeight(document.getElementById('fullBackupList'));
}

function fitListHeight(box) {
  if (!box) return;
  const rows = box.querySelectorAll('.backup-item');
  if (rows.length <= 6) {
    box.style.maxHeight = '';
    return;
  }
  const cs = getComputedStyle(box);
  const gap = parseFloat(cs.rowGap || cs.gap || '0') || 0;
  const h = rows[0].getBoundingClientRect().height;
  if (!h) return;
  box.style.maxHeight = `${Math.round(h * 6 + gap * 5)}px`;
}

function fitAllLists() {
  fitListHeight(document.getElementById('extBackupList'));
  fitListHeight(document.getElementById('fullBackupList'));
}

function fitAllLists() {
  fitListHeight(document.getElementById('extBackupList'));
  fitListHeight(document.getElementById('fullBackupList'));
}

function fitListHeight(box) {
  if (!box) return;
  const rows = box.querySelectorAll('.backup-item');
  if (rows.length <= 6) {
    box.style.maxHeight = '';
    return;
  }
  const cs = getComputedStyle(box);
  const gap = parseFloat(cs.rowGap || cs.gap || '0') || 0;
  const h = rows[0].getBoundingClientRect().height;
  if (!h) return;
  box.style.maxHeight = `${Math.round(h * 6 + gap * 5)}px`;
}

function renderExtList() {
  const box = document.getElementById('extBackupList');
  const count = document.getElementById('extBackupCount');
  const clearBtn = document.getElementById('btnClearExtBackups');
  if (!box) return;

  const list = extState.backups.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  const frag = document.createDocumentFragment();

  if (!list.length) {
    frag.appendChild(emptyNote('还没有扩展备份。在 Finder 里双击插件目录下的「备份扩展源码.command」。'));
  } else {
    list.forEach((item) => {
      const icon = findExtForFolder(item.folder) || { id: item.folder, name: item.name, icons: [] };
      frag.appendChild(backupRow({
        title: item.name,
        meta: backupMetaLine(item) || '脚本导入',
        where: `${BACKUP_ROOT}/${item.path}/`,
        icon,
        onDelete: () => deleteBackup(item)
      }));
    });
  }
  box.replaceChildren(frag);
  fitListHeight(box);

  const bytes = list.reduce((s, x) => s + (x.size || 0), 0);
  const sized = list.length > 0 && list.every((x) => x.size != null);
  if (count) count.textContent = list.length ? `${list.length} 个${sized ? ` · ${extHuman(bytes)}` : ''}` : '0 个';
  if (clearBtn) clearBtn.disabled = !list.length;
}

function renderFullList() {
  const box = document.getElementById('fullBackupList');
  const count = document.getElementById('fullBackupCount');
  const clearBtn = document.getElementById('btnClearFullBackups');
  if (!box) return;

  const list = extState.tabFiles.slice();
  const frag = document.createDocumentFragment();

  if (!list.length) {
    frag.appendChild(emptyNote('还没有完整备份。到「标签与收藏」页签点「备份到插件目录」，会同时保存标签组与收藏夹。'));
  } else {
    list.forEach((file) => {
      frag.appendChild(backupRow({
        title: file.name,
        meta: `${extHuman(file.size)} · ${extTime(file.mtime)}`,
        where: `${BACKUP_ROOT}/${DIR_FULL}/${file.name}`,
        onDelete: () => deleteTabFile(file.name)
      }));
    });
  }
  box.replaceChildren(frag);
  fitListHeight(box);

  const bytes = list.reduce((s, x) => s + (x.size || 0), 0);
  if (count) count.textContent = list.length ? `${list.length} 个 · ${extHuman(bytes)}` : '0 个';
  if (clearBtn) clearBtn.disabled = !list.length;
}

function updateSummary() {
  const sum = document.getElementById('backupSummary');
  if (!sum) return;
  const extN = extState.backups.length;
  const fullN = extState.tabFiles.length;
  sum.textContent = extN || fullN
    ? `${extN} 个扩展 · ${fullN} 份完整备份`
    : '暂无备份';
}

/* 先取数据、再一次性替换 DOM，避免刷新时列表先清空再填回造成的抖动 */
let backupLoading = null;
let backupDirty = false;

function loadBackups() {
  if (backupLoading) {
    backupDirty = true;
    return backupLoading;
  }
  backupLoading = (async () => {
    const extBox = document.getElementById('extBackupList');
    const fullBox = document.getElementById('fullBackupList');
    if (!extBox || !fullBox) return;

    if (!extState.dst || !extState.dstReady) {
      const note = emptyNote(extState.dst
        ? '插件目录需要重新授权才能读取，请点上方「恢复授权」。'
        : '尚未授权插件目录。');
      extBox.replaceChildren(note.cloneNode(true));
      fullBox.replaceChildren(note);
      const sum = document.getElementById('backupSummary');
      if (sum) sum.textContent = '';
      const ec = document.getElementById('extBackupCount');
      const fc = document.getElementById('fullBackupCount');
      if (ec) ec.textContent = '';
      if (fc) fc.textContent = '';
      extState.trash = [];
      renderTrash();
      renderLocation();
      return;
    }

    extState.pluginPath = await readPluginPath();
    extState.backups = await listBackupFolders();
    extState.tabFiles = await listTabFiles();
    extState.trash = await listTrash();

    updateSummary();
    renderExtList();
    renderFullList();
    renderTrash();
    renderLocation();

    ensureSizes();
  })().finally(() => {
    backupLoading = null;
    if (backupDirty) {
      backupDirty = false;
      loadBackups();
    }
  });
  return backupLoading;
}

/* ---------------- 回收站（软删除） ---------------- */

function trashStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function entryExists(parent, name) {
  try { await parent.getDirectoryHandle(name); return true; } catch { /* 继续试文件 */ }
  try { await parent.getFileHandle(name); return true; } catch { return false; }
}

async function copyTree(srcDir, dstDir) {
  for await (const [name, handle] of srcDir.entries()) {
    if (name === '_metadata' || name === '.DS_Store') continue;
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      const out = await dstDir.getFileHandle(name, { create: true });
      const w = await out.createWritable();
      await w.write(file);
      await w.close();
    } else {
      const sub = await dstDir.getDirectoryHandle(name, { create: true });
      await copyTree(handle, sub);
    }
  }
}

async function moveToTrash(relPath, displayName) {
  const root = extState.dst;
  const { dir, name } = await resolveParent(root, relPath);

  let kind = 'dir';
  let handle = null;
  try {
    handle = await dir.getDirectoryHandle(name);
  } catch {
    handle = await dir.getFileHandle(name);
    kind = 'file';
  }

  const trash = await root.getDirectoryHandle(TRASH_DIR, { create: true });
  const stamp = trashStamp();
  let entryName = `${stamp}-${name}`;
  let n = 2;
  while (await entryExists(trash, entryName)) {
    entryName = `${stamp}-${name}-${n}`;
    n += 1;
  }

  const entry = await trash.getDirectoryHandle(entryName, { create: true });
  const data = await entry.getDirectoryHandle('data', { create: true });

  if (kind === 'dir') {
    await copyTree(handle, data);
  } else {
    const file = await handle.getFile();
    const out = await data.getFileHandle(name, { create: true });
    const w = await out.createWritable();
    await w.write(file);
    await w.close();
  }

  const info = { path: relPath, name: displayName, leaf: name, kind, at: extTime() };
  const infoFh = await entry.getFileHandle('info.json', { create: true });
  const iw = await infoFh.createWritable();
  await iw.write(JSON.stringify(info, null, 2));
  await iw.close();

  await dir.removeEntry(name, { recursive: true });
  return info;
}

function normalizeRelPath(relPath) {
  const p = String(relPath || '');
  return p.startsWith(`${LEGACY_DIR_FULL}/`) ? `${DIR_FULL}/${p.slice(LEGACY_DIR_FULL.length + 1)}` : p;
}

async function listTrash() {
  if (!extState.dst || !extState.dstReady) return [];
  try {
    const trash = await extState.dst.getDirectoryHandle(TRASH_DIR);
    const out = [];
    for await (const [entryName, h] of trash.entries()) {
      if (h.kind !== 'directory') continue;
      let info = null;
      try {
        const f = await (await h.getFileHandle('info.json')).getFile();
        info = JSON.parse(await f.text());
      } catch { /* 没有记录就跳过 */ }
      if (!info || !info.path) continue;
      out.push({ entryName, ...info, path: normalizeRelPath(info.path) });
    }
    return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  } catch {
    return [];
  }
}

async function restoreTrash(entryName) {
  const trash = await extState.dst.getDirectoryHandle(TRASH_DIR);
  const entry = await trash.getDirectoryHandle(entryName);
  let info = null;
  try {
    const f = await (await entry.getFileHandle('info.json')).getFile();
    info = JSON.parse(await f.text());
  } catch { /* 下面报错 */ }
  if (!info || !info.path) throw new Error('这个条目缺少记录，无法恢复');

  const targetPath = normalizeRelPath(info.path);
  const { dir: parent, name: leaf } = await resolveParent(extState.dst, targetPath);
  if (await entryExists(parent, leaf)) throw new Error('原位置已有同名项目，请先处理它');

  const data = await entry.getDirectoryHandle('data');
  if (info.kind === 'dir') {
    const target = await parent.getDirectoryHandle(leaf, { create: true });
    await copyTree(data, target);
  } else {
    const src = await data.getFileHandle(info.leaf || leaf);
    const file = await src.getFile();
    const out = await parent.getFileHandle(leaf, { create: true });
    const w = await out.createWritable();
    await w.write(file);
    await w.close();
  }

  await trash.removeEntry(entryName, { recursive: true });
  return info;
}

async function deleteTrashEntry(entryName) {
  const trash = await extState.dst.getDirectoryHandle(TRASH_DIR);
  await trash.removeEntry(entryName, { recursive: true });
}

async function emptyTrash() {
  if (!extState.trash.length) return;
  const n = extState.trash.length;
  if (!window.confirm(`彻底清空回收站？\n\n${n} 项会被从磁盘删除，不可恢复。`)) return;
  let failed = 0;
  for (const item of extState.trash) {
    try {
      await deleteTrashEntry(item.entryName);
    } catch {
      failed += 1;
    }
  }
  await loadBackups();
  setBackupStatus(failed ? `清空完成，${failed} 项失败` : `回收站已清空（${n} 项）`, failed ? 'err' : 'ok');
}

/* ---------------- 删除 ---------------- */

async function resolveParent(root, relPath) {
  const segs = String(relPath || '').split('/').filter(Boolean);
  const name = segs.pop();
  let dir = root;
  for (const s of segs) dir = await dir.getDirectoryHandle(s);
  return { dir, name };
}

async function deleteBackup(item) {
  if (!extState.dst || !extState.dstReady) return;
  const ok = window.confirm(
    `把扩展备份「${item.name}」移入回收站？\n\n位置：${BACKUP_ROOT}/${item.path}/\n之后可在「回收站」里恢复，或彻底删除。`
  );
  if (!ok) return;
  try {
    await moveToTrash(item.path, item.name);
    setBackupStatus(`已移入回收站：${item.name}`, 'ok');
  } catch (e) {
    if (e.name === 'NotFoundError') setBackupStatus(`文件夹已不存在，刷新即可：${item.name}`, '');
    else setBackupStatus(`移入回收站失败：${e.message}`, 'err');
  }
  await loadBackups();
}

async function deleteTabFile(name) {
  if (!extState.dst || !extState.dstReady) return;
  if (!window.confirm(`把完整备份「${name}」移入回收站？\n\n之后可在「回收站」里恢复，或彻底删除。`)) return;
  try {
    await moveToTrash(`${DIR_FULL}/${name}`, name);
    setBackupStatus(`已移入回收站：${name}`, 'ok');
  } catch (e) {
    setBackupStatus(`移入回收站失败：${e.message}`, 'err');
  }
  await loadBackups();
}

async function clearExtensionBackups() {
  if (!extState.dst || !extState.dstReady || !extState.backups.length) return;
  const n = extState.backups.length;
  if (!window.confirm(
    `把「${BACKUP_ROOT}/${DIR_EXT}/」下 ${n} 个扩展备份全部移入回收站？\n\n回收站可以逐项恢复。`
  )) return;

  let failed = 0;
  for (const item of extState.backups) {
    try {
      await moveToTrash(item.path, item.name);
    } catch (e) {
      if (e.name !== 'NotFoundError') failed += 1;
    }
  }
  await loadBackups();
  setBackupStatus(failed ? `已移入回收站，${failed} 个失败` : `${n} 个扩展备份已移入回收站`, failed ? 'err' : 'ok');
}

async function clearTabBackups() {
  if (!extState.dst || !extState.dstReady || !extState.tabFiles.length) return;
  const n = extState.tabFiles.length;
  if (!window.confirm(
    `把「${BACKUP_ROOT}/${DIR_FULL}/」下 ${n} 个完整备份全部移入回收站？\n\n回收站可以逐项恢复。`
  )) return;

  let failed = 0;
  for (const file of extState.tabFiles) {
    try {
      await moveToTrash(`${DIR_FULL}/${file.name}`, file.name);
    } catch {
      failed += 1;
    }
  }
  await loadBackups();
  setBackupStatus(failed ? `已移入回收站，${failed} 个失败` : `${n} 个完整备份已移入回收站`, failed ? 'err' : 'ok');
}

/* ---------------- 导出清单 ---------------- */

function exportInventory() {
  const picked = extState.list.filter((e) => extState.picked.has(e.id));
  const source = picked.length ? picked : extState.list;
  const rows = [['名称', '版本', '类型', '状态', 'ID', '安装来源']];
  for (const item of source) {
    rows.push([
      item.name, item.version,
      (INSTALL_TYPE[item.installType] || INSTALL_TYPE.other).label,
      item.enabled ? '启用' : '停用',
      item.id, item.installType
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `edge-extensions-${Date.now()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setStatus(`清单已导出（${source.length} 个）`, 'ok');
}

/* ---------------- 供标签与收藏页签复用 ---------------- */

window.ExtStore = {
  ready: () => !!(extState.dst && extState.dstReady),
  name: () => (extState.base ? `${extState.base.name}/${BACKUP_ROOT}` : BACKUP_ROOT),
  async writeText(text, filename) {
    if (!extState.dst || !extState.dstReady) {
      throw new Error('尚未授权插件目录，请到「备份管理」里授权一次');
    }
    const dir = await extState.dst.getDirectoryHandle(DIR_FULL, { create: true });
    const fh = await dir.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    await loadBackups();
    const base = extState.pluginPath ? `${extState.pluginPath}/${BACKUP_ROOT}` : window.ExtStore.name();
    return `${base}/${DIR_FULL}/${filename}`;
  }
};

/* ---------------- 初始化 ---------------- */

let extReady = null;

function initExtModule() {
  if (extReady) return extReady;
  extReady = (async () => {
    document.getElementById('btnExtRefresh').addEventListener('click', loadExtensions);
    document.getElementById('btnExportInv').addEventListener('click', exportInventory);
    document.getElementById('btnPickDst').addEventListener('click', pickDest);
    document.getElementById('btnRetryDst').addEventListener('click', retryPermission);
    document.getElementById('btnReloadBackups').addEventListener('click', loadBackups);
    document.getElementById('extBackupToggle').addEventListener('click', () => toggleSection('ext'));
    document.getElementById('fullBackupToggle').addEventListener('click', () => toggleSection('full'));
    document.getElementById('btnClearExtBackups').addEventListener('click', clearExtensionBackups);
    document.getElementById('btnClearFullBackups').addEventListener('click', clearTabBackups);
    document.getElementById('btnEmptyTrash').addEventListener('click', emptyTrash);

    document.getElementById('extSelectAll').addEventListener('change', (e) => {
      if (e.target.checked) extState.list.forEach((x) => extState.picked.add(x.id));
      else extState.picked.clear();
      savePicked();
      renderExtTable();
    });

    await loadPicked();
    await loadOpenState();
    applyOpenState();
    await loadExtensions();

    const base = await idbGet('base');
    if (base) {
      extState.base = base;
      if (await ensurePermission(base, 'readwrite', false)) {
        try {
          extState.dst = await base.getDirectoryHandle(BACKUP_ROOT, { create: true });
          extState.dstReady = true;
        } catch {
          extState.dstReady = false;
        }
      }
    }
    if (extState.dstReady) {
      try {
        await ensureStructure();
      } catch (e) {
        extState.dstReady = false;
        setBackupStatus(`插件目录不可写：${e.message}`, 'err');
      }
    }
    renderLocation();
    await loadBackups();
  })();
  return extReady;
}

/* ---------------- 视图切换 ---------------- */

const VIEWS = ['tabs', 'ext', 'backup'];

async function switchView(view, persist) {
  const bar = document.getElementById('tabBar');
  if (!bar) return;
  const target = VIEWS.includes(view) ? view : 'tabs';
  bar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === target));
  document.getElementById('view-tabs').hidden = target !== 'tabs';
  document.getElementById('view-ext').hidden = target !== 'ext';
  document.getElementById('view-backup').hidden = target !== 'backup';
  const wasReady = !!extReady;
  await initExtModule();
  // 首次打开时 init 已经读过一次，避免重复扫盘
  if (target === 'backup') {
    if (wasReady) await loadBackups();
    fitAllLists();
  }
  if (persist) {
    try { await chrome.storage.local.set({ activeView: target }); } catch { /* 忽略 */ }
  }
}

(function bindTabs() {
  const bar = document.getElementById('tabBar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchView(btn.dataset.view, true);
  });
  chrome.storage.local.get({ activeView: 'tabs' })
    .then((got) => {
      const v = got && VIEWS.includes(got.activeView) ? got.activeView : 'tabs';
      if (v !== 'tabs') switchView(v, false);
    })
    .catch(() => {});
})();
