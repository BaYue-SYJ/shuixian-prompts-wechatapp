# -*- coding: utf-8 -*-
"""
生成微信小程序（纯文字版）数据文件 —— v5 压缩版。

⚠️ 微信所有限制均为「源文件字节大小」（非 gzip）：
  - 主包 <= 2MB
  - 单个分包 <= 2MB
  - 所有包合计 <= 20MB

数据体量现实：约 5,200 条提示词以中文为主，原文 UTF-8 约 8.5MB。
仅清理字段/空白几乎无法缩小中文体积（3 字节/字符），因此采用压缩（保留全部原文）：
  - 正文：id\x01body\x02\x01image 拼接 → raw deflate(level9) → base64，
          按源文件 <=1.85MB 切分（当前 3 个正文分包）。
  - 索引：仍是 JSON，按 UTF-8 字节 <=1.85MB 切分（当前 1 个索引分包 i0）。
  - 运行时用极简 inflate(tiny-inflate / tinfl) 即时解压，保留全部原文。

字段只保留必要 5 个：id / title / category / prompt / image
（image 为 R2 公开 CDN URL；展示待 r2.qqsrc.com 域名备案后开启，见 app.js showImage）。
其余 author/thumb/slug/likes/resultsCount/tweet/images 全部丢弃。

用法（从仓库根目录 wechat-miniprogram/ 运行）:
    python scripts/build_miniprogram_data.py               # 全量
    python scripts/build_miniprogram_data.py --limit 3000  # 只取最新 N 条
    python scripts/build_miniprogram_data.py --dry-run     # 只测算不写文件
    python scripts/build_miniprogram_data.py --data-dir /path/to/source/data

数据源默认：环境变量 MP_SRC_DATA → 否则 ../shuixian-unified-0920/data（仓库外邻近目录）。
"""
import argparse
import base64
import glob
import json
import os
import re
import zlib
import time

# 本脚本随仓库一起发布，位于 <repo>/scripts/build_miniprogram_data.py
# ROOT = 仓库根目录（即 wechat-miniprogram/ 本身，小程序工程根）
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
MP_DIR = ROOT                        # 数据写入仓库根
INFLATE_SRC = os.path.join(SCRIPT_DIR, "tiny_inflate_src.js")  # 极简 inflate 源
# 数据源默认：环境变量 MP_SRC_DATA → 否则 ../shuixian-unified-0920/data
DEFAULT_DATA_DIR = os.environ.get("MP_SRC_DATA") or os.path.join(
    ROOT, "..", "shuixian-unified-0920", "data")
DATA_DIR = DEFAULT_DATA_DIR

# ⚠️ 微信检查的是 JS 源文件字节大小
SRC_LIMIT = int(1.85 * 1024 * 1024)   # 单包源文件上限
TOTAL_SRC_LIMIT = int(19 * 1024 * 1024)  # 总计上限（20MB 留余量）
MAIN_SRC_LIMIT = int(1.5 * 1024 * 1024)  # 主包安全线

EXCERPT_LEN = 40
TITLE_LEN = 40
FALLBACK_CAT = "其他/未归类"
# 小程序不收录「其他/未归类」（无提示词的隔离项）。
# 仅小程序侧排除；画廊 shuixian-prompts/data 仍保留 17 类（含 501 条未归类），部署版冻结不变。
EXCLUDE_CATS = {"其他/未归类"}

# 图片：公开 CDN 基址（仅存 URL，不打包；展示待备案后开 showImage）
IMG_BASE = "https://r2.qqsrc.com"

SEP_KV = "\x01"     # 条目内：id \x01 body \x01 image
SEP_ENTRY = "\x02"  # 条目间分隔
RAW_TARGET = int(3 * 1024 * 1024)  # 正文分包原始字节目标（保证 base64<=1.85MB）


def load_list(path):
    with open(path, "r", encoding="utf-8") as f:
        d = json.load(f)
    if isinstance(d, list):
        return d
    return d.get("items") or d.get("prompts") or []


