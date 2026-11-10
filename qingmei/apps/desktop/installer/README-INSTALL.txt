Qingmei Desktop 0.1.3 (portable ZIP)
===================================

Option A (recommended):
1. Extract the whole ZIP to a folder.
2. Double-click START-QINGMEI.cmd.
3. If Windows SmartScreen appears: More info -> Run anyway.

Option B (install + desktop shortcut):
1. Extract the ZIP.
2. Right-click INSTALL-QINGMEI.ps1 -> Run with PowerShell.
   Or:
   powershell -ExecutionPolicy Bypass -File .\INSTALL-QINGMEI.ps1
3. A "Qingmei" shortcut appears on the desktop.

Uninstall:
powershell -ExecutionPolicy Bypass -File .\UNINSTALL-QINGMEI.ps1

Notes:
- Unsigned build; SmartScreen may warn.
- Data: %LOCALAPPDATA%\qingmei-desktop
