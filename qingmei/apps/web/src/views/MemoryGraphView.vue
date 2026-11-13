<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import MemoriesView from './MemoriesView.vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson } from '../lib/api.js'
import { on } from '../lib/bus.js'

const mode = ref('graph')
const nodes = ref([])
const edges = ref([])
const facts = ref([])
const focus = ref('')
const depth = ref(2)
const error = ref('')
const loading = ref(false)
const selected = ref('')
const showPanel = ref(true)
const signals = ref([])
const pulse = new Map()
let unsubscribe = () => {}
const stage = ref(null)
const canvas = ref(null)

let frame = 0
let positions = new Map()
let angleY = 0.2
let angleX = -0.15
let zoom = 1
let dragging = null

const FOV = 900

async function load() {
  loading.value = true
  try {
    const query = { depth: depth.value, limit: 240 }
    if (focus.value.trim()) query.focus = focus.value.trim()
    const body = await apiJson(ENDPOINTS.memoryGraph, { query })
    nodes.value = Array.isArray(body?.nodes) ? body.nodes : []
    edges.value = Array.isArray(body?.edges) ? body.edges : []
    facts.value = Array.isArray(body?.facts) ? body.facts : []
    selected.value = body?.focus ?? ''
    error.value = ''
    seedPositions()
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '加载图谱失败'
  } finally {
    loading.value = false
  }
}

function seedPositions() {
  positions = new Map()
  const count = Math.max(1, nodes.value.length)
  nodes.value.forEach((node, index) => {
    const phi = Math.acos(1 - (2 * (index + 0.5)) / count)
    const theta = Math.PI * (1 + Math.sqrt(5)) * index
    const radius = 180 + (index % 5) * 18
    positions.set(node.id, {
      x: Math.sin(phi) * Math.cos(theta) * radius,
      y: Math.cos(phi) * radius,
      z: Math.sin(phi) * Math.sin(theta) * radius,
      vx: 0,
      vy: 0,
      vz: 0,
    })
  })
}

