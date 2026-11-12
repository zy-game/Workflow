; 青梅桌面宿主 · Inno Setup 安装脚本
;
; 设计取向（替代 NSIS）：
;   - PrivilegesRequired=lowest：装到 %LOCALAPPDATA%\Programs\Qingmei，不触发 UAC；
;   - 升级就是覆盖安装：同一 AppId，任意旧版本 → 最新版一步到位；
;   - /VERYSILENT 可被应用内更新器直接调起，装完自动重启；
;   - 旧 NSIS 安装（electron-builder 产物）在安装前静默卸载，避免两套并存。
;
; 编译（由 scripts/build-desktop-installer.mjs 调用）：
;   ISCC.exe /DAppVersion=0.1.4 /DSourceDir=<win-unpacked> /DOutputDir=<dist> qingmei.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\win-unpacked"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif

#define AppName "青梅"
#define AppPublisher "Qingmei"
#define AppExeName "Qingmei.exe"
#define AppDataDirName "qingmei-desktop"

[Setup]
AppId={{6BE89DA6-93F7-47E7-94E6-9052BD2339C7}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} 安装程序
DefaultDirName={localappdata}\Programs\Qingmei
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDir}
OutputBaseFilename=Qingmei-Setup-{#AppVersion}
SetupIconFile=..\..\build\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
; lzma2/max 在这个 210MB payload 上会产出「双击没反应」的安装包（stub 解压失败），normal 正常
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
; 安装包本身不签名，SmartScreen 仍可能提示一次；与 NSIS 相比少了杀软对自解压脚本的误报
SignedUninstaller=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: checkedonce

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; 静默安装（自动更新）时不自动拉起，由更新器在安装完成后启动
Filename: "{app}\{#AppExeName}"; Description: "启动 {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 只清程序目录；用户设置与数据在 %APPDATA%\qingmei-desktop，保留
Type: filesandordirs; Name: "{app}\resources\app.asar.unpacked"
Type: dirifempty; Name: "{app}"

[Code]
{ 只做一件事：安装前结束正在运行的青梅，避免文件占用。
  旧 NSIS 版本请手动在「应用和功能」里卸载一次——自动扫描卸载项的写法在
  静默模式下会让 Setup 直接退出（实测），不值得为一次性迁移冒风险。 }

procedure KillRunningApp();
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/IM {#AppExeName} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/IM 青梅.exe /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function InitializeSetup(): Boolean;
begin
  KillRunningApp();
  Result := True;
end;
