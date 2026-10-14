var store = require('../../utils/store.js');
var fav = require('../../utils/fav.js');

Page({
  data: {
    total: 0,
    catCount: 0,
    favCount: 0,
    buildAt: ''
  },

  onShow: function () {
    // meta 在主包，无需等索引；但 random 需要索引
    this.setData({
      total: store.total,
      catCount: store.meta.cats.length,
      favCount: fav.count(),
      buildAt: store.meta.buildAt
    });
  },

  goFav: function () {
    wx.switchTab({ url: '/pages/favorites/favorites' });
  },

  goRandom: function () {
    var self = this;
    store.init(function () {
      store.random(function (err, item) {
        if (!err && item) wx.navigateTo({ url: '/pages/detail/detail?id=' + item.id });
      });
    });
  },

  clearCache: function () {
    wx.showModal({
      title: '清除本地数据',
      content: '将清空收藏与搜索历史，提示词内容不受影响。',
      confirmColor: '#2C8CAB',
      success: function (res) {
        if (!res.confirm) return;
        try {
          wx.removeStorageSync('sx_fav_ids');
          wx.removeStorageSync('sx_search_history');
        } catch (e) {}
        wx.showToast({ title: '已清除', icon: 'none' });
      }
    });
  },

  onShareAppMessage: function () {
    return { title: '水仙的AI提示词 · ' + store.total + ' 条精选提示词', path: '/pages/index/index' };
  }
});
