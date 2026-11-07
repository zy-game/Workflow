<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'
import { on } from '../lib/bus.js'
import {
  CONTENT_STATUS_TEXT,
  PLATFORM_TEXT,
  VARIANT_STATUS_TEXT,
  formatWhen,
} from '../lib/format.js'

const gate = ref(null)
const items = ref([])
const detail = ref(null)
const selectedId = ref('')
const error = ref('')
const notice = ref('')
const loading = ref(false)
const busy = ref('')
let unsubscribers = []

const form = reactive({ title: '', body: '', tags: '', source: 'public', authorized: false })
const draft = reactive({ title: '', body: '', tags: '', source: 'public', authorized: false })

const EDITABLE = ['idea', 'drafting', 'drafted', 'rejected']
const editable = computed(() => detail.value && EDITABLE.includes(detail.value.item.status))

const nextActions = computed(() => {
  const status = detail.value?.item.status
  switch (status) {
    case 'idea':
      return [{ to: 'drafting', label: '开始起草' }]
    case 'drafting':
      return [{ to: 'drafted', label: '完成草稿' }]
    case 'drafted':
      return [{ to: 'reviewing', label: '提交人审' }]
    case 'reviewing':
      return [
        { to: 'approved', label: '批准', primary: true },
        { to: 'rejected', label: '驳回', danger: true, reason: true },
      ]
    case 'approved':
      return [{ to: 'archived', label: '归档' }]
    case 'rejected':
      return [
        { to: 'drafting', label: '继续修改' },
        { to: 'archived', label: '归档' },
      ]
    case 'published':
      return [{ to: 'archived', label: '归档' }]
    default:
      return []
  }
})

function platformText(platform) {
  return PLATFORM_TEXT[platform] ?? platform
}

function badgeClass(status) {
  if (status === 'approved' || status === 'published' || status === 'live' || status === 'ready') return 'badge-done'
  if (status === 'reviewing' || status === 'drafting' || status === 'scheduled' || status === 'publishing') return 'badge-running'
  if (status === 'rejected' || status === 'failed') return 'badge-failed'
  if (status === 'archived') return 'badge-dim'
  return 'badge-queued'
}

