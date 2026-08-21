# 留言板（河灯）GPU 性能优化与分析计划

> 现状：留言板界面 GPU 占用率 40%–60%（用户实测），需要优化；**视觉效果完全保留**是硬约束。
> 本文档为分析与分阶段实施计划，每次优化后更新「阶段记录」。
> 关联页面：[index.tsx](index.tsx) + [index.scss](index.scss)（`frontend/src/pages/RiverBoard/`）

---

## 1. 渲染管线总览

```
┌─ 每帧（requestAnimationFrame 主循环，index.tsx:1308-1376）
│
│  drawScene(ctx)                     ── canvas 2D 全屏重绘（3200×1800 @dpr2）
│   ├─ 静态基底 drawImage ×2          山体/静星（视差重投影，renderBase 已预渲染 ✓）
│   ├─ bands 水光带 ×12               22 段折线 + createLinearGradient + fill 全河宽
│   ├─ 月光碎影 46 条线 + 1 全河渐变 fill
│   ├─ streaks 流向纹 ×170            贝塞尔 stroke（每帧）
│   ├─ glints 碎光点 ×140             line/arc stroke（每帧）
│   ├─ 涟漪 ellipse ×N(活跃)          河灯周围扩散环
│   ├─ 星光闪烁 ~33 颗                每颗 2 stroke + 1 arc
│   ├─ 萤火虫 ×17                     createRadialGradient + arc（每帧建渐变）
│   ├─ 孔明灯 ×3-4                    createRadialGradient + arc（每帧建渐变）
│   └─ 流星（罕见）                    createLinearGradient + stroke
│
│  driveLanterns(dt)                  ── DOM 河灯驱动（index.tsx:1241-1314）
│   ├─ O(n²) 碰撞（n≤22，≤231 对/帧，纯 JS 开销小）
│   └─ 每盏灯每帧写 5 个样式属性：
│        transform / zIndex / opacity / filter / 内部 .rz-pool opacity
│        ★ filter: brightness()+hue-rotate() 每帧变化 → 22 个元素每帧重栅格化
│
│  scrollTick(dt)                     ── 气泡长文滚动（仅气泡展开时）
└─
```

**每盏灯的 DOM 层级（.rz-lantern，index.scss:36-130）**——22 盏 × 约 6 个动画/合成层：

| 层级 | 尺寸 | 动画 | GPU 开销点 |
|---|---|---|---|
| `.rz-halo` | 300×300 | `rz-halo-breathe` 3.6s 无限 | 大半径呼吸光晕 ×22 |
| `.rz-pool` 光斑 | 230×52 | `rz-pool-pulse` 4.1s | 渐变背景动画 |
| `.rz-pool .rz-ring` ×2 | 110×24 | `rz-ring-out` 3.4s 无限 | 与 canvas 涟漪疑似重复 |
| `.rz-flame` | 52×60 | `rz-flame-flick` steps(5) + `rz-flame-sway` | **mix-blend-mode: screen**（强制每帧与底层混合） |
| 灯本体 | 118×118 | 无（JS 驱动） | filter 每帧重栅格化 |

**CSS 级联层**：`.rz-lantern` 声明 `will-change: transform, opacity, filter` → 每盏灯强制常驻独立合成层（22 层起步，叠加内部动画层 ≈ **130 个合成层**）。弹窗 `backdrop-filter: blur(7px)`（index.scss:146/1048）在弹窗打开期间为全屏实时模糊。

---

## 2. 每帧成本分解（1600×900 视口、dpr=2 估算）

