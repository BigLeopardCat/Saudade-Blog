/** Shared image and Mermaid viewer; imported together with its styles. */
import "./zoomOverlay.sass"

type ZoomPoint = { id: number; x: number; y: number }

let overlay: HTMLDivElement | null = null
let keydownHandler: ((e: KeyboardEvent) => void) | null = null
let previousOverflow = {root:"",body:""}
let previousFocus: HTMLElement | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const isSvgEl = (el: Element): boolean => el instanceof SVGSVGElement || el.tagName.toLowerCase() === "svg"

/** 源元素自然尺寸(px):img 用 naturalWidth,svg 用 viewBox,mermaid 容器取其内部 svg;兜底 getBoundingClientRect */
const naturalSize = (el: Element): [number, number] => {
  if (el.tagName.toLowerCase() === "img") {
    const img = el as HTMLImageElement
    if (img.naturalWidth > 0) return [img.naturalWidth, img.naturalHeight]
  } else if (isSvgEl(el)) {
    const svg = el as unknown as SVGSVGElement
    const vb = svg.viewBox?.baseVal
    if (vb && vb.width > 0 && vb.height > 0) return [vb.width, vb.height]
    try {
      const b = svg.getBBox()
      if (b.width > 0 && b.height > 0) return [b.width, b.height]
    } catch {
      /* 未挂载的 svg 可能取不到 bbox */
    }
  } else if (el.classList.contains("bytemd-mermaid")) {
    const svg = el.querySelector("svg")
    if (svg) return naturalSize(svg)
  }
  const r = el.getBoundingClientRect()
  if (r.width > 0 && r.height > 0) return [r.width, r.height]
  return [800, 600] // 兜底
}

export const closeZoomOverlay = (): void => {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  if (keydownHandler) {
    document.removeEventListener("keydown", keydownHandler)
    keydownHandler = null
  }
  if (!overlay) return
  const el = overlay
  overlay = null
  document.documentElement.style.overflow = previousOverflow.root
  document.body.style.overflow = previousOverflow.body
  if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true})
  previousFocus = null
  el.style.opacity = "0"
  el.addEventListener("transitionend", () => el.remove(), { once: true })
  setTimeout(() => el.remove(), 200) // 兜底(transition 被中断时)
}

