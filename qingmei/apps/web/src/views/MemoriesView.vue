<script setup>
import { computed, onMounted, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'

const facts = ref([])
const proposals = ref([])
const changes = ref([])
const candidates = ref([])
const accepted = ref([])
const rejected = ref([])
const profile = ref([])
const stats = ref(null)
const evaluations = ref({})
const lastChangeId = ref('')
const tab = ref('facts')
const error = ref('')
const loading = ref(false)
const busy = ref('')

const conceptCount = computed(() => Number(stats.value?.concepts ?? 0))
const candidateCount = computed(() => candidates.value.length)
const appliedChanges = computed(() => changes.value.filter((item) => item.status === 'applied'))

async function load() {
  loading.value = true
  try {
    const [factBody, statBody, proposalBody, changeBody, candidateBody, acceptedBody, rejectedBody, profileBody] =
      await Promise.all([
        apiJson(ENDPOINTS.memoryFacts),
        apiJson(ENDPOINTS.memoryStats).catch(() => ({ stats: null })),
        apiJson(ENDPOINTS.conceptProposals).catch(() => ({ proposals: [] })),
        apiJson(ENDPOINTS.conceptChanges).catch(() => ({ changes: [] })),
        apiJson(ENDPOINTS.memoryCandidates).catch(() => ({ items: [] })),
        apiJson(`${ENDPOINTS.memoryCandidates}?status=accepted&limit=10`).catch(() => ({ items: [] })),
        apiJson(`${ENDPOINTS.memoryCandidates}?status=rejected&limit=10`).catch(() => ({ items: [] })),
        apiJson(ENDPOINTS.memoryProfile).catch(() => ({ entries: [] })),
      ])
    facts.value = Array.isArray(factBody?.facts) ? factBody.facts : []
    stats.value = statBody?.stats ?? null
    proposals.value = Array.isArray(proposalBody?.proposals) ? proposalBody.proposals : []
    changes.value = Array.isArray(changeBody?.changes) ? changeBody.changes : []
    candidates.value = Array.isArray(candidateBody?.items) ? candidateBody.items : []
    accepted.value = Array.isArray(acceptedBody?.items) ? acceptedBody.items : []
    rejected.value = Array.isArray(rejectedBody?.items) ? rejectedBody.items : []
    profile.value = Array.isArray(profileBody?.entries) ? profileBody.entries : []
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '读取记忆失败'
  } finally {
    loading.value = false
  }
}

async function decideCandidate(candidate, allow) {
  busy.value = candidate.id
  try {
    await apiSend(ENDPOINTS.memoryCandidateDecide, { body: { id: candidate.id, allow } })
    await load()
  } catch (err) {
    error.value = err.message || '候选处理失败'
  } finally {
    busy.value = ''
  }
}

async function reopenCandidate(candidate) {
  busy.value = candidate.id
  try {
    await apiSend(ENDPOINTS.memoryCandidateReopen, { body: { id: candidate.id } })
    await load()
  } catch (err) {
    error.value = err.message || '恢复失败'
  } finally {
    busy.value = ''
  }
}

async function rollbackBatch(candidate) {
  if (!window.confirm(`撤回这一批采纳的事实？`)) return
  busy.value = candidate.batch_id
  try {
    await apiSend(ENDPOINTS.memoryCandidateRollback, { body: { batchId: candidate.batch_id } })
    await load()
  } catch (err) {
    error.value = err.message || '撤回失败'
  } finally {
    busy.value = ''
  }
}

async function evaluate(proposal) {
  busy.value = proposal.id
  try {
    const body = await apiSend(ENDPOINTS.conceptEvaluate, { body: proposal })
    evaluations.value = { ...evaluations.value, [proposal.id]: body?.evaluation ?? null }
  } catch (err) {
    error.value = err.message || '评估失败'
  } finally {
    busy.value = ''
  }
}

async function apply(proposal) {
  const evaluation = evaluations.value[proposal.id]
  if (!evaluation?.canApply) return
  if (!window.confirm('应用这次概念变更？会保存快照，可回滚。')) return
  busy.value = proposal.id
  try {
    const body = await apiSend(ENDPOINTS.conceptApply, { body: proposal })
    lastChangeId.value = body?.changeId || ''
    await load()
  } catch (err) {
    error.value = err.message || '应用失败'
  } finally {
    busy.value = ''
  }
}

async function rollbackChange(change) {
  busy.value = change.id
  try {
    await apiSend(ENDPOINTS.conceptRollback, { body: { changeId: change.id } })
    lastChangeId.value = ''
    await load()
  } catch (err) {
    error.value = err.message || '回滚失败'
  } finally {
    busy.value = ''
  }
}

async function rollbackAll() {
  const ids = appliedChanges.value.map((item) => item.id)
  if (ids.length === 0) return
  if (!window.confirm(`回滚最近 ${ids.length} 次概念变更？`)) return
  busy.value = 'rollback-batch'
  try {
    await apiSend(ENDPOINTS.conceptRollbackBatch, { body: { changeIds: ids } })
    lastChangeId.value = ''
    await load()
  } catch (err) {
    error.value = err.message || '批量回滚失败'
  } finally {
    busy.value = ''
  }
}

async function rollback() {
  if (!lastChangeId.value) return
  busy.value = 'rollback'
  try {
    await apiSend(ENDPOINTS.conceptRollback, { body: { changeId: lastChangeId.value } })
    lastChangeId.value = ''
    await load()
  } catch (err) {
    error.value = err.message || '回滚失败'
  } finally {
    busy.value = ''
  }
}

async function consolidate() {
  busy.value = 'consolidate'
  try {
    await apiSend(ENDPOINTS.memoryConsolidate, { body: {} })
    await load()
  } catch (err) {
    error.value = err.message || '沉淀失败'
  } finally {
    busy.value = ''
  }
}

async function edit(fact) {
  const next = window.prompt('修正这条记忆的内容', String(fact.object ?? ''))
  if (next === null) return
  const value = next.trim()
  if (!value) return
  try {
    await apiSend(`${ENDPOINTS.memoryFacts}/${encodeURIComponent(fact.id)}`, {
      method: 'PATCH',
      body: { object: value },
    })
    await load()
  } catch (err) {
    error.value = err.message || '修正失败'
  }
}

async function remove(fact) {
  if (!window.confirm(`删除「${fact.object}」？`)) return
  try {
    await apiSend(`${ENDPOINTS.memoryFacts}/${encodeURIComponent(fact.id)}`, { method: 'DELETE' })
    await load()
  } catch (err) {
    error.value = err.message || '删除失败'
  }
}

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">记忆</h2>
        <p class="view-sub">事实由你确认，概念由重复共现沉淀；合并只走提案，可回滚。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
        <button class="btn" type="button" :disabled="busy === 'consolidate'" @click="consolidate">
          {{ busy === 'consolidate' ? '沉淀中…' : '沉淀一次' }}
        </button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>

    <div class="memory-summary" v-if="stats">
      <span>神经元 {{ stats.neurons }}</span>
      <span>点触 {{ stats.synapses }}</span>
      <span>事件 {{ stats.episodes }}</span>
      <span>概念 {{ conceptCount }}</span>
    </div>

    <div class="view-actions memory-tabs">
      <button class="btn small" :class="{ ghost: tab !== 'facts' }" type="button" @click="tab = 'facts'">事实</button>
      <button class="btn small" :class="{ ghost: tab !== 'concepts' }" type="button" @click="tab = 'concepts'">
        概念提案 <span v-if="proposals.length">({{ proposals.length }})</span>
      </button>
      <button class="btn small" :class="{ ghost: tab !== 'candidates' }" type="button" @click="tab = 'candidates'">
        待确认 <span v-if="candidateCount">({{ candidateCount }})</span>
      </button>
      <button class="btn small" :class="{ ghost: tab !== 'profile' }" type="button" @click="tab = 'profile'">画像</button>
    </div>

    <template v-if="tab === 'facts'">
      <p v-if="!loading && facts.length === 0" class="empty">还没有记住什么。聊几句，青梅会自己记。</p>
      <ul class="list">
        <li v-for="fact in facts" :key="fact.id" class="item">
          <div class="item-main">
            <p class="item-title">{{ fact.subject }} {{ fact.predicate }} {{ fact.object }}</p>
            <p class="item-meta">置信 {{ Math.round(Number(fact.confidence) * 100) }}%</p>
          </div>
          <div class="item-actions">
            <button class="btn small ghost" type="button" @click="edit(fact)">修正</button>
            <button class="btn small danger" type="button" @click="remove(fact)">删除</button>
          </div>
        </li>
      </ul>
    </template>

    <template v-else-if="tab === 'concepts'">
      <p v-if="!loading && proposals.length === 0" class="empty">暂时没有概念变更提案。</p>
      <p v-if="lastChangeId" class="item-meta">
        已应用变更 {{ lastChangeId }}
        <button class="btn small danger" type="button" :disabled="busy === 'rollback'" @click="rollback">
          {{ busy === 'rollback' ? '回滚中…' : '回滚' }}
        </button>
      </p>
      <ul class="list">
        <li v-for="proposal in proposals" :key="proposal.id" class="item">
          <div class="item-main">
            <p class="item-title">
              {{ proposal.kind === 'merge' ? '合并概念' : '概念过载' }} · {{ proposal.reason }}
            </p>
            <p class="item-meta">{{ proposal.id }}</p>
            <p class="item-meta" v-if="evaluations[proposal.id]">
              影响概念 {{ evaluations[proposal.id].affectedConcepts }} 个，事件
              {{ evaluations[proposal.id].affectedEpisodes }} 个，重叠
              {{ Math.round(Number(evaluations[proposal.id].overlap) * 100) }}%，风险
              {{ evaluations[proposal.id].risk }}
              <span v-if="!evaluations[proposal.id].canApply">（仅提案，不自动应用）</span>
            </p>
          </div>
          <div class="item-actions">
            <button class="btn small ghost" type="button" :disabled="busy === proposal.id" @click="evaluate(proposal)">评估</button>
            <button
              class="btn small"
              type="button"
              :disabled="busy === proposal.id || !evaluations[proposal.id]?.canApply"
              @click="apply(proposal)"
            >
              应用
            </button>
          </div>
        </li>
      </ul>

      <div v-if="changes.length" class="memory-history">
        <div class="view-actions">
          <h3>最近概念变更</h3>
          <button
            class="btn small danger"
            type="button"
            :disabled="busy === 'rollback-batch' || appliedChanges.length === 0"
            @click="rollbackAll"
          >
            {{ busy === 'rollback-batch' ? '批量回滚中…' : `回滚全部 (${appliedChanges.length})` }}
          </button>
        </div>
        <ul class="list">
          <li v-for="change in changes" :key="change.id" class="item">
            <div class="item-main">
              <p class="item-title">{{ change.kind === 'merge' ? '合并' : '拆分' }} · {{ change.status }}</p>
              <p class="item-meta">{{ change.id }} · {{ new Date(change.createdAt).toLocaleString() }}</p>
            </div>
            <div class="item-actions">
              <button
                v-if="change.status === 'applied'"
                class="btn small danger"
                type="button"
                :disabled="busy === change.id"
                @click="rollbackChange(change)"
              >
                回滚
              </button>
            </div>
          </li>
        </ul>
      </div>
    </template>

    <template v-else-if="tab === 'candidates'">
      <p v-if="!loading && candidates.length === 0" class="empty">
        没有待确认的记忆。聊到「我住在…」「我对…过敏」这类陈述时，候选会出现在这里，点「采纳」才写入记忆。
      </p>
      <ul class="list">
        <li v-for="candidate in candidates" :key="candidate.id" class="item">
          <div class="item-main">
            <p class="item-title">{{ candidate.subject }} {{ candidate.predicate }} {{ candidate.object }}</p>
            <p class="item-meta">
              置信 {{ Math.round(Number(candidate.confidence) * 100) }}% · 规则 {{ candidate.rule }} ·
              {{ new Date(candidate.created_at).toLocaleString() }}
            </p>
          </div>
          <div class="item-actions">
            <button class="btn small" type="button" :disabled="busy === candidate.id" @click="decideCandidate(candidate, true)">
              采纳
            </button>
            <button class="btn small ghost" type="button" :disabled="busy === candidate.id" @click="decideCandidate(candidate, false)">
              忽略
            </button>
          </div>
        </li>
      </ul>

      <div v-if="accepted.length" class="memory-history">
        <h3>最近采纳（可整批撤回）</h3>
        <ul class="list">
          <li v-for="item in accepted" :key="item.id" class="item">
            <div class="item-main">
              <p class="item-title">{{ item.subject }} {{ item.predicate }} {{ item.object }}</p>
              <p class="item-meta">
                批次 {{ item.batch_id }} · {{ new Date(item.decided_at || item.created_at).toLocaleString() }}
              </p>
            </div>
            <div class="item-actions">
              <button class="btn small danger" type="button" :disabled="busy === item.batch_id" @click="rollbackBatch(item)">
                撤回本批
              </button>
            </div>
          </li>
        </ul>
      </div>
      <div v-if="rejected.length" class="memory-history">
        <h3>最近忽略（可恢复）</h3>
        <ul class="list">
          <li v-for="item in rejected" :key="item.id" class="item">
            <div class="item-main">
              <p class="item-title">{{ item.subject }} {{ item.predicate }} {{ item.object }}</p>
              <p class="item-meta">规则 {{ item.rule }} · {{ new Date(item.decided_at || item.created_at).toLocaleString() }}</p>
            </div>
            <div class="item-actions">
              <button class="btn small ghost" type="button" :disabled="busy === item.id" @click="reopenCandidate(item)">
                恢复
              </button>
            </div>
          </li>
        </ul>
      </div>
    </template>

    <template v-else>
      <p v-if="!loading && profile.length === 0" class="empty">
        画像还没有内容。画像按「主体」聚合高置信事实，私聊里会作为稳定背景注入。
      </p>
      <ul class="list">
        <li v-for="entry in profile" :key="entry.subject" class="item">
          <div class="item-main">
            <p class="item-title">{{ entry.subject }}</p>
            <p class="item-meta">
              <span v-for="(item, index) in entry.facts" :key="index">
                {{ item.predicate }} {{ item.object }}
                <span v-if="index < entry.facts.length - 1"> · </span>
              </span>
            </p>
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.memory-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 12px 0;
  color: var(--muted, #6b7280);
  font-size: 13px;
}
.memory-tabs {
  margin-bottom: 12px;
}
</style>
