<script setup>
import { ref } from 'vue'
import { ENDPOINTS } from '../lib/endpoints.js'
import { request } from '../lib/api.js'
import { session, saveToken } from '../lib/session.js'

const emit = defineEmits(['done'])
const user = ref('admin')
const password = ref('')
const token = ref('')
const error = ref('')
const busy = ref(false)

async function loginWithPassword() {
  error.value = ''
  const name = user.value.trim()
  if (!name || !password.value) {
    error.value = '账号和密码都要填'
    return
  }
  busy.value = true
  try {
    const res = await fetch(ENDPOINTS.login, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: name, password: password.value }),
    })
    if (!res.ok) {
      error.value = res.status === 401 ? '账号或密码不对' : `登录失败（HTTP ${res.status}）`
      return
    }
    const body = await res.json().catch(() => ({}))
    if (body && typeof body.token === 'string' && body.token) {
      session.token = body.token
      saveToken(body.token)
    } else {
      session.cookieAuth = true
    }
    emit('done')
  } catch {
    error.value = '登录失败，请检查网络'
  } finally {
    busy.value = false
  }
}

function useToken() {
  const value = token.value.trim()
  if (!value) {
    error.value = '令牌不能为空'
    return
  }
  session.token = value
  saveToken(value)
  emit('done')
}
</script>

<template>
  <div class="login-backdrop" role="dialog" aria-modal="true" aria-labelledby="login-title">
    <div class="login-card">
      <h2 id="login-title" class="login-title">进入青梅</h2>
      <p class="login-sub">用管理员账号登录，或贴上访问令牌。</p>

      <p v-if="error" class="alert" role="alert">{{ error }}</p>

      <label class="field">
        <span class="field-label">管理员账号</span>
        <input v-model="user" class="input" autocomplete="username" />
      </label>
      <label class="field">
        <span class="field-label">密码</span>
        <input v-model="password" class="input" type="password" autocomplete="current-password" @keydown.enter="loginWithPassword" />
      </label>
      <div class="login-actions">
        <button class="btn" type="button" :disabled="busy" @click="loginWithPassword">
          {{ busy ? '登录中…' : '登录' }}
        </button>
      </div>

      <div class="login-divider"><span>或者</span></div>

      <label class="field">
        <span class="field-label">访问令牌（QM_TOKEN）</span>
        <input v-model="token" class="input" placeholder="粘贴令牌后回车" @keydown.enter="useToken" />
      </label>
      <div class="login-actions">
        <button class="btn ghost" type="button" @click="useToken">用令牌进入</button>
      </div>
    </div>
  </div>
</template>
