App({
  globalData: {
    // 后续 qqsrc.com 备案恢复后，把 imageBase 填成已备案的 https 图片域名，
    // 并在 app.json / 微信后台配置 downloadFile 合法域名，即可开启图片展示。
    imageBase: '',
    showImage: false
  },

  onLaunch: function () {
    var sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.globalData.windowWidth = sys.windowWidth;
  }
});
