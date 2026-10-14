/** 收藏（本地存储，不依赖服务器） */
var KEY = 'sx_fav_ids';

function all() {
  try {
    var v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function save(ids) {
  try { wx.setStorageSync(KEY, ids); } catch (e) {}
}

function has(id) {
  return all().indexOf(id) !== -1;
}

/** 切换收藏，返回切换后的状态 */
function toggle(id) {
  var ids = all();
  var i = ids.indexOf(id);
  if (i === -1) {
    ids.unshift(id);   // 新收藏放最前
  } else {
    ids.splice(i, 1);
  }
  save(ids);
  return i === -1;
}

function clear() {
  save([]);
}

module.exports = { all: all, has: has, toggle: toggle, clear: clear, count: function () { return all().length; } };