function simulate() {
  const list = nodes.value
  for (let i = 0; i < list.length; i += 1) {
    const a = positions.get(list[i].id)
    if (!a) continue
    for (let j = i + 1; j < list.length; j += 1) {
      const b = positions.get(list[j].id)
      if (!b) continue
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dz = a.z - b.z
      const dist = Math.max(30, Math.hypot(dx, dy, dz))
      const force = 90000 / (dist * dist * dist)
      a.vx += dx * force
      a.vy += dy * force
      a.vz += dz * force
      b.vx -= dx * force
      b.vy -= dy * force
      b.vz -= dz * force
    }
    a.vx -= a.x * 0.0015
    a.vy -= a.y * 0.0015
    a.vz -= a.z * 0.0015
  }
  for (const edge of edges.value) {
    const a = positions.get(edge.from)
    const b = positions.get(edge.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dz = b.z - a.z
    const dist = Math.max(1, Math.hypot(dx, dy, dz))
    const force = (dist - 120) * 0.0016
    a.vx += (dx / dist) * force
    a.vy += (dy / dist) * force
    a.vz += (dz / dist) * force
    b.vx -= (dx / dist) * force
    b.vy -= (dy / dist) * force
    b.vz -= (dz / dist) * force
  }
  for (const pos of positions.values()) {
    pos.vx *= 0.9
    pos.vy *= 0.9
    pos.vz *= 0.9
    pos.x += pos.vx
    pos.y += pos.vy
    pos.z += pos.vz
  }
}

function project(pos) {
  const cosY = Math.cos(angleY)
  const sinY = Math.sin(angleY)
  const cosX = Math.cos(angleX)
  const sinX = Math.sin(angleX)
  const x1 = pos.x * cosY - pos.z * sinY
  const z1 = pos.x * sinY + pos.z * cosY
  const y1 = pos.y * cosX - z1 * sinX
  const z2 = pos.y * sinX + z1 * cosX
  const scale = (FOV / Math.max(260, FOV + z2)) * zoom
  return { x: x1 * scale, y: y1 * scale, scale, depth: z2 }
}

function draw() {
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('2d')
  const ratio = window.devicePixelRatio || 1
  const width = el.clientWidth
  const height = el.clientHeight
  if (el.width !== Math.floor(width * ratio) || el.height !== Math.floor(height * ratio)) {
    el.width = Math.floor(width * ratio)
    el.height = Math.floor(height * ratio)
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const cx = width / 2
  const cy = height / 2
  const projected = new Map()
  for (const node of nodes.value) {
    const pos = positions.get(node.id)
    if (!pos) continue
    const p = project(pos)
    projected.set(node.id, { ...p, x: cx + p.x, y: cy + p.y })
  }
  const sortedEdges = [...edges.value].sort((a, b) => {
    const da = projected.get(a.from)?.depth ?? 0
    const db = projected.get(b.from)?.depth ?? 0
    return db - da
  })
  for (const edge of sortedEdges) {
    const a = projected.get(edge.from)
    const b = projected.get(edge.to)
    if (!a || !b) continue
    
    // 深度越远越透明
    const depthFactor = 1 - Math.max(a.depth, b.depth) / 2000
    const alpha = Math.max(0.04, Math.min(0.35, depthFactor * 0.3))
    
    // 两端距离越远，连线越粗
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.hypot(dx, dy)
    const widthFactor = Math.max(0.8, Math.min(2, dist / 100))
    
    // 渐变连线
    const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
    gradient.addColorStop(0, `rgba(100, 160, 255, ${alpha * 0.5})`)
    gradient.addColorStop(0.5, `rgba(100, 200, 255, ${alpha})`)
    gradient.addColorStop(1, `rgba(120, 180, 255, ${alpha * 0.6})`)
    
    ctx.strokeStyle = gradient
    ctx.lineWidth = 1.2 * widthFactor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.globalAlpha = 0.9
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  // 召回信号：命中节点画扩散环，像电信号经过
  const now = Date.now()
  for (const [id, expires] of pulse) {
    if (expires <= now) {
      pulse.delete(id)
      continue
    }
    const p = projected.get(id)
    if (!p) continue
    const t = 1 - (expires - now) / 2500
    const pulseRadius = 10 + t * 28
    
    // 多层脉冲环
    ctx.beginPath()
    ctx.strokeStyle = `rgba(255, 179, 71, ${Math.max(0, 0.9 * (1 - t))})`
    ctx.lineWidth = 3
    ctx.arc(p.x, p.y, pulseRadius, 0, Math.PI * 2)
    ctx.stroke()
    
    ctx.beginPath()
    ctx.strokeStyle = `rgba(255, 120, 50, ${Math.max(0, 0.4 * (1 - t * t))})`
    ctx.lineWidth = 1
    ctx.arc(p.x, p.y, pulseRadius * 0.65, 0, Math.PI * 2)
    ctx.stroke()
  }
  const sortedNodes = [...nodes.value].sort(
    (a, b) => (projected.get(b.id)?.depth ?? 0) - (projected.get(a.id)?.depth ?? 0),
  )
  
  for (const node of sortedNodes) {
    const p = projected.get(node.id)
    if (!p) continue
    const radius = Math.min(36, (7 + Math.sqrt(node.degree + 1) * 3.5) * p.scale)
    const highlight = node.id === selected.value
    
    if (radius < 2) continue
    
    // ===== 球体渲染 =====
    // 1. 远景：暗阴影圈（球底）
    const shadowGrad = ctx.createRadialGradient(p.x, p.y, radius * 0.7, p.x, p.y, radius * 1.1)
    shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0)')
    shadowGrad.addColorStop(0.8, highlight ? `rgba(100, 50, 0, 0.2)` : `rgba(0, 30, 80, 0.25)`)
    shadowGrad.addColorStop(1, highlight ? `rgba(100, 50, 0, 0)` : `rgba(0, 30, 80, 0)`)
    
    ctx.fillStyle = shadowGrad
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius * 1.15, 0, Math.PI * 2)
    ctx.fill()
    
    // 2. 主球体：浓烈的径向渐变（从中心亮到边缘暗）
    const sphereGrad = ctx.createRadialGradient(
      p.x - radius * 0.35,  // 高光中心（左上）
      p.y - radius * 0.35,
      radius * 0.1,         // 高光起点半径
      p.x,
      p.y,
      radius
    )
    
    if (highlight) {
      // 聚焦节点：橙色球体
      sphereGrad.addColorStop(0, '#fff8e6')        // 亮点：接近白色
      sphereGrad.addColorStop(0.25, '#ffd966')     // 高光区：亮橙
      sphereGrad.addColorStop(0.5, '#ffb347')      // 主色：中橙
      sphereGrad.addColorStop(0.75, '#ff9500')     // 暗部：深橙
      sphereGrad.addColorStop(1, '#cc6600')        // 最暗边缘
    } else {
      // 普通节点：蓝色球体
      sphereGrad.addColorStop(0, '#e6f2ff')        // 亮点：接近白色
      sphereGrad.addColorStop(0.25, '#99d4ff')     // 高光区：亮蓝
      sphereGrad.addColorStop(0.5, '#6ba4ff')      // 主色：中蓝
      sphereGrad.addColorStop(0.75, '#3366ff')     // 暗部：深蓝
      sphereGrad.addColorStop(1, '#003399')        // 最暗边缘
    }
    
    ctx.fillStyle = sphereGrad
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.fill()
    
    // 3. 高光层：亮白色小圆，模拟反光
    const highlightSize = radius * 0.35
    const highlightGrad = ctx.createRadialGradient(
      p.x - radius * 0.3,
      p.y - radius * 0.3,
      0,
      p.x - radius * 0.3,
      p.y - radius * 0.3,
      highlightSize
    )
    highlightGrad.addColorStop(0, highlight ? 'rgba(255, 255, 200, 0.9)' : 'rgba(255, 255, 255, 0.85)')
    highlightGrad.addColorStop(1, highlight ? 'rgba(255, 200, 100, 0.2)' : 'rgba(200, 230, 255, 0.1)')
    
    ctx.fillStyle = highlightGrad
    ctx.beginPath()
    ctx.arc(p.x - radius * 0.3, p.y - radius * 0.3, highlightSize, 0, Math.PI * 2)
    ctx.fill()
    
    // 4. 球体外圈：细框线，增加立体感
    ctx.strokeStyle = highlight ? 'rgba(200, 100, 0, 0.6)' : 'rgba(50, 100, 200, 0.5)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.stroke()
    
    // 5. 下沉阴影：球底部暗线
    ctx.strokeStyle = highlight ? `rgba(150, 50, 0, 0.4)` : `rgba(0, 40, 100, 0.35)`
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(p.x, p.y + radius * 0.6, radius * 0.8, Math.PI * 0.3, Math.PI * 0.7)
    ctx.stroke()
    
    // ===== 标签 =====
    if (radius > 6) {
      const fontSize = Math.max(9, 11 * Math.min(1.6, p.scale))
      const text = String(node.name).slice(0, 12)
      
      ctx.font = `600 ${fontSize}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      
      // 文字放在球体下方
      const textY = p.y + radius + 12
      
      // 文字背景
      if (radius > 8) {
        const metrics = ctx.measureText(text)
        const bgPadding = 4
        ctx.fillStyle = highlight ? 'rgba(255, 179, 71, 0.12)' : 'rgba(100, 140, 200, 0.06)'
        ctx.fillRect(p.x - metrics.width / 2 - bgPadding, textY - fontSize * 0.5 - 1, metrics.width + bgPadding * 2, fontSize + 2)
      }
      
      // 文字
      ctx.fillStyle = highlight ? 'rgba(255, 100, 0, 0.95)' : 'rgba(150, 200, 255, 0.9)'
      ctx.fillText(text, p.x, textY)
    }
  }
  return projected
}

let lastProjected = new Map()

function tick() {
  if (!dragging) angleY += 0.0015
  simulate()
  lastProjected = draw() ?? lastProjected
  frame = requestAnimationFrame(tick)
}

function onPointerDown(event) {
  dragging = { x: event.clientX, y: event.clientY, angleY, angleX }
  canvas.value?.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event) {
  if (!dragging) return
  angleY = dragging.angleY + (event.clientX - dragging.x) * 0.008
  angleX = dragging.angleX + (event.clientY - dragging.y) * 0.006
  angleX = Math.max(-1.2, Math.min(1.2, angleX))
}

function onPointerUp(event) {
  if (dragging && Math.abs(event.clientX - dragging.x) < 4 && Math.abs(event.clientY - dragging.y) < 4) {
    selectAt(event)
  }
  dragging = null
}

function onRecallSignal(payload) {
  if (!payload || typeof payload !== 'object') return
  const at = Number(payload.at) || Date.now()
  const facts = Array.isArray(payload.facts) ? payload.facts : []
  signals.value = [
    { at, query: String(payload.query ?? ''), facts },
    ...signals.value,
  ].slice(0, 8)
  for (const fact of facts) {
    if (fact?.subject) pulse.set(String(fact.subject), at + 2500)
    if (fact?.object) pulse.set(String(fact.object), at + 2500)
  }
  showPanel.value = true
}

function selectAt(event) {
  const rect = canvas.value?.getBoundingClientRect()
  if (!rect) return
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  let nearest = null
  let best = 26
  for (const node of nodes.value) {
    const p = lastProjected.get(node.id)
    if (!p) continue
    const dist = Math.hypot(p.x - x, p.y - y)
    if (dist < best) {
      best = dist
      nearest = node
    }
  }
  if (nearest) {
    selected.value = nearest.id
    focus.value = nearest.id
    showPanel.value = true
    void load()
    return
  }
  if (focus.value) {
    focus.value = ''
    selected.value = ''
    void load()
  }
}

function onWheel(event) {
  event.preventDefault()
  zoom = Math.max(0.45, Math.min(2.6, zoom - event.deltaY * 0.0012))
}

function resetView() {
  angleY = 0.2
  angleX = -0.15
  zoom = 1
}

onMounted(() => {
  void load()
  unsubscribe = on('memory-recall', onRecallSignal)
  frame = requestAnimationFrame(tick)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  unsubscribe()
})

const subtitle = computed(() =>
  mode.value === 'graph' ? '拖动旋转、滚轮缩放、点节点看它的事实。' : '列表视图保留原有的事实检索。',
)
</script>

<template>
  <section class="view graph-view">
    <header class="view-head graph-head">
      <div>
        <h2 class="view-title">记忆</h2>
        <p class="view-sub">{{ subtitle }}</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :class="{ primary: mode === 'graph' }" @click="mode = 'graph'">3D 图谱</button>
        <button class="btn ghost" type="button" :class="{ primary: mode === 'list' }" @click="mode = 'list'">列表</button>
        <button v-if="mode === 'graph'" class="btn ghost" type="button" @click="focus = ''; selected = ''; load()">全图</button>
        <button v-if="mode === 'graph'" class="btn ghost" type="button" @click="resetView">复位</button>
      </div>
    </header>

    <template v-if="mode === 'graph'">
      <div class="graph-controls">
        <input v-model="focus" class="input" placeholder="聚焦实体（如 三国）" @keyup.enter="load" />
        <select v-model.number="depth" class="input" @change="load">
          <option :value="1">1 跳</option>
          <option :value="2">2 跳</option>
          <option :value="3">3 跳</option>
        </select>
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
        <button class="btn ghost" type="button" @click="showPanel = !showPanel">{{ showPanel ? '隐藏详情' : '显示详情' }}</button>
      </div>
      <p v-if="error" class="alert" role="alert">{{ error }}</p>
      <div ref="stage" class="graph-stage">
        <canvas
          ref="canvas"
          class="graph-canvas"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @wheel="onWheel"
        ></canvas>
        <aside v-if="showPanel" class="graph-panel">
          <p class="item-meta">节点 {{ nodes.length }} · 关系 {{ edges.length }}</p>
          <p v-if="selected" class="item-title">聚焦：{{ selected }}</p>
          <ul class="list">
            <li v-for="(fact, index) in facts.slice(0, 14)" :key="index" class="item">
              <p class="item-meta">{{ fact.subject }} · {{ fact.predicate }}</p>
              <p class="item-title">{{ fact.object }}</p>
            </li>
          </ul>
          <p v-if="facts.length === 0" class="empty">点一个节点看它的事实。</p>
          <div class="recall-feed">
            <p class="item-meta">召回信号（实时）</p>
            <p v-if="signals.length === 0" class="item-meta">还没有召回；对青梅说句话就会亮。</p>
            <div v-for="(signal, index) in signals" :key="index" class="recall-item">
              <p class="item-title">「{{ signal.query || '（无文本）' }}」</p>
              <p class="item-meta">{{ signal.facts.length }} 条命中</p>
              <p v-for="(fact, i) in signal.facts.slice(0, 3)" :key="i" class="item-meta">
                {{ fact.subject }} · {{ fact.predicate }} · {{ fact.object }}
              </p>
            </div>
          </div>
        </aside>
      </div>
    </template>
    <MemoriesView v-else />
  </section>
</template>
