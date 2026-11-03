using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class Program {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  static int Main() {
    try {
      IntPtr handle = GetForegroundWindow();
      if (handle == IntPtr.Zero) { Console.Write("0"); return 0; }
      RECT rect;
      if (!GetWindowRect(handle, out rect)) { Console.Write("0"); return 0; }
      Screen screen = Screen.FromHandle(handle);
      if (screen == null) { Console.Write("0"); return 0; }
      int width = rect.Right - rect.Left;
      int height = rect.Bottom - rect.Top;
      Console.Write(width >= screen.Bounds.Width && height >= screen.Bounds.Height ? "1" : "0");
      return 0;
    } catch {
      Console.Write("0");
      return 0;
    }
  }
}