/**
 * 数据访问层（全异步版 v5 —— 索引+正文均分包，正文走压缩）
 *
 * 索引拆分在 packages/i0, i1, ...（多个分包，需全部加载合并）
 * 正文拆分在 packages/b0, b1, ...（多个分包，按需下载 + 即时解压）
 *
 * 所有公开 API 均为 callback 形式：method(args, cb)
 *   cb(err, result)  —  err 为 null 表示成功
 *
 * 索引每项结构：[id, title, catIdx, excerpt, bodyChunkIdx]
 *
 * 正文 data.js 内容 = raw deflate(level9) + base64 字符串；
 * 运行时用极简 inflate 解压为 "id\x01body\x02..." 再解析为 {id: body}。
 */

var META = require('./meta.js');
var LOADERS = require('./loaders.js');
var inflate = require('./inflate.js');

var I_ID = 0, I_TITLE = 1, I_CAT = 2, I_EXCERPT = 3, I_BCHUNK = 4, I_IMG = 5;

// ---- 运行时解码辅助 ----
function b64ToBytes(b64) {
  // 小程序运行时用 wx.base64ToArrayBuffer；Node 测试环境已 shim
  return new Uint8Array(wx.base64ToArrayBuffer(b64));
}

function utf8Decode(u8) {
  var s = '', i = 0, n = u8.length;
  while (i < n) {
    var c = u8[i++];
    if (c < 0x80) {
      s += String.fromCharCode(c);
    } else if (c < 0xE0) {
      s += String.fromCharCode(((c & 0x1F) << 6) | (u8[i++] & 0x3F));
    } else if (c < 0xF0) {
      s += String.fromCharCode(((c & 0x0F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F));
    } else {
      var cp = ((c & 0x07) << 18) | ((u8[i++] & 0x3F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F);
      cp -= 0x10000;
      s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    }
  }
  return s;
}

function parseBodyMap(raw) {
  var map = {}, a = raw.split('\u0002'), i;
  for (i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    var p = a[i].indexOf('\u0001');
    if (p < 0) continue;
    var id = a[i].substring(0, p);
    var rest = a[i].substring(p + 1);
    var q = rest.indexOf('\u0001');
    var body = q < 0 ? rest : rest.substring(0, q);
    var img = q < 0 ? '' : rest.substring(q + 1);
    map[id] = [body, img];
  }
  return map;
}

// ---- 异步索引加载（多分包合并）----
var INDEX = null;          // 加载完成后的完整索引数组
var indexLoading = false;
var indexQueue = [];

/** 确保索引已加载（幂等） */
function ensureIndex(cb) {
  if (INDEX) { cb(null); return; }
  indexQueue.push(cb);
  if (indexLoading) return;
  indexLoading = true;

  var ni = META.idxChunks || 1; // 索引分包数量
  var loaded = [];
  var errors = [];

  function onAllDone() {
    if (errors.length) {
      indexLoading = false;
      var q = indexQueue;
      indexQueue = [];
      var err = new Error('索引加载失败: ' + errors.join('; '));
      for (var i = 0; i < q.length; i++) q[i](err);
      return;
    }
    // 合并所有索引分包
    INDEX = [];
    for (var i = 0; i < loaded.length; i++) {
      var chunk = loaded[i];
      if (chunk && chunk.length) {
        for (var j = 0; j < chunk.length; j++) INDEX.push(chunk[j]);
      }
    }
    // 按 id 降序排列（确保与原始顺序一致）
    INDEX.sort(function (a, b) { return b[I_ID] - a[I_ID]; });

    indexLoading = false;
    var q = indexQueue;
    indexQueue = [];
    for (var k = 0; k < q.length; k++) q[k](null);
  }

  var pending = ni;
  if (pending === 0) { onAllDone(); return; }

  for (var idx = 0; idx < ni; idx++) {
    (function (ci) {
      var loader = LOADERS[ci]; // loaders[0..ni-1] = 索引分包
      try {
        loader(
          function (mod) { loaded[ci] = mod; if (--pending === 0) onAllDone(); },
          function (e) { errors.push((e && e.errMsg) || ('i' + ci)); if (--pending === 0) onAllDone(); }
        );
      } catch (e) {
        errors.push(String(e));
        if (--pending === 0) onAllDone();
      }
    })(idx);
  }
}

// ---- 正文分包缓存 ----
var chunkCache = {};
var chunkLoading = {};

function loadChunk(ci, cb) {
  if (chunkCache[ci]) return cb(null, chunkCache[ci]);
  if (chunkLoading[ci]) return chunkLoading[ci].push(cb);
  var loader = LOADERS[META.idxChunks + ci]; // loaders[ni+0..ni+nb-1] = 正文分包
  if (!loader) return cb(new Error('正文分包不存在: ' + ci));

  chunkLoading[ci] = [cb];
  var done = function (err, mod) {
    var queue = chunkLoading[ci];
    delete chunkLoading[ci];
    if (!err) chunkCache[ci] = mod;
    for (var i = 0; i < queue.length; i++) queue[i](err, mod);
  };
  try {
    loader(
      function (b64) {
        // b64 = raw deflate + base64 字符串 → 解压 → 解析为 {id: body}
        try {
          var bytes = b64ToBytes(b64);
          var out = inflate(bytes, new Uint8Array(META.bodyRawLen[ci]));
          var raw = utf8Decode(out);
          done(null, parseBodyMap(raw));
        } catch (e) {
          done(new Error('正文解压失败: ' + (e && e.message)));
        }
      },
      function (e) { done(new Error((e && e.errMsg) || '分包加载失败')); }
    );
  } catch (e) {
    done(e);
  }
}

// ---- 同步辅助（仅 INDEX 就绪后调用）----
var byId = null;

function ensureMap() {
  if (byId) return byId;
  byId = {};
  for (var i = 0; i < INDEX.length; i++) byId[INDEX[i][I_ID]] = INDEX[i];
  return byId;
}

function toItem(row) {
  if (!row) return null;
  return {
    id: row[I_ID],
    title: row[I_TITLE],
    cat: META.cats[row[I_CAT]] || '其他/未归类',
    catIdx: row[I_CAT],
    excerpt: row[I_EXCERPT],
    image: row[I_IMG] || ''
  };
}

// ---- 公开 API（全部 callback）----

function init(cb) { ensureIndex(cb); }

function categories(cb) {
  ensureIndex(function (err) {
    if (err) return cb(err);
    var out = [];
    for (var i = 0; i < META.cats.length; i++) {
      out.push({ idx: i, name: META.cats[i], count: META.catCount[i] || 0 });
    }
    out.sort(function (a, b) { return b.count - a.count; });
    cb(null, out);
  });
}

function query(opt, cb) {
  ensureIndex(function (err) {
    if (err) return cb(err);
    opt = opt || {};
    var cat = (opt.catIdx === 0 || opt.catIdx) ? opt.catIdx : null;
    var kw = (opt.keyword || '').trim().toLowerCase();
    var offset = opt.offset || 0;
    var size = opt.size || 20;

    var hit = [];
    for (var i = 0; i < INDEX.length; i++) {
      var row = INDEX[i];
      if (cat !== null && row[I_CAT] !== cat) continue;
      if (kw) {
        var hay = (row[I_TITLE] + ' ' + row[I_EXCERPT] + ' ' + META.cats[row[I_CAT]]).toLowerCase();
        if (hay.indexOf(kw) === -1) continue;
      }
      hit.push(row);
    }
    var page = hit.slice(offset, offset + size).map(toItem);
    cb(null, { list: page, total: hit.length, hasMore: offset + size < hit.length });
  });
}

function getMeta(id, cb) {
  ensureIndex(function (err) {
    if (err) return cb(err);
    cb(null, toItem(ensureMap()[id]));
  });
}

function getMany(ids, cb) {
  ensureIndex(function (err) {
    if (err) return cb(err);
    var map = ensureMap(), out = [];
    for (var i = 0; i < ids.length; i++) {
      var row = map[ids[i]];
      if (row) out.push(toItem(row));
    }
    cb(null, out);
  });
}

function random(cb) {
  ensureIndex(function (err) {
    if (err) return cb(err);
    cb(null, INDEX.length ? toItem(INDEX[Math.floor(Math.random() * INDEX.length)]) : null);
  });
}

function getPrompt(id, cb) {
  ensureIndex(function (err) {
    if (err) return cb(err);
    var row = ensureMap()[id];
    if (!row) return cb(new Error('提示词不存在'));
    loadChunk(row[I_BCHUNK], function (err, mod) {
      if (err) return cb(err);
      var item = toItem(row);
      var pair = mod && mod[String(id)];
      item.prompt = (pair && pair[0]) || '';
      item.image = (pair && pair[1]) || '';
      if (!item.prompt) return cb(new Error('正文缺失'));
      cb(null, item);
    });
  });
}

module.exports = {
  meta: META,
  total: META.total,
  init: init,
  categories: categories,
  query: query,
  getMeta: getMeta,
  getMany: getMany,
  random: random,
  getPrompt: getPrompt
};
