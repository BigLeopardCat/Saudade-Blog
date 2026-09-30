# -*- coding: utf-8 -*-
"""标签管理页「选中即填充 → 就地改 / 删」的验收（用户 20261001 第 2 条）。

原话：「标签管理界面操作逻辑优化，选中右侧的标签，左侧参数自动填充，进而实现快速
二次编辑或者删除。」

改版前的实况：左侧那张表单**只会新增**。选中右侧树里的标签只有两条路 —— 删除（直接吃
selectedKeys）与弹窗编辑（弹窗里是另一套 title/color 输入框）。于是"把「Python」改个名"
要：选中 → 点编辑 → 在弹窗里改 → 保存，四个动作；而左侧明明有同样的四个字段，填进去却
只会在提交时**新建一个同名标签**。

这一版：选中一个节点就把 title/level/fatherTag/color 灌进左侧表单，主按钮在
「添加 ↔ 保存修改」之间切换，弹窗整块删掉。

为什么必须真跑浏览器而不是读源码：这一条的正确性全在**交互之后的状态**里 ——
表单里到底显示的是谁、主按钮此刻是哪个动词、点了它发出去的是 PUT 还是 POST、
发的是哪张表的哪个 id。源码里 `form.setFieldsValue` 写着不代表 Tree 的 onSelect 真的
接上了（antd 的 `multiple` 树点击是**切换**语义，点第二次是取消选中）；也不代表
"取消选中之后表单被清空"——而那一条（不清空 ⇒ 主按钮回到「添加」⇒ 一点就建出一个
同名标签）正是这次填充必然会带出来的新坑。

沙箱：真 antd（Tree/Form/Select/ColorPicker 都是真的，esbuild 直接打真组件），
只桩三个边界 —— axios 单例（换成一个内存里的假标签库，顺带记录每一次请求）、
redux 的 store thunk、以及 liveRefresh（它带着定时器，沙箱里不需要）。

用法：python3 frontend/tests/tag-manage.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd）、playwright(python)。
"""
import json
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"

DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production",'
          '"DEV":false,"PROD":true,"BASE_URL":"/"}')

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