function tagList(value) {
  return String(value ?? '')
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function syncDraft(item) {
  draft.title = item.title
  draft.body = item.body
  draft.tags = (item.tags ?? []).join(', ')
  draft.source = item.source
  draft.authorized = item.source !== 'public'
}

async function loadGate() {
  try {
    const body = await apiJson(ENDPOINTS.contentStatus)
    gate.value = body
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '读取闸门失败'
  }
}

async function loadItems() {
  try {
    const body = await apiJson(ENDPOINTS.content)
    items.value = Array.isArray(body?.items) ? body.items : []
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '读取内容台账失败'
  }
}

async function loadAll() {
  loading.value = true
  await Promise.all([loadGate(), loadItems()])
  if (selectedId.value) await select(selectedId.value)
  loading.value = false
}

async function select(id) {
  selectedId.value = id
  try {
    const body = await apiJson(ENDPOINTS.contentItem, { query: { id } })
    detail.value = body
    syncDraft(body.item)
  } catch (err) {
    error.value = err.message || '读取内容详情失败'
  }
}

async function createItem() {
  const title = form.title.trim()
  if (!title) {
    error.value = '标题不能为空'
    return
  }
  if (form.source !== 'public' && !form.authorized) {
    error.value = 'work / life 素材需要先脱敏并勾选授权'
    return
  }
  busy.value = 'create'
  try {
    const body = await apiSend(ENDPOINTS.content, {
      body: {
        title,
        body: form.body,
        tags: tagList(form.tags),
        source: form.source,
        authorized: form.authorized,
      },
    })
    form.title = ''
    form.body = ''
    form.tags = ''
    form.source = 'public'
    form.authorized = false
    error.value = ''
    await loadItems()
    if (body?.item?.id) await select(body.item.id)
    notice.value = `已创建 ${body?.item?.title ?? '内容'}`
  } catch (err) {
    error.value = err.message || '创建失败'
  } finally {
    busy.value = ''
  }
}

async function saveDraft() {
  if (!detail.value) return
  if (draft.source !== 'public' && !draft.authorized) {
    error.value = 'work / life 素材需要先脱敏并勾选授权'
    return
  }
  busy.value = 'save'
  try {
    await apiSend(ENDPOINTS.contentUpdate, {
      body: {
        id: detail.value.item.id,
        title: draft.title,
        body: draft.body,
        tags: tagList(draft.tags),
        source: draft.source,
        authorized: draft.authorized,
      },
    })
    await Promise.all([loadItems(), select(detail.value.item.id)])
    notice.value = '草稿已保存'
    error.value = ''
  } catch (err) {
    error.value = err.message || '保存失败'
  } finally {
    busy.value = ''
  }
}

async function transition(action) {
  if (!detail.value) return
  let reason = ''
  if (action.reason) {
    const input = window.prompt('驳回理由（会回灌记忆，起草时召回）')
    if (!input || !input.trim()) return
    reason = input.trim()
  }
  busy.value = action.to
  try {
    await apiSend(ENDPOINTS.contentTransition, {
      body: { id: detail.value.item.id, to: action.to, reason },
    })
    await Promise.all([loadGate(), loadItems(), select(detail.value.item.id)])
    notice.value = `状态已推进到 ${CONTENT_STATUS_TEXT[action.to] ?? action.to}`
    error.value = ''
  } catch (err) {
    error.value = err.message || '状态迁移失败'
  } finally {
    busy.value = ''
  }
}

async function renderVariants() {
  if (!detail.value) return
  busy.value = 'render'
  try {
    await apiSend(ENDPOINTS.contentRender, { body: { id: detail.value.item.id } })
    await Promise.all([loadGate(), loadItems(), select(detail.value.item.id)])
    notice.value = '已按平台规则生成形态'
    error.value = ''
  } catch (err) {
    error.value = err.message || '生成失败'
  } finally {
    busy.value = ''
  }
}

async function attemptPublish() {
  if (!detail.value) return
  try {
    await apiSend(ENDPOINTS.contentPublish, { body: { id: detail.value.item.id } })
    notice.value = '已进入发布流程'
  } catch (err) {
    notice.value = `闸门拦住了：${err.message}`
  }
  await select(detail.value.item.id)
}

onMounted(() => {
  void loadAll()
  unsubscribers = [on('content-updated', () => void loadAll())]
})

onBeforeUnmount(() => {
  for (const off of unsubscribers) off()
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">账号运维</h2>
        <p class="view-sub">
          一件事写一遍，分发到博客 / 微博 / B站 / 知乎。这里管内容台账与人审闸门；平台账号未接入前，发布一律被挡住。
        </p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="loadAll">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice-banner">{{ notice }}</p>

    <div v-if="gate" class="gate-grid">
      <div v-for="platform in gate.platforms" :key="platform.platform" class="card gate-card">
        <p class="gate-platform">{{ platformText(platform.platform) }}</p>
        <p class="gate-state" :class="platform.connected ? 'ok' : 'dim'">
          {{ platform.connected ? '已接入' : '未接入' }}
        </p>
        <p class="gate-hint">{{ platform.connected ? '可进入发布流程' : '等主人在 DSH 的 Chrome 里登录' }}</p>
      </div>
      <div class="card gate-card">
        <p class="gate-platform">今日预算</p>
        <ul class="budget-list">
          <li v-for="budget in gate.budgets" :key="budget.action">
            <span>{{ budget.label }}</span>
            <span :class="{ dim: budget.remaining === 0 }">{{ budget.used }}/{{ budget.limit }}</span>
          </li>
        </ul>
      </div>
      <div class="card gate-card">
        <p class="gate-platform">静默时段</p>
        <p class="gate-state" :class="gate.quiet ? 'dim' : 'ok'">{{ gate.quiet ? '静默中' : '可发' }}</p>
        <p class="gate-hint">{{ gate.quietWindow }}</p>
      </div>
    </div>
    <p v-if="gate?.reasons?.length" class="gate-reasons">闸门：{{ gate.reasons.join('；') }}</p>

    <div class="content-split">
      <div class="content-left">
        <div class="card">
          <h3 class="card-title">写一条内容</h3>
          <label class="field">
            <span class="field-label">标题</span>
            <input v-model="form.title" class="input" placeholder="一件事，不是一条文案" />
          </label>
          <label class="field">
            <span class="field-label">正文（Markdown）</span>
            <textarea v-model="form.body" class="textarea" rows="5" placeholder="发生了什么、判断错在哪、结论是什么"></textarea>
          </label>
          <label class="field">
            <span class="field-label">标签（逗号分隔）</span>
            <input v-model="form.tags" class="input" placeholder="项目, 踩坑" />
          </label>
          <div class="field-row">
            <label class="field">
              <span class="field-label">素材分级</span>
              <select v-model="form.source" class="input">
                <option value="public">public（可对公）</option>
                <option value="work">work（工作素材）</option>
                <option value="life">life（生活素材）</option>
              </select>
            </label>
            <label v-if="form.source !== 'public'" class="tag-toggle" :class="{ active: form.authorized }">
              <input v-model="form.authorized" type="checkbox" />
              已脱敏并逐条授权
            </label>
          </div>
          <div class="item-actions">
            <button class="btn" type="button" :disabled="busy === 'create'" @click="createItem">
              {{ busy === 'create' ? '创建中…' : '创建' }}
            </button>
          </div>
        </div>

        <p v-if="!loading && items.length === 0" class="empty">还没有内容。先写一条「正在做的事」，它可以是博客长文的草稿。</p>

        <ul class="list">
          <li
            v-for="item in items"
            :key="item.id"
            class="item item-clickable"
            :class="{ selected: item.id === selectedId }"
            @click="select(item.id)"
          >
            <div class="item-main">
              <p class="item-title">
                <span class="badge" :class="badgeClass(item.status)">{{ CONTENT_STATUS_TEXT[item.status] ?? item.status }}</span>
                {{ item.title }}
              </p>
              <p class="item-meta">
                {{ item.source }} · {{ (item.tags || []).join('/') || '无标签' }} · {{ formatWhen(item.updatedAt, null) }}
              </p>
            </div>
          </li>
        </ul>
      </div>

      <div class="content-right">
        <p v-if="!detail" class="empty">选一条内容看详情。</p>
        <template v-else>
          <div class="card">
            <div class="item">
              <div class="item-main">
                <p class="item-title">
                  <span class="badge" :class="badgeClass(detail.item.status)">
                    {{ CONTENT_STATUS_TEXT[detail.item.status] ?? detail.item.status }}
                  </span>
                  {{ detail.item.title }}
                </p>
                <p class="item-meta">
                  {{ detail.item.source }} · {{ (detail.item.tags || []).join('/') || '无标签' }} ·
                  {{ formatWhen(detail.item.createdAt, null) }}
                </p>
              </div>
            </div>
            <p v-if="detail.item.rejectReason" class="item-error">驳回理由：{{ detail.item.rejectReason }}</p>

            <template v-if="editable">
              <label class="field">
                <span class="field-label">标题</span>
                <input v-model="draft.title" class="input" />
              </label>
              <label class="field">
                <span class="field-label">正文</span>
                <textarea v-model="draft.body" class="textarea" rows="8"></textarea>
              </label>
              <label class="field">
                <span class="field-label">标签</span>
                <input v-model="draft.tags" class="input" />
              </label>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">素材分级</span>
                  <select v-model="draft.source" class="input">
                    <option value="public">public</option>
                    <option value="work">work</option>
                    <option value="life">life</option>
                  </select>
                </label>
                <label v-if="draft.source !== 'public'" class="tag-toggle" :class="{ active: draft.authorized }">
                  <input v-model="draft.authorized" type="checkbox" />
                  已脱敏并逐条授权
                </label>
              </div>
              <div class="item-actions">
                <button class="btn small" type="button" :disabled="busy === 'save'" @click="saveDraft">
                  {{ busy === 'save' ? '保存中…' : '保存草稿' }}
                </button>
              </div>
            </template>
            <pre v-else class="markdown small">{{ detail.item.body }}</pre>

            <div class="item-actions">
              <button
                v-for="action in nextActions"
                :key="action.to"
                class="btn small"
                :class="{ danger: action.danger, ghost: !action.primary }"
                type="button"
                :disabled="Boolean(busy)"
                @click="transition(action)"
              >
                {{ busy === action.to ? '处理中…' : action.label }}
              </button>
              <button
                v-if="detail.item.status === 'approved'"
                class="btn small ghost"
                type="button"
                @click="attemptPublish"
              >
                尝试发布（先过闸门）
              </button>
            </div>
          </div>

          <div class="card">
            <div class="item">
              <div class="item-main">
                <h3 class="card-title">平台形态</h3>
                <p class="item-note">render 只做平台规则适配（截断、排版、提示），不发布。</p>
              </div>
              <div class="item-actions">
                <button class="btn small ghost" type="button" :disabled="busy === 'render'" @click="renderVariants">
                  {{ busy === 'render' ? '生成中…' : '生成全部形态' }}
                </button>
              </div>
            </div>
            <p v-if="detail.variants.length === 0" class="item-note">还没有平台形态。</p>
            <table v-else class="data-table">
              <thead>
                <tr>
                  <th>平台</th>
                  <th>形态</th>
                  <th>状态</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="variant in detail.variants" :key="variant.id">
                  <td>{{ platformText(variant.platform) }}</td>
                  <td>{{ variant.kind }}</td>
                  <td>
                    <span class="badge" :class="badgeClass(variant.status)">
                      {{ VARIANT_STATUS_TEXT[variant.status] ?? variant.status }}
                    </span>
                  </td>
                  <td>
                    <p class="variant-body">{{ variant.body }}</p>
                    <p v-if="variant.notes?.length" class="item-note">提示：{{ variant.notes.join('；') }}</p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="card">
            <h3 class="card-title">动作流水</h3>
            <ul class="sublist">
              <li v-for="action in detail.actions" :key="action.id" class="item">
                <div class="item-main">
                  <p class="item-title">
                    <span class="badge" :class="action.result === 'blocked' ? 'badge-failed' : 'badge-done'">
                      {{ action.result }}
                    </span>
                    {{ action.action }}
                  </p>
                  <p class="item-meta">{{ formatWhen(action.at, null) }} · {{ action.detail }}</p>
                </div>
              </li>
            </ul>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
