# 河灯页：场景、交互与渲染重构

东方夜河采用远山、月色、临水建筑与漂流灯火的分层构图。页面只有一套完整氛围：流动水面、灯芯明灭、烛光倒影、指针掠水与落水涟漪、轻雾和萤火共同构成夜渡场景。取消画质档位及其本地偏好，不向访客展示性能配置；系统“减少动态效果”偏好仍会实时生效。

## 渲染结构

- `LanternArt.tsx`：莲花灯、八角灯、圆笼灯共用透明图集；独立 SVG 灯芯和透纸暖光叠加在灯体内，火焰随风倾斜、明灭。每盏灯使用稳定相位，`flameIntensity` 同时驱动灯火与水面暖反光。待审/未通过的灯不显示火焰或透光。
- `useRiverScene.ts`：背景美术保留普通图片，水面自视口高度的 44% 起单独绘制。WebGL 主路径使用纹理折射、运动法线、月色与局部灯火反光；指针轨迹和点击波纹参与水面形变与高光。无 WebGL 时采用二维水面回退。交互波纹有数量、寿命和采样频率上限。
- `sceneBudget.ts`：单一动态预算为 45 fps，画布宽度上限 1600 像素，不随 DPR 或高刷新显示器无限增加。只维护一条调度链。水面覆盖面积与像素预算用于实现有层次的动态效果，不代表真实设备上的 GPU 利用率。
- `useDialogFocus.ts`：弹窗约束焦点、支持 Escape、关闭后恢复触发位置。背景场景在弹窗打开、页面隐藏时暂停；恢复不补算隐藏期间的时间。减少动态效果与组件卸载会停止调度并清理监听器。
- `cinematic.scss`：夜河文字、木框、温润纸绢、朱印与烛光统一视觉；放灯窗、灯影集、公告、阅读笺沿用同一材质。选择状态同时有边框/文字标记，键盘焦点保持可见。手机横竖屏允许弹窗内容滚动。
- RiverBoard 路由按需加载；助手经用户主动唤起。此前已在 SPA 中启动的全局助手仍沿用既有生命周期。

这是一套背景美术与实时水面/灯火结合的分层场景，没有宣称完整三维场景、光线追踪或某款 3A 游戏的渲染规格。静态美术资产来源、生成提示词和图集规格见 [`assets/README.md`](../frontend/src/pages/RiverBoard/assets/README.md)。

## 业务与交互

保留公开留言、放灯三步流程、灯影集、我的河灯、审核状态、收回及通知链接定位。未登录门禁维持原有规则；待审/驳回灯不作为已公开留言点亮。示意河灯、真实空列表、加载失败有明确区分，失败可重试。放灯失败保留输入并显示原因，在途避免重复提交和误退出，成功后清除忙碌状态。用户输入使用 React 文本节点呈现。

主按钮、返回博客、合卷、选灯、心印与书写保持文字可辨，不依赖箭头或纯图标。放灯窗补充当前步骤，灯卡提供 `aria-pressed` 状态，输入具备可访问名称。

## 验证方式

```bash
cd frontend
npm ci
npm run fetch:widget
npx tsc --noEmit -p tsconfig.json
npm test
npm run test:unit
npm run lint
npm run test:browser -- riverboard
```

快速回归覆盖画布预算、cover 裁剪、限频、暂停/恢复、销毁，以及每盏灯不同相位的火焰强度。独立的真实页面浏览器验证拦截所有 API（包括 POST），同时阻断站外网络，不向生产环境写入：

```bash
npm run dev -- --host 127.0.0.1 --port 5174
# 另一个终端；Playwright 安装位置可通过 PLAYWRIGHT_MODULE_PATH 显式提供。
RIVER_TEST_URL=http://127.0.0.1:5174/guestbook \
RIVER_SCREENSHOTS=/tmp/riverboard-preview RIVER_RECORD=1 \
node tests/riverboard.browser.mjs
```

CI 通过 `tests/browser/riverboard.spec.ts` 调用同一份真实路由脚本，自动启动独立 Vite 服务、设置 360 秒总时限并保留失败日志/截图。这是接通现有回归的过渡桥，尚未将驱动本身完整迁入原生 TS fixture。CI 不录视频；单独录制可设 `RIVER_RECORD_ONLY=1 RIVER_RECORD=1`，避免重复完整业务流程。

该脚本要求 Chromium 软件 WebGL 可用，检查实际 renderer 为 `river-refraction`，并覆盖桌面/手机横竖屏、掠水与点击、公开阅读、门禁、失败留输入与待审成功、弹窗正反向焦点边界/Escape/暂停、系统减少动态效果、隐藏恢复、加载失败重试/空态、无默认助手启动及页面异常。旧画质存储值不再改变场景。`RIVER_RECORD=1` 额外保存一段灯火、水波与开卷过程的 WebM；它记录实际动态，不能作为硬件 GPU 测量。

运行环境使用 Chromium SwiftShader，真实 GPU 占用、帧率与发热需在用户实际显卡/浏览器上检查。本轮未在共享主机运行生产构建或修改 Nginx、服务及数据库。
