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
const devicePrompt = ref('')
const deviceError = ref('')
const error = ref('')
const loading = ref(false)
const statusFilter = ref('all')
const originFilter = ref('all')
const triggerFilter = ref('all')
const scheduleText = ref('')
const scheduleAt = ref('')
const scheduleCron = ref('')
const scheduleError = ref('')
const scheduling = ref(false)
const filteredTasks = computed(() =>
  tasks.value.filter(
    (run) =>
      (statusFilter.value === 'all' || run.status === statusFilter.value) &&
      (originFilter.value === 'all' || run.origin === originFilter.value) &&
      (triggerFilter.value === 'all' || run.trigger === triggerFilter.value),
  ),
)
const selectedDevice = computed(() => devices.value.find((device) => device.id === deviceId.value))
const workspaces = computed(() => selectedDevice.value?.workspaces ?? [])
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
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '读取任务失败'
  } finally {
    loading.value = false
  }
}

watch(deviceId, () => {
  workspaceId.value = workspaces.value[0]?.id ?? ''
})

async function dispatchDevice() {
  deviceError.value = ''
  if (!deviceId.value || !devicePrompt.value.trim()) {
    deviceError.value = '先选设备并写任务'
    return
  }
  try {
    await apiSend(ENDPOINTS.tasks, {
      method: 'POST',
      body: {
        prompt: devicePrompt.value.trim(),
        title: devicePrompt.value.trim().slice(0, 40),
        target: {
          executorId: `device:${deviceId.value}`,
          ...(workspaceId.value ? { workspaceId: workspaceId.value } : {}),
          sessionKey: workspaceId.value || deviceId.value,
          cwd: workspaces.value.find((workspace) => workspace.id === workspaceId.value)?.path,
        },
      },
    })
    devicePrompt.value = ''
    await load()
  } catch (err) {
    deviceError.value = err.message || '派发失败'
  }
}

async function decideTask(run, allow) {
  try {
    await apiSend(ENDPOINTS.taskDecide, { method: 'POST', body: { id: run.id, allow } })
    await load()
  } catch (err) {
    error.value = err.message || '决策失败'
  }
}

async function createScheduled() {
  scheduleError.value = ''
  const text = scheduleText.value.trim()
  if (!text) {
    scheduleError.value = '写点要提醒的内容'
    return
  }
  const body = {
    prompt: text,
    title: text.slice(0, 40),
    kind: 'reminder',
    status: 'scheduled',
    origin: 'schedule',
    target: { executorId: 'local' },
  }
  if (scheduleCron.value.trim()) {
    body.trigger = 'cron'
    body.schedule = { rrule: scheduleCron.value.trim() }
  } else if (scheduleAt.value) {
    body.trigger = 'at'
    body.schedule = { at: new Date(scheduleAt.value).toISOString() }
  } else {
    scheduleError.value = '选一个时间或写 cron'
    return
  }
  scheduling.value = true
  try {
    await apiSend(ENDPOINTS.tasks, { method: 'POST', body })
    scheduleText.value = ''
    scheduleAt.value = ''
    scheduleCron.value = ''
    await load()
  } catch (err) {
    scheduleError.value = err.message || '创建定时任务失败'
  } finally {
    scheduling.value = false
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
      <p class="view-sub">任务直接进目标设备的 worker 队列，由本机 DSH 执行器执行。</p>
      <div class="form-row">
        <select v-model="deviceId" class="input">
          <option value="">选择设备</option>
          <option v-for="device in devices" :key="device.id" :value="device.id">
            {{ device.name }} · {{ device.systemType || device.platform }}/{{ device.arch }} · {{ device.deviceClass || 'desktop' }} · {{ device.online ? '在线' : '离线' }}
          </option>
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
              {{ task.target.executorId }} · {{ task.target.workspaceId || '默认工作区' }} · {{ TASK_STATUS_TEXT[task.status] ?? task.status }}
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

    <div class="card schedule-form">
      <p class="item-title">新建定时任务</p>
      <div class="portrait-grid">
        <label class="field">内容 <input v-model="scheduleText" type="text" placeholder="下午三点开会" /></label>
        <label class="field">时间 <input v-model="scheduleAt" type="datetime-local" /></label>
        <label class="field">或 cron <input v-model="scheduleCron" type="text" placeholder="0 9 * * 1-5" /></label>
      </div>
      <p v-if="scheduleError" class="alert" role="alert">{{ scheduleError }}</p>
      <button class="btn primary" type="button" :disabled="scheduling" @click="createScheduled">
        {{ scheduling ? '创建中…' : '创建' }}
      </button>
    </div>
    <div class="task-filters">
      <select v-model="statusFilter" class="input">
        <option value="all">全部状态</option>
        <option value="proposed">建议</option>
        <option value="scheduled">待触发</option>
        <option value="queued">排队</option>
        <option value="running">进行中</option>
        <option value="needs_approval">待确认</option>
        <option value="done">完成</option>
        <option value="failed">失败</option>
      </select>
      <select v-model="originFilter" class="input">
        <option value="all">全部来源</option>
        <option value="user">用户</option>
        <option value="chat">聊天</option>
        <option value="internal">内部</option>
        <option value="schedule">日程</option>
        <option value="autonomy">主动</option>
        <option value="review">复盘</option>
      </select>
      <select v-model="triggerFilter" class="input">
        <option value="all">全部触发</option>
        <option value="now">立即</option>
        <option value="at">定时</option>
        <option value="cron">周期</option>
        <option value="event">事件</option>
      </select>
    </div>
    <p v-if="!loading && filteredTasks.length === 0" class="empty">
      没有符合条件的任务。
    </p>

    <ul class="list">
      <li v-for="run in filteredTasks" :key="run.id" class="item" :class="`is-${run.status}`">
        <div class="item-main">
          <p class="item-title">{{ run.title || '（未命名任务）' }}</p>
          <p class="item-meta">
            <span class="badge" :class="`badge-${run.status}`">{{ TASK_STATUS_TEXT[run.status] ?? run.status }}</span>
            {{ formatWhen(run.createdAt, null) }}
            <span v-if="run.origin"> · {{ run.origin }}</span>
            <span v-if="run.trigger && run.trigger !== 'now'"> · {{ run.trigger }}</span>
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
        <div class="view-actions">
          <button
            v-if="run.status === 'proposed' || run.status === 'needs_approval'"
            class="btn small"
            type="button"
            @click="decideTask(run, true)"
          >批准</button>
          <button
            v-if="run.status === 'proposed' || run.status === 'needs_approval' || run.status === 'scheduled'"
            class="btn small danger"
            type="button"
            @click="decideTask(run, false)"
          >拒绝</button>
        </div>
      </li>
    </ul>
  </section>
</template>
