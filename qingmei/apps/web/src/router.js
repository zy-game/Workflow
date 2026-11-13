import { createRouter, createWebHashHistory } from 'vue-router'
import ChatView from './views/ChatView.vue'
import MemoriesView from './views/MemoryGraphView.vue'
import WorkbenchView from './views/WorkbenchView.vue'
import PortraitView from './views/PortraitView.vue'
import CostView from './views/CostView.vue'
import SettingsView from './views/SettingsView.vue'

// 导航即路由表：桌面侧栏与移动端抽屉都从这里渲染，ui-contract 测试也断言这张表。
export const NAV = [
  { path: '/', title: '对话', hint: '和青梅说话' },
  { path: '/workbench', title: '工作台', hint: '任务、定时、建议、记录、失败、复盘' },
  { path: '/portraits', title: '画像', hint: '青梅、主人、群' },
  { path: '/memories', title: '记忆', hint: '神经元图谱' },
  { path: '/cost', title: '用量', hint: '余额与 embedding' },
  { path: '/settings', title: '设置', hint: '连接、技能与版本' },
]

// 视图全部静态导入：管理台体量小，省掉懒加载分包，避免「服务重启后点菜单没反应」。
// base 只取 pathname，不能带 query——?token= 会在启动后被抹掉，带上它会让路由算错地址。
const router = createRouter({
  history: createWebHashHistory(window.location.pathname),
  routes: [
    { path: '/', name: 'chat', component: ChatView, meta: { title: '对话' } },
    { path: '/workbench', name: 'workbench', component: WorkbenchView, meta: { title: '工作台' } },
    { path: '/portraits', name: 'portraits', component: PortraitView, meta: { title: '画像' } },
    { path: '/memories', name: 'memories', component: MemoriesView, meta: { title: '记忆' } },
    { path: '/cost', name: 'cost', component: CostView, meta: { title: '用量' } },
    { path: '/settings', name: 'settings', component: SettingsView, meta: { title: '设置' } },
    { path: '/tasks', redirect: '/workbench' },
    { path: '/schedules', redirect: '/workbench' },
    { path: '/autonomy', redirect: '/workbench' },
    { path: '/review', redirect: '/workbench' },
    { path: '/incidents', redirect: '/workbench' },
    { path: '/audit', redirect: '/workbench' },
    { path: '/conversations', redirect: '/portraits' },    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

export default router





