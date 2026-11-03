# 检测前台窗口是否占满所在显示器；输出 1/0。
# 仅 Windows 使用；由主进程按设置轮询。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class QmFullscreen {
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static bool Check() {
    var handle = GetForegroundWindow();
    if (handle == IntPtr.Zero) return false;
    RECT rect;
    if (!GetWindowRect(handle, out rect)) return false;
    var screen = Screen.FromHandle(handle);
    if (screen == null) return false;
    var bounds = screen.Bounds;
    return (rect.Right - rect.Left) >= bounds.Width && (rect.Bottom - rect.Top) >= bounds.Height;
  }
}
"@
if ([QmFullscreen]::Check()) { '1' } else { '0' }
