<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'
import { formatWhen, localDateTimeValue, ruleOf } from '../lib/format.js'

const items = ref([])
const error = ref('')
const loading = ref(false)
const editingId = ref('')
const draft = reactive({ text: '', kind: '', cron: '', timezone: '', seconds: '', at: '' })

async function load() {
  loading.value = true
  try {
    const body = await apiJson(ENDPOINTS.schedules)
    items.value = Array.isArray(body?.items) ? body.items : []
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '读取日程失败'
  } finally {
    loading.value = false
  }
}

function startEdit(item) {
  editingId.value = item.id
  draft.text = item.text ?? ''
  if (typeof item.cron === 'string' && item.cron) {
    draft.kind = 'cron'
    draft.cron = item.cron
    draft.timezone = item.timezone ?? ''
  } else if (Number.isFinite(item.everyMs) && item.everyMs > 0) {
    draft.kind = 'every'
    draft.seconds = String(Math.round(item.everyMs / 1000))
  } else {
    draft.kind = 'once'
    draft.at = localDateTimeValue(item.nextAt)
  }
}

function cancelEdit() {
  editingId.value = ''
}

async function save(item) {
  const body = { text: draft.text.trim() }
  if (!body.text) {
    error.value = '提醒内容不能为空'
    return
  }
  if (draft.kind === 'cron') {
    if (!draft.cron.trim()) {
      error.value = 'cron 不能为空'
      return
    }
    body.cron = draft.cron.trim()
    body.timezone = draft.timezone.trim()
  } else if (draft.kind === 'every') {
    const seconds = Number(draft.seconds)
    if (!(seconds > 0)) {
      error.value = '间隔必须是正数'
      return
    }
    body.everyMs = seconds * 1000
  } else {
    const at = new Date(draft.at)
    if (Number.isNaN(at.getTime())) {
      error.value = '时间格式不对'
      return
    }
    body.at = at.toISOString()
  }
  try {
    await apiSend(`${ENDPOINTS.schedules}/${encodeURIComponent(item.id)}`, { method: 'PATCH', body })
    editingId.value = ''
    await load()
  } catch (err) {
    error.value = err.status === 404 ? '这条提醒已经结束，改不了了' : err.message || '保存失败'
  }
}

async function togglePause(item) {
  const action = item.pausedAt ? 'resume' : 'pause'
  try {
    await apiSend(`${ENDPOINTS.schedules}/${encodeURIComponent(item.id)}/${action}`)
    await load()
  } catch (err) {
    error.value = err.message || '操作失败'
  }
}

async function cancel(item) {
  if (!window.confirm(`取消「${item.text}」？`)) return
  try {
    await apiSend(`${ENDPOINTS.schedules}/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
    await load()
  } catch (err) {
    error.value = err.message || '取消失败'
  }
}

function ordered() {
  return [...items.value].sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">日程</h2>
        <p class="view-sub">一次性、固定间隔或 cron。暂停保留原定时间，继续时周期规则从「现在」重排。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="!loading && items.length === 0" class="empty">
      还没有日程。在对话里说一句「每天九点提醒我喝水」就行。
    </p>

    <ul class="list">
      <li v-for="item in ordered()" :key="item.id" class="item" :class="{ 'is-muted': item.firedAt || item.pausedAt }">
        <form v-if="editingId === item.id" class="edit-form" @submit.prevent="save(item)">
          <label class="field">
            <span class="field-label">内容</span>
            <input v-model="draft.text" class="input" />
          </label>
          <div v-if="draft.kind === 'cron'" class="field-row">
            <label class="field">
              <span class="field-label">cron 表达式</span>
              <input v-model="draft.cron" class="input" placeholder="0 9 * * *" />
            </label>
            <label class="field">
              <span class="field-label">时区</span>
              <input v-model="draft.timezone" class="input" placeholder="Asia/Shanghai" />
            </label>
          </div>
          <label v-else-if="draft.kind === 'every'" class="field">
            <span class="field-label">间隔（秒）</span>
            <input v-model="draft.seconds" class="input" type="number" min="1" />
          </label>
          <label v-else class="field">
            <span class="field-label">时间（本地）</span>
            <input v-model="draft.at" class="input" type="datetime-local" />
          </label>
          <div class="item-actions">
            <button class="btn small" type="submit">保存</button>
            <button class="btn small ghost" type="button" @click="cancelEdit">取消</button>
          </div>
        </form>

        <template v-else>
          <div class="item-main">
            <p class="item-title">{{ item.text || '（无内容）' }}</p>
            <p class="item-meta">
              <span v-if="item.firedAt">已触发</span>
              <span v-else-if="item.pausedAt">已暂停</span>
              <span v-else>下次 {{ formatWhen(item.nextAt, item.timezone) }}</span>
              · {{ ruleOf(item) }}
            </p>
          </div>
          <div v-if="!item.firedAt" class="item-actions">
            <button class="btn small ghost" type="button" @click="startEdit(item)">编辑</button>
            <button class="btn small ghost" type="button" @click="togglePause(item)">{{ item.pausedAt ? '继续' : '暂停' }}</button>
            <button class="btn small danger" type="button" @click="cancel(item)">取消</button>
          </div>
        </template>
      </li>
    </ul>
  </section>
</template>