| 成本项 | 数量 | 单位成本 | GPU 影响 | 占比估 |
|---|---|---|---|---|
| canvas 全屏重绘 | 3200×1800 | 576 万像素/帧 | 纹理上传+合成 | 高 |
| canvas 绘制调用 | **≈430 次/帧**（bands 12×22 段 + 月光 46 + streaks 170 + glints 140 + 星 33×3 + 萤 17 + 灯 3） | 每次 path+fill/stroke | CPU 光栅化为主 | 高 |
| createGradient 新建 | **≈30 次/帧**（bands 12 + 萤火虫 17 + 孔明灯 3 + 流星） | 渐变对象分配 | CPU | 中 |
| 灯 filter 每帧重栅格化 | 22 元素 × 每帧 | 元素级重光栅 | **GPU 重栅格化（最大单项）** | 高 |
| 灯样式写入 | 22 × 5 属性/帧（zIndex 每帧变） | style/layout invalidate | CPU → 合成 | 中 |
| CSS 无限动画 | 22 灯 × ~5 层 | 合成器常驻 | GPU 层合成 | 中高 |
| mix-blend-mode: screen | 22（火焰） | 每帧与底层混合 | GPU | 高 |
| backdrop-filter | 弹窗开启期间 | 全屏实时模糊 | GPU | 瞬时极高 |

**结论：GPU 占用主来源按优先级**
1. **灯 `filter` 每帧重栅格化**（22 元素，最贵单点）
2. **canvas 全屏每帧重绘 + 430 次绘制调用**（渐变创建加重 CPU，合成压力转 GPU）
3. **DOM 层爆炸**：will-change 强制分层 + halo/flame/ring 无限动画 + screen 混合模式（~130 层）
4. 弹窗 backdrop-filter（瞬时）

---

## 3. 测量与基线方法（先测后改，逐项记录）

### 3.1 用户真实环境基线（GPU 占用）
- 打开留言板 → 停留 10s（等加载幕结束、河灯全量入场）
- **DevTools → Rendering → Frame Rendering Stats**：记录 FPS、GPU memory（连续 10s 均值）
- **DevTools → Performance**：录制 5s，看 GPU 时间线与 Main 线程耗时
- 或 **chrome://gpu** 确认硬件加速未失效（注意：若浏览器禁用 GPU 则测不到真实占用）
- 条件变量：① 静止观望 ② 移动鼠标（视差）③ 滚动（气泡滚动时）

### 3.2 代码内插桩（每阶段提交前自测）
在 `index.tsx` 主循环加临时 debug（合入后可留开关 `?perf=1`）：
- 每帧计数：`ctx.beginPath`/`createLinearGradient`/`fill`/`stroke` 次数（包一层计数 proxy）
- 每帧 JS 耗时（`performance.now()` 差值，60fps 预算 16.7ms）
- 当前 dpr / 灯数 / 合成层数（`chrome://tracing` 或 DevTools Layers）

### 3.3 QA 脚本回归基线
- `/tmp/qa/qa46.js` 流程不变（放灯 → 再看一眼 → 灯影集同步），新增断言：
  - rAF 驱动下 JS 帧耗时 p95 < 12ms（headless 软渲染下仅作 JS 侧基线）
  - 每帧绘制调用数 < 150（优化后目标，proxy 计数）
- 截图对照：同 viewport 同场景，优化前后像素 diff < 阈值（视觉保真硬指标）

### 3.4 基线记录表
| 日期 | 版本 | JS 帧耗时 p95 | 绘制调用/帧 | FPS | GPU% | 备注 |
|---|---|---|---|---|---|---|
| 2026-08-21 | d08ced0 | 116.7ms(idle) | ~430 | - | 40-60 | 优化前基线（headless 软渲染） |
| 2026-08-21 | 7d60224 | 116.6ms(idle，触 15fps 节流地板) | ~110 | - | 待真机复测 | P0+P1 第一轮完成 |
| 2026-08-21 | 本轮(22) | 同（headless 触底） | ~110 | - | 待真机复测 | P2-2 dpr 2→1.5（像素 -44%）+ 留言批次轮播 |

---

## 4. 分阶段优化计划

> 原则：每阶段独立可验证、可回滚；视觉以「优化前后截图并排」为准，任何像素级差异必须人工确认接受。

### 阶段 P0 — 快赢（改动小、收益最大，预计 GPU −40~50%）

