<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'
import { on } from '../lib/bus.js'
import { formatWhen, TASK_STATUS_TEXT } from '../lib/format.js'

const tasks = ref([])
const approvals = ref([])
const devices = ref([])
const deviceTasks = ref([])
const deviceId = ref('')
const workspaceId = ref('')
const harness = ref('')
const devicePrompt = ref('')
const deviceError = ref('')
const error = ref('')
const loading = ref(false)
const selectedDevice = computed(() => devices.value.find((device) => device.id === deviceId.value))
const workspaces = computed(() => selectedDevice.value?.workspaces ?? [])
const harnesses = computed(() => selectedDevice.value?.harnesses ?? [])
let unsubscribers = []

async function load() {
  loading.value = true
  try {
    const [taskBody, approvalBody] = await Promise.all([
      apiJson(ENDPOINTS.tasks, { query: { limit: 20 } }),
      apiJson(ENDPOINTS.approvals, { query: { status: 'pending' } }).catch(() => ({ items: [] })),
    ])
    tasks.value = Array.isArray(taskBody?.items) ? taskBody.items : []
    approvals.value = Array.isArray(approvalBody?.items) ? approvalBody.items : []
    const [deviceBody, deviceTaskBody] = await Promise.all([
      apiJson(ENDPOINTS.devices).catch(() => ({ items: [] })),
      apiJson(ENDPOINTS.deviceTasks, { query: { limit: 20 } }).catch(() => ({ items: [] })),
    ])
    devices.value = Array.isArray(deviceBody?.items) ? deviceBody.items : []
    deviceTasks.value = Array.isArray(deviceTaskBody?.items) ? deviceTaskBody.items : []
    if (!deviceId.value && devices.value.length > 0) deviceId.value = devices.value[0].id
    if (!workspaceId.value || !workspaces.value.some((workspace) => workspace.id === workspaceId.value)) {
      workspaceId.value = workspaces.value[0]?.id ?? ''
    }
    if (!harness.value || !harnesses.value.some((item) => item.kind === harness.value)) {
      harness.value = harnesses.value[0]?.kind ?? 'dsh'
    }
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '读取任务失败'
  } finally {
    loading.value = false
  }
}

watch(deviceId, () => {
  workspaceId.value = workspaces.value[0]?.id ?? ''
  harness.value = harnesses.value[0]?.kind ?? 'dsh'
})

async function dispatchDevice() {
  deviceError.value = ''
  if (!deviceId.value || !devicePrompt.value.trim()) {
    deviceError.value = '先选设备并写任务'
    return
  }
  try {
    await apiSend(ENDPOINTS.deviceTasks, {
      method: 'POST',
      body: {
        deviceId: deviceId.value,
        threadId: workspaceId.value || deviceId.value,
        workspaceId: workspaceId.value || undefined,
        cwd: workspaces.value.find((workspace) => workspace.id === workspaceId.value)?.path,
        prompt: devicePrompt.value.trim(),
        title: devicePrompt.value.trim().slice(0, 40),
        harness: harness.value || 'dsh',
      },
    })
    devicePrompt.value = ''
    await load()
  } catch (err) {
    deviceError.value = err.message || '派发失败'
  }
}

async function decide(approval, allow) {
  try {
    await apiSend(ENDPOINTS.approvalDecide, { body: { id: approval.id, allow } })
    await load()
  } catch (err) {
    error.value = err.message || '操作失败'
  }
}

function artifactLabel(artifact) {
  return `📎 ${artifact.name}`
}

onMounted(() => {
  void load()
  unsubscribers = [
    on('task-started', () => void load()),
    on('task-progress', () => void load()),
    on('task-finished', () => void load()),
    on('approval-requested', () => void load()),
    on('approval-decided', () => void load()),
  ]
})

