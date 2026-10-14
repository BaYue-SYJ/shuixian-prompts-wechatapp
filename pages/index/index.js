var store = require('../../utils/store.js');
var PAGE_SIZE = 20;

Page({
  data: {
    total: 0,
    chips: [],
    catIdx: null,
    list: [],
    offset: 0,
    hasMore: true,
    loading: false,
    hitTotal: 0
  },

  onLoad: function () {
    var self = this;
    store.init(function (err) {
      if (err) return console.error('store.init:', err);
      store.categories(function (e, cats) {
        if (e) return console.error('categories:', e);
        var chips = [{ idx: null, name: '全部' }];
        for (var i = 0; i < cats.length; i++) chips.push({ idx: cats[i].idx, name: cats[i].name });
        self.setData({ total: store.total, chips: chips });
        self.reload();
      });
    });
  },

  reload: function () {
    var self = this;
    store.query({ catIdx: this.data.catIdx, offset: 0, size: PAGE_SIZE }, function (err, r) {
      if (err) return console.error('query:', err);
      self.setData({ list: r.list, offset: r.list.length, hasMore: r.hasMore, hitTotal: r.total });
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    });
  },

  onChip: function (e) {
    var idx = e.currentTarget.dataset.idx;
    if (idx === '' || idx === undefined) idx = null;
    if (idx === this.data.catIdx) return;
    this.setData({ catIdx: idx }, this.reload.bind(this));
  },

  onReachBottom: function () {
    if (!this.data.hasMore || this.data.loading) return;
    this.setData({ loading: true });
    var self = this;
    store.query({ catIdx: this.data.catIdx, offset: this.data.offset, size: PAGE_SIZE }, function (err, r) {
      if (err) { self.setData({ loading: false }); return; }
      self.setData({
        list: self.data.list.concat(r.list),
        offset: self.data.offset + r.list.length,
        hasMore: r.hasMore,
        loading: false
      });
    });
  },

  goSearch: function () {
    wx.navigateTo({ url: '/pages/list/list?focus=1' });
  },

  goDetail: function (e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  goRandom: function () {
    var self = this;
    store.random(function (err, item) {
      if (!err && item) wx.navigateTo({ url: '/pages/detail/detail?id=' + item.id });
    });
  },

  onShareAppMessage: function () {
    return { title: '水仙的AI提示词 · ' + store.total + ' 条精选提示词', path: '/pages/index/index' };
  },

  onShareTimeline: function () {
    return { title: '水仙的AI提示词 · ' + store.total + ' 条精选提示词' };
  }
});
