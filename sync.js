/* ============================================================
 * NikSync —— 通用 Gitee 云同步模块（浏览器直连，零依赖）
 * ------------------------------------------------------------
 * 原理：把应用的 localStorage 内容打包成一个 JSON，
 *       经 Gitee Open API v5 存进私有仓库的 data/<app>.json。
 *       Gitee 仓库自带版本历史，改坏了可回滚。
 *
 * 接入（以 LogosNik 为例）：
 *   1) 页面引入 sync.js
 *   2) 页面加载后：
 *      NikSync.init({
 *        app: 'logosnik', owner: '用户名', repo: 'data-sync',
 *        branch: 'master', token: '私人令牌(可留空,设置页再填)',
 *        file: 'data/logosnik.json',
 *        keys: ['ln_warehouse_v16', 'ln_inspirations_v1'],
 *        device: '本设备名(可选)'
 *      });
 *   3) 本地任何内容保存后调用：  NikSync.schedulePush();
 *      （内部防抖 3 秒自动上传，带冲突检测）
 *   4) 页面启动时调用：          NikSync.autoPull();
 *      （远端较新则自动覆盖本地；首次使用自动建文件上传）
 *   5) 设置页手动按钮：          NikSync.pushNow(); / NikSync.pullNow();
 *   6) 设置页表单读写：          NikSync.cfg(); NikSync.save(...);
 *   7) 查询状态：                NikSync.status();
 *
 * 安全：token 只存在本机浏览器 localStorage，由应用设置页录入。
 * 配置与状态共占两个 localStorage key：niksync_cfg / niksync_meta。
 * ============================================================ */
(function (global) {
  'use strict';

  var CFG_KEY = 'niksync_cfg';
  var META_KEY = 'niksync_meta';
  var CFG = null, META = null, timer = null, ADAPTER = null;
  var lastErr = null;
  var DEFAULT_BRANCH = 'master';

  /* ---------- 小工具 ---------- */
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64d(s) {
    if (!s) return '';
    s = String(s).replace(/\s+/g, '');
    try { return decodeURIComponent(escape(atob(s))); }
    catch (e) { try { return atob(s); } catch (e2) { return ''; } }
  }
  function jget(key, fb) {
    try { var v = localStorage.getItem(key); return v === null ? fb : JSON.parse(v); }
    catch (e) { return fb; }
  }
  function jset(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  function nowTs() { return Date.now(); }
  function log() { try { console.log.apply(console, ['[NikSync]'].concat([].slice.call(arguments))); } catch (e) {} }
  function warn() { try { console.warn.apply(console, ['[NikSync]'].concat([].slice.call(arguments))); } catch (e) {} }

  /* ---------- 配置 ---------- */
  function getCfg() {
    if (!CFG) CFG = jget(CFG_KEY, null);
    return CFG || { app: 'app', owner: '', repo: '', branch: DEFAULT_BRANCH, token: '', file: '', keys: [], device: '' };
  }
  function saveCfg(cfg) { CFG = cfg; jset(CFG_KEY, cfg); }
  function getMeta() {
    if (!META) META = jget(META_KEY, { ts: 0, device: '', pending: false });
    return META;
  }
  function setMeta(m) { META = m; jset(META_KEY, m); }
  function valid() {
    var c = getCfg();
    return !!(c.owner && c.repo && c.token && (c.file || c.app));
  }
  function filePath() {
    var c = getCfg();
    return c.file || ('data/' + c.app + '.json');
  }
  function deviceName() {
    var c = getCfg();
    return c.device || ('device-' + Math.random().toString(36).slice(2, 7));
  }

  /* ---------- Gitee Contents API ---------- */
  function apiUrl(path, qs) {
    var c = getCfg();
    var url = 'https://gitee.com/api/v5/repos/' + encodeURIComponent(c.owner) + '/' +
      encodeURIComponent(c.repo) + '/contents/' + path;
    return qs ? (url + '?' + qs) : url;
  }
  function apiGet(path) {
    var c = getCfg();
    return fetch(apiUrl(path, 'access_token=' + encodeURIComponent(c.token)))
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) return r.json().then(function (j) { throw new Error('GET ' + r.status + ' ' + (j.message || '')); });
        return r.json();
      });
  }
  function apiWrite(path, content, sha) {
    var c = getCfg();
    var body = {
      access_token: c.token,
      content: b64e(content),
      message: 'sync ' + (c.app || 'app') + ' ' + new Date().toISOString()
    };
    if (sha) body.sha = sha;
    return fetch(apiUrl(path), {
      method: sha ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error('WRITE ' + r.status + ' ' + (j.message || '')); });
      return r.json();
    });
  }

  /* ---------- 数据打包 / 落盘 ---------- */
  async function collectLocal() {
    var c = getCfg(), data = {};
    (c.keys || []).forEach(function (k) {
      try { var v = localStorage.getItem(k); if (v !== null) data[k] = v; } catch (e) {}
    });
    if (ADAPTER && typeof ADAPTER.exportExtra === 'function') {
      try {
        var ex = await ADAPTER.exportExtra();
        if (ex) { Object.keys(ex).forEach(function (k) { data[k] = ex[k]; }); }
      } catch (e) { warn('exportExtra 失败：', e); }
    }
    return data;
  }
  async function applyRemote(data) {
    var changed = false;
    (getCfg().keys || []).forEach(function (k) {
      if (typeof data[k] !== 'string') return;
      try {
        if (localStorage.getItem(k) !== data[k]) { localStorage.setItem(k, data[k]); changed = true; }
      } catch (e) {}
    });
    if (ADAPTER && typeof ADAPTER.importExtra === 'function') {
      try { var r = await ADAPTER.importExtra(data); if (r) changed = true; } catch (e) { warn('importExtra 失败：', e); }
    }
    return changed;
  }
  function buildFile(payload) {
    return JSON.stringify({
      meta: { v: 1, ts: nowTs(), device: deviceName() },
      data: payload
    });
  }
  function parseRemote(remote) {
    try { return JSON.parse(b64d(remote.content)); } catch (e) { return null; }
  }

  /* ---------- 推送 ---------- */
  function pushNow() {
    if (!valid()) { lastErr = '同步未配置：请在设置中填齐 用户名/仓库/令牌'; warn(lastErr); return Promise.resolve(false); }
    var path = filePath(), m = getMeta();
    return apiGet(path).then(async function (remote) {
      var obj = remote ? parseRemote(remote) : null;
      var remoteTs = (obj && obj.meta && obj.meta.ts) || 0;
      if (remote && remoteTs > m.ts && m.pending) {
        var ok = global.confirm('云端数据比本机上次同步点更新，直接上传会覆盖云端新内容。\n建议先「下载」合并，仍要继续上传吗？');
        if (!ok) return false;
      }
      return apiWrite(path, buildFile(await collectLocal()), remote ? remote.sha : undefined).then(function () {
        setMeta({ ts: nowTs(), device: deviceName(), pending: false });
        lastErr = null;
        log('已上传');
        return true;
      });
    }).catch(function (e) {
      lastErr = (e && e.message) || String(e);
      warn('上传失败：', lastErr);
      return false;
    });
  }

  /* ---------- 拉取 ---------- */
  function pullNow(silent) {
    if (!valid()) { lastErr = '同步未配置：请在设置中填齐 用户名/仓库/令牌'; warn(lastErr); return Promise.resolve(false); }
    var path = filePath(), m = getMeta();
    return apiGet(path).then(async function (remote) {
      if (!remote || !remote.content) { log('云端暂无数据'); return false; }
      var obj = parseRemote(remote);
      if (!obj || !obj.data) { lastErr = '云端数据格式异常'; warn(lastErr); return false; }
      var remoteTs = (obj.meta && obj.meta.ts) || 0;
      if (!silent && m.pending && remoteTs > m.ts) {
        var ok = global.confirm('本机有未上传改动，云端也有更新。\n用云端覆盖将丢失本机改动，确定继续？');
        if (!ok) return false;
      }
      var changed = await applyRemote(obj.data);
      if (changed || remoteTs > m.ts) setMeta({ ts: remoteTs || nowTs(), device: deviceName(), pending: false });
      lastErr = null;
      log(changed ? '已应用云端数据' : '与本机一致');
      return changed;
    }).catch(function (e) {
      lastErr = (e && e.message) || String(e);
      if (!silent) warn('下载失败：', lastErr);
      return false;
    });
  }

  /* ---------- 对外 ---------- */
  function schedulePush(delay) {
    if (!valid()) return;
    var m = getMeta(); m.pending = true; setMeta(m);
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; pushNow(); }, delay || 3000);
  }
  function autoPull() {
    if (!valid()) return Promise.resolve(false);
    return apiGet(filePath()).then(async function (remote) {
      if (!remote || !remote.content) {
        var localData = await collectLocal();
        if (!Object.keys(localData).length) return false;
        return apiWrite(filePath(), buildFile(localData), undefined).then(function () {
          setMeta({ ts: nowTs(), device: deviceName(), pending: false });
          log('首次使用：已自动上传本地数据');
          return false;
        }).catch(function (e) { warn('首次上传失败：', (e && e.message) || e); return false; });
      }
      return pullNow(true);
    }).catch(function (e) { lastErr = (e && e.message) || String(e); return false; });
  }
  function cfg() { var c = getCfg(); return { app: c.app, owner: c.owner, repo: c.repo, branch: c.branch || DEFAULT_BRANCH, token: c.token || '', file: c.file, keys: (c.keys || []).slice(), device: c.device || '' }; }
  function save(c) { saveCfg(c); }
  function status() { var m = getMeta(); return { ts: m.ts, device: m.device, pending: m.pending, configured: valid() }; }
  function configured() { return valid(); }

  /* ============================================================
   * 通用"云同步中心"浮层 + 悬浮入口（供未内嵌设置面板的应用使用）
   * 样式全内联，尽量不受宿主页面 CSS 影响
   * ============================================================ */
  var fabEl = null, panelEl = null;
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTs(ts) {
    if (!ts) return '从未';
    var d = new Date(ts), p = function (n) { return n < 10 ? '0' + n : n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function buildPanel() {
    var c = getCfg(), st = status();
    var p = document.createElement('div');
    p.id = 'niksync-panel';
    p.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483000;width:min(92vw,360px);background:#fbfaf6;color:#26221c;border:1px solid #d8d2c4;border-radius:14px;padding:18px;font-family:-apple-system,"PingFang SC","Noto Sans SC",sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.25);font-size:13px;line-height:1.5';
    var stTxt = st.configured
      ? '已配置 · 内容保存后自动上传' + (st.pending ? '（有待上传改动）' : '')
      : '未配置：填齐 用户名/仓库/令牌 即可用';
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<b style="font-size:14px">云同步 · Gitee</b>' +
      '<span onclick="NikSync.hideSyncUI()" style="cursor:pointer;font-size:16px;line-height:1;color:#8a8578">×</span></div>' +
      '<div style="font-size:11px;color:#8a8578;margin-bottom:10px">' + esc(stTxt) + ' · 上次同步 ' + fmtTs(st.ts) + '</div>' +
      row('Gitee 用户名', 'niksync-owner', c.owner, '用户名') +
      row('仓库名', 'niksync-repo', c.repo, '如 data-sync') +
      row('本设备名', 'niksync-device', c.device, '可选，如 macbook') +
      row('分支', 'niksync-branch', c.branch || 'master', '一般 master') +
      '<div style="font-size:11px;color:#8a8578;margin:6px 0 3px">私人令牌（projects 权限）</div>' +
      '<input id="niksync-token" type="password" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d8d2c4;border-radius:8px;background:#fff;font-size:12px;outline:none" placeholder="ghp_xxx / gitee 令牌" value="' + esc(c.token || '') + '">' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<button onclick="NikSync.saveFromPanel()" style="flex:1;padding:8px;border:none;border-radius:9px;background:#26221c;color:#f5f1e6;font-size:12px;cursor:pointer;font-weight:600">保存并上传</button>' +
      '<button onclick="NikSync.downloadNow()" style="flex:1;padding:8px;border:1px solid #d8d2c4;border-radius:9px;background:#fff;color:#26221c;font-size:12px;cursor:pointer">下载到本机</button></div>' +
      '<div style="font-size:10px;color:#a29b8c;margin-top:10px;line-height:1.6">数据存进 Gitee 私有仓库的 data/' + esc(c.app || 'app') + '.json，自带版本历史。令牌只存本浏览器。多设备填同一仓库即可互相同步。</div>' +
      '<div id="niksync-msg" style="font-size:11px;color:#1d9e75;margin-top:6px;min-height:14px"></div>';
    return p;
  }
  function row(label, id, val, ph) {
    return '<div style="font-size:11px;color:#8a8578;margin:6px 0 3px">' + label + '</div>' +
      '<input id="' + id + '" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d8d2c4;border-radius:8px;background:#fff;font-size:12px;outline:none" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '">';
  }
  function msg(txt, ok) {
    var m = document.getElementById('niksync-msg');
    if (m) { m.textContent = txt; m.style.color = ok ? '#1d9e75' : '#a32d2d'; }
  }
  function showSyncUI() {
    if (panelEl) { panelEl.remove(); panelEl = null; }
    panelEl = buildPanel();
    document.body.appendChild(panelEl);
  }
  function hideSyncUI() { if (panelEl) { panelEl.style.display = 'none'; } }
  function readPanel() {
    var c = getCfg();
    var val = function (id) {
      var el = document.getElementById(id);
      return (el && el.value != null) ? String(el.value).trim() : '';
    };
    var t;
    if ((t = val('niksync-owner'))) c.owner = t;
    if ((t = val('niksync-repo'))) c.repo = t;
    if ((t = val('niksync-device'))) c.device = t;
    if ((t = val('niksync-branch'))) c.branch = t;
    if ((t = val('niksync-token'))) c.token = t;
    return c;
  }
  function saveFromPanel() {
    saveCfg(readPanel());
    lastErr = null;
    msg('已保存，正在上传…', true);
    pushNow().then(function (ok) { msg(ok ? '上传成功 ✓' : '上传失败：' + (lastErr || '检查配置/网络'), ok); });
  }
  function downloadNow() {
    saveCfg(readPanel());
    lastErr = null;
    msg('正在下载…', true);
    pullNow(false).then(function (ok) {
      if (ok) { msg('已下载并应用 ✓', true); setTimeout(function () { location.reload(); }, 600); }
      else msg('下载失败：' + (lastErr || '无更新或网络异常'), false);
    });
  }
  function ensureFAB() {
    if (fabEl || document.getElementById('niksync-fab')) return;
    fabEl = document.createElement('div');
    fabEl.id = 'niksync-fab';
    fabEl.textContent = '☁';
    fabEl.title = '云同步设置';
    fabEl.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147482000;width:34px;height:34px;border-radius:50%;background:#26221c;color:#f5f1e6;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;opacity:.55;box-shadow:0 2px 8px rgba(0,0,0,.2);font-family:sans-serif';
    fabEl.addEventListener('click', function (e) { e.stopPropagation(); showSyncUI(); });
    document.body.appendChild(fabEl);
  }

  global.NikSync = {
    init: saveCfg, schedulePush: schedulePush, pushNow: pushNow,
    pullNow: pullNow, autoPull: autoPull, cfg: cfg, save: save,
    status: status, configured: configured, setAdapter: function (a) { ADAPTER = a; },
    showSyncUI: showSyncUI, hideSyncUI: hideSyncUI, saveFromPanel: saveFromPanel,
    downloadNow: downloadNow, ensureFAB: ensureFAB
  };
})(window);
