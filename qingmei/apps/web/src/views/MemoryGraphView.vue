<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import MemoriesView from './MemoriesView.vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson } from '../lib/api.js'

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
    const alpha = Math.max(0.06, Math.min(0.45, 0.4 - ((a.depth + b.depth) / 2) / 2200))
    ctx.strokeStyle = `rgba(120, 165, 230, ${alpha})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  const sortedNodes = [...nodes.value].sort(
    (a, b) => (projected.get(b.id)?.depth ?? 0) - (projected.get(a.id)?.depth ?? 0),
  )
  for (const node of sortedNodes) {
    const p = projected.get(node.id)
    if (!p) continue
    const radius = Math.min(26, (6 + Math.sqrt(node.degree + 1) * 3) * p.scale)
    const highlight = node.id === selected.value
    ctx.beginPath()
    ctx.fillStyle = highlight ? '#ffb347' : `rgba(107, 164, 255, ${Math.max(0.25, Math.min(0.95, p.scale))})`
    ctx.arc(p.x, p.y, Math.max(2, radius), 0, Math.PI * 2)
    ctx.fill()
    if (radius > 4) {
      ctx.fillStyle = 'rgba(232, 238, 252, 0.85)'
      ctx.font = `${Math.max(9, 11 * Math.min(1.4, p.scale))}px sans-serif`
      ctx.fillText(String(node.name).slice(0, 12), p.x + radius + 3, p.y + 3)
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
  frame = requestAnimationFrame(tick)
})
onBeforeUnmount(() => cancelAnimationFrame(frame))

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
        </aside>
      </div>
    </template>
    <MemoriesView v-else />
  </section>
</template>
