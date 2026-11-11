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
var
  OldInstallFound: Boolean;

{ 找旧版 NSIS/electron-builder 安装并静默卸载；找不到就跳过。 }
function FindOldUninstaller(): String;
var
  Names: TArrayOfString;
  I: Integer;
  Root: Integer;
  Base: String;
  DisplayName: String;
  UninstallString: String;
begin
  Result := '';
  Root := HKCU;
  Base := 'Software\Microsoft\Windows\CurrentVersion\Uninstall';
  if RegGetSubkeyNames(Root, Base, Names) then
  begin
    for I := 0 to GetArrayLength(Names) - 1 do
    begin
      if RegQueryStringValue(Root, Base + '\' + Names[I], 'DisplayName', DisplayName) then
      begin
        if (Pos('青梅', DisplayName) > 0) or (Pos('Qingmei', DisplayName) > 0) then
        begin
          if RegQueryStringValue(Root, Base + '\' + Names[I], 'UninstallString', UninstallString) then
          begin
            { 自己的 AppId 不是这个键名，靠卸载程序路径区分：Inno 的 unins000.exe 会被排除 }
            if Pos('unins000.exe', Lowercase(UninstallString)) = 0 then
            begin
              Result := UninstallString;
              OldInstallFound := True;
              Exit;
            end;
          end;
        end;
      end;
    end;
  end;
end;

procedure KillRunningApp();
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/IM {#AppExeName} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/IM 青梅.exe /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure RemoveOldInstall();
var
  Uninstaller: String;
  Command: String;
  ResultCode: Integer;
begin
  Uninstaller := FindOldUninstaller();
  if Uninstaller = '' then
    Exit;
  { UninstallString 可能带引号或参数；NSIS 静默卸载用 /S }
  Command := Uninstaller;
  if Pos('/S', Command) = 0 then
    Command := Command + ' /S';
  Log('卸载旧版本：' + Command);
  Exec(ExpandConstant('{cmd}'), '/C ' + Command, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { NSIS 卸载器会把自己复制到临时目录后立即返回，等它真正删完 }
  Sleep(2500);
end;

function InitializeSetup(): Boolean;
begin
  KillRunningApp();
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    RemoveOldInstall();
end;
