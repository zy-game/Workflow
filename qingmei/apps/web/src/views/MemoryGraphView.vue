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
  
  // 按 kind 分组节点
  const layers = new Map()
  for (const node of nodes.value) {
    const kind = node.kind || 'topic'
    if (!layers.has(kind)) layers.set(kind, [])
    layers.get(kind).push(node)
  }
  
  // 为每个 kind 分配 y 轴层级（垂直分层）
  const kindList = Array.from(layers.keys()).sort()
  const layerHeight = 280
  const baseY = -((kindList.length - 1) * layerHeight) / 2
  
  kindList.forEach((kind, layerIndex) => {
    const nodesInLayer = layers.get(kind)
    const layerY = baseY + layerIndex * layerHeight
    const layerRadius = 200 + nodesInLayer.length * 2
    
    nodesInLayer.forEach((node, indexInLayer) => {
      // 在当前层的水平圆盘上均匀分布
      const angle = (indexInLayer / nodesInLayer.length) * Math.PI * 2
      const radiusOffset = (indexInLayer % 3) * 30
      const r = layerRadius + radiusOffset
      
      positions.set(node.id, {
        x: Math.cos(angle) * r,
        y: layerY + (Math.random() - 0.5) * 40, // 轻微垂直抖动
        z: Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        vz: 0,
      })
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
    const depthFactor = Math.max(a.depth, b.depth) / 2000
    const alpha = Math.max(0.02, Math.min(0.08, 0.05 - depthFactor * 0.02))
    
    // 连线非常淡
    ctx.strokeStyle = `rgba(100, 150, 255, ${alpha})`
    ctx.lineWidth = 0.8
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
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
    const radius = Math.min(8, (2 + Math.sqrt(node.degree + 1) * 0.8) * p.scale)
    const highlight = node.id === selected.value
    
    if (radius < 0.5) continue
    
    // ===== 星点效果 =====
    
    // 1. 外圈光晕（远）
    const haloGrad1 = ctx.createRadialGradient(p.x, p.y, radius * 0.5, p.x, p.y, radius * 6)
    if (highlight) {
      haloGrad1.addColorStop(0, 'rgba(255, 180, 50, 0.4)')
      haloGrad1.addColorStop(0.3, 'rgba(255, 150, 50, 0.15)')
      haloGrad1.addColorStop(1, 'rgba(255, 100, 0, 0)')
    } else {
      haloGrad1.addColorStop(0, 'rgba(100, 200, 255, 0.25)')
      haloGrad1.addColorStop(0.4, 'rgba(100, 150, 255, 0.08)')
      haloGrad1.addColorStop(1, 'rgba(100, 180, 255, 0)')
    }
    ctx.fillStyle = haloGrad1
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius * 6, 0, Math.PI * 2)
    ctx.fill()
    
    // 2. 中层光晕（近）
    const haloGrad2 = ctx.createRadialGradient(p.x, p.y, radius * 0.3, p.x, p.y, radius * 2.5)
    if (highlight) {
      haloGrad2.addColorStop(0, 'rgba(255, 200, 100, 0.6)')
      haloGrad2.addColorStop(1, 'rgba(255, 150, 50, 0)')
    } else {
      haloGrad2.addColorStop(0, 'rgba(150, 220, 255, 0.5)')
      haloGrad2.addColorStop(1, 'rgba(100, 180, 255, 0)')
    }
    ctx.fillStyle = haloGrad2
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius * 2.5, 0, Math.PI * 2)
    ctx.fill()
    
    // 3. 核心亮点（星点本身）
    const coreGrad = ctx.createRadialGradient(p.x - radius * 0.2, p.y - radius * 0.2, 0, p.x, p.y, radius)
    if (highlight) {
      coreGrad.addColorStop(0, '#fff9e6')
      coreGrad.addColorStop(0.5, '#ffb347')
      coreGrad.addColorStop(1, '#ff8c00')
    } else {
      coreGrad.addColorStop(0, '#ffffff')
      coreGrad.addColorStop(0.6, '#99d4ff')
      coreGrad.addColorStop(1, '#4da6ff')
    }
    ctx.fillStyle = coreGrad
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.fill()
    
    // 4. 十字光芒（星芒效果）
    const glareSize = radius * 1.5
    ctx.strokeStyle = highlight ? 'rgba(255, 200, 50, 0.4)' : 'rgba(150, 220, 255, 0.3)'
    ctx.lineWidth = 0.5
    ctx.lineCap = 'round'
    
    // 横竖两条线
    ctx.beginPath()
    ctx.moveTo(p.x - glareSize, p.y)
    ctx.lineTo(p.x + glareSize, p.y)
    ctx.stroke()
    
    ctx.beginPath()
    ctx.moveTo(p.x, p.y - glareSize)
    ctx.lineTo(p.x, p.y + glareSize)
    ctx.stroke()
    
    // ===== 标签 =====
    if (radius > 1 && highlight) {
      const fontSize = Math.max(9, 10 * Math.min(1.2, p.scale))
      const text = String(node.name).slice(0, 12)
      
      ctx.font = `500 ${fontSize}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      
      const textY = p.y - radius - 12
      
      // 文字背景
      const metrics = ctx.measureText(text)
      const bgPadding = 3
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
      ctx.fillRect(p.x - metrics.width / 2 - bgPadding, textY - fontSize * 0.5 - 1, metrics.width + bgPadding * 2, fontSize + 2)
      
      // 文字
      ctx.fillStyle = 'rgba(255, 200, 100, 0.9)'
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

const layerStats = computed(() => {
  const stats = new Map()
  for (const node of nodes.value) {
    const kind = node.kind || 'topic'
    stats.set(kind, (stats.get(kind) || 0) + 1)
  }
  return Array.from(stats.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count)
})
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