export const openZoomOverlay = (source: HTMLElement): void => {
  if (overlay) closeZoomOverlay()

  // mermaid 容器(带图框)整体克隆:浮层里保留白底/边框;图片/裸 svg 直接克隆
  const isFrame = source.classList.contains("bytemd-mermaid")
  const [w0, h0] = naturalSize(source)
  const clone = source.cloneNode(true) as HTMLElement
  // 去掉源上的行内尺寸约束(宽高/max-width),尺寸由浮层控制
  const svg = isSvgEl(clone) ? clone : clone.querySelector("svg")
  if (svg) {
    svg.removeAttribute("width")
    svg.removeAttribute("height")
    ;(svg as HTMLElement).style.removeProperty("width")
    ;(svg as HTMLElement).style.removeProperty("height")
    ;(svg as HTMLElement).style.removeProperty("max-width")
    ;(svg as HTMLElement).style.removeProperty("max-height")
  }
  clone.style.margin = "0"

  // mermaid 图框的 padding/border 计入 content 尺寸,浮层里图框完整显示
  let padX = 0
  let padY = 0
  if (isFrame) {
    const cs = getComputedStyle(source)
    const f = (v: string): number => parseFloat(v) || 0
    padX = f(cs.paddingLeft) + f(cs.paddingRight) + f(cs.borderLeftWidth) + f(cs.borderRightWidth)
    padY = f(cs.paddingTop) + f(cs.paddingBottom) + f(cs.borderTopWidth) + f(cs.borderBottomWidth)
  }

  // 浮层骨架
  overlay = document.createElement("div")
  overlay.className = "md-zoom-overlay"
  overlay.setAttribute("role", "dialog")
  overlay.setAttribute("aria-modal", "true")
  overlay.setAttribute("aria-label", "图片放大视图")
  previousOverflow = {root:document.documentElement.style.overflow,body:document.body.style.overflow}
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const stage = document.createElement("div")
  stage.className = "md-zoom-stage"
  const content = document.createElement("div")
  content.className = "md-zoom-content"
  content.style.width = `${w0 + padX}px`
  content.style.height = `${h0 + padY}px`
  content.appendChild(clone)
  const closeBtn = document.createElement("button")
  closeBtn.className = "md-zoom-close"
  closeBtn.type = "button"
  closeBtn.textContent = "✕"
  closeBtn.setAttribute("aria-label", "关闭放大视图")
  const tip = document.createElement("div")
  tip.className = "md-zoom-tip"
  tip.textContent = "滚轮 / 捏合缩放 · 拖拽移动 · 双击还原 · 单击空白关闭 · Esc"
  overlay.appendChild(tip)
  setTimeout(() => {
    tip.style.transition = "opacity 0.4s"
    tip.style.opacity = "0"
    setTimeout(() => tip.remove(), 400)
  }, 3500)
  stage.appendChild(content)
  overlay.appendChild(stage)
  overlay.appendChild(closeBtn)
  document.body.appendChild(overlay)
  closeBtn.focus({preventScroll:true})

  // 变换状态:content 居中,translate+scale(transform-origin: center)
  let scale = 1
  let tx = 0
  let ty = 0
  const points = new Map<number, ZoomPoint>()
  let moved = 0 // 本次手势累计位移,区分"轻点关闭"与拖拽
  let pinchDist = 0

  const apply = (): void => {
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }
  const center = (): [number, number] => {
    const r = stage.getBoundingClientRect()
    return [r.left + r.width / 2, r.top + r.height / 2]
  }
  const fitScale = (): number => {
    const r = stage.getBoundingClientRect()
    return clamp(Math.min((r.width - 56) / (w0 + padX), (r.height - 72) / (h0 + padY)), 0.001, 1)
  }
  const readableScale = (): number => {
    const fit = fitScale()
    if (!isFrame || stage.getBoundingClientRect().width > 768) return fit
    const natural = w0 + padX
    return clamp(Math.max(fit, Math.min(1, 720 / natural)), 0.001, 1)
  }
  const zoomAt = (factor: number, px: number, py: number): void => {
    const ns = clamp(scale * factor, Math.min(fitScale(), 0.4), 16)
    const [cx, cy] = center()
    tx = px - cx - ((px - cx - tx) * ns) / scale
    ty = py - cy - ((py - cy - ty) * ns) / scale
    scale = ns
    apply()
  }
  /** 整图适配（桌面档的"还原"目标，也是窄屏双击的另一个端点） */
  const fitView = (): void => {
    scale = fitScale()
    tx = 0
    ty = 0
    apply()
  }
  const reset = (): void => {
    scale = readableScale()
    tx = 0
    ty = 0
    apply()
  }
  reset()
  // 提示语随档位变：窄屏起点是"能读"（整图被裁），双击的另一端是"整图"
  tip.textContent =
    readableScale() > fitScale() + 1e-6
      ? '双指缩放 · 拖拽移动 · 双击切换「整图 / 细节」 · 单击空白关闭'
      : '滚轮 / 捏合缩放 · 拖拽移动 · 双击还原 · 单击空白关闭 · Esc'

  // 滚轮缩放(以光标为中心)
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY)
  }
  stage.addEventListener("wheel", onWheel, { passive: false })

  // 指针:拖拽平移 / 双指捏合缩放 / 轻点空白关闭
  const onPointerDown = (e: PointerEvent): void => {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null // 任何新手势都取消 pending 关闭(防止轻点后立即拖动时被误关)
    }
    stage.setPointerCapture(e.pointerId)
    points.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY })
    moved = 0
    if (points.size === 2) {
      const [a, b] = [...points.values()]
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
    }
    stage.classList.add("md-zoom-dragging")
  }
  const onPointerMove = (e: PointerEvent): void => {
    const p = points.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    points.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY })
    if (points.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy)
      tx += dx
      ty += dy
      apply()
    } else if (points.size === 2) {
      const [a, b] = [...points.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDist > 0 && d > 0) {
        zoomAt(d / pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2)
      }
      pinchDist = d
    }
  }
  const onPointerUp = (e: PointerEvent): void => {
    points.delete(e.pointerId)
    if (points.size !== 0) return
    stage.classList.remove("md-zoom-dragging")
    if (moved >= 6) return // 拖动过,不算轻点
    // 轻点落在图片(含图框)上:不关闭,便于继续拖动/放大
    const cr = content.getBoundingClientRect()
    const M = 24 // 图框外余量
    const inContent =
      e.clientX >= cr.left - M && e.clientX <= cr.right + M &&
      e.clientY >= cr.top - M && e.clientY <= cr.bottom + M
    if (inContent) return
    // 轻点空白:延迟关闭;260ms 内再次轻点视为双击,交给 dblclick 缩放
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
      return
    }
    closeTimer = setTimeout(() => {
      closeTimer = null
      closeZoomOverlay()
    }, 260)
  }
  stage.addEventListener("pointerdown", onPointerDown)
  stage.addEventListener("pointermove", onPointerMove)
  stage.addEventListener("pointerup", onPointerUp)
  stage.addEventListener("pointercancel", onPointerUp)

  // 双击:适配 ↔ 2.5×适配
  const onDblClick = (e: MouseEvent): void => {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    e.preventDefault()
    const fit = fitScale()
    // 窄屏（起点是"能读"、整图被裁）：双击在「能读 ↔ 整图适配」之间切 —— 这两个端点才是
    // 手机上真正要来回看的两个状态。桌面档照旧在「适配 ↔ 2.5× 适配」之间切。
    if (readableScale() > fit + 1e-6) {
      if (Math.abs(scale - fit) < 0.02 && Math.abs(tx) < 1 && Math.abs(ty) < 1) {
        reset()
      } else {
        fitView()
      }
      return
    }
    if (scale <= fit * 1.05) {
      zoomAt((fit * 2.5) / scale, e.clientX, e.clientY)
    } else {
      fitView()
    }
  }
  stage.addEventListener("dblclick", onDblClick)

  // 关闭:Escape / ×
  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeZoomOverlay()
    if (e.key === "Tab") { e.preventDefault(); closeBtn.focus() }
  }
  document.addEventListener("keydown", keydownHandler)
  closeBtn.addEventListener("click", closeZoomOverlay)

  document.documentElement.style.overflow = "hidden"
  document.body.style.overflow = "hidden"
}

