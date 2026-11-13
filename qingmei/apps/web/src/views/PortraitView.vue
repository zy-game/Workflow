<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { apiJson, apiSend } from '../lib/api.js'

const items = ref([])
const psyche = ref(null)
const error = ref('')
const loading = ref(false)
const saving = ref(false)
const selfForm = reactive({ persona: '', traits: '' })
const personForm = reactive({ name: '主人', traits: '' })

const groupForm = reactive({ id: '', name: '', blocked: '', note: '', requireApproval: true })

async function load() {
  loading.value = true
  try {
    const [body, mind] = await Promise.all([
      apiJson(ENDPOINTS.portraits),
      apiJson(ENDPOINTS.psyche).catch(() => null),
    ])
    items.value = Array.isArray(body?.items) ? body.items : []
    psyche.value = mind
    const self = items.value.find((item) => item.kind === 'self')
    if (self) {
      selfForm.persona = self.persona || ''
      selfForm.traits = (self.traits ?? []).join('、')
    }
    const person = items.value.find((item) => item.kind === 'person')
    if (person) {
      personForm.name = person.name || '主人'
      personForm.traits = (person.traits ?? []).join('、')
    }
    error.value = ''
  } catch (err) {
    error.value = err instanceof TypeError ? '无法连接服务' : err.message || '加载画像失败'
  } finally {
    loading.value = false
  }
}

async function save(kind, payload) {
  saving.value = true
  try {
    await apiSend(ENDPOINTS.portraits, { method: 'POST', body: { kind, ...payload } })
    await load()
  } catch (err) {
    error.value = err.message || '保存失败'
  } finally {
    saving.value = false
  }
}

function saveSelf() {
  void save('self', { id: 'self', name: '青梅', persona: selfForm.persona, traits: splitTraits(selfForm.traits) })
}
function savePerson() {
  void save('person', { id: 'owner', name: personForm.name, traits: splitTraits(personForm.traits) })
}
function saveGroup() {
  if (!groupForm.name.trim()) return
  void save('group', {
    ...(groupForm.id.trim() ? { id: `group:${groupForm.id.trim()}` } : {}),
    name: groupForm.name,
    rules: {
      blocked: splitTraits(groupForm.blocked),
      note: groupForm.note,
      requireApproval: groupForm.requireApproval,
    },
  })
}

function splitTraits(value) {
  return String(value || '')
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

const groups = () => items.value.filter((item) => item.kind === 'group')

onMounted(load)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">画像</h2>
        <p class="view-sub">青梅的人格、主人的偏好、群的规矩，各是一份画像；它们决定怎么说话和什么不能发。</p>
      </div>
      <div class="view-actions">
        <button class="btn ghost" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </header>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>

    <article class="card portrait-card">
      <h3>青梅（自己）</h3>
      <label class="field">
        人格
        <textarea v-model="selfForm.persona" rows="4" placeholder="你叫青梅……"></textarea>
      </label>
      <label class="field">
        特质（顿号/逗号分隔）
        <input v-model="selfForm.traits" type="text" placeholder="务实、直接、不寒暄" />
      </label>
      <button class="btn primary" type="button" :disabled="saving" @click="saveSelf">保存青梅人格</button>
    </article>

    <article class="card portrait-card">
      <h3>主人</h3>
      <label class="field">称呼 <input v-model="personForm.name" type="text" /></label>
      <label class="field">
        画像
        <textarea v-model="personForm.traits" rows="3" placeholder="作息、偏好、边界"></textarea>
      </label>
      <button class="btn primary" type="button" :disabled="saving" @click="savePerson">保存主人画像</button>
    </article>

    <article v-if="psyche" class="card portrait-card">
      <h3>关系与日记</h3>
      <p class="item-meta">只记一起做过的事，不做情绪评分。</p>
      <ul class="list">
        <li v-for="event in (psyche.relation?.events ?? []).slice(-5)" :key="event.text" class="item">
          <p class="item-meta">{{ event.kind === 'failed' ? '失败' : '完成' }} · {{ event.text }}</p>
        </li>
      </ul>
      <p v-if="(psyche.relation?.events ?? []).length === 0" class="item-meta">还没有共同经历。</p>
      <h4>最近的日记</h4>
      <ul class="list">
        <li v-for="journal in (psyche.journals ?? []).slice(0, 3)" :key="journal.day" class="item">
          <p class="item-title">{{ journal.day }}</p>
          <p class="item-meta">{{ journal.text }}</p>
        </li>
      </ul>
      <p v-if="(psyche.journals ?? []).length === 0" class="item-meta">还没有日记。</p>
    </article>

    <article class="card portrait-card">
      <h3>群</h3>
      <ul class="list">
        <li v-for="group in groups()" :key="group.id" class="item">
          <p class="item-title">{{ group.name }}</p>
          <p class="item-meta">
            禁提：{{ (group.rules?.blocked ?? []).join('、') || '无' }} ·
            {{ group.rules?.requireApproval ? '命中转审批' : '命中直接压' }}
          </p>
          <p class="item-meta">{{ group.rules?.note || '' }}</p>
        </li>
      </ul>
      <div class="portrait-grid">
        <label class="field">群 ID <input v-model="groupForm.id" type="text" placeholder="g1（可选）" /></label>
        <label class="field">群名 <input v-model="groupForm.name" type="text" placeholder="XX 聊天群" /></label>
        <label class="field">禁提词 <input v-model="groupForm.blocked" type="text" placeholder="三国、项目" /></label>
        <label class="field">规则说明 <input v-model="groupForm.note" type="text" placeholder="聊天群，不能提项目" /></label>
      </div>
      <label class="toggle"><input v-model="groupForm.requireApproval" type="checkbox" /> 命中后转审批</label>
      <button class="btn primary" type="button" :disabled="saving" @click="saveGroup">保存群画像</button>
    </article>
  </section>
</template>