onBeforeUnmount(() => {
  for (const off of unsubscribers) off()
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">任务</h2>
        <p class="view-sub">派给 harness 的活；有敏感操作时会先在这里等你拍板。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <div class="card">
      <h3 class="card-title">本机设备任务</h3>
      <p class="view-sub">任务直接进目标设备的 worker 队列，由本机 ACP 拉起 DSH。</p>
      <div class="form-row">
        <select v-model="deviceId" class="input">
          <option value="">选择设备</option>
          <option v-for="device in devices" :key="device.id" :value="device.id">
            {{ device.name }} · {{ device.systemType || device.platform }}/{{ device.arch }} · {{ device.deviceClass || 'desktop' }} · {{ device.online ? '在线' : '离线' }}
          </option>
        </select>
        <select v-model="harness" class="input" :disabled="harnesses.length <= 1">
          <option v-for="item in harnesses" :key="item.kind" :value="item.kind">{{ item.kind }}</option>
        </select>
        <select v-model="workspaceId" class="input" :disabled="workspaces.length === 0">
          <option value="">选择工作区</option>
          <option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">
            {{ workspace.title }} · {{ workspace.path }}
          </option>
        </select>
        <input v-model="devicePrompt" class="input" placeholder="例如：把当前测试跑一遍，失败就修" />
        <button class="btn" type="button" :disabled="!deviceId || !devicePrompt.trim()" @click="dispatchDevice">派发</button>
      </div>
      <p v-if="deviceError" class="alert" role="alert">{{ deviceError }}</p>
      <ul v-if="deviceTasks.length" class="list">
        <li v-for="task in deviceTasks" :key="task.id" class="item">
          <div class="item-main">
            <p class="item-title">{{ task.title || task.prompt }}</p>
            <p class="item-meta">
              {{ task.source === 'device' ? '设备' : '服务器' }} · {{ task.target?.deviceId || task.deviceId }} · {{ task.target?.harnessId || task.harness }} · {{ task.target?.workspaceId || task.workspaceId || '默认工作区' }} · {{ TASK_STATUS_TEXT[task.status] ?? task.status }}
              · {{ formatWhen(task.createdAt, null) }}
            </p>
            <p v-if="task.result" class="item-note">{{ task.result.slice(0, 300) }}</p>
            <p v-if="task.error" class="item-error">{{ task.error }}</p>
          </div>
        </li>
      </ul>
    </div>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>

    <div v-if="approvals.length > 0" class="card approval-card">
      <h3 class="card-title">待确认（{{ approvals.length }}）</h3>
      <div v-for="approval in approvals" :key="approval.id" class="item">
        <div class="item-main">
          <p class="item-title">{{ approval.prompt || approval.action }}</p>
          <p class="item-meta">
            {{ approval.requester || '' }} · {{ formatWhen(approval.createdAt, null) }}
            <span v-if="approval.notifiedTo?.length"> · 已推送 {{ approval.notifiedTo.join('/') }}</span>
          </p>
        </div>
        <div class="item-actions">
          <button class="btn small" type="button" @click="decide(approval, true)">批准</button>
          <button class="btn small danger" type="button" @click="decide(approval, false)">拒绝</button>
        </div>
      </div>
    </div>

    <p v-if="!loading && tasks.length === 0" class="empty">
      还没有任务。在对话里说「用 DSH 把测试跑一遍」，或者直接 POST /api/v1/tasks。
    </p>

    <ul class="list">
      <li v-for="run in tasks" :key="run.id" class="item" :class="`is-${run.status}`">
        <div class="item-main">
          <p class="item-title">{{ run.title || '（未命名任务）' }}</p>
          <p class="item-meta">
            <span class="badge" :class="`badge-${run.status}`">{{ TASK_STATUS_TEXT[run.status] ?? run.status }}</span>
            {{ formatWhen(run.createdAt, null) }}
            <span v-if="run.project"> · {{ run.project }}</span>
            <span v-if="Number.isFinite(run.priority) && run.priority !== 5"> · P{{ run.priority }}</span>
            <span v-if="run.dependsOn?.length"> · 等 {{ run.dependsOn.length }} 个前置</span>
            <span v-if="run.usage && Number.isFinite(run.usage.totalTokens)"> · {{ run.usage.totalTokens }} tokens</span>
          </p>
          <p v-if="run.progress?.phase" class="item-note">
            进度：{{ run.progress.phase }}<span v-if="run.progress.note"> · {{ run.progress.note }}</span>
          </p>
          <ul v-if="run.artifacts?.length" class="artifact-list">
            <li v-for="(artifact, index) in run.artifacts" :key="index">
              <a v-if="artifact.url" :href="artifact.url" target="_blank" rel="noopener noreferrer">{{ artifactLabel(artifact) }}</a>
              <span v-else>{{ artifactLabel(artifact) }}<span v-if="artifact.path"> · {{ artifact.path }}</span></span>
            </li>
          </ul>
          <p v-if="run.error" class="item-error">错误：{{ run.error }}</p>
          <p v-else-if="run.result" class="item-note">{{ run.result.length > 300 ? `${run.result.slice(0, 300)}…` : run.result }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>