| # | 改动 | 现状 → 目标 | 收益 | 视觉风险 |
|---|---|---|---|---|
| P0-1 | **灯 filter 降频** | 每帧写 `brightness(hue-rotate)` → **只在 d 档位变化时写**（如 0.05 一档）；`brightness` 改为 `opacity` 近似（近景 1.0 → 远景 0.72 系数并入 opacity） | 消除 22 元素每帧重栅格化，最大单项 | 低：0.05 档内亮度差肉眼不可察；远景微暗化需截图确认 |
| P0-2 | **zIndex 分桶写入** | 每帧 `200+round(d*1000)` → 每 50 档（d 变化 0.05 才重写） | 减少 style invalidate 频率 | 无：同档位灯排序不变（档间排序差 < 0.05 景深，视觉上本就重叠） |
| P0-3 | **渐变缓存** | 每帧 createLinearGradient/RadialGradient → 预构建复用（bands 按 alpha 档缓存 ~5 个；萤火虫/孔明灯用预渲染 offscreen 小光点纹理 drawImage 替代） | 消除 ~30 次/帧渐变分配 | 低：同参数渐变逐像素相同；光点用贴图后 alpha 混合差异需截图 |
| P0-4 | **will-change 精简** | `transform, opacity, filter` → 仅 `transform`（filter 不再每帧变后无需预分层） | 合成层数量大降 | 无 |
| P0-5 | **ring 与 canvas 涟漪去重** | 对照截图确认 `.rz-ring`（DOM）与 canvas 涟漪是否为双份视觉；留一套，砍另一套 | 22×2 动画层消失 | 需人工对照选定保留者 |

**P0 验收**：绘制调用 < 250/帧（已达成 ~110）；JS 帧耗时 p95 < 12ms（headless 触节流地板，待真机）；GPU% 用户复测。

**P0/P1 实施记录（7d60224，已完成）**
- P0-1/P0-2 ✅ filter/zIndex 换档写入（0.05 档，m._dq 缓存）
- P0-3a ✅ 萤火虫/孔明灯预渲染光点贴图（2x 超采样 drawImage）
- P0-3b ✅ 月光光晕独立预渲染层（注：最初烘焙进基底导致河面变暗 ~3 亮度值——band 宽带遮挡暖光；改为独立缓冲在 bands 之上合成，视觉恢复）
- P0-4 ✅ will-change 只留 transform
- P0-5 ✅ 保留双涟漪：DOM .rz-ring（暖光 255,208,138 光环）与 canvas 涟漪（冷光 205,222,255 水纹）颜色语义不同，非重复
- P1-1a ✅ 火焰 sway 动画 margin-left → transform: translateX（消除每帧 relayout）
- P1 新增 ✅ 慢层合并：流向纹/碎光点/涟漪 → 20fps 离屏缓冲（renderSlow），每帧约 320 次调用降为 1 次 drawImage
- P2-2 ✅ dpr 上限 2 → 1.5（DPR_CAP 常量，3200×1800 → 2400×1350，像素 -44%）——真机 35-46% 稳态未见明显下降，此刀是砍全屏重绘填充的最直接手段，观感不满可调 1.75
- 第 22 轮 ✅ 河流留言批次轮播：全量留言（时间倒序）入池，初始显示最新一批，每盏灯「眼前重入」时从批次序列取下一条 → 窗口整体向更早推进，滚到最早回最新循环（节奏 ≈ 灯漂流周期，约 1 分钟一批）；打开灯影集顺带刷新轮播池
- 第 22 轮 ✅ 用户三反馈修复（火焰退化 / 河面加宽变暗 / 星星透过山）：
  - 火焰退化根因：7d60224 把 sway 从 margin-left 改为 transform 后，CSS 同属性后声明动画覆盖（rz-flame-sway 的 transform 覆盖 rz-flame-flick 的 transform）→ 闪烁丢失。修复：拆 .rz-flame-wrap（定位 + sway）与 .rz-flame（背景渐变 + flick），两动画分属不同元素
  - 河面加宽 + 变暗：hw 0.085+0.95d² → 0.12+1.08d²（宽约 20%）；灯 u 分布 0.25-0.7 → 0.15-0.85；riverBase 渐变调暗、heart 天光 alpha 0.15/0.07/0.02、bands 0.042/0.03
  - 星星透过山修复：彻底移除 renderBase 累积的 amb.skyClip 传递（旧方案只裁最前层 #050a18，中层 #070d22 脊线高出前层处透星），改为 drawScene 内 buildSkyClip(w,h) 就地构建——三层山脊线逐 x 取 min（最终可见上缘）+ 全屏矩形 evenodd 镂空 + 视差同步平移（translate 后 clip 再 translate 回），w/h 缓存 resize 重建
  - ★ QA 教训：星星修复的两轮像素检测（34/63、38/65 在山体内）均为误报——① 左缘对联 .rz-couplet 金色字符落入检测区（排除 x<260 后消失）；② 山脊公式波长按 CSS 像素调谐（0.0042 rad/px），PIL 却喂设备像素 x（2 倍）导致曲线错位。正确坐标系下（device x/S → CSS 再回乘）山体剪影内亮像素 = 0，隔离测试（真实 Chrome Path2D+evenodd）全宽扫描亦零泄漏。clip 本身自始正确
