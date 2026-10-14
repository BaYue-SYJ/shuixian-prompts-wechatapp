var store = require('../../utils/store.js');

Page({
  data: {
    cats: [],
    total: 0
  },

  onLoad: function () {
    var self = this;
    store.init(function (err) {
      if (err) return console.error('store.init:', err);
      store.categories(function (e, cats) {
        if (e) return console.error('categories:', e);
        self.setData({ cats: cats, total: store.total });
      });
    });
  },

  goCat: function (e) {
    wx.navigateTo({ url: '/pages/list/list?cat=' + e.currentTarget.dataset.idx });
  },

  goSearch: function () {
    wx.navigateTo({ url: '/pages/list/list?focus=1' });
  },

  onShareAppMessage: function () {
    return { title: '水仙的AI提示词 · 全部分类', path: '/pages/category/category' };
  }
});
