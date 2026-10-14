var store = require('../../utils/store.js');
var PAGE_SIZE = 20;
var HISTORY_KEY = 'sx_search_history';

Page({
  data: {
    catIdx: null,
    catName: '',
    keyword: '',
    focus: false,
    list: [],
    offset: 0,
    hasMore: true,
    hitTotal: 0,
    searched: false,
    history: []
  },

  onLoad: function (opt) {
    var self = this;
    var catIdx = (opt.cat === undefined || opt.cat === '') ? null : parseInt(opt.cat, 10);
    var kw = opt.kw ? decodeURIComponent(opt.kw) : '';
    store.init(function () {
      var d = {
        catIdx: catIdx,
        catName: catIdx === null ? '' : (store.meta.cats[catIdx] || ''),
        keyword: kw,
        focus: opt.focus === '1',
        history: self.loadHistory()
      };
      self.setData(d);
      wx.setNavigationBarTitle({
        title: d.catName || (kw ? '搜索：' + kw : '搜索提示词')
      });
      if (catIdx !== null || kw) self.reload();
    });
  },

  loadHistory: function () {
    try { var v = wx.getStorageSync(HISTORY_KEY); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  },

  pushHistory: function (kw) {
    if (!kw) return;
    var h = this.loadHistory();
    var i = h.indexOf(kw);
    if (i !== -1) h.splice(i, 1);
    h.unshift(kw);
    h = h.slice(0, 10);
    try { wx.setStorageSync(HISTORY_KEY, h); } catch (e) {}
    this.setData({ history: h });
  },

  clearHistory: function () {
    try { wx.setStorageSync(HISTORY_KEY, []); } catch (e) {}
    this.setData({ history: [] });
  },

  reload: function () {
    var self = this;
    store.query({ catIdx: this.data.catIdx, keyword: this.data.keyword, offset: 0, size: PAGE_SIZE }, function (err, r) {
      if (err) return console.error('query:', err);
      self.setData({
        list: r.list,
        offset: r.list.length,
        hasMore: r.hasMore,
        hitTotal: r.total,
        searched: true
      });
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    });
  },

  onInput: function (e) {
    this.setData({ keyword: e.detail.value });
  },

  onConfirm: function () {
    var kw = (this.data.keyword || '').trim();
    this.pushHistory(kw);
    this.reload();
  },

  onClear: function () {
    this.setData({ keyword: '', list: [], hitTotal: 0, searched: false, offset: 0, hasMore: true });
  },

  onTapHistory: function (e) {
    this.setData({ keyword: e.currentTarget.dataset.kw }, this.onConfirm.bind(this));
  },

  onReachBottom: function () {
    if (!this.data.hasMore) return;
    var self = this;
    store.query({
      catIdx: this.data.catIdx,
      keyword: this.data.keyword,
      offset: this.data.offset,
      size: PAGE_SIZE
    }, function (err, r) {
      if (err) return;
      self.setData({
        list: self.data.list.concat(r.list),
        offset: self.data.offset + r.list.length,
        hasMore: r.hasMore
      });
    });
  },

  goDetail: function (e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  onShareAppMessage: function () {
    return { title: '水仙的AI提示词', path: '/pages/index/index' };
  }
});