- 第 23 轮 ✅ 六项修复（视觉 + 逻辑）：
  - 孔明灯光斑移除：amb.skyGlows 接口字段 / 初始化 / drawScene 绘制循环三处删除（KONGLING_SPRITE 常量一并移除），天空只剩月光、星星与流星
  - 河流整体调暗：riverBase 渐变 #0e1738→#02040d，接近山体（#050a18-#0b1230），河面不再比远山亮
  - 水平视差加大：drawScene 的 px 26→40（左右视角 54% 加强），lanternXY 10→14
  - 河流远端加宽：hw 系数 0.12→0.15（远端 d→0 处宽约 +25%，前端基本不变）
  - 重复留言修复（「两条相同的 test4」根因）：非批次轮换所致——是留言数 < 灯数时 `items[i % items.length]` 取模回绕，同一条留言被分到多盏灯同时漂浮。修复：① fetch 后按留言数裁剪灯数（metaRef/lanternCountRef/views 同步裁，DOM 交 React 卸载）；② 池被灯数全覆盖（留言数 ≤ 灯数）时 advanceMsg 提前返回，不做轮换——轮换语义是「更多留言分批涌来」，池内每条已唯一归属时轮换只会制造瞬时重复（若池恰好等于灯数，重入灯取下一条会拿到别的灯正在展示的留言）
  - 碰撞抖动修复（重点项）：旧机制每次只推一半穿透量 → 稳态残留重叠 → 每帧再次碰撞 → 短时间高频推挤 = 抖动观感。重写为三路分离：
    ① oX/oY 瞬态推挤：完全分离 + 6% 余量（不再半推），按帧封顶 0.4rr，深重叠两三轮内干净分开；衰减 0.9→0.975/帧（约 1.5s 归零），顶开感不被一帧拽回
    ② 水平向持久分离：整段穿透转入 u 空间（u 不衰减、clamp 河道内）——u 是碰撞的"最终解"，分解后不会因 oX 衰减重新叠回；河道收窄（~1.1px/帧）导致的再次接触是缓慢挤压，每次 ≤3.5px 单帧解完，间隔 0.5s 以上
    ③ 近垂直对（|nx|<0.25）持久分离：整段穿透转入 d 空间（d 不衰减且更深者流速更快，自增强）——否则 oY 衰减 7 帧弹回，同速同列灯对会以 ~0.12s 周期反复轻撞；含 1.15 补偿（d^1.42 凹曲线下区间位移比局部导数小 ~13%，不补偿会在 oY 衰减后贴回接触阈值）
    - 验证：确定性模拟（sim_collision5，与实现逐行一致）五场景全 PASS——深重叠/轻接触/垂直同速/垂直追越(10px/s、2px/s) 均恰好 1 次碰撞事件、带余量分开、零回弹；对照旧算法深重叠 90 帧 18 次碰撞
  - TS 清理：allTalks state 只写不读 → 移除（留 allTalksRef）；KONGLING_SPRITE 未用 → 移除；fetch 内联类型补 talkKey
- 待办：P1-1b 火焰 mix-blend-mode: screen A/B 测试、P1-3 远景灯停动画、P2-1 水光纹理滚动、P2-3 自适应降级

### 阶段 P1 — 合成层瘦身（预计再降 20~30%）

