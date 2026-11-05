# 签名与自动更新

## Windows 代码签名

仓库不带证书。electron-builder 通过环境变量读取证书，构建时自动签名：

```powershell
$env:CSC_LINK = 'C:\path\codesign.pfx'   # 或 base64、URL
$env:CSC_KEY_PASSWORD = '证书密码'
pnpm --filter @qingmei/desktop dist:nsis
```

没有证书时构建会显示 `no code signing certificate configured`，安装包仍可用，但 SmartScreen 会提示未知发布者。

## 自动更新

`electron-updater` 已接入，只有打包版且设置 `QM_UPDATE_URL` 时才启用：

```powershell
$env:QM_UPDATE_URL = 'https://example.com/qingmei/updates'
```

该 URL 需要提供 electron-builder 生成的 `latest.yml` 与安装包（NSIS 差分/全量均可）。没有更新源时不发起任何网络请求。

当前仓库没有发布更新源，因此只完成了接入，未做真实升级验证。

## 产物

```text
apps/desktop/dist/qingmei-desktop-0.1.0-x64.exe   # portable
apps/desktop/dist/青梅 Setup 0.1.0.exe             # NSIS
```