def clean(s):
    """安全清洗 prompt 文本：只动空白与控制符，不改语义。"""
    s = (s or "").replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("\u2028", "\n").replace("\u2029", "\n")
    s = re.sub(r"\n{3,}", "\n\n", s)              # 三以上连续换行折叠成二
    s = "\n".join(line.rstrip() for line in s.split("\n"))  # 去行尾空白
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", s)  # 去其他控制符(防与分隔符冲突)
    return s.strip()


def collect():
    # 主数据源：优先 prompts.json；不存在则收集分片 prompts.part*.json
    # （shuixian-unified-0920/data 即采用分片格式）
    files = []
    if os.path.exists(os.path.join(DATA_DIR, "prompts.json")):
        files.append("prompts.json")
    else:
        parts = sorted(glob.glob(os.path.join(DATA_DIR, "prompts.part*.json")))
        files.extend(os.path.basename(p) for p in parts)
        if not parts:
            print("  ! 缺少 prompts.json 或 prompts.part*.json")
    files.append("prompts-twitter.json")
    rows, seen = [], set()
    excluded = 0
    for name in files:
        p = os.path.join(DATA_DIR, name)
        if not os.path.exists(p):
            continue
        for e in load_list(p):
            pid = e.get("id")
            body = clean(e.get("prompt"))
            if pid is None or not body or pid in seen:
                continue
            cat = e.get("category") or FALLBACK_CAT
            if cat in EXCLUDE_CATS:   # 小程序排除「其他/未归类」
                excluded += 1
                continue
            seen.add(pid)
            raw_img = e.get("image") or ""
            img_url = (IMG_BASE.rstrip("/") + "/" + raw_img) if raw_img else ""
            rows.append({
                "id": int(pid),
                "title": clean(e.get("title"))[:TITLE_LEN] or "未命名提示词",
                "cat": cat,
                "body": body,
                "image": img_url,
            })
    rows.sort(key=lambda r: -r["id"])
    return rows, excluded


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def js_module(payload_json, banner):
    literal = json.dumps(payload_json, ensure_ascii=False)
    return "// %s\n// 由 scripts/build_miniprogram_data.py 自动生成，请勿手改\nmodule.exports = JSON.parse(%s);\n" % (
        banner, literal,
    )


def esc_template(s):
    """模板字符串转义（当前正文走压缩，不再用模板字符串；保留以防扩展）。"""
    s = s.replace("\\", "\\\\")
    s = s.replace("`", "\\`")
    s = s.replace("${", "\\${")
    return s


# ---- 正文压缩 ----
def compress_raw(raw_text):
    """raw deflate(level9) → base64 字符串；返回 (b64, raw_utf8_bytes)。"""
    raw_bytes = raw_text.encode("utf-8")
    co = zlib.compressobj(9, zlib.DEFLATED, -15)  # -15 = 原始 deflate（无 zlib 头）
    comp = co.compress(raw_bytes) + co.flush()
    b64 = base64.b64encode(comp).decode("ascii")
    return b64, len(raw_bytes)


def chunk_base64_len(entries):
    raw = SEP_ENTRY.join((pid + SEP_KV + body + SEP_KV + img) for pid, body, img in entries)
    b64, rawlen = compress_raw(raw)
    return len(b64.encode("utf-8")), rawlen, b64


def body_js(b64, banner):
    return ("// %s\n"
            "// 压缩正文(raw deflate + base64)。脚本自动生成，请勿手改\n"
            "module.exports=%s;\n") % (banner, json.dumps(b64))


