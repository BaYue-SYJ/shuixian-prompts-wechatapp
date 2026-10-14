var store = require('../../utils/store.js');
var fav = require('../../utils/fav.js');

Page({
  data: {
    list: []
  },

  onShow: function () {
    this.refresh();
  },

  refresh: function () {
    var self = this;
    store.init(function () {
      store.getMany(fav.all(), function (err, list) {
        if (err) return console.error('getMany:', err);
        self.setData({ list: list || [] });
      });
    });
  },

  goDetail: function (e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  removeOne: function (e) {
    var id = e.currentTarget.dataset.id;
    fav.toggle(id);
    this.refresh();
    wx.showToast({ title: '已移除', icon: 'none' });
  },

  clearAll: function () {
    var self = this;
    wx.showModal({
      title: '清空收藏',
      content: '确定要清空全部收藏吗？此操作不可撤销。',
      confirmColor: '#2C8CAB',
      success: function (res) {
        if (res.confirm) {
          fav.clear();
          self.refresh();
        }
      }
    });
  },

  goIndex: function () {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onShareAppMessage: function () {
    return { title: '水仙的AI提示词', path: '/pages/index/index' };
  }
});