# 假标签库：一级 10 编程 / 11 生活，二级 5 Python(父 10) / 6 Rust(父 10) / 7 咖啡(父 11)。
# 二级的名字刻意与一级**不重名**，且父子名字都能单独搜到；`咖啡` 用来验"只改一个不动别人"。
SEED = {
    "one": [{"key": 10, "title": "编程", "color": "#1677ff"},
            {"key": 11, "title": "生活", "color": "#52c41a"}],
    "two": [{"key": 5, "title": "Python", "color": "#1677ff", "fatherKey": 10},
            {"key": 6, "title": "Rust", "color": "#eb2f96", "fatherKey": 10},
            {"key": 7, "title": "咖啡", "color": "#fa8c16", "fatherKey": 11}],
}


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="tag-manage-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    # ── 边界①：axios 单例 → 内存假库。**必须换掉而不是打网络**：这一套件量的是
    # "点了保存之后发出去的是哪个请求"，真发出去就变成量后端了。
    # 返回值的形状照抄 axios 的响应（`res.status` / `res.data.data`），TagMethods 读的就是这两处。
    (sb / "src/apis/axios.tsx").write_text('''\
const w: any = window;
w.__calls = [];
const resp = (payload: any, status = 200) => ({status, data: payload});

const http = async (cfg: any) => {
  const db = w.__db;
  const method = (cfg.method || 'GET').toUpperCase();
  w.__calls.push({url: cfg.url, method, data: cfg.data});
  if (cfg.url === '/api/public/tagone' && method === 'GET') {
    return resp({code: 200, data: db.one.map((t: any) => (
      {tagKey: t.key, title: t.title, level: 1, color: t.color}))});
  }
  if (cfg.url === '/api/public/tagtwo' && method === 'GET') {
    return resp({code: 200, data: db.two.map((t: any) => ({
      tagKey: t.key, title: t.title, level: 2, color: t.color,
      fatherKey: t.fatherKey,
      fatherTag: (db.one.find((o: any) => o.key === t.fatherKey) || {}).title}))});
  }
  const upd = /^\\/api\\/protected\\/(tagone|tagtwo)\\/(\\d+)$/.exec(cfg.url);
  if (upd && method === 'PUT') {
    const bucket = upd[1] === 'tagone' ? db.one : db.two;
    const row = bucket.find((t: any) => t.key === Number(upd[2]));
    if (row) { row.title = cfg.data.title; row.color = cfg.data.color; }
    return resp({code: 200});
  }
  if (cfg.url === '/api/protected/tag' && method === 'DELETE') {
    const {level, ids} = cfg.data;
    if (level === 'one') {
      db.one = db.one.filter((t: any) => !ids.includes(t.key));
      db.two = db.two.filter((t: any) => !ids.includes(t.fatherKey));   // FK ON DELETE CASCADE
    } else {
      db.two = db.two.filter((t: any) => !ids.includes(t.key));
    }
    return resp({code: 200});
  }
  return resp({code: 200});
};
export default http;
''', encoding="utf-8")

    # 边界②：标签字典的 redux thunk。它内部也是打接口的，沙箱里这两个 GET 由上面的假库
    # 负责，这里只要一个能 dispatch 的壳（component 只关心"派发过去了"）。
    (sb / "src/store/components/tags.tsx").write_text('''\
export const fetchTags = () => ({type: 'tags/stub'});
''', encoding="utf-8")

    # 边界③：liveRefresh 带着 20 秒轮询定时器，沙箱里不需要（挂载期它本来就不拉）
    (sb / "src/utils/liveRefresh.ts").write_text('''\
export const AGENT_TURN_DONE_EVENT = 'agent-turn-done';
export const useLiveRefresh = (_fn: any, _opts?: any) => undefined;
''', encoding="utf-8")

    # react-redux：全站单例，沙箱里给个不发请求的壳
    (sb / "redux-stub.tsx").write_text('''\
const state: any = {};
export const useSelector = (fn: any) => { try { return fn(state); } catch { return undefined; } };
export const useDispatch = () => (_a: any) => undefined;
export const Provider = ({children}: any) => children;
''', encoding="utf-8")

    (sb / "entry.tsx").write_text('''\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import AllTag from './src/pages/Dashboard/Notes/AllTag/index.tsx';

(window as any).__mount = () => {
  createRoot(document.getElementById('root')!).render(<AllTag />);
};
''', encoding="utf-8")

    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                    "--bundle", "--format=iife", "--outfile=bundle.js",
                    "--loader:.sass=text", "--jsx=automatic", f"--define:{DEFINE}",
                    "--loader:.png=dataurl", "--loader:.svg=dataurl", "--loader:.css=text",
                    f"--alias:react-redux={sb}/redux-stub.tsx"],
                   cwd=str(sb), check=True, capture_output=True)

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>'
        '<div id="root"></div><script src="bundle.js"></script></body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()

from playwright.sync_api import sync_playwright  # noqa: E402

