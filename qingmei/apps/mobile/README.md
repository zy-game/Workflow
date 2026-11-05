# 青梅移动端（M4）

Capacitor Android 壳，内置青梅 Web UI，不依赖手机浏览器。

## 结构

- `www/index.html`：首次连接页（服务器地址 + `QM_TOKEN`，本地校验后保存）
- `www/app/`：由 `scripts/sync-web.mjs` 从 `apps/web/public` 复制，构建产物不提交
- `android/`：Capacitor 生成的 Android 工程
- `capacitor.config.json`：`appId=com.qingmei.mobile`，`webDir=www`

## 构建

需要 JDK 21、Android SDK（platform 35 / build-tools 35）。

```bash
cd qingmei
pnpm install --filter @qingmei/mobile
cd apps/mobile
pnpm sync-web
cd android
./gradlew assembleDebug
```

Windows：

```powershell
$env:ANDROID_HOME='C:\Android\sdk'
cd apps/mobile/android
.\gradlew.bat assembleDebug
```

APK：`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。

Gradle wrapper 默认指向腾讯镜像；离线时可把 `distributionUrl` 改为本地 zip 的 `file:///` 地址。

## 连接

1. 安装 APK，打开青梅
2. 填服务器地址（生产 `https://139.155.78.241:8710`）和 `QM_TOKEN`
3. 连接成功后进入聊天；令牌写入 Android Keystore 加密存储（EncryptedSharedPreferences），下次直接进入
4. 需要换服务器时清除应用数据，或在连接页点“清除已保存的连接”

## 已知边界

- 目前是 Web UI 的移动壳，聊天/任务/审批/审计都能用；后台收到回复时用本地通知提示（需授权）
- Android 后台 WebView 被系统冻结时，SSE 会断开，回到前台自动重连
- 没有正式签名，debug APK 仅供个人安装；release 需要自己的 keystore
