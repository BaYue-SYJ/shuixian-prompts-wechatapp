var store = require('../../utils/store.js');
var fav = require('../../utils/fav.js');

Page({
  data: {
    id: 0,
    item: null,
    loading: true,
    error: '',
    faved: false
  },

  onLoad: function (opt) {
    var id = parseInt(opt.id, 10);
    if (!id) {
      this.setData({ loading: false, error: '缺少提示词 ID' });
      return;
    }
    var self = this;
    this.setData({ id: id });
    // 先取 meta（需索引），再拉正文
    store.init(function () {
      store.getMeta(id, function (err, meta) {
        if (!err && meta) {
          self.setData({ item: meta, faved: fav.has(id) });
          wx.setNavigationBarTitle({ title: meta.title });
        }
        self.fetch();
      });
    });
  },

  fetch: function () {
    var self = this;
    this.setData({ loading: true, error: '' });
    store.getPrompt(this.data.id, function (err, item) {
      if (err) {
        self.setData({ loading: false, error: err.message || '加载失败' });
        return;
      }
      self.setData({ item: item, loading: false });
    });
  },

  copyPrompt: function () {
    var item = this.data.item;
    if (!item || !item.prompt) return;
    wx.setClipboardData({
      data: item.prompt,
      success: function () {
        wx.showToast({ title: '提示词已复制', icon: 'none' });
      }
    });
  },

  toggleFav: function () {
    var on = fav.toggle(this.data.id);
    this.setData({ faved: on });
    wx.showToast({ title: on ? '已收藏' : '已取消收藏', icon: 'none' });
  },

  goCat: function () {
    var item = this.data.item;
    if (!item) return;
    wx.navigateTo({ url: '/pages/list/list?cat=' + item.catIdx });
  },

  onShareAppMessage: function () {
    var item = this.data.item;
    return {
      title: item ? item.title : '水仙的AI提示词',
      path: '/pages/detail/detail?id=' + this.data.id
    };
  },

  onShareTimeline: function () {
    var item = this.data.item;
    return { title: item ? item.title : '水仙的AI提示词', query: 'id=' + this.data.id };
  }
});
