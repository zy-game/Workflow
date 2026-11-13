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
const canvas = ref(null)
let frame = 0
let positions = new Map()
let drag = null

async function load() {
  loading.value = true
  try {
    const query = { depth: depth.value }
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
  const width = canvas.value?.clientWidth || 600
  const height = canvas.value?.clientHeight || 420
  positions = new Map()
  nodes.value.forEach((node, index) => {
    const angle = (index / Math.max(1, nodes.value.length)) * Math.PI * 2
    positions.set(node.id, {
      x: width / 2 + Math.cos(angle) * 120,
      y: height / 2 + Math.sin(angle) * 120,
      vx: 0,
      vy: 0,
    })
  })
}

function tick() {
  const width = canvas.value?.clientWidth || 600
  const height = canvas.value?.clientHeight || 420
  const list = nodes.value
  for (let i = 0; i < list.length; i += 1) {
    const a = positions.get(list[i].id)
    if (!a) continue
    for (let j = i + 1; j < list.length; j += 1) {
      const b = positions.get(list[j].id)
      if (!b) continue
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist = Math.max(20, Math.hypot(dx, dy))
      const force = 2200 / (dist * dist)
      const nx = dx / dist
      const ny = dy / dist
      a.vx += nx * force
      a.vy += ny * force
      b.vx -= nx * force
      b.vy -= ny * force
    }
    a.vx += (width / 2 - a.x) * 0.002
    a.vy += (height / 2 - a.y) * 0.002
  }
  for (const edge of edges.value) {
    const a = positions.get(edge.from)
    const b = positions.get(edge.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.max(1, Math.hypot(dx, dy))
    const target = 110
    const force = (dist - target) * 0.004
    a.vx += (dx / dist) * force
    a.vy += (dy / dist) * force
    b.vx -= (dx / dist) * force
    b.vy -= (dy / dist) * force
  }
  for (const [id, pos] of positions) {
    pos.vx *= 0.85
    pos.vy *= 0.85
    pos.x = Math.max(24, Math.min(width - 24, pos.x + pos.vx))
    pos.y = Math.max(24, Math.min(height - 24, pos.y + pos.vy))
  }
  draw()
  frame = requestAnimationFrame(tick)
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
  ctx.lineWidth = 1
  for (const edge of edges.value) {
    const a = positions.get(edge.from)
    const b = positions.get(edge.to)
    if (!a || !b) continue
    ctx.strokeStyle = 'rgba(120, 160, 220, 0.35)'
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    ctx.fillStyle = 'rgba(160, 180, 210, 0.7)'
    ctx.font = '10px sans-serif'
    ctx.fillText(String(edge.predicate).slice(0, 8), mx + 2, my - 2)
  }
  for (const node of nodes.value) {
    const pos = positions.get(node.id)
    if (!pos) continue
    const radius = Math.min(22, 7 + Math.sqrt(node.degree + 1) * 3)
    ctx.beginPath()
    ctx.fillStyle = node.id === selected.value ? '#ffb347' : 'rgba(107, 164, 255, 0.9)'
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#e8eefc'
    ctx.font = '11px sans-serif'
    ctx.fillText(String(node.name).slice(0, 10), pos.x + radius + 3, pos.y + 3)
  }
}

function onCanvasClick(event) {
  const rect = canvas.value?.getBoundingClientRect()
  if (!rect) return
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  let nearest = null
  let best = 30
  for (const node of nodes.value) {
    const pos = positions.get(node.id)
    if (!pos) continue
    const dist = Math.hypot(pos.x - x, pos.y - y)
    if (dist < best) {
      best = dist
      nearest = node
    }
  }
  if (nearest) {
    focus.value = nearest.id
    void load()
  }
}

onMounted(() => {
  void load()
  frame = requestAnimationFrame(tick)
})
onBeforeUnmount(() => cancelAnimationFrame(frame))

const subtitle = computed(() =>
  mode.value === 'graph' ? '节点是实体，连线是关系；点节点看向它的事实。' : '列表视图保留原有的事实检索。',
)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">记忆</h2>
        <p class="view-sub">{{ subtitle }}</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :class="{ primary: mode === 'graph' }" @click="mode = 'graph'">图谱</button>
        <button class="btn ghost" type="button" :class="{ primary: mode === 'list' }" @click="mode = 'list'">列表</button>
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
      </div>
      <p v-if="error" class="alert" role="alert">{{ error }}</p>
      <div class="graph-layout">
        <canvas ref="canvas" class="graph-canvas" @click="onCanvasClick"></canvas>
        <aside class="graph-side">
          <p class="item-meta">节点 {{ nodes.length }} · 关系 {{ edges.length }}</p>
          <p v-if="selected" class="item-title">聚焦：{{ selected }}</p>
          <ul class="list">
            <li v-for="(fact, index) in facts.slice(0, 12)" :key="index" class="item">
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