| # | 改动 | 说明 | 视觉风险 |
|---|---|---|---|
| P1-1 | **火焰去掉 mix-blend-mode: screen** | 火焰光晕改为预渲染精灵（5 帧 steps 动画帧合成进一张雪碧图，光晕烘焙进 sprite），去掉 screen 混合与 radial-gradient 动画 | 中：火焰视觉最敏感，需逐帧截图对照；保留 sway 用 transform（合成器属性） |
| P1-2 | **halo 呼吸降级** | `rz-halo-breathe`（300×300 大半径 opacity 动画）→ 改用 transform: scale(0.98~1.02) 呼吸（合成器属性）或预渲染光晕贴图 | 低：呼吸幅度小，scale 呼吸视觉等价 |
| P1-3 | **远景灯降级** | d < 0.15 的灯：停掉内部动画层（halo/flame/pool 类名切换），仅留静态精灵 | 低：远景灯本就小（scale≈0.18），细节不可察 |
| P1-4 | **灯数自适应** | 22 → 视口宽度自适应（>1920 保持 22，<1440 减到 14-16）；或按性能预算裁远景灯 | 低：密度视觉略变，人工确认 |

### 阶段 P2 — canvas 重架构（大改，单独排期，预计再降 20%）

| # | 改动 | 说明 | 风险 |
|---|---|---|---|
| P2-1 | **水光层纹理滚动** | bands+streaks+glints 合成到一段预渲染 offscreen 纹理（河面宽度 × 2-3 屏高），每帧仅 drawImage 带偏移滚动，**几何重绘降为 0**（视觉流动感由纹理位移模拟，需调参对齐现视觉） | 高：水光是最精细的视觉层，需大量 A/B 截图；失败可整体回滚此层 |
| P2-2 | **dpr 动态降采样** | 静态 dpr=min(2, devicePixelRatio) → 按帧耗时预算动态：p95 > 14ms 时 dpr 降到 1.5/1.25（canvas 重采样由浏览器缩放，视觉近等价） | 低：dpr 1.5 与 2 在 118px 灯精灵下差异极小 |
| P2-3 | **帧率自适应降级** | 主循环统计近 60 帧平均耗时，超预算自动套用 `reduced()` 降级路径（现成实现，index.tsx:1372），预算恢复时自动还原 | 低：reduced() 路径已存在且验证过，仅触发条件从系统偏好扩为动态预算 |

### 阶段 P3 — 防退化纪律（长期）

- 未来新增动画的提交检查清单（写入 CLAUDE.md 约定）：
  - 新动画只允许 transform/opacity（合成器属性）；禁 filter、禁 mix-blend-mode、禁 backdrop-filter 常驻
  - 新 canvas 绘制禁止每帧 `createGradient`；一律预构建/贴图
  - 新增灯/粒子数必须先跑 P0 基准（绘制调用/帧）
- 每季度复测基线表，GPU% 漂移 > 10% 触发排查

---

## 5. 验证清单（每阶段完成时）

- [ ] 基线表更新（JS 帧耗时 p95 / 绘制调用 / FPS / GPU%）
- [ ] 截图对照通过：静止 / 视差 / 滚动 三场景，像素 diff 在阈值内或人工确认
- [ ] 功能回归：`/tmp/qa/qa46.js` 全绿（放灯、再看一眼、灯影集实时同步）
- [ ] 动效完整：河灯入场、涟漪、萤火虫、流星、月光碎影、气泡滚动逐项目检
- [ ] 提交：仅相关文件，中文 commit，`-` 项目符号

## 6. 风险与回滚

- **最大风险点**：P1-1（火焰）与 P2-1（水光纹理）——视觉最敏感的两层。策略：各层独立封装（火焰 sprite 与光晕互不耦合；水光纹理层独立函数），失败即单独回滚该层，不影响其余优化。
- 所有改动均为前端单文件（index.tsx / index.scss），回滚 = 切回上一 commit，成本低。
- dpr 降采样与灯数自适应属「按预算浮动」，用户环境不同可能看到不同密度——确认用户接受后再默认开启，否则做成 `?perf=0` 开关兜底。
