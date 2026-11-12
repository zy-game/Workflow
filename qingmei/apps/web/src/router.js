import { createRouter, createWebHashHistory } from 'vue-router'
import ChatView from './views/ChatView.vue'
import TasksView from './views/TasksView.vue'
import SchedulesView from './views/SchedulesView.vue'
import MemoriesView from './views/MemoriesView.vue'
import AutonomyView from './views/AutonomyView.vue'
import ConversationsView from './views/ConversationsView.vue'
import ReviewView from './views/ReviewView.vue'
import IncidentsView from './views/IncidentsView.vue'
import AuditView from './views/AuditView.vue'
import SettingsView from './views/SettingsView.vue'

// 导航即路由表：桌面侧栏与移动端抽屉都从这里渲染，ui-contract 测试也断言这张表。
export const NAV = [
  { path: '/', title: '对话', hint: '和青梅说话' },
  { path: '/tasks', title: '任务', hint: '派给 harness 的活与待确认' },
  { path: '/schedules', title: '日程', hint: '提醒与周期任务' },
  { path: '/memories', title: '记忆', hint: '记住的事实' },
  { path: '/autonomy', title: '主动', hint: '她主动说话的理由' },
  { path: '/conversations', title: '群组', hint: '群标签与回复策略' },
  { path: '/review', title: '复盘', hint: '月度报告与评分' },
  { path: '/incidents', title: '故障', hint: '失败与自愈' },
  { path: '/audit', title: '审计', hint: '工具调用流水' },
  { path: '/settings', title: '设置', hint: '人格与技能版本' },
]

// 视图全部静态导入：管理台体量小，省掉懒加载分包，避免「服务重启后点菜单没反应」。
// base 只取 pathname，不能带 query——?token= 会在启动后被抹掉，带上它会让路由算错地址。
const router = createRouter({
  history: createWebHashHistory(window.location.pathname),
  routes: [
    { path: '/', name: 'chat', component: ChatView, meta: { title: '对话' } },
    { path: '/tasks', name: 'tasks', component: TasksView, meta: { title: '任务' } },
    { path: '/schedules', name: 'schedules', component: SchedulesView, meta: { title: '日程' } },
    { path: '/memories', name: 'memories', component: MemoriesView, meta: { title: '记忆' } },
    { path: '/autonomy', name: 'autonomy', component: AutonomyView, meta: { title: '主动' } },
    { path: '/conversations', name: 'conversations', component: ConversationsView, meta: { title: '群组' } },
    { path: '/review', name: 'review', component: ReviewView, meta: { title: '复盘' } },
    { path: '/incidents', name: 'incidents', component: IncidentsView, meta: { title: '故障' } },
    { path: '/audit', name: 'audit', component: AuditView, meta: { title: '审计' } },
    { path: '/settings', name: 'settings', component: SettingsView, meta: { title: '设置' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router

