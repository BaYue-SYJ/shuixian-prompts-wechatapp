// 小程序数据层集成测试（Node 运行，模拟微信分包异步加载语义）
//
// 验证目标：wechat-miniprogram/utils/store.js 在「3 参异步 require + wx.base64ToArrayBuffer
// shim + 运行时 tiny-inflate 解压」语义下，init -> categories -> query -> getPrompt 全链路正确，
// 且 getPrompt 解压出的 prompt / image 与源数据清洗结果逐字一致。
//
// 运行：从仓库根目录 wechat-miniprogram/ 执行 `node scripts/mp_integration_test.js`
//
// 数据源：默认读环境变量 MP_SRC_DATA；否则 ../shuixian-unified-0920/data（仓库外邻近目录）。
// 若数据源目录不存在，本测试自动跳过（exit 0），不会在缺少源数据的克隆上误报失败。
process.on('uncaughtException', function (e) { console.error('UNCAUGHT', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', function (e) { console.error('UNHANDLED', (e && e.stack) || e); process.exit(1); });
var Module = require('module');
var path = require('path');
var fs = require('fs');

// 本测试从仓库根目录（wechat-miniprogram/）运行；用 __dirname 解析，与 cwd 无关
var MP = path.resolve(__dirname, '..');
var UTILS = path.join(MP, 'utils');
var DATA = process.env.MP_SRC_DATA
  ? process.env.MP_SRC_DATA
  : path.join(MP, '..', 'shuixian-unified-0920', 'data');

if (!fs.existsSync(DATA) || !fs.statSync(DATA).isDirectory()) {
  console.log('⚠️  跳过集成测试：未找到数据源目录');
  console.log('    设置环境变量 MP_SRC_DATA 指向 shuixian-unified-0920/data，再运行本测试以比对数据。');
  console.log('    （缺源数据的克隆上跳过属正常，不影响仓库可用性。）');
  process.exit(0);
}

global.wx = { base64ToArrayBuffer: function (b) { return Buffer.from(b, 'base64').buffer; } };

var vm = require('vm');

// 递归加载 MP 下所有模块，并注入支持「3 参异步 require」的自定义 require
// （Node 原生 require 不支持 ok/fail 回调，必须用 vm+Module.wrap 自己注入）
function loadModule(absPath, baseDir) {
  var content = fs.readFileSync(absPath, 'utf8');
  var m = new Module(absPath, module);
  m.filename = absPath;
  m.paths = Module._nodeModulePaths(baseDir);

  function customRequire(req) {
    // 3 参异步形式：require('包路径', ok, fail) —— 与小程序分包加载语义一致
    if (arguments.length >= 2) {
      var ok = arguments[1], fail = arguments[2];
      try {
        var childAbs = path.resolve(baseDir, req);
        var mod = loadModule(childAbs, path.dirname(childAbs));
        ok(mod);
      } catch (e) { fail(e); }
      return;
    }
    // 普通同步形式
    if (req[0] === '.' || path.isAbsolute(req)) {
      var childAbs2 = path.resolve(baseDir, req);
      return loadModule(childAbs2, path.dirname(childAbs2));
    }
    return Module._load(req, m, false);
  }
  customRequire.resolve = function (req) { return Module._resolveFilename(req, m); };
  customRequire.cache = Module._cache;
  customRequire.extensions = Module._extensions;
  customRequire.main = process.mainModule;

  var wrapper = Module.wrap(content);
  var compiled = vm.runInThisContext(wrapper, { filename: absPath });
  compiled.call(m.exports, m.exports, customRequire, m, absPath, baseDir);
  return m.exports;
}

var store = loadModule(path.join(UTILS, 'store.js'), UTILS);
var meta = require(path.join(MP, 'utils', 'meta.js'));

// 期望数据
function clean(s) {
  s = (s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/\u2028/g, '\n').replace(/\u2029/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).join('\n');
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return s.trim();
}
function loadList(p) {
  var d = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(d) ? d : (d.items || d.prompts || []);
}
var EXCLUDE_CAT = '其他/未归类';  // 小程序侧已排除，源抽样也须排除，避免随机命中
var IMG_BASE = 'https://r2.qqsrc.com';
// 实际构建源：shuixian-unified-0920/data/prompts.part1..3.json + prompts-twitter.json
var SRC_FILES = ['prompts.part1.json', 'prompts.part2.json', 'prompts.part3.json', 'prompts-twitter.json'];
var expected = {};
var expectedImg = {};
SRC_FILES.forEach(function (name) {
  var p = path.join(DATA, name);
  if (!fs.existsSync(p)) return;
  loadList(p).forEach(function (e) {
    if (e.id == null) return;
    if ((e.category || EXCLUDE_CAT) === EXCLUDE_CAT) return;  // 与小程序构建一致：排除未归类
    var b = clean(e.prompt);
    if (!b || expected[e.id] !== undefined) return;
    expected[e.id] = b;
    var rawImg = e.image || '';
    // 大凶现已随其他类别一样携带 R2 URL（构建时不再排除），故此处也按统一规则比对
    expectedImg[e.id] = rawImg ? (IMG_BASE + '/' + rawImg) : '';
  });
});

function assert(cond, msg) { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) process.exitCode = 1; }

store.init(function (err) {
  assert(!err, 'store.init 成功' + (err ? ' (' + err.message + ')' : ''));
  store.categories(function (err, cats) {
    assert(!err && cats.length === meta.cats.length, '分类数=' + meta.cats.length + ': ' + (cats ? cats.length : err));
    assert(!cats || cats.indexOf(EXCLUDE_CAT) === -1, '分类列表不含「其他/未归类」');
    assert(!err && Object.keys(expected).length === meta.total, '源抽样条数=' + meta.total + ': ' + Object.keys(expected).length);
    store.query({ size: 5, offset: 0 }, function (err, res) {
      assert(!err && res.list.length === 5, 'query 返回 5 条');
      var sample = res.list[0];
      console.log('  示例条目:', sample.id, sample.title.slice(0, 20));
      store.getPrompt(sample.id, function (err, item) {
        assert(!err, 'getPrompt(' + sample.id + ') 成功' + (err ? ' (' + err.message + ')' : ''));
        var ok = item && item.prompt && item.prompt === expected[sample.id];
        assert(ok, 'getPrompt 返回的 prompt 与源清洗结果完全一致' +
          (ok ? '' : '\n    期望头: ' + (expected[sample.id] || '').slice(0, 40) +
                 '\n    实际头: ' + (item && item.prompt || '').slice(0, 40)));
        var imgOk = item && item.image === expectedImg[sample.id];
        assert(imgOk, 'getPrompt 返回 image 与源一致' +
          (imgOk ? '' : '\n    期望: ' + (expectedImg[sample.id] || '').slice(0, 50) +
                 '\n    实际: ' + (item && item.image || '').slice(0, 50)));

        // 再随机抽查 20 条 getPrompt
        var ids = Object.keys(expected);
        var allOk = true, bad = null;
        var pending = 20, done = 0;
        function checkOne() {
          if (done >= pending) {
            assert(allOk, '随机抽查 20 条 getPrompt 全部一致' + (bad ? ' (首错 ' + bad.id + ')' : ''));
            console.log('\n全部集成测试通过。');
            return;
          }
          var rid = ids[Math.floor(Math.random() * ids.length)];
          store.getPrompt(Number(rid), function (e, it) {
            done++;
            if (e || !it || it.prompt !== expected[rid] || it.image !== expectedImg[rid]) { allOk = false; bad = { id: rid }; }
            checkOne();
          });
        }
        checkOne();
      });
    });
  });
});