# 读左侧表单：按 **label 文字**取那一个 Form.Item 里的输入控件。
# 不用 antd 生成的 id（`标签管理_title` 那种）：id 由 Form 的 name 拼出来，
# 改个表单名就会让整套断言静默变成 null。
READ = """() => {
  const items = [...document.querySelectorAll('.newTagForm .ant-form-item')];
  const byLabel = (label) => {
    const it = items.find(i => (((i.querySelector('label') || {}).textContent) || '').trim() === label);
    if (!it) return null;
    // ⚠️ antd 的 ColorPicker 不是 <input>（`showText` 时那个色号是一枚 span），
    // Select 的值也存在 `.ant-select-selection-item` 里 —— 三处都要认，
    // 否则断言读到 null，看起来像"没填充"，其实是"读错了地方"。
    const input = it.querySelector('input');
    const sel = it.querySelector('.ant-select');
    const selItem = it.querySelector('.ant-select-selection-item');
    const swatch = it.querySelector('.ant-color-picker-trigger-text');
    // ⚠️ Select 内部**也有一个 `<input>`**（`.ant-select-selection-search-input`，永远是空的）。
    // 先取 input 的写法会把"选中的是哪一项"读成空串 —— 本套件初版就是这么把
    // 「等级填成二级」判红的（值其实填对了，是读错了地方）。所以 Select 先认 selection-item。
    return {
      value: sel
             ? (selItem ? (selItem.getAttribute('title') || selItem.textContent) : '')
             : (input ? input.value : (swatch ? swatch.textContent.trim() : null)),
      disabled: sel ? sel.classList.contains('ant-select-disabled')
                    : (input ? input.disabled : null),
    };
  };
  const submit = document.querySelector('.newTagForm button[type=submit]');
  // 顶部那条提示条：认 `.ant-alert` 而不是 `.ant-alert-info` —— 它是**变档**的
  // （正在修改=info / 多选=warning），钉死 info 会让 warning 档读成 null。
  // 表单里还有第二条 Alert（底部那个计数），它在 DOM 里排在后面，querySelector 取到的是第一条。
  const banner = document.querySelector('.newTagForm .ant-alert');
  // antd 的 autoInsertSpace 会在两个汉字之间插一个空格（「添 加」）——抹掉空白再比
  const txt = (el) => el ? el.textContent.replace(/\\s+/g, '') : null;
  return {
    title: byLabel('标签名称'),
    level: byLabel('标签等级'),
    father: byLabel('父标签'),
    color: byLabel('标签颜色'),
    button: txt(submit),
    banner: txt(banner),
    tree: [...document.querySelectorAll('.ant-tree-title')].map(e => e.textContent.trim()),
  };
}"""


def click_node(pg, name):
    """点树里那个**文字恰好等于 name** 的节点（`.ant-tree-treenode` 会连子孙的文字一起命中，
    所以取最里层的 `.ant-tree-title`）。multiple 树里再点一次 = 取消选中。"""
    hit = pg.evaluate("""(name) => {
        const el = [...document.querySelectorAll('.ant-tree-title')]
            .find(e => e.textContent.trim() === name);
        if (!el) return false;
        el.click();
        return true;
    }""", name)
    pg.wait_for_timeout(250)
    return hit


def calls(pg):
    return pg.evaluate("() => window.__calls")


def clear_calls(pg):
    pg.evaluate("() => { window.__calls = []; }")