def split_body_chunks(rows):
    """按源文件(压缩后 base64) <= SRC_LIMIT 切分；自适应二分保证不超限。"""
    prepared = []
    for r in rows:
        pid = str(r["id"])
        body = r["body"]
        img = r.get("image") or ""
        rb = len((pid + SEP_KV + body + SEP_KV + img + SEP_ENTRY).encode("utf-8"))
        prepared.append((pid, body, img, rb))

    # 第一遍：按原始字节贪心切块（RAW_TARGET）
    candidates, cur, cur_b = [], [], 0
    for pid, body, img, rb in prepared:
        if cur and cur_b + rb > RAW_TARGET:
            candidates.append(cur)
            cur, cur_b = [], 0
        cur.append((pid, body, img))
        cur_b += rb
    if cur:
        candidates.append(cur)

    # 第二遍：确保每块压缩后 base64 <= SRC_LIMIT，超出则二分
    def enforce(chunks):
        out = []
        for c in chunks:
            blen, _, _ = chunk_base64_len(c)
            if blen <= SRC_LIMIT or len(c) <= 1:
                out.append(c)
            else:
                mid = len(c) // 2
                out.extend(enforce([c[:mid], c[mid:]]))
        return out

    return enforce(candidates)


def index_chunk_size(ic):
    return len(js_module(dumps(ic), "x").encode("utf-8"))


def split_index_chunks(index_rows):
    """按 UTF-8 字节(非字符) <= SRC_LIMIT 切分索引 JSON；实测+二分保证不超限。"""
    base = len(js_module([], "x").encode("utf-8"))
    candidates, cur, cur_sz = [], [], base
    for row in index_rows:
        rj = len(json.dumps(row, ensure_ascii=False).encode("utf-8"))
        if cur and cur_sz + rj + 1 > SRC_LIMIT - 50000:  # 留 50KB 余量
            candidates.append(cur)
            cur, cur_sz = [], base
        cur.append(row)
        cur_sz += rj + 1  # 数组逗号
    if cur:
        candidates.append(cur)  # 收尾：把最后一段也加入

    def enforce(chunks):
        out = []
        for c in chunks:
            if len(c) <= 1 or index_chunk_size(c) <= SRC_LIMIT:
                out.append(c)
            else:
                mid = len(c) // 2
                out.extend(enforce([c[:mid], c[mid:]]))
        return out

    return enforce(candidates)