/**
 * 在 root 容器上做点击委托:mermaid 图(整框)与正文图片单击放大。
 * 返回清理函数。委托方式兼容 mermaid 异步渲染完成后的节点。
 */
export const initZoomDelegation = (root: HTMLElement): (() => void) => {
  const prepareDiagrams = () => {
    root.querySelectorAll<HTMLElement>('.bytemd-mermaid').forEach(diagram => {
      diagram.tabIndex = 0
      diagram.setAttribute('role', 'button')
      diagram.setAttribute('aria-label', '放大图表')
    })
  }
  prepareDiagrams()
  const observer = new MutationObserver(prepareDiagrams)
  observer.observe(root, { childList: true, subtree: true })
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const diagram = (event.target as HTMLElement).closest('.bytemd-mermaid')
    if (!diagram || overlay) return
    event.preventDefault()
    openZoomOverlay(diagram as HTMLElement)
  }
  const onClick = (e: MouseEvent): void => {
    if (overlay) return // 查看器已打开
    if (!root.contains(e.target as Node)) return
    const target = e.target as HTMLElement
    if (target.closest("a")) return // 链接内元素不拦截,保留新标签页行为
    const diagram = target.closest(".bytemd-mermaid")
    if (diagram) {
      e.preventDefault()
      openZoomOverlay(diagram as HTMLElement) // 整框克隆,mermaid 连同图框放大
      return
    }
    const img = target.closest("img")
    if (img) {
      e.preventDefault()
      openZoomOverlay(img)
    }
  }
  root.addEventListener("click", onClick)
  root.addEventListener('keydown', onKey)
  return () => {
    observer.disconnect()
    root.removeEventListener('keydown', onKey)
    root.removeEventListener("click", onClick)
    closeZoomOverlay() // 组件卸载时关闭浮层,防止残留
  }
}

declare global {
  interface Window {
    __openZoomOverlay?: (source: HTMLElement) => void
    __closeZoomOverlay?: () => void
  }
}
window.__openZoomOverlay = openZoomOverlay
window.__closeZoomOverlay = closeZoomOverlay
