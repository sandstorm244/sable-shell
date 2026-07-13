// Tiny Windows helper for the screen-share picker. Compiled at build time
// with mono's mcs (see README) and bundled as resources/winhelper/ — this
// replaces runtime PowerShell invocations, which EDR heuristics dislike.
//
// Commands (stdout, one result per line):
//   info <hwnd>     -> "<pid>|<processName>"
//   restore <hwnd>  -> "restored" | "not-minimized"
//   list            -> "<hwnd>|<title>" per minimized top-level window

using System;
using System.Text;
using System.Runtime.InteropServices;

static class Helper
{
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr h);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr h);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr h, int cmd);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr h);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr h, StringBuilder text, int max);

    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr h, int index);

    delegate bool EnumProc(IntPtr h, IntPtr lparam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumProc callback, IntPtr lparam);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int SW_RESTORE = 9;

    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length == 0)
            return 2;

        switch (args[0])
        {
            case "info":
            {
                IntPtr h = (IntPtr)long.Parse(args[1]);
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                string name = "";
                try
                {
                    name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
                }
                catch { }
                Console.WriteLine(pid + "|" + name);
                return 0;
            }
            case "restore":
            {
                IntPtr h = (IntPtr)long.Parse(args[1]);
                if (IsIconic(h))
                {
                    ShowWindow(h, SW_RESTORE);
                    SetForegroundWindow(h);
                    System.Threading.Thread.Sleep(350);
                    Console.WriteLine("restored");
                }
                else
                {
                    Console.WriteLine("not-minimized");
                }
                return 0;
            }
            case "list":
            {
                EnumWindows(delegate(IntPtr h, IntPtr l)
                {
                    if (!IsIconic(h) || !IsWindowVisible(h))
                        return true;
                    if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0)
                        return true;
                    var sb = new StringBuilder(512);
                    GetWindowText(h, sb, 512);
                    string title = sb.ToString();
                    if (title.Length > 0)
                        Console.WriteLine(((long)h) + "|" + title);
                    return true;
                }, IntPtr.Zero);
                return 0;
            }
        }
        return 2;
    }
}