def main():
    global DATA_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只取最新 N 条，0=全量")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--data-dir", default=DEFAULT_DATA_DIR,
                    help="数据源目录（含 prompts.part*.json / prompts-twitter.json）。"
                         "默认读 MP_SRC_DATA 环境变量，否则 ../shuixian-unified-0920/data")
    args = ap.parse_args()

    if args.data_dir and os.path.isdir(args.data_dir):
        DATA_DIR = args.data_dir
    elif not os.path.isdir(DATA_DIR):
        raise SystemExit(
            "未找到数据源目录：%s\n"
            "请用 --data-dir 指定，或设置环境变量 MP_SRC_DATA 指向 shuixian-unified-0920/data。"
            % DATA_DIR)

    print("读取数据 ...")
    rows, excluded = collect()
    print("  可用提示词:", len(rows))
    if excluded:
        print("  排除(小程序不收录):", excluded, "条（其他/未归类）")
    if args.limit:
        rows = rows[: args.limit]
        print("  按 --limit 截取:", len(rows))

    cats = sorted({r["cat"] for r in rows})
    cat_idx = {c: i for i, c in enumerate(cats)}
    cat_count = {c: 0 for c in cats}
    for r in rows:
        cat_count[r["cat"]] += 1

    # ---- 1. 切分正文分包（压缩）----
    print("切分正文分包 (压缩后源文件上限 %.2f MB) ..." % (SRC_LIMIT / 1048576))
    body_chunks = split_body_chunks(rows)
    print("  正文分包数:", len(body_chunks))

    chunk_of = {}
    for ci, ck in enumerate(body_chunks):
        for pid, _, _ in ck:
            chunk_of[int(pid)] = ci

    # ---- 2. 构建索引并切分索引分包 ----
    print("切分索引分包 ...")
    index_rows = [
        [r["id"], r["title"], cat_idx[r["cat"]],
         re.sub(r"\s+", " ", r["body"])[:EXCERPT_LEN], chunk_of[r["id"]], r["image"]]
        for r in rows
    ]
    idx_chunks = split_index_chunks(index_rows)
    print("  索引分包数:", len(idx_chunks))

    # ---- 3. 生成所有 JS 文件并测算体积 ----
    print("\n== 体积测算（源文件字节）==")

    meta = {
        "total": len(rows),
        "cats": cats,
        "catCount": [cat_count[c] for c in cats],
        "idxChunks": len(idx_chunks),
        "bodyChunks": len(body_chunks),
        "bodyRawLen": [],   # 填充：每块解压后 UTF-8 字节数（供 inflate 分配缓冲）
        "buildAt": time.strftime("%Y-%m-%d %H:%M"),
        "idRange": [rows[-1]["id"], rows[0]["id"]] if rows else [0, 0],
    }
    meta_js = js_module(dumps(meta), "元信息")
    meta_sz = len(meta_js.encode("utf-8"))

    ni = len(idx_chunks)
    nb = len(body_chunks)
    loaders_js = (
        "// 分包异步化加载器（路径必须是字面量）\n"
        "// 由 scripts/build_miniprogram_data.py 自动生成，请勿手改\n"
        "// [0..%d]=索引分包(i0..i%d)  [%d..%d]=正文分包(b0..b%d)\n"
        "module.exports = [\n"
        % (ni - 1, ni - 1, ni, ni + nb - 1, nb - 1)
        + "".join(
            "  function (ok, fail) { require('../packages/i%d/data.js', ok, fail) },\n" % i for i in range(ni)
        )
        + "".join(
            "  function (ok, fail) { require('../packages/b%d/data.js', ok, fail) },\n" % i for i in range(nb)
        )
        + "];\n"
    )
    loaders_sz = len(loaders_js.encode("utf-8"))

    main_sz = meta_sz + loaders_sz
    print("  主包(源文件): %.1f KB  (meta+loaders)" % (main_sz / 1024))
    if main_sz > MAIN_SRC_LIMIT:
        raise SystemExit("主包超安全线 %.0f KB!" % (MAIN_SRC_LIMIT / 1024))

    total_src = main_sz
    idx_js_list = []
    print("  索引分包:")
    for ici, ic in enumerate(idx_chunks):
        js = js_module(dumps(ic), "索引分包 i%d (%d-%d)" % (ici, ic[0][0], ic[-1][0]))
        sz = len(js.encode("utf-8"))
        total_src += sz
        idx_js_list.append(js)
        print("    i%-2d : %7d KB  (%d 条)%s" % (ici, sz // 1024, len(ic), "" if sz <= SRC_LIMIT else " ✗ 超!"))

    body_js_list, body_raw_lens = [], []
    print("  正文分包(压缩):")
    for bci, bc in enumerate(body_chunks):
        b64, rawlen = compress_raw(SEP_ENTRY.join((pid + SEP_KV + body + SEP_KV + img) for pid, body, img in bc))
        js = body_js(b64, "正文分包 b%d" % bci)
        sz = len(js.encode("utf-8"))
        total_src += sz
        body_js_list.append(js)
        body_raw_lens.append(rawlen)
        print("    b%-2d : %7d KB  (%d 条, 解压 %d KB)%s" % (
            bci, sz // 1024, len(bc), rawlen // 1024, "" if sz <= SRC_LIMIT else " ✗ 超!"))

    meta["bodyRawLen"] = body_raw_lens
    meta_js = js_module(dumps(meta), "元信息")
    main_sz = len(meta_js.encode("utf-8")) + loaders_sz
    total_src = main_sz
    for js in idx_js_list:
        total_src += len(js.encode("utf-8"))
    for js in body_js_list:
        total_src += len(js.encode("utf-8"))

    print("  --------")
    print("  合计     : %.2f MB / %.0f MB 上限" % (total_src / 1048576, TOTAL_SRC_LIMIT / 1048576))

    all_ok = (
        main_sz < MAIN_SRC_LIMIT
        and total_src < TOTAL_SRC_LIMIT
        and all(len(js.encode("utf-8")) <= SRC_LIMIT for js in idx_js_list + body_js_list)
    )
    print("  校验     :", "通过 ✓" if all_ok else "未通过 ✗")
    if not all_ok:
        raise SystemExit("体积超限")

    if args.dry_run:
        print("\n--dry-run，未写文件")
        return

    # ---- 4. 写入文件 ----
    print("\n写入文件 ...")

    os.makedirs(os.path.join(MP_DIR, "utils"), exist_ok=True)
    for name, content in (("meta.js", meta_js), ("loaders.js", loaders_js)):
        with open(os.path.join(MP_DIR, "utils", name), "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        print("  utils/%s" % name)

    # 极简 inflate（tinfl/miniz 端口），放入主包供运行时解压
    if os.path.exists(INFLATE_SRC):
        with open(os.path.join(MP_DIR, "utils", "inflate.js"), "w", encoding="utf-8") as f:
            f.write(open(INFLATE_SRC, "r", encoding="utf-8").read())
        print("  utils/inflate.js (极简 inflate)")

    def write_holder(pkg_dir):
        os.makedirs(os.path.join(pkg_dir, "holder"), exist_ok=True)
        holder = {
            "holder.js": "// 占位页：静态引用 data.js 防止打包忽略\nvar _data = require('../data.js');\nPage({});\n",
            "holder.json": '{"navigationBarTitleText":""}\n',
            "holder.wxml": "<view/>\n",
            "holder.wxss": "",
        }
        for n, c in holder.items():
            with open(os.path.join(pkg_dir, "holder", n), "w", encoding="utf-8") as f:
                f.write(c)

    pkg_dir = os.path.join(MP_DIR, "packages")

    for ici, js in enumerate(idx_js_list):
        d = os.path.join(pkg_dir, "i%d" % ici)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "data.js"), "w", encoding="utf-8", newline="\n") as f:
            f.write(js)
        write_holder(d)
        print("  packages/i%d/data.js (%d 条索引)" % (ici, len(idx_chunks[ici])))

    for bci, js in enumerate(body_js_list):
        d = os.path.join(pkg_dir, "b%d" % bci)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "data.js"), "w", encoding="utf-8", newline="\n") as f:
            f.write(js)
        write_holder(d)
        print("  packages/b%d/data.js (%d 条正文)" % (bci, len(body_chunks[bci])))

    app_json_path = os.path.join(MP_DIR, "app.json")
    if os.path.exists(app_json_path):
        with open(app_json_path, "r", encoding="utf-8") as f:
            app = json.load(f)
        app["subPackages"] = (
            [{"root": "packages/i%d" % i, "name": "i%d" % i, "pages": ["holder/holder"]} for i in range(ni)]
            + [{"root": "packages/b%d" % i, "name": "b%d" % i, "pages": ["holder/holder"]} for i in range(nb)]
        )
        app["preloadRule"] = {
            "pages/index/index": {
                "network": "all",
                # ⚠️ 微信限制：单个页面 preloadRule 预载的分包源文件合计 ≤ 2MB。
                # i0(索引,1.82MB)+b0(正文,1.21MB)=3.04MB 会触发 80058 错误。
                # 索引 i0 已在启动时由 store.init 加载，故这里只预载最新正文包 b0(1.21MB)，
                # 让"点最新提示词"基本无感，且不超 2MB 上限。
                "packages": ["b0"]
            }
        }
        with open(app_json_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(app, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print("  app.json 已更新 (%d 索引 + %d 正文 = %d 个分包)" % (ni, nb, ni + nb))

    print("\n完成：%d 条提示词 / %d 个分类 / %d 索引分包 + %d 正文分包" % (
        len(rows), len(cats), ni, nb))


if __name__ == "__main__":
    main()
