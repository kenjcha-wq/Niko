//
//  xiangxin-core.js —— 象信 Lite 的协议核心（平台无关，纯逻辑）
//
//  为什么要有这一份：Mac 宿主的协议逻辑在 Swift 里（XiangxinAsync.swift + XiangxinSync.swift），
//  但 Android 上没有 Swift。如果为 Android 再写一遍 Kotlin 版协议，
//  就变成"同一套格式两份实现"，迟早背离。
//
//  所以 Android 侧只实现最原始的 fs.* 文件操作（Kotlin + WebDAV），
//  协议逻辑（文件名、全序、已读合并、消息编解码）全部在这里，**用 node 就能测**。
//  以后做 Windows 客户端也能直接复用这一份。
//
//  依赖注入：引擎不碰任何平台 API，只通过 io 适配器说话：
//    io.listDir(path) -> Promise<[{name,isDir,size,mtime}]>
//    io.readText(path) -> Promise<string>
//    io.readBase64(path, offset, length) -> Promise<string>
//    io.writeText(path, text, overwrite) -> Promise<void>
//    io.move(from, to) -> Promise<void>
//    io.delete(path) -> Promise<void>
//
//  ⚠️ 刻意不用 BigInt：Android 7 的 WebView 没有它。
//  定长时间戳一律用**字符串**比较（宽度固定 → 字典序 == 数值序），
//  需要数值时先按字符串验范围，再累加（此时必然 < 2^53，double 精确）。
//

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XiangxinCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TS_DIGITS = 15, DEV_DIGITS = 6, RAND_DIGITS = 6;
  var MIN_EPOCH_MS = 86400000;                 // 1970-01-01 之后一天，早于它的当坏数据
  var MAX_EPOCH_MS = 253402300799999;          // 公元 9999-12-31
  var SKEW_TOLERANCE_MS = 2 * 60 * 1000;
  var ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var DEFAULT_SEEN_LIMIT = 5000;

  // ══════════════════════════════════════════════════════════
  //  base36 定长
  // ══════════════════════════════════════════════════════════

  function b36encode(value, width) {
    if (!(value >= 0) || !isFinite(value)) return null;
    var v = Math.floor(value);
    if (v === 0) return repeat('0', width);
    var out = '';
    while (v > 0) {
      out = ALPHABET.charAt(v % 36) + out;
      v = Math.floor(v / 36);
    }
    if (out.length > width) return null;
    return repeat('0', width - out.length) + out;
  }

  function repeat(s, n) { var o = ''; while (n-- > 0) o += s; return o; }

  /// 解析定长 base36。**先验范围再累加**：范围不合格直接 null，
  /// 这样累加时值必然 < 2^53，double 不会丢精度。
  function b36decode(s, width) {
    if (typeof s !== 'string' || s.length !== width) return null;
    var v = 0;
    for (var i = 0; i < s.length; i++) {
      var d = ALPHABET.indexOf(s.charAt(i).toUpperCase());
      if (d < 0) return null;
      v = v * 36 + d;
    }
    return v;
  }

  var MAX_TS_STR = b36encode(MAX_EPOCH_MS, TS_DIGITS);
  var MIN_TS_STR = b36encode(MIN_EPOCH_MS, TS_DIGITS);

  // ══════════════════════════════════════════════════════════
  //  文件名
  // ══════════════════════════════════════════════════════════

  /// 同步工具的冲突副本：从**第一个** .sync-conflict- 处截断。
  /// 用"从后往前"截是错的 —— 副本名里时间戳在最后，从后切会切出一个时间戳完全错误的名字。
  function stripConflict(stem) {
    var i = stem.indexOf('.sync-conflict-');
    return i < 0 ? stem : stem.slice(0, i);
  }

  function stemOf(ts, dev, rand) {
    return b36encode(ts, TS_DIGITS) + '-' + String(dev).toUpperCase() + '-' + String(rand).toUpperCase();
  }

  /// 解析主干。返回 {ts, dev, rand, stem}；不合格返回 null。
  function parseStem(raw) {
    if (typeof raw !== 'string') return null;
    var stem = stripConflict(raw);
    var parts = stem.split('-');
    if (parts.length !== 3) return null;
    var t = parts[0], d = parts[1], r = parts[2];
    if (t.length !== TS_DIGITS || d.length !== DEV_DIGITS || r.length !== RAND_DIGITS) return null;
    if (!isAlnum36(d) || !isAlnum36(r)) return null;
    // 定长字符串比大小 = 数值比大小
    var tu = t.toUpperCase();
    if (tu < MIN_TS_STR || tu > MAX_TS_STR) return null;
    var ts = b36decode(tu, TS_DIGITS);
    if (ts === null) return null;
    return { ts: ts, dev: d.toUpperCase(), rand: r.toUpperCase(), stem: stemOf(ts, d, r) };
  }

  function isAlnum36(s) {
    for (var i = 0; i < s.length; i++) {
      if (ALPHABET.indexOf(s.charAt(i).toUpperCase()) < 0) return false;
    }
    return true;
  }

  function stemOfFile(fileName) { return stripExt(fileName); }
  function stripExt(n) {
    var i = n.lastIndexOf('.');
    return i <= 0 ? n : n.slice(0, i);
  }
  function extOf(n) {
    var i = n.lastIndexOf('.');
    return i <= 0 ? '' : n.slice(i + 1).toLowerCase();
  }
  /// 排序键：整个主干（大写）。所有设备算出来的一致，与文件系统 mtime 无关。
  function sortKey(stem) { return String(stem).toUpperCase(); }

  function compareStems(a, b) {
    var ka = sortKey(a), kb = sortKey(b);
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  }

  /// 输入文件名列表，输出确定顺序。解析失败的原样保留（排在能解析的后面，按字节序）。
  function sortNames(names) {
    return names.slice().sort(function (a, b) {
      var ka = sortKey(stemOfFile(a)), kb = sortKey(stemOfFile(b));
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
  }

  /// 去重：同一 id 的多个文件（冲突副本、多路径同步），保留排序最靠前的那份。
  function dedupe(names) {
    var seen = {}, kept = [], dropped = [];
    sortNames(names).forEach(function (f) {
      var key = sortKey(stripConflict(stemOfFile(f)));
      if (seen[key]) dropped.push(f);
      else { seen[key] = true; kept.push(f); }
    });
    return { kept: kept, dropped: dropped };
  }

  // ══════════════════════════════════════════════════════════
  //  消息
  // ══════════════════════════════════════════════════════════

  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  function isoString(ms, tzMinutes) {
    var tz = (typeof tzMinutes === 'number') ? tzMinutes : localTZMinutes();
    var d = new Date(ms + tz * 60000);
    var sign = tz < 0 ? '-' : '+';
    var a = Math.abs(tz);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2)
      + 'T' + pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2)
      + '.' + pad(d.getUTCMilliseconds(), 3) + sign + pad(Math.floor(a / 60), 2) + ':' + pad(a % 60, 2);
  }

  function localTZMinutes() { return -new Date().getTimezoneOffset(); }

  function randomToken(digits) {
    var n = digits || RAND_DIGITS, o = '';
    for (var i = 0; i < n; i++) o += ALPHABET.charAt(Math.floor(Math.random() * 36));
    return o;
  }

  /// 设备ID：稳定标识（Android 用 ANDROID_ID）派生。用 FNV-1a 32 位 —— 不需要跟
  /// Mac 的 64 位算法一致，设备ID 本来就是各自生成的、对外只是 6 位大写 base36。
  function deviceIdFromSeed(seed) {
    var h = 0x811c9dc5;
    var s = String(seed);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    var n = h % 2176782336;               // 36^6
    return b36encode(n, DEV_DIGITS);
  }

  function mimeForExt(ext) {
    switch (String(ext).toLowerCase()) {
      case 'png': return 'image/png';
      case 'jpg': case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      case 'webp': return 'image/webp';
      case 'heic': return 'image/heic';
      case 'pdf': return 'application/pdf';
      case 'txt': case 'md': case 'log': return 'text/plain';
      case 'json': return 'application/json';
      case 'mp4': return 'video/mp4';
      case 'mp3': return 'audio/mpeg';
      case 'm4a': return 'audio/mp4';
      case 'zip': return 'application/zip';
      default: return 'application/octet-stream';
    }
  }

  function composeText(text, o) {
    var now = (o && o.now != null) ? o.now : Date.now();
    var rand = (o && o.random) ? o.random : randomToken();
    var tz = (o && o.tz != null) ? o.tz : localTZMinutes();
    var name = parseStem(stemOf(now, o.device, rand));
    var msg = {
      v: 1, id: name.stem, kind: 'text', ts: name.ts, tsISO: isoString(name.ts, tz), tz: tz,
      from: name.dev, fromName: o.deviceName || '', text: text,
      schema: 'xiangxin.message/1'
    };
    return { name: name, msg: msg, fileName: name.stem + '.json' };
  }

  function composeFile(ref, text, o) {
    var m = composeText(text, o);
    m.msg.kind = 'file';
    m.msg.ref = ref;
    return m;
  }

  /// 从文件名 + 正文解析。**文件名是唯一真相**：正文缺字段就用文件名补，
  /// 两边打架时以文件名为准并记告警。正文整个坏掉也要能从文件名恢复出骨架。
  function parseMessage(fileName, bodyText) {
    var warnings = [];
    var name = parseStem(stemOfFile(fileName));
    if (!name) return { msg: null, warnings: ['文件名不符合格式，已忽略：' + fileName] };

    var o = {};
    try { o = JSON.parse(bodyText); if (!o || typeof o !== 'object') o = {}; }
    catch (e) { warnings.push('正文不是合法 JSON，只能用文件名里的信息：' + fileName); }

    if (typeof o.id === 'string' && sortKey(o.id) !== sortKey(name.stem)) {
      warnings.push('正文 id 与文件名不一致（以文件名为准）：' + fileName);
    }
    var v = (typeof o.v === 'number') ? o.v : 1;
    if (v > 1) warnings.push('消息版本 v=' + v + ' 高于本程序认识的 1，未知字段已忽略：' + fileName);
    if (typeof o.ts === 'number' && o.ts !== name.ts) {
      warnings.push('正文 ts 与文件名时间戳不一致（以文件名为准）：' + fileName);
    }

    var msg = {
      v: v,
      id: name.stem,
      kind: (typeof o.kind === 'string') ? o.kind : 'text',
      ts: name.ts,
      tsISO: (typeof o.tsISO === 'string') ? o.tsISO : isoString(name.ts, 0),
      tz: (typeof o.tz === 'number') ? o.tz : 0,
      from: (typeof o.from === 'string' && o.from) ? o.from.toUpperCase() : name.dev,
      fromName: (typeof o.fromName === 'string' && o.fromName) ? o.fromName : name.dev,
      text: (typeof o.text === 'string') ? o.text : '',
      ref: null,
      replyTo: (typeof o.replyTo === 'string') ? o.replyTo : null
    };
    if (o.ref && typeof o.ref === 'object') {
      msg.ref = {
        file: String(o.ref.file || ''),
        name: String(o.ref.name || ''),
        size: Number(o.ref.size || 0),
        mime: String(o.ref.mime || 'application/octet-stream'),
        sha256: String(o.ref.sha256 || '')
      };
    }
    return { msg: msg, warnings: warnings };
  }

  function isAhead(ts, now, tol) {
    return (ts - now) > (tol == null ? SKEW_TOLERANCE_MS : tol);
  }

  // ══════════════════════════════════════════════════════════
  //  已读
  // ══════════════════════════════════════════════════════════

  /// 解析一份 <设备ID>.ndjson。坏行跳过 —— 末尾半截行是预期内的。
  function parseReadLines(text) {
    var marks = [], bad = 0;
    String(text || '').split('\n').forEach(function (line) {
      var s = line.trim();
      if (!s) return;
      var o = null;
      try { o = JSON.parse(s); } catch (e) { bad++; return; }
      if (!o || typeof o !== 'object') { bad++; return; }
      var read = Array.isArray(o.read) ? o.read.map(function (x) { return String(x).toUpperCase(); }) : [];
      marks.push({
        ts: Number(o.ts || 0),
        upTo: (typeof o.upTo === 'string') ? o.upTo.toUpperCase() : null,
        read: read
      });
    });
    return { marks: marks, bad: bad };
  }

  /// 合并成一台设备的最终状态：高水位取最大，散点取并集。
  function mergeReadMarks(marks) {
    var upTo = null, read = {};
    marks.forEach(function (m) {
      if (m.upTo && (!upTo || sortKey(m.upTo) > sortKey(upTo))) upTo = m.upTo;
      m.read.forEach(function (r) { read[r] = true; });
    });
    return { upTo: upTo, read: read };
  }

  function hasRead(state, stem) {
    if (!state) return false;
    var key = sortKey(stem);
    if (state.upTo && key <= sortKey(state.upTo)) return true;
    return !!(state.read && (state.read[key] || state.read[stem]));
  }

  /// 所有设备都读过才算已读。**只比文件名，绝不比时钟。**
  /// devices 必须是"应该读到的全部设备" —— 包括还没写过已读文件的（传 null）。
  function readByAll(stem, devices) {
    if (!devices || !devices.length) return false;
    for (var i = 0; i < devices.length; i++) {
      if (!hasRead(devices[i], stem)) return false;
    }
    return true;
  }

  function compactReadMarks(marks, keepTail) {
    var keep = keepTail == null ? 200 : keepTail;
    if (marks.length <= keep) return marks;
    var sorted = marks.slice().sort(function (a, b) { return a.ts - b.ts; });
    var head = sorted.slice(0, sorted.length - keep);
    var tail = sorted.slice(sorted.length - keep);
    var best = null, scatters = {};
    head.forEach(function (m) {
      if (m.upTo && (!best || sortKey(m.upTo) > sortKey(best))) best = m.upTo;
      m.read.forEach(function (r) { scatters[r] = true; });
    });
    if (!best) return tail;
    var folded = { ts: head[head.length - 1].ts, upTo: best, read: Object.keys(scatters).sort() };
    return [folded].concat(tail);
  }

  // ══════════════════════════════════════════════════════════
  //  SHA-256（走平台的 crypto.subtle；拿不到就明确降级）
  // ══════════════════════════════════════════════════════════

  function sha256Hex(bytes) {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      return Promise.resolve(null);          // 明确返回 null = "没法校验"，不冒充成功
    }
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      var b = new Uint8Array(buf), s = '';
      for (var i = 0; i < b.length; i++) s += pad(b[i].toString(16), 2);
      return s;
    });
  }

  // ══════════════════════════════════════════════════════════
  //  base64 ↔ 字节
  // ══════════════════════════════════════════════════════════

  function base64ToBytes(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToBase64(bytes) {
    var s = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(s);
  }

  // ══════════════════════════════════════════════════════════
  //  引擎：把上面这些和 io 适配器接起来
  // ══════════════════════════════════════════════════════════

  function createEngine(io, config) {
    var cfg = {
      deviceID: String(config.deviceID).toUpperCase(),
      deviceName: config.deviceName || '',
      platform: config.platform || 'android',
      // 身份码：同一个人的多台设备填同一个。用来把"我自己的其他设备"从"对方"里排除掉。
      // 不填就默认等于设备ID（一台设备一个人时不用管它）。
      owner: (config.owner && String(config.owner).toUpperCase()) || null,
      msgDir: '消息', fileDir: '文件', readDir: '已读', deviceDir: '设备',
      seenLimit: config.seenLimit || DEFAULT_SEEN_LIMIT,
      state: config.state || null,         // {get(), set(obj)} 用来持久化"已见"集合
      // 个人资料（头像 / 账号 / 口令哈希）。**引擎不认识这些字段的含义**，
      // 只负责原样写进 设备/<ID>.json —— 这样以后加字段不用改引擎。
      profile: config.profile || {}
    };

    var messages = [];
    var byId = {};
    var seenFiles = {};
    var bodyCache = {};                    // name -> {size, mtime, msg}
    var warnings = [];

    if (cfg.state) {
      try {
        var st = cfg.state.get();
        if (st && st.seen && st.seen.length) st.seen.forEach(function (x) { seenFiles[x] = true; });
      } catch (e) { /* 状态坏了就从头开始，不是致命错误 */ }
    }

    function saveState() {
      if (!cfg.state) return;
      var keys = Object.keys(seenFiles);
      if (keys.length > cfg.seenLimit) keys = keys.sort().slice(keys.length - cfg.seenLimit);
      try { cfg.state.set({ v: 1, seen: keys }); } catch (e) { /* 存不下就算了 */ }
    }

    function ensureTree() {
      return Promise.all([cfg.msgDir, cfg.fileDir, cfg.readDir, cfg.deviceDir].map(function (d) {
        return io.mkdir(d);
      }));
    }

    function myOwner() { return cfg.owner || cfg.deviceID; }

    function announceSelf(now) {
      var t = now == null ? Date.now() : now;
      var body = {
        v: 1, deviceID: cfg.deviceID, name: cfg.deviceName, platform: cfg.platform,
        owner: myOwner(),
        lastSeen: t, lastSeenISO: isoString(t, localTZMinutes())
      };
      // 个人资料：头像 / 账号 / 口令哈希。空值不上传，免得把对方的好数据覆盖成空。
      var pf = cfg.profile || {};
      Object.keys(pf).forEach(function (k) {
        if (pf[k] !== null && pf[k] !== undefined && pf[k] !== '') body[k] = pf[k];
      });
      return io.writeText(cfg.deviceDir + '/' + cfg.deviceID + '.json',
                          JSON.stringify(body), true);
    }

    /// 设备ID -> 身份码。**没写 owner 的老设备文件按"它自己一个人一台设备"处理**（向后兼容）。
    function deviceOwners() {
      var out = {};
      out[cfg.deviceID] = myOwner();
      return io.listDir(cfg.deviceDir).then(function (list) {
        var jobs = [];
        (list || []).forEach(function (e) {
          if (e.isDir || !/\.json$/.test(e.name) || /^temp-/.test(e.name)) return;
          jobs.push(io.readText(cfg.deviceDir + '/' + e.name).then(function (txt) {
            try {
              var o = JSON.parse(txt);
              if (!o || !o.deviceID) return;
              var id = String(o.deviceID).toUpperCase();
              var ow = o.owner ? String(o.owner).toUpperCase() : '';
              out[id] = ow || id;
            } catch (err) { /* 坏文件跳过 */ }
          }).catch(function () {}));
        });
        return Promise.all(jobs).then(function () { return out; });
      }).catch(function () { return out; });
    }

    function deviceNames() {
      return io.listDir(cfg.deviceDir).then(function (list) {
        var out = {}, jobs = [];
        (list || []).forEach(function (e) {
          if (e.isDir || !/\.json$/.test(e.name) || /^temp-/.test(e.name)) return;
          jobs.push(io.readText(cfg.deviceDir + '/' + e.name).then(function (txt) {
            try {
              var o = JSON.parse(txt);
              if (o && o.deviceID && o.name) out[String(o.deviceID).toUpperCase()] = o.name;
            } catch (err) { /* 坏文件跳过 */ }
          }).catch(function () { /* 读不到就算了 */ }));
        });
        return Promise.all(jobs).then(function () { return out; });
      }).catch(function () { return {}; });
    }

    /// 设备ID -> {name, owner, avatar, account}
    ///
    /// ⚠️ 存在的意义不只是头像：原来 snapshot() 分别调 deviceNames() 和
    ///    deviceOwners()，**同一批设备文件要被读两遍**。手机到 Supabase
    ///    单次往返约 1.2 秒，这一下就省掉一整轮往返。
    function deviceProfiles() {
      return io.listDir(cfg.deviceDir).then(function (list) {
        var out = {}, jobs = [];
        (list || []).forEach(function (e) {
          if (e.isDir || !/\.json$/.test(e.name) || /^temp-/.test(e.name)) return;
          jobs.push(io.readText(cfg.deviceDir + '/' + e.name).then(function (txt) {
            try {
              var o = JSON.parse(txt);
              if (!o || !o.deviceID) return;
              var id = String(o.deviceID).toUpperCase();
              out[id] = {
                name: o.name ? String(o.name) : '',
                owner: o.owner ? String(o.owner).toUpperCase() : id,
                avatar: typeof o.avatar === 'string' ? o.avatar : '',
                account: o.account ? String(o.account) : ''
              };
            } catch (err) { /* 坏文件跳过 */ }
          }).catch(function () {}));
        });
        return Promise.all(jobs).then(function () { return out; });
      }).catch(function () { return {}; });
    }

    function scan() {
      warnings = [];
      return io.listDir(cfg.msgDir).then(function (entries) {
        var all = (entries || []).filter(function (e) {
          return !e.isDir && /\.json$/.test(e.name) && !/^temp-/.test(e.name);
        });
        var byName = {};
        all.forEach(function (e) { byName[e.name] = e; });

        var d = dedupe(all.map(function (e) { return e.name; }));
        var newCache = {};
        var jobs = d.kept.map(function (name) {
          var meta = byName[name] || { size: -1, mtime: 0 };
          var hit = bodyCache[name];
          if (hit && hit.size === meta.size && hit.mtime === meta.mtime) {
            newCache[name] = hit;
            return Promise.resolve();
          }
          return io.readText(cfg.msgDir + '/' + name).then(function (txt) {
            var r = parseMessage(name, txt);
            warnings = warnings.concat(r.warnings);
            if (r.msg) {
              r.msg.receivedAt = meta.mtime || 0;
              if (isAhead(r.msg.ts, Date.now())) {
                warnings.push('对方的钟好像快了（' + r.msg.fromName + '）：' + r.msg.id);
              }
              newCache[name] = { size: meta.size, mtime: meta.mtime, msg: r.msg };
            }
          }).catch(function () {
            warnings.push('读不了，已跳过：' + name);
          });
        });

        return Promise.all(jobs).then(function () {
          bodyCache = newCache;
          messages = [];
          byId = {};
          d.kept.forEach(function (name) {
            var hit = newCache[name];
            if (hit) { messages.push(hit.msg); byId[hit.msg.id] = hit.msg; }
          });

          var mine = cfg.deviceID;
          var newFromOthers = [], newFromMe = [];
          messages.forEach(function (m) {
            if (seenFiles[m.id]) return;
            if (m.from === mine) newFromMe.push(m); else newFromOthers.push(m);
          });

          // 目录里已经消失的从「已见」里清掉，否则同名文件再出现会被当成旧的
          var present = {};
          d.kept.forEach(function (n) { present[sortKey(stripConflict(stemOfFile(n)))] = true; });
          Object.keys(seenFiles).forEach(function (k) { if (!present[k]) delete seenFiles[k]; });

          return unreadMessages().then(function (unread) {
            return {
              messages: messages.slice(),
              newFromOthers: newFromOthers,
              newFromMe: newFromMe,
              unreadCount: unread.length,
              warnings: warnings.slice(),
              droppedDuplicates: d.dropped,
              parsedCount: messages.length
            };
          });
        });
      });
    }

    function markSeen(msgs) {
      (msgs || []).forEach(function (m) { seenFiles[m.id] = true; });
      saveState();
    }

    function readStateOf(device) {
      var id = String(device).toUpperCase();
      return io.readText(cfg.readDir + '/' + id + '.ndjson').then(function (txt) {
        var p = parseReadLines(txt);
        return { device: id, available: true, state: mergeReadMarks(p.marks) };
      }).catch(function () {
        // 读不到 = 无法证明它读过 = 当没读（宁可多显示未读，也不静默吞掉）
        return { device: id, available: false, state: null };
      });
    }

    function knownDevices() {
      var out = {};
      out[cfg.deviceID] = true;
      return io.listDir(cfg.deviceDir).then(function (list) {
        (list || []).forEach(function (e) {
          if (!e.isDir && /\.json$/.test(e.name) && !/^temp-/.test(e.name)) {
            out[sortKey(stripExt(e.name))] = true;
          }
        });
        return Object.keys(out).sort();
      }).catch(function () { return [cfg.deviceID]; });
    }

    function myReadState() {
      return readStateOf(cfg.deviceID).then(function (r) { return r.state; });
    }

    function unreadMessages() {
      return myReadState().then(function (st) {
        return messages.filter(function (m) {
          return m.from !== cfg.deviceID && !hasRead(st, m.id);
        });
      });
    }

    function receiptsFor(stem) {
      return knownDevices().then(function (devices) {
        return Promise.all(devices.map(function (d) {
          return readStateOf(d).then(function (r) { return { device: d, state: r.state }; });
        })).then(function (list) {
          var readBy = [], pending = [];
          list.forEach(function (x) {
            if (hasRead(x.state, stem)) readBy.push(x.device); else pending.push(x.device);
          });
          return {
            readByAll: readByAll(stem, list.map(function (x) { return x.state; })),
            readBy: readBy, pending: pending
          };
        });
      });
    }

    function writeMessage(name, msg) {
      var path = cfg.msgDir + '/' + name.stem + '.json';
      return io.readText(path).then(function () {
        // 已存在 -> 绝不覆盖
        return Promise.reject(new Error('文件已存在，按「只写不改」的规矩不覆盖：' + path));
      }, function () {
        return io.writeText(path, JSON.stringify(msg) + '\n', false);
      });
    }

    function sendText(text, now, random) {
      var c = composeText(text, { device: cfg.deviceID, deviceName: cfg.deviceName, now: now, random: random });
      return writeMessage(c.name, c.msg).then(function () {
        seenFiles[c.name.stem] = true;
        saveState();
        return c.msg;
      });
    }

    /// 发附件：前端已经拿到字节（<input type=file>），这里只负责
    /// ① 写进「文件/」 ② 算出 sha256 ③ 发带 ref 的消息。
    function sendAttachment(bytes, originalName, text, mime, now, random) {
      var t = now == null ? Date.now() : now;
      var rand = random || randomToken();
      var name = parseStem(stemOf(t, cfg.deviceID, rand));
      var ext = extOf(originalName) || 'bin';
      var attName = name.stem + '.' + ext.replace(/[^a-z0-9]/g, '');
      var rel = cfg.fileDir + '/' + attName;

      // ⚠️ 必须走 writeBase64（二进制通道）。写成 writeText 的话，
      // 存进去的是 base64 那一串**字符**，读回来解一次得到的是那串字符本身 ——
      // sha256 必然对不上（这个坑自检抓到过）。
      return io.writeBase64(rel, bytesToBase64(bytes), false)
        .then(function () { return sha256Hex(bytes); })
        .then(function (sha) {
          var ref = {
            file: attName, name: originalName, size: bytes.length,
            mime: mime || mimeForExt(ext), sha256: sha || ''
          };
          var c = composeFile(ref, text || '', { device: cfg.deviceID, deviceName: cfg.deviceName, now: t, random: rand });
          return writeMessage(c.name, c.msg).catch(function (e) {
            // 消息没发成 -> 把附件删掉，别留个没人引用的孤儿
            return io.delete(rel).catch(function () {}).then(function () { throw e; });
          }).then(function () {
            seenFiles[c.name.stem] = true;
            saveState();
            return c.msg;
          });
        });
    }

    function markRead(ids, asHighWater) {
      if (!ids || !ids.length) return Promise.resolve(0);
      var now = Date.now();
      var mark;
      // asHighWater 是**调用方**的政策（界面那边按"一次标 3 条以上就用高水位"来调）。
      // 引擎自己再加一层条件的话，就和 Swift 版语义不一致了 —— 自检抓到过。
      if (asHighWater) {
        var sorted = sortNames(ids.map(function (i) { return i + '.json'; }));
        var last = stripExt(sorted[sorted.length - 1]);
        mark = { ts: now, upTo: last };
      } else {
        mark = { ts: now, read: ids.map(function (i) { return String(i).toUpperCase(); }) };
      }
      return io.appendLine(cfg.readDir + '/' + cfg.deviceID + '.ndjson', JSON.stringify(mark))
        .then(function () { return ids.length; });
    }

    /// 附件是否"到齐"：**只看大小**（列表里就有），不去下载校验 ——
    /// 手机上为了一个指示器把整个附件拉下来太浪费流量。
    /// 真正的 sha256 校验发生在用户点开附件下载的时候。
    function attachmentReady(msg) {
      if (!msg || !msg.ref) return false;
      return io.stat(cfg.fileDir + '/' + msg.ref.file).then(function (e) {
        return !!e && Number(e.size) === Number(msg.ref.size);
      }).catch(function () { return false; });
    }

    function attachmentBytes(msg) {
      if (!msg || !msg.ref) return Promise.reject(new Error('不是附件消息'));
      return io.readFile(cfg.fileDir + '/' + msg.ref.file).then(function (b64) {
        var bytes = base64ToBytes(b64);
        if (msg.ref.sha256) {
          return sha256Hex(bytes).then(function (sha) {
            if (sha && sha !== msg.ref.sha256.toLowerCase()) {
              throw new Error('附件内容和记录对不上（sha256 不符），可能还在同步或已损坏');
            }
            return bytes;
          });
        }
        return bytes;
      });
    }


    /// 一次刷新需要的**全部**东西。
    ///
    /// 为什么要有这个：手机上每次网络往返都是钱和时间。
    /// 逐个调 attachmentReady() 会对每个附件各发一次 PROPFIND；
    /// 逐个调 receiptsFor() 会对每台设备的已读文件各发一次 GET。
    /// 这里把它们合并成固定的几次请求：
    ///   1× listDir(消息) + 新消息的读取
    ///   1× listDir(设备) + 每个设备文件一次 GET
    ///   1× listDir(文件)   ← 附件大小全从这一份列表里拿，不再逐个 stat
    ///   每台设备 1× GET 已读文件
    function snapshot() {
      return scan().then(function () {
        return Promise.all([deviceProfiles(), knownDevices(), listFiles()])
          .then(function (r) {
            var profs = r[0], devices = r[1], fileSizes = r[2];
            var names = {}, owners = {};
            Object.keys(profs).forEach(function (id) {
              if (profs[id].name) names[id] = profs[id].name;
              owners[id] = profs[id].owner || id;
            });
            // 自己这台的资料以本机配置为准（云端那份可能还是旧的）
            owners[cfg.deviceID] = myOwner();
            if (!names[cfg.deviceID]) names[cfg.deviceID] = cfg.deviceName;
            return Promise.all(devices.map(function (d) {
              return readStateOf(d).then(function (x) { return [d, x]; });
            })).then(function (pairs) {
              var states = {};
              pairs.forEach(function (p) { states[p[0]] = p[1]; });

              var myState = states[cfg.deviceID] ? states[cfg.deviceID].state : null;
              var deviceMap = {};
              devices.forEach(function (d) {
                var pf = profs[d] || {};
                deviceMap[d] = {
                  name: names[d] || (d === cfg.deviceID ? cfg.deviceName : d),
                  isMe: d === cfg.deviceID,
                  hasReadFile: !!(states[d] && states[d].available),
                  // 界面靠这两个字段画头像。对方那头像是**别的设备写进来的**，
                  // 页面那边会当成不可信输入再校验一次（只认 data:image/*）。
                  avatar: pf.avatar || '',
                  account: pf.account || ''
                };
              });

              var out = [], unreadCount = 0;
              messages.forEach(function (m) {
                var isMe = m.from === cfg.deviceID;
                var unread = !isMe && !hasRead(myState, m.id);
                if (unread) unreadCount++;
                var o = {
                  id: m.id, kind: m.kind, text: m.text, ts: m.ts, tsISO: m.tsISO, tz: m.tz,
                  from: m.from,
                  fromName: names[m.from] || (isMe ? cfg.deviceName : m.fromName),
                  isMe: isMe, unread: unread
                };
                if (m.ref) {
                  var sz = fileSizes[m.ref.file];
                  o.file = {
                    name: m.ref.name, size: m.ref.size, mime: m.ref.mime,
                    ready: sz != null && Number(sz) === Number(m.ref.size)
                  };
                }
                // ⚠️ 回执必须给**所有**消息都算，包括我自己发出的 ——
                // 双勾恰恰是显示在"我发出的"消息上的。之前只在收到的消息上算，
                // 结果界面上 "自己的消息" 永远拿不到 readPending，
                // 于是**双勾一直是假亮的**（undefined.length 兜底成 0 = 全读过）。
                //
                // ⚠️「对方读过」= 至少一台**别的身份**的设备读过，
                // 不是"所有设备都读过"。我自己往往有 Mac + 手机两台，
                // 用"全部读过"的话双勾永远不会出现。
                var readBy = [], pending = [], peerRead = false, peerPending = [];
                devices.forEach(function (d) {
                  var read = hasRead(states[d] ? states[d].state : null, m.id);
                  if (read) readBy.push(d); else pending.push(d);
                  if ((owners[d] || d) !== myOwner()) {
                    if (read) peerRead = true; else peerPending.push(d);
                  }
                });
                o.readByPeer = peerRead;
                o.readByAll = readBy.length === devices.length && devices.length > 0;
                o.readBy = readBy; o.readPending = pending; o.peerPending = peerPending;
                out.push(o);
              });

              return {
                ok: true, messages: out, devices: deviceMap,
                deviceID: cfg.deviceID, deviceName: names[cfg.deviceID] || cfg.deviceName,
                owner: myOwner(), owners: owners,
                root: '坚果云 WebDAV', unreadCount: unreadCount,
                warnings: warnings.slice(), now: Date.now()
              };
            });
          });
      });
    }

    /// 文件目录的 name -> size 映射（附件到齐没到齐就靠它，不再逐个 stat）
    function listFiles() {
      return io.listDir(cfg.fileDir).then(function (list) {
        var m = {};
        (list || []).forEach(function (e) { if (!e.isDir) m[e.name] = e.size; });
        return m;
      }).catch(function () { return {}; });
    }

    return {
      cfg: cfg,
      ensureTree: ensureTree,
      snapshot: snapshot,
      deviceOwners: deviceOwners,
      myOwner: myOwner,
      announceSelf: announceSelf,
      deviceNames: deviceNames,
      deviceProfiles: deviceProfiles,
      scan: scan,
      markSeen: markSeen,
      sendText: sendText,
      sendAttachment: sendAttachment,
      markRead: markRead,
      knownDevices: knownDevices,
      myReadState: myReadState,
      unreadMessages: unreadMessages,
      receiptsFor: receiptsFor,
      attachmentReady: attachmentReady,
      attachmentBytes: attachmentBytes,
      messages: function () { return messages.slice(); },
      messageById: function (id) { return byId[id] || null; }
    };
  }

  // ══════════════════════════════════════════════════════════
  //  导出
  // ══════════════════════════════════════════════════════════

  return {
    createEngine: createEngine,
    // 纯函数：给自检和别处用
    b36encode: b36encode,
    b36decode: b36decode,
    stripConflict: stripConflict,
    stemOf: stemOf,
    parseStem: parseStem,
    sortKey: sortKey,
    compareStems: compareStems,
    sortNames: sortNames,
    dedupe: dedupe,
    composeText: composeText,
    composeFile: composeFile,
    parseMessage: parseMessage,
    isoString: isoString,
    isAhead: isAhead,
    parseReadLines: parseReadLines,
    mergeReadMarks: mergeReadMarks,
    hasRead: hasRead,
    readByAll: readByAll,
    compactReadMarks: compactReadMarks,
    sha256Hex: sha256Hex,
    base64ToBytes: base64ToBytes,
    bytesToBase64: bytesToBase64,
    deviceIdFromSeed: deviceIdFromSeed,
    mimeForExt: mimeForExt,
    randomToken: randomToken,
    consts: {
      TS_DIGITS: TS_DIGITS, DEV_DIGITS: DEV_DIGITS, RAND_DIGITS: RAND_DIGITS,
      MIN_EPOCH_MS: MIN_EPOCH_MS, MAX_EPOCH_MS: MAX_EPOCH_MS,
      SKEW_TOLERANCE_MS: SKEW_TOLERANCE_MS
    }
  };
});
