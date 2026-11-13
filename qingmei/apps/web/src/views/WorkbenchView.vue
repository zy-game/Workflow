<script setup>
import { computed, ref } from 'vue'
import TasksView from './TasksView.vue'
import TaskEventsView from './TaskEventsView.vue'

const tabs = [
  { id: 'tasks', label: '全部任务', component: TasksView },
  { id: 'events', label: '记录', component: TaskEventsView },
]
const active = ref('tasks')
const current = computed(() => tabs.find((tab) => tab.id === active.value)?.component ?? TasksView)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <div>
        <h2 class="view-title">工作台</h2>
        <p class="view-sub">任务、定时、建议、复盘、失败、审计都在这一张任务账本里；状态/来源/触发方式在上面筛。</p>
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