def main():
    url = SANDBOX.as_uri() + "/index.html"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1440, "height": 900})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))

        print("\n① 初始态：没选中任何标签 ⇒ 表单是空的、「添加」")
        pg.goto(url)
        pg.evaluate("(db) => { window.__db = db }", SEED)
        pg.evaluate("() => window.__mount()")
        pg.wait_for_selector(".ant-tree-title", timeout=5000)
        pg.wait_for_timeout(300)
        st = pg.evaluate(READ)
        check("右树渲染出 5 个标签", sorted(st["tree"]) == sorted(["编程", "生活", "Python", "Rust", "咖啡"]),
              str(st["tree"]))
        check("初始时标签名称是空的", st["title"]["value"] == "", repr(st["title"]["value"]))
        check("初始时主按钮是「添加」", st["button"] == "添加", st["button"])
        check("初始时没有「正在修改…」提示条", "正在修改" not in st["banner"], st["banner"])

        print("\n② 选中一个二级标签 ⇒ 左侧四个字段全部自动填充")
        check("点得到「Python」那个节点", click_node(pg, "Python"))
        st = pg.evaluate(READ)
        check("标签名称填成 Python", st["title"]["value"] == "Python", repr(st["title"]["value"]))
        check("标签等级填成「二级标签」", st["level"]["value"] == "二级标签", st["level"]["value"])
        check("父标签填成「编程」", (st["father"] or {}).get("value") == "编程", str(st["father"]))
        check("标签颜色填成 Python 自己的色（#1677ff）",
              (st["color"]["value"] or "").lower() in ("#1677ff", "1677ff"), repr(st["color"]["value"]))
        check("主按钮变成「保存修改」", st["button"] == "保存修改", st["button"])
        check("提示条写明正在改的是谁", "Python" in st["banner"] and "二级" in st["banner"], st["banner"])
        # 层级/父级在修改态是灰的：PUT 端点契约上只收 title+color，换层级走另一条端点
        check("修改态下「标签等级」是禁用的（层级不可就地改）", st["level"]["disabled"] is True,
              str(st["level"]["disabled"]))
        check("修改态下「父标签」是禁用的", st["father"]["disabled"] is True, str(st["father"]["disabled"]))

        print("\n③ 改名 + 保存 ⇒ 打的是 PUT /tagtwo/5，且改完树上是新名字")
        clear_calls(pg)
        pg.locator(".newTagForm input").first.fill("Python3")
        pg.locator(".newTagForm button[type=submit]").click()
        pg.wait_for_timeout(400)
        cs = calls(pg)
        puts = [c for c in cs if c["method"] == "PUT"]
        check("发了且只发了一条 PUT", len(puts) == 1, json.dumps(cs, ensure_ascii=False)[:200])
        if puts:
            check("打的是二级标签那个 id 的端点（/api/protected/tagtwo/5）",
                  puts[0]["url"] == "/api/protected/tagtwo/5", puts[0]["url"])
            check("只提交 title/color 两个字段（层级/父级不进请求体）",
                  sorted(puts[0]["data"].keys()) == ["color", "title"], str(puts[0]["data"]))
            check("提交的是改后的名字", puts[0]["data"]["title"] == "Python3", str(puts[0]["data"]))
        check("没有误发 POST（新增）", not [c for c in cs if c["method"] == "POST"],
              json.dumps(cs, ensure_ascii=False)[:200])
        st = pg.evaluate(READ)
        check("改完树上显示新名字", "Python3" in st["tree"], str(st["tree"]))
        check("改完仍停在修改态（选中没丢）", st["button"] == "保存修改", st["button"])

        print("\n④ 取消选中 ⇒ 表单清空、主按钮回到「添加」")
        click_node(pg, "Python3")
        st = pg.evaluate(READ)
        check("标签名称已清空（不清的话下一次「添加」就是照抄一个同名标签）",
              st["title"]["value"] == "", repr(st["title"]["value"]))
        check("主按钮回到「添加」", st["button"] == "添加", st["button"])
        check("提示条消失", "正在修改" not in st["banner"], st["banner"])
        check("「取消选中」按钮此时不可点", pg.locator(
            ".newTagForm button:has-text('取消选中')").is_disabled())

        print("\n⑤ 选中一级标签 ⇒ 走 /tagone/:id；删除按层级分组")
        click_node(pg, "生活")
        st = pg.evaluate(READ)
        check("标签等级填成「一级标签」", st["level"]["value"] == "一级标签", st["level"]["value"])
        check("一级标签不显示「父标签」那一栏", st["father"] is None or st["father"]["value"] in (None, ""),
              str(st["father"]))
        clear_calls(pg)
        pg.locator(".newTagForm input").first.fill("日常")
        pg.locator(".newTagForm button[type=submit]").click()
        pg.wait_for_timeout(400)
        puts = [c for c in calls(pg) if c["method"] == "PUT"]
        check("一级标签改名打的是 /api/protected/tagone/11",
              len(puts) == 1 and puts[0]["url"] == "/api/protected/tagone/11",
              json.dumps(puts, ensure_ascii=False)[:200])
        st = pg.evaluate(READ)
        check("树上显示「日常」", "日常" in st["tree"], str(st["tree"]))

        print("\n⑥ 多选是**加选**（rc-tree 的 arrAdd 语义）⇒ 选中两个以上时左侧不填充")
        # 上一步「日常」还选着。此时点「咖啡」不是"改选"而是"加选"，两个都在选中态里 ——
        # 这一条把"左侧表单里是谁"与"删除会删掉谁"钉在一起：多选时左侧必须是空的，
        # 绝不能出现"表单里显示 A、点删除却把 A 和 B 一起删了"。
        click_node(pg, "咖啡")
        st = pg.evaluate(READ)
        check("选中两个标签后左侧不填充（回到新增态）",
              st["title"]["value"] == "" and st["button"] == "添加",
              f"{st['title']['value']!r}/{st['button']}")
        check("提示条说明这是批量删除模式",
              "批量删除" in st["banner"] and "2" in st["banner"], st["banner"])

        print("\n⑦ 批量删除：选中「日常」(一级 11) + 「咖啡」(二级 7) ⇒ 按层级发两条 DELETE")
        # 选中集里跨了两个层级：后端接口一次只收一张表（见 delTag 注释），所以这里
        # 应当是**两条**请求，各自只带自己那一层的 id —— 旧接口把两级 id 混在一个数组里、
        # 两张表各删一遍，删一级 #11 会顺手删掉二级 #11。
        clear_calls(pg)
        pg.locator(".newTagForm .ant-btn-dangerous").click()
        pg.wait_for_timeout(400)
        dels = [c for c in calls(pg) if c["method"] == "DELETE"]
        check("按层级发了两条 DELETE（不是一条混合的）", len(dels) == 2,
              json.dumps(dels, ensure_ascii=False)[:200])
        got = {c["data"]["level"]: c["data"]["ids"] for c in dels}
        check("一级那条只带一级的 id", got.get("one") == [11], str(got))
        check("二级那条只带二级的 id", got.get("two") == [7], str(got))
        st = pg.evaluate(READ)
        check("树上「日常」「咖啡」都没了", "日常" not in st["tree"] and "咖啡" not in st["tree"],
              str(st["tree"]))
        check("「编程」那一支不受影响（Rust / Python3 还在）",
              "编程" in st["tree"] and "Rust" in st["tree"] and "Python3" in st["tree"], str(st["tree"]))
        check("删完表单清空、回到「添加」",
              st["title"]["value"] == "" and st["button"] == "添加", f"{st['title']['value']!r}/{st['button']}")

        print("\n⑧ 单删 + FK 级联：删一级「编程」⇒ 它下面的二级标签一起走")
        click_node(pg, "编程")
        st = pg.evaluate(READ)
        check("选中「编程」后表单填的是编程", st["title"]["value"] == "编程", repr(st["title"]["value"]))
        clear_calls(pg)
        pg.locator(".newTagForm .ant-btn-dangerous").click()
        pg.wait_for_timeout(400)
        dels = [c for c in calls(pg) if c["method"] == "DELETE"]
        check("只发了一条 DELETE", len(dels) == 1, json.dumps(dels, ensure_ascii=False)[:200])
        if dels:
            check("删一级标签带的是 level=one（这就是那个「删错层级」老毛病）",
                  dels[0]["data"]["level"] == "one", str(dels[0]["data"]))
            check("删除体只含被选中的那个 id（10）", dels[0]["data"]["ids"] == [10], str(dels[0]["data"]))
        st = pg.evaluate(READ)
        check("树上没有「编程」了", "编程" not in st["tree"], str(st["tree"]))
        check("它下面的二级标签也没了（FK 级联；沙箱假库照真库语义写的）",
              "Python3" not in st["tree"] and "Rust" not in st["tree"], str(st["tree"]))
        check("删完表单清空、回到「添加」",
              st["title"]["value"] == "" and st["button"] == "添加", f"{st['title']['value']!r}/{st['button']}")

        print("\n⑨ 对照：此刻表单是空的 ⇒ ② 组读到的「Python」只可能来自那次点击")
        # 判据没牙 = 没测。这一条是 ② 组的负空间：经历了一整轮增删改之后表单又回到空态，
        # 说明 ② 组读到的值确实**由点击产生**，而不是"表单本来就有值"或"读的是树上的文字"。
        st_before = pg.evaluate(READ)
        check("（对照）此刻标签名称是空的", st_before["title"]["value"] == "",
              repr(st_before["title"]["value"]))
        check("（对照）此刻主按钮是「添加」", st_before["button"] == "添加", st_before["button"])

        check("全程无 JS 报错", not errs, str(errs[:1]))
        browser.close()

    print("\n%s 标签管理「选中即填充」：%d 失败" % ("✗" if FAILS else "✓", len(FAILS)))
    for f in FAILS:
        print("   - " + f)
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
