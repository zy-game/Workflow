# 签名与自动更新（个人版）

## 代码签名

个人版不公开发布，**不做代码签名**。未签名安装包仍可安装，Windows SmartScreen 可能提示未知发布者。

如果以后要签名，electron-builder 通过环境变量读取证书：

```powershell
$env:CSC_LINK = 'C:\path\codesign.pfx'
$env:CSC_KEY_PASSWORD = '证书密码'
pnpm --filter @qingmei/desktop dist:nsis
```

## 自动更新（服务器静态源）

`electron-updater` 已接入，打包版默认从生产服务器检查：

```text
https://139.155.78.241:8710/updates
```

可用 `QM_UPDATE_URL` 覆盖：

```powershell
$env:QM_UPDATE_URL = 'https://example.com/qingmei/updates'
```

服务器目录 `/opt/qingmei/updates/` 由 nginx 直接静态托管：

- `latest.yml`
- `Qingmei-Setup-<version>.exe`

发布更新：

```bash
pnpm --filter @qingmei/desktop dist:nsis
node scripts/desktop-update.mjs
scp apps/desktop/dist/latest.yml \
  apps/desktop/dist/Qingmei-Setup-<version>.exe \
  ubuntu@139.155.78.241:/tmp/
# 服务器上 mv 到 /opt/qingmei/updates/
```

当前 `latest.yml` 指向 0.1.0，安装同版本不会触发升级；bump `apps/desktop/package.json` 的 version 后重新构建即可推送新版本。未签名更新在 Windows 上可能触发 SmartScreen，但个人使用可手动允许。

## 产物

```text
apps/desktop/dist/qingmei-desktop-0.1.0-x64.exe   # portable
apps/desktop/dist/青梅 Setup 0.1.0.exe             # NSIS
```
