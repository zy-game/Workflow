<script setup>
import { ref } from 'vue'
import { installAndroidUpdate } from '../lib/updater.js'

const props = defineProps({ latest: { type: Object, required: true } })
const emit = defineEmits(['dismiss'])
const busy = ref(false)
const error = ref('')

async function install() {
  busy.value = true
  error.value = ''
  try {
    await installAndroidUpdate(props.latest)
    emit('dismiss')
  } catch (err) {
    error.value = err?.message || '更新失败，请稍后重试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-backdrop" role="dialog" aria-modal="true" aria-labelledby="update-title">
    <div class="login-card">
      <h2 id="update-title" class="login-title">发现新版本 {{ latest.version }}</h2>
      <p class="login-sub">
        当前 {{ latest.currentName || latest.current }} · 更新包 {{ Math.round((latest.size || 0) / 1048576) }} MB
      </p>
      <p class="login-sub">下载完成后会弹出系统安装界面，按提示覆盖安装即可。</p>
      <p v-if="error" class="alert" role="alert">{{ error }}</p>
      <div class="login-actions">
        <button class="btn ghost" type="button" :disabled="busy" @click="emit('dismiss')">稍后</button>
        <button class="btn" type="button" :disabled="busy" @click="install">
          {{ busy ? '下载中…' : '立即更新' }}
        </button>
      </div>
    </div>
  </div>
</template>
