<script setup>
import { computed, ref } from 'vue'
import TasksView from './TasksView.vue'
import SchedulesView from './SchedulesView.vue'
import AutonomyView from './AutonomyView.vue'
import AuditView from './AuditView.vue'
import IncidentsView from './IncidentsView.vue'
import ReviewView from './ReviewView.vue'

const tabs = [
  { id: 'tasks', label: '任务', component: TasksView },
  { id: 'schedules', label: '定时', component: SchedulesView },
  { id: 'suggestions', label: '建议', component: AutonomyView },
  { id: 'audit', label: '记录', component: AuditView },
  { id: 'failed', label: '失败', component: IncidentsView },
  { id: 'review', label: '复盘', component: ReviewView },
]
const active = ref('tasks')
const current = computed(() => tabs.find((tab) => tab.id === active.value)?.component ?? TasksView)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">工作台</h2>
        <p class="view-sub">任务、定时、建议、记录、失败、复盘都收在这里：它们都是任务的不同状态或触发方式。</p>
      </div>
    </header>
    <nav class="workbench-tabs" aria-label="工作台分类">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="btn ghost"
        :class="{ primary: tab.id === active }"
        @click="active = tab.id"
      >
        {{ tab.label }}
      </button>
    </nav>
    <component :is="current" />
  </section>
</template>
