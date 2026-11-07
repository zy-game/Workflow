<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'
import { CONVERSATION_STATUS_TEXT, formatWhen } from '../lib/format.js'

const TAGS = [
  ['work', '工作'],
  ['casual', '吹水'],
  ['family', '家人'],
  ['client', '客户'],
  ['temp', '临时'],
]

const groups = ref([])
const suggestions = ref([])
const error = ref('')
const loading = ref(false)
const selected = reactive({})
const policies = reactive({})
const histories = reactive({})

function keyOf(item) {
  return `${item.channel}:${item.platformConversationId}`
}

async function load() {
  loading.value = true
  try {
    const [groupBody, suggestionBody] = await Promise.all([
      apiJson(ENDPOINTS.conversations),
      apiJson(ENDPOINTS.conversationSuggestions).catch(() => ({ items: [] })),
    ])
    groups.value = Array.isArray(groupBody?.items) ? groupBody.items : []
    suggestions.value = Array.isArray(suggestionBody?.items) ? suggestionBody.items : []
    for (const group of groups.value) {
      const key = keyOf(group)
      selected[key] = Array.isArray(group.tags) ? [...group.tags] : []
      void previewPolicy(key)
    }
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '加载群组失败'
  } finally {
    loading.value = false
  }
}

function formatPolicy(policy) {
  if (!policy) return '未知策略'
  const tone = policy.tone === 'formal' ? '正式' : policy.tone === 'neutral' ? '中性' : '随意'
  const forbidden = Array.isArray(policy.forbiddenTopics) && policy.forbiddenTopics.length > 0
    ? ` · 禁止 ${policy.forbiddenTopics.join('/')}`
    : ''
  return `预览：≤${policy.maxChars} 字 · ${tone} · ${policy.proactive ? '可主动' : '不主动'}${forbidden}`
}

async function previewPolicy(key) {
  const tags = selected[key] ?? []
  if (tags.length === 0) {
    policies[key] = '至少选一个标签才能预览策略'
    return
  }
  try {
    const body = await apiJson(ENDPOINTS.conversationPreview, { query: { tags: tags.join(',') } })
    policies[key] = formatPolicy(body?.policy)
  } catch {
    policies[key] = '策略预览暂不可用'
  }
}

function toggleTag(key, value) {
  const list = selected[key] ?? []
  selected[key] = list.includes(value) ? list.filter((tag) => tag !== value) : [...list, value]
  void previewPolicy(key)
}

async function saveGroup(group) {
  const key = keyOf(group)
  const tags = selected[key] ?? []
  if (tags.length === 0) {
    error.value = '至少选一个标签'
    return
  }
  try {
    await apiSend(ENDPOINTS.conversationsConfigure, {
      body: {
        channel: group.channel,
        conversationId: group.platformConversationId,
        tags,
        title: group.title,
      },
    })
    await load()
  } catch (err) {
    error.value = err.message || '保存失败'
  }
}

async function toggleHistory(group) {
  const key = keyOf(group)
  if (histories[key]?.visible) {
    histories[key].visible = false
    return
  }
  try {
    const body = await apiJson(ENDPOINTS.conversationHistory, {
      query: { channel: group.channel, conversationId: group.platformConversationId },
    })
    histories[key] = { visible: true, items: Array.isArray(body?.items) ? body.items : [] }
  } catch (err) {
    error.value = err.message || '加载历史失败'
  }
}

async function rollbackGroup(group) {
  if (!window.confirm(`把「${group.title || group.platformConversationId}」恢复到上一版标签？`)) return
  try {
    await apiSend(ENDPOINTS.conversationRollback, {
      body: { channel: group.channel, conversationId: group.platformConversationId },
    })
    await load()
  } catch (err) {
    error.value = err.message || '回滚失败'
  }
}

async function decideSuggestion(suggestion, accept) {
  try {
    await apiSend(accept ? ENDPOINTS.conversationSuggestionAccept : ENDPOINTS.conversationSuggestionDismiss, {
      body: { id: suggestion.id },
    })
    await load()
  } catch (err) {
    error.value = err.message || '操作失败'
  }
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">群组</h2>
        <p class="view-sub">未配置的群会回「权限未配置」；打标签后按策略回复。标签决定字数、语气与是否可主动。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>

    <div v-if="suggestions.length > 0" class="card">
      <h3 class="card-title">标签建议</h3>
      <div v-for="suggestion in suggestions" :key="suggestion.id" class="item">
        <div class="item-main">
          <p class="item-title">💡 {{ suggestion.conversationId }} 可能是 {{ suggestion.tag }}</p>
          <p class="item-meta">{{ suggestion.evidence }}</p>
        </div>
        <div class="item-actions">
          <button class="btn small" type="button" @click="decideSuggestion(suggestion, true)">采纳</button>
          <button class="btn small ghost" type="button" @click="decideSuggestion(suggestion, false)">忽略</button>
        </div>
      </div>
    </div>

    <p v-if="!loading && groups.length === 0" class="empty">还没有发现群。把机器人拉进群后，这里会出现待配置的群。</p>

    <div v-for="group in groups" :key="keyOf(group)" class="card">
      <div class="item">
        <div class="item-main">
          <p class="item-title">{{ group.title || group.platformConversationId }}</p>
          <p class="item-meta">
            {{ group.channel }} · {{ CONVERSATION_STATUS_TEXT[group.status] ?? group.status }} · {{ group.platformConversationId }}
          </p>
        </div>
      </div>
      <div class="tag-row">
        <label v-for="[value, label] in TAGS" :key="value" class="tag-toggle" :class="{ active: selected[keyOf(group)]?.includes(value) }">
          <input
            type="checkbox"
            :checked="selected[keyOf(group)]?.includes(value)"
            @change="toggleTag(keyOf(group), value)"
          />
          {{ label }}
        </label>
      </div>
      <p class="item-note">{{ policies[keyOf(group)] || '正在读取策略…' }}</p>
      <div class="item-actions">
        <button class="btn small" type="button" @click="saveGroup(group)">保存标签</button>
        <button class="btn small ghost" type="button" @click="toggleHistory(group)">
          {{ histories[keyOf(group)]?.visible ? '收起历史' : '历史' }}
        </button>
        <button class="btn small ghost" type="button" @click="rollbackGroup(group)">回滚</button>
      </div>
      <ul v-if="histories[keyOf(group)]?.visible" class="sublist">
        <li v-if="histories[keyOf(group)].items.length === 0" class="item-note">还没有可回滚的历史。</li>
        <li v-for="(snapshot, index) in histories[keyOf(group)].items" :key="index" class="item-note">
          {{ formatWhen(snapshot.at, null) }} · {{ (snapshot.tags || []).join('/') }} · {{ snapshot.status }}
        </li>
      </ul>
    </div>
  </section>
</template>
