// 分包异步化加载器（路径必须是字面量）
// 由 scripts/build_miniprogram_data.py 自动生成，请勿手改
// [0..0]=索引分包(i0..i0)  [1..3]=正文分包(b0..b2)
module.exports = [
  function (ok, fail) { require('../packages/i0/data.js', ok, fail) },
  function (ok, fail) { require('../packages/b0/data.js', ok, fail) },
  function (ok, fail) { require('../packages/b1/data.js', ok, fail) },
  function (ok, fail) { require('../packages/b2/data.js', ok, fail) },
];
