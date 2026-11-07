import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base 用相对路径：网关托管在任意前缀、Capacitor 的 file:// 下都能加载。
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
