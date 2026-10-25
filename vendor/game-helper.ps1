param([switch]$Probe)

$ErrorActionPreference = 'Stop'
$gameDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $gameDir 'config.json'
$statusPath = Join-Path $gameDir 'status.json'
$commandPath = Join-Path $gameDir 'command.json'
$sessionPath = Join-Path $gameDir 'session.json'
$gamesPath = Join-Path $gameDir 'games.json'
$logPath = Join-Path $gameDir 'game-helper.log'
$helperVersion = 1

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class PulseGameMode
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STICKYKEYS { public int cbSize; public int dwFlags; }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(
        IntPtr hWnd, int attribute, out int value, int valueSize);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint action, uint param, ref STICKYKEYS keys, uint winIni);

    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);

    [DllImport("ntdll.dll")]
    public static extern int NtSuspendProcess(IntPtr processHandle);

    [DllImport("ntdll.dll")]
    public static extern int NtResumeProcess(IntPtr processHandle);

    [DllImport("psapi.dll")]
    public static extern bool EmptyWorkingSet(IntPtr processHandle);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

    [DllImport("user32.dll")]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    private static LowLevelKeyboardProc hookProc;
    private static IntPtr hookHandle = IntPtr.Zero;
    private static Thread hookThread;
    private static uint hookThreadId;
    private static volatile bool hookRunning;

    public static bool WindowsKeyBlocked
    {
        get { return hookRunning; }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            if (message == 0x0100 || message == 0x0101 || message == 0x0104 || message == 0x0105)
            {
                var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if (info.vkCode == 0x5B || info.vkCode == 0x5C)
                {
                    return (IntPtr)1;
                }
            }
        }
        return CallNextHookEx(hookHandle, nCode, wParam, lParam);
    }

    public static bool StartWindowsKeyBlock()
    {
        if (hookRunning) return true;
        hookRunning = true;
        hookThread = new Thread(() =>
        {
            try
            {
                hookThreadId = GetCurrentThreadId();
                hookProc = HookCallback;
                hookHandle = SetWindowsHookEx(13, hookProc, GetModuleHandle(null), 0);
                if (hookHandle == IntPtr.Zero)
                {
                    hookRunning = false;
                    return;
                }
                MSG message;
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
            }
            finally
            {
                if (hookHandle != IntPtr.Zero)
                {
                    UnhookWindowsHookEx(hookHandle);
                    hookHandle = IntPtr.Zero;
                }
                hookRunning = false;
            }
        });
        hookThread.IsBackground = true;
        hookThread.Start();
        Thread.Sleep(140);
        return hookRunning;
    }

    public static void StopWindowsKeyBlock()
    {
        if (hookThread == null && hookHandle == IntPtr.Zero) return;
        hookRunning = false;
        if (hookThreadId != 0)
        {
            PostThreadMessage(hookThreadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
        }
        if (hookHandle != IntPtr.Zero)
        {
            UnhookWindowsHookEx(hookHandle);
            hookHandle = IntPtr.Zero;
        }
        if (hookThread != null)
        {
            hookThread.Join(1200);
            hookThread = null;
        }
        hookThreadId = 0;
    }

    public class DesktopState
    {
        public long[] Windows;
        public long[] Shell;
    }

    private static bool IsShellClass(IntPtr hWnd)
    {
        var name = new StringBuilder(128);
        GetClassName(hWnd, name, name.Capacity);
        string value = name.ToString();
        return value == "Progman" || value == "WorkerW" || value == "Shell_TrayWnd" ||
               value == "Shell_SecondaryTrayWnd";
    }

    public static bool IsDesktopForeground()
    {
        try
        {
            IntPtr foreground = GetForegroundWindow();
            if (foreground == IntPtr.Zero) return false;
            var name = new StringBuilder(128);
            GetClassName(foreground, name, name.Capacity);
            string value = name.ToString();
            return value == "Progman" || value == "WorkerW";
        }
        catch
        {
            return false;
        }
    }

    public static bool HasVisibleGameWindow(uint processId)
    {
        try
        {
            bool found = false;
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                uint owner;
                GetWindowThreadProcessId(hWnd, out owner);
                if (owner != processId) return true;
                if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
                int exStyle = GetWindowLong(hWnd, -20);
                if ((exStyle & 0x80) != 0) return true;
                var title = new StringBuilder(256);
                GetWindowText(hWnd, title, title.Capacity);
                RECT rect;
                if (!GetWindowRect(hWnd, out rect)) return true;
                int width = rect.Right - rect.Left;
                int height = rect.Bottom - rect.Top;
                if (title.Length == 0 && (width < 320 || height < 240)) return true;
                found = true;
                return false;
            }, IntPtr.Zero);
            return found;
        }
        catch
        {
            return false;
        }
    }

    public static bool HasAnyGameWindow(uint processId)
    {
        try
        {
            bool found = false;
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                uint owner;
                GetWindowThreadProcessId(hWnd, out owner);
                if (owner != processId) return true;
                int exStyle = GetWindowLong(hWnd, -20);
                if ((exStyle & 0x80) != 0) return true;
                var title = new StringBuilder(256);
                GetWindowText(hWnd, title, title.Capacity);
                RECT rect;
                if (!GetWindowRect(hWnd, out rect)) return true;
                int width = rect.Right - rect.Left;
                int height = rect.Bottom - rect.Top;
                if (title.Length == 0 && (width < 320 || height < 240)) return true;
                found = true;
                return false;
            }, IntPtr.Zero);
            return found;
        }
        catch
        {
            return false;
        }
    }

    private static IntPtr FindTopLevelWindow(string className, string title)
    {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            var cls = new StringBuilder(128);
            GetClassName(hWnd, cls, cls.Capacity);
            if (!string.IsNullOrEmpty(className) && cls.ToString() != className) return true;
            if (!string.IsNullOrEmpty(title))
            {
                var text = new StringBuilder(256);
                GetWindowText(hWnd, text, text.Capacity);
                if (text.ToString() != title) return true;
            }
            result = hWnd;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    private static bool IsWindowCloaked(IntPtr hWnd)
    {
        try
        {
            int cloaked;
            int result = DwmGetWindowAttribute(hWnd, 14, out cloaked, sizeof(int));
            return result == 0 && cloaked != 0;
        }
        catch
        {
            return false;
        }
    }

    // Keep Pulse directly above the desktop but below every ordinary window.
    // Only when no ordinary window is above the desktop (Win+D / Show Desktop)
    // is Pulse made topmost, so it stays visible on the exposed desktop.
    public static void ManagePulseZOrder()
    {
        try
        {
            IntPtr pulse = FindTopLevelWindow(null, "Pulse");
            if (pulse == IntPtr.Zero || !IsWindowVisible(pulse) || IsIconic(pulse)) return;

            IntPtr progman = FindTopLevelWindow("Progman", null);
            if (progman == IntPtr.Zero) return;

            IntPtr lowestApp = IntPtr.Zero;
            IntPtr cursor = GetWindow(progman, 3);
            while (cursor != IntPtr.Zero)
            {
                if (cursor != pulse &&
                    IsWindowVisible(cursor) &&
                    !IsIconic(cursor) &&
                    !IsShellClass(cursor) &&
                    !IsWindowCloaked(cursor))
                {
                    lowestApp = cursor;
                    break;
                }
                cursor = GetWindow(cursor, 3);
            }

            const uint flags = 0x0001 | 0x0002 | 0x0010;
            if (lowestApp != IntPtr.Zero)
            {
                SetWindowPos(pulse, lowestApp, 0, 0, 0, 0, flags);
            }
            else if (IsDesktopForeground())
            {
                SetWindowPos(pulse, (IntPtr)(-1), 0, 0, 0, 0, flags);
            }
            else
            {
                SetWindowPos(pulse, (IntPtr)(-2), 0, 0, 0, 0, flags);
            }
        }
        catch
        {
            // Z-order maintenance must never stop game detection.
        }
    }

    private static void HideClass(string className, List<long> handles)
    {
        var found = new List<IntPtr>();
        IntPtr current = IntPtr.Zero;
        while ((current = FindWindowEx(IntPtr.Zero, current, className, null)) != IntPtr.Zero)
        {
            if (IsWindowVisible(current)) found.Add(current);
        }
        foreach (IntPtr handle in found)
        {
            ShowWindow(handle, 0);
            handles.Add(handle.ToInt64());
        }
    }

    private static IntPtr FindDesktopIconList()
    {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr view = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (view == IntPtr.Zero)
        {
            IntPtr discovered = IntPtr.Zero;
            EnumWindows((hWnd, lParam) =>
            {
                IntPtr child = FindWindowEx(hWnd, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (child != IntPtr.Zero)
                {
                    discovered = child;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            view = discovered;
        }
        if (view == IntPtr.Zero) return IntPtr.Zero;
        return FindWindowEx(view, IntPtr.Zero, "SysListView32", null);
    }

    public static DesktopState HideGameDesktop(int gamePid)
    {
        var state = new DesktopState();
        var shell = new List<long>();
        var windows = new List<long>();

        HideClass("Shell_TrayWnd", shell);
        HideClass("Shell_SecondaryTrayWnd", shell);
        IntPtr iconList = FindDesktopIconList();
        if (iconList != IntPtr.Zero && IsWindowVisible(iconList))
        {
            ShowWindow(iconList, 0);
            shell.Add(iconList.ToInt64());
        }

        EnumWindows((hWnd, lParam) =>
        {
            if (!IsWindowVisible(hWnd) || IsIconic(hWnd) || IsShellClass(hWnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == (uint)gamePid) return true;
            if (GetWindow(hWnd, 4) != IntPtr.Zero) return true;
            int exStyle = GetWindowLong(hWnd, -20);
            if ((exStyle & 0x80) != 0) return true;
            ShowWindow(hWnd, 6);
            windows.Add(hWnd.ToInt64());
            return true;
        }, IntPtr.Zero);

        state.Windows = windows.ToArray();
        state.Shell = shell.ToArray();
        return state;
    }

    public static void RestoreGameDesktop(long[] windows, long[] shell)
    {
        if (shell != null)
        {
            foreach (long handle in shell)
            {
                if (handle != 0) ShowWindow(new IntPtr(handle), 5);
            }
        }
        if (windows != null)
        {
            foreach (long handle in windows)
            {
                if (handle != 0) ShowWindow(new IntPtr(handle), 9);
            }
        }
    }
}
'@

function Write-Log([string]$message) {
  try {
    $line = '{0:o} {1}' -f (Get-Date), $message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {}
}

function Write-Json([string]$path, $value) {
  $json = ConvertTo-Json -InputObject $value -Depth 8 -Compress
  $temp = $path + '.tmp'
  [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temp -Destination $path -Force
}

function Read-Json([string]$path) {
  try {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $raw = [System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false)))
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-Games {
  $stored = Read-Json $gamesPath
  if ($null -eq $stored) { return @() }
  return @($stored)
}

function Save-Games($games) {
  Write-Json $gamesPath $games
}

function Register-Game($game) {
  try {
    if (-not $game -or -not $game.name) { return }
    if ([int]$game.pid -eq 0) { return }
    $gamePath = [string]$game.path
    $idSource = if ($gamePath) { $gamePath } else { [string]$game.name }
    $id = $idSource.ToLowerInvariant()
    $games = @(Get-Games)
    $existing = @($games | Where-Object {
      [string]$_.id -eq $id -or
      [string]$_.name -eq [string]$game.name -or
      ([string]$_.processName -and [string]$_.processName -eq [string]$game.processName)
    })
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($existing.Count -gt 0) {
      $record = $existing[0]
      $record.name = [string]$game.name
      if ($gamePath) { $record.path = $gamePath }
      if ($game.processName) { $record.processName = [string]$game.processName }
      if ([int]$game.steamAppId -gt 0) { $record.steamAppId = [int]$game.steamAppId }
      if ($game.launcher) { $record.launcher = [string]$game.launcher }
      if ($record.source -ne 'manual' -and $record.source -ne 'steam') {
        $record.source = if ($game.source) { [string]$game.source } else { 'auto' }
      }
      $record.lastPlayed = $now
      $record.launches = [int]$record.launches + 1
    } else {
      $games += [pscustomobject]@{
        id = $id
        name = [string]$game.name
        path = $gamePath
        processName = [string]$game.processName
        steamAppId = if ([int]$game.steamAppId -gt 0) { [int]$game.steamAppId } else { $null }
        launcher = [string]$game.launcher
        source = if ($game.source) { [string]$game.source } else { 'auto' }
        addedAt = $now
        lastPlayed = $now
        launches = 1
      }
    }
    Save-Games $games
  } catch {
    Write-Log "Could not update the game list: $($_.Exception.Message)"
  }
}

function Find-LibraryGame {
  $blockedIds = @('pulse', 'electron', 'powershell', 'pwsh')
  foreach ($game in @(Get-Games)) {
    try {
      $processName = [string]$game.processName
      if (-not $processName -and $game.path) {
        $processName = [System.IO.Path]::GetFileNameWithoutExtension([string]$game.path)
      }
      if (-not $processName) { continue }
      if ($blockedIds -contains $processName.ToLowerInvariant()) { continue }

      $gamePath = ''
      try { $gamePath = [System.IO.Path]::GetFullPath([string]$game.path) } catch {}
      $processes = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
      foreach ($process in $processes) {
        if ($process.Id -eq $PID) { continue }
        # A process that is still only a background worker/updater is not a
        # game session yet. Require a real, visible top-level game window.
        if (-not [PulseGameMode]::HasVisibleGameWindow([uint32]$process.Id)) { continue }
        $processPath = ''
        try { $processPath = [System.IO.Path]::GetFullPath([string]$process.Path) } catch {}
        if ($gamePath -and $processPath -and ($processPath -ne $gamePath)) {
          # Same executable name from another installation should not match.
          continue
        }
        return [pscustomobject]@{
          pid = $process.Id
          name = [string]$game.name
          title = [string]$process.MainWindowTitle
          path = $processPath
          processName = $process.ProcessName
          steamAppId = if ([int]$game.steamAppId -gt 0) { [int]$game.steamAppId } else { $null }
          launcher = [string]$game.launcher
          source = if ($game.source -eq 'manual') { 'manual' } elseif ($game.source -eq 'steam') { 'steam' } else { 'auto' }
        }
      }
    } catch {}
  }
  return $null
}

function Get-GameConfig {
  $saved = Read-Json $configPath
  $tweaks = @{
    preventSleep = $true
    highPerformance = $true
    clearClipboard = $true
    trimMemory = $true
    stickyKeys = $true
    cortana = $true
    backgroundApps = $true
    telemetry = $true
    errorReporting = $true
    windowsKey = $false
    gameDesktop = $false
  }
  if ($saved -and $saved.tweaks) {
    foreach ($key in @($tweaks.Keys)) {
      if ($null -ne $saved.tweaks.$key) { $tweaks[$key] = [bool]$saved.tweaks.$key }
    }
  }
  return [pscustomobject]@{
    enabled = if ($null -ne $saved.enabled) { [bool]$saved.enabled } else { $true }
    autoDetect = if ($null -ne $saved.autoDetect) { [bool]$saved.autoDetect } else { $true }
    tweaks = $tweaks
  }
}

$script:active = $false
$script:game = $null
$script:applied = @()
$script:errors = @()
$script:session = $null
$script:sessionId = ''
$script:memoryFreedBytes = [long]0
$script:lastSession = $null
$script:admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
$script:candidatePid = 0
$script:candidateSince = $null
$script:libraryCandidatePid = 0
$script:libraryCandidateSince = $null
$script:gameWindowMissingSince = $null
$script:suppressedPid = 0
$script:suppressedName = ''

$script:blockedProcesses = @(
  'explorer', 'pulse', 'electron', 'powershell', 'pwsh',
  'chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi',
  'vlc', 'mpc-hc', 'mpc-hc64', 'potplayermini', 'potplayermini64', 'video.ui',
  'spotify', 'discord', 'teams', 'ms-teams', 'zoom',
  'acrobat', 'winword', 'excel', 'powerpnt',
  'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'lockapp',
  'taskmgr', 'systemsettings', 'applicationframehost'
)

$script:backgroundNames = @(
  'OneDrive', 'Dropbox', 'GoogleDriveFS', 'Adobe Desktop Service',
  'AdobeIPCBroker', 'CCleaner', 'Spotify', 'MicrosoftTeams', 'ms-teams',
  'Skype', 'YourPhone', 'PhoneExperienceHost'
)

function Get-ForegroundFullscreen {
  try {
    $hwnd = [PulseGameMode]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero -or -not [PulseGameMode]::IsWindowVisible($hwnd)) {
      return $null
    }

    $rect = New-Object 'PulseGameMode+RECT'
    if (-not [PulseGameMode]::GetWindowRect($hwnd, [ref]$rect)) { return $null }

    $monitor = [PulseGameMode]::MonitorFromWindow($hwnd, 2)
    if ($monitor -eq [IntPtr]::Zero) { return $null }
    $info = New-Object 'PulseGameMode+MONITORINFO'
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][PulseGameMode+MONITORINFO])
    if (-not [PulseGameMode]::GetMonitorInfo($monitor, [ref]$info)) { return $null }

    $tolerance = 2
    if ($rect.Left -gt ($info.rcMonitor.Left + $tolerance)) { return $null }
    if ($rect.Top -gt ($info.rcMonitor.Top + $tolerance)) { return $null }
    if ($rect.Right -lt ($info.rcMonitor.Right - $tolerance)) { return $null }
    if ($rect.Bottom -lt ($info.rcMonitor.Bottom - $tolerance)) { return $null }

    $processId = 0
    [PulseGameMode]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null
    if ($processId -eq 0) { return $null }
    $process = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $name = [string]$process.ProcessName
    if ($script:blockedProcesses -contains $name.ToLowerInvariant()) { return $null }
    $processPath = ''
    try { $processPath = [string]$process.Path } catch {}

    return [pscustomobject]@{
      pid = [int]$processId
      name = $name
      title = [string]$process.MainWindowTitle
      path = $processPath
      processName = $name
      source = 'auto'
    }
  } catch {
    return $null
  }
}

function Write-Status {
  $config = Get-GameConfig
  $payload = [ordered]@{
    ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    active = $script:active
    game = $script:game
    sessionId = $script:sessionId
    memoryFreedBytes = [long]$script:memoryFreedBytes
    lastSession = $script:lastSession
    autoDetect = [bool]$config.autoDetect
    enabled = [bool]$config.enabled
    applied = @($script:applied)
    errors = @($script:errors)
    admin = $script:admin
    helperVersion = $helperVersion
    desktopVisible = [PulseGameMode]::IsDesktopForeground()
    pid = $PID
  }
  Write-Json $statusPath $payload
}

function Invoke-PowerPlan {
  $previous = (& powercfg.exe /getactivescheme 2>$null) -join ' '
  $match = [regex]::Match($previous, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
  if (-not $match.Success) { throw 'Could not read the active power plan.' }
  & powercfg.exe /setactive '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & powercfg.exe /setactive 'SCHEME_MAX' 2>$null | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { throw 'Could not switch to the high performance power plan.' }
  return $match.Value
}

function Suspend-BackgroundApps {
  $suspended = @()
  foreach ($name in $script:backgroundNames) {
    $items = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID })
    foreach ($process in $items) {
      try {
        $handle = $process.Handle
        $result = [PulseGameMode]::NtSuspendProcess($handle)
        if ($result -eq 0) {
          $suspended += [pscustomobject]@{ id = $process.Id; name = $process.ProcessName }
        }
      } catch {}
    }
  }
  return $suspended
}

function Resume-BackgroundApps($suspended) {
  foreach ($item in @($suspended)) {
    try {
      $process = Get-Process -Id $item.id -ErrorAction Stop
      [PulseGameMode]::NtResumeProcess($process.Handle) | Out-Null
    } catch {}
  }
}

function Disable-StickyKeys {
  $keys = New-Object 'PulseGameMode+STICKYKEYS'
  $keys.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][PulseGameMode+STICKYKEYS])
  if (-not [PulseGameMode]::SystemParametersInfo(0x000A, 0, [ref]$keys, 0)) {
    throw 'Could not read sticky keys state.'
  }
  $original = $keys.dwFlags
  $keys.dwFlags = $keys.dwFlags -band (-bnot 0x1)
  if (-not [PulseGameMode]::SystemParametersInfo(0x000B, 0, [ref]$keys, 2)) {
    throw 'Could not disable sticky keys.'
  }
  return $original
}

function Restore-StickyKeys([int]$flags) {
  if ($null -eq $flags) { return }
  $keys = New-Object 'PulseGameMode+STICKYKEYS'
  $keys.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][PulseGameMode+STICKYKEYS])
  $keys.dwFlags = $flags
  [PulseGameMode]::SystemParametersInfo(0x000B, 0, [ref]$keys, 2) | Out-Null
}

function Start-Session($game) {
  if ($script:active) { return }
  $config = Get-GameConfig
  $tweaks = $config.tweaks
  $script:applied = @()
  $script:errors = @()
  $script:game = $game
  $script:memoryFreedBytes = [long]0
  $script:sessionId = [guid]::NewGuid().ToString('N')
  $script:gameWindowMissingSince = $null

  $session = [ordered]@{
    id = $script:sessionId
    game = $game
    startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    powerPlan = $null
    stickyKeys = $null
    services = @()
    suspended = @()
    memoryFreedBytes = [long]0
    preventSleep = $false
  }

  if ($tweaks.preventSleep) {
    try {
      [PulseGameMode]::SetThreadExecutionState([uint32]2147483651) | Out-Null
      $session.preventSleep = $true
      $script:applied += 'preventSleep'
    } catch {
      $script:errors += "preventSleep: $($_.Exception.Message)"
    }
  }

  if ($tweaks.highPerformance) {
    try {
      $session.powerPlan = Invoke-PowerPlan
      $script:applied += 'highPerformance'
    } catch {
      $script:errors += "highPerformance: $($_.Exception.Message)"
    }
  }

  if ($tweaks.clearClipboard) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.Clipboard]::Clear()
      $script:applied += 'clearClipboard'
    } catch {
      try {
        & cmd.exe /c 'echo. | clip' | Out-Null
        $script:applied += 'clearClipboard'
      } catch {
        $script:errors += "clearClipboard: $($_.Exception.Message)"
      }
    }
  }

  if ($tweaks.stickyKeys) {
    try {
      $session.stickyKeys = Disable-StickyKeys
      $script:applied += 'stickyKeys'
    } catch {
      $script:errors += "stickyKeys: $($_.Exception.Message)"
    }
  }

  if ($tweaks.windowsKey) {
    try {
      if (-not [PulseGameMode]::StartWindowsKeyBlock()) {
        throw 'Could not install the keyboard hook.'
      }
      $session.windowsKey = $true
      $script:applied += 'windowsKey'
    } catch {
      $script:errors += "windowsKey: $($_.Exception.Message)"
    }
  }

  if ($tweaks.gameDesktop -and [int]$game.pid -ne 0) {
    try {
      $desktop = [PulseGameMode]::HideGameDesktop([int]$game.pid)
      $session.desktop = [pscustomobject]@{
        windows = @($desktop.Windows)
        shell = @($desktop.Shell)
      }
      $script:applied += 'gameDesktop'
    } catch {
      $script:errors += "gameDesktop: $($_.Exception.Message)"
    }
  }

  if ($tweaks.cortana) {
    try {
      $cortana = @(Get-Process -Name 'Cortana', 'Microsoft.Cortana' -ErrorAction SilentlyContinue)
      if ($cortana.Count -gt 0) {
        $cortana | Stop-Process -Force -ErrorAction SilentlyContinue
        $script:applied += 'cortana'
      }
    } catch {
      $script:errors += "cortana: $($_.Exception.Message)"
    }
  }

  if ($tweaks.backgroundApps) {
    try {
      $session.suspended = @(Suspend-BackgroundApps)
      if ($session.suspended.Count -gt 0) {
        $script:applied += 'backgroundApps'
      }
    } catch {
      $script:errors += "backgroundApps: $($_.Exception.Message)"
    }
  }

  if ($tweaks.trimMemory -and $session.suspended.Count -gt 0) {
    try {
      $beforeBytes = [long]0
      $afterBytes = [long]0
      foreach ($item in $session.suspended) {
        try {
          $process = Get-Process -Id $item.id -ErrorAction Stop
          $beforeBytes += [long]$process.WorkingSet64
          [PulseGameMode]::EmptyWorkingSet($process.Handle) | Out-Null
        } catch {}
      }
      Start-Sleep -Milliseconds 120
      foreach ($item in $session.suspended) {
        try {
          $process = Get-Process -Id $item.id -ErrorAction Stop
          $afterBytes += [long]$process.WorkingSet64
        } catch {}
      }
      $session.memoryFreedBytes = [long][math]::Max(0, $beforeBytes - $afterBytes)
      $script:memoryFreedBytes = [long]$session.memoryFreedBytes
      $script:applied += 'trimMemory'
    } catch {
      $script:errors += "trimMemory: $($_.Exception.Message)"
    }
  }

  if ($tweaks.telemetry -or $tweaks.errorReporting) {
    foreach ($serviceName in @('DiagTrack', 'WerSvc')) {
      if ($serviceName -eq 'DiagTrack' -and -not $tweaks.telemetry) { continue }
      if ($serviceName -eq 'WerSvc' -and -not $tweaks.errorReporting) { continue }
      try {
        $service = Get-Service -Name $serviceName -ErrorAction Stop
        if ($service.Status -eq 'Running') {
          Stop-Service -Name $serviceName -Force -ErrorAction Stop
          $session.services += [pscustomobject]@{ name = $serviceName; wasRunning = $true }
          $script:applied += $serviceName
        }
      } catch {
        $script:errors += "${serviceName}: $($_.Exception.Message)"
      }
    }
  }

  $script:session = $session
  Write-Json $sessionPath $session
  $script:active = $true
  if ($game -and [int]$game.pid -ne 0 -and $game.name -ne 'Manual') {
    Register-Game $game
  }
  Write-Status
  Write-Log "Started game session for $($game.name) ($($game.pid))"
}

function Stop-Session([string]$reason) {
  if (-not $script:active) { return }
  Write-Log "Stopping game session: $reason"
  $session = $script:session
  if ($null -eq $session) { $session = Read-Json $sessionPath }

  try {
    if ($session -and $session.preventSleep) {
      [PulseGameMode]::SetThreadExecutionState([uint32]2147483648) | Out-Null
    }
  } catch {}

  try {
    if ($session -and $session.suspended) {
      Resume-BackgroundApps $session.suspended
    }
  } catch {}

  try {
    if ($session -and $session.services) {
      foreach ($item in @($session.services)) {
        if ($item.wasRunning) {
          try { Start-Service -Name $item.name -ErrorAction SilentlyContinue } catch {}
        }
      }
    }
  } catch {}

  try {
    if ($session -and $session.stickyKeys -ne $null) {
      Restore-StickyKeys ([int]$session.stickyKeys)
    }
  } catch {}

  try {
    if ($session -and $session.powerPlan) {
      & powercfg.exe /setactive $session.powerPlan 2>$null | Out-Null
    }
  } catch {}

  try {
    if ($session -and $session.desktop) {
      $desktopWindows = @($session.desktop.windows | ForEach-Object { [long]$_ })
      $desktopShell = @($session.desktop.shell | ForEach-Object { [long]$_ })
      [PulseGameMode]::RestoreGameDesktop($desktopWindows, $desktopShell)
    }
  } catch {}

  try {
    if ($session -and $session.windowsKey) {
      [PulseGameMode]::StopWindowsKeyBlock()
    }
  } catch {}

  if (Test-Path -LiteralPath $sessionPath) {
    try { Remove-Item -LiteralPath $sessionPath -Force } catch {}
  }

  if ($reason -eq 'manual stop' -and $session -and $session.game) {
    if ([int]$session.game.pid -ne 0) {
      $script:suppressedPid = [int]$session.game.pid
    }
    $script:suppressedName = [string]$session.game.name
  }

  $script:lastSession = [ordered]@{
    id = if ($session) { [string]$session.id } else { '' }
    game = if ($session) { $session.game } else { $null }
    memoryFreedBytes = if ($session) { [long]$session.memoryFreedBytes } else { [long]0 }
    endedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    reason = $reason
  }
  $script:active = $false
  $script:game = $null
  $script:applied = @()
  $script:errors = @()
  $script:session = $null
  $script:memoryFreedBytes = [long]0
  $script:sessionId = ''
  $script:gameWindowMissingSince = $null
  Write-Status
}

try {
  if ($Probe) {
    try {
      $fg = Get-ForegroundFullscreen
      $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][PulseGameMode+MONITORINFO])
      [pscustomobject]@{
        admin = $script:admin
        foreground = $fg
        monitorInfoSize = $size
        helperVersion = $helperVersion
      } | ConvertTo-Json -Depth 4 -Compress
    } catch {
      [pscustomobject]@{ error = $_.Exception.ToString() } | ConvertTo-Json -Compress
    }
    exit 0
  }

  $mutex = New-Object System.Threading.Mutex($false, 'Global\PulseGameModeHelper')
  if (-not $mutex.WaitOne(0)) { exit 0 }

  if (Test-Path -LiteralPath $sessionPath) {
    try {
      $script:session = Read-Json $sessionPath
      if ($script:session) {
        $script:active = $true
        Stop-Session 'recovering the previous session'
      }
    } catch {}
  }
  Write-Status

  while ($true) {
    $config = Get-GameConfig
    $now = Get-Date

    if (
      $config.enabled -and
      $script:active -and
      $script:session -and
      ([int]$script:session.game.pid -ne 0)
    ) {
      $gameProcess = Get-Process -Id ([int]$script:session.game.pid) -ErrorAction SilentlyContinue
      if (-not $gameProcess) {
        Stop-Session 'the game process exited'
      } elseif (-not [PulseGameMode]::HasAnyGameWindow([uint32]$gameProcess.Id)) {
        if (-not $script:gameWindowMissingSince) {
          $script:gameWindowMissingSince = $now
        } elseif (($now - $script:gameWindowMissingSince).TotalSeconds -ge 6) {
          Stop-Session 'the game window closed'
        }
      } else {
        $script:gameWindowMissingSince = $null
      }
    }

    if (-not $config.enabled -and $script:active) {
      Stop-Session 'game mode was disabled'
    }

    if (Test-Path -LiteralPath $commandPath) {
      $command = Read-Json $commandPath
      try { Remove-Item -LiteralPath $commandPath -Force } catch {}
      if ($command -and $command.action -eq 'start' -and -not $script:active) {
        $script:suppressedPid = 0
        $script:suppressedName = ''
        $game = Get-ForegroundFullscreen
        if (-not $game) {
          $game = [pscustomobject]@{ pid = 0; name = 'Manual'; title = 'Manual game session' }
        }
        Start-Session $game
      } elseif ($command -and $command.action -eq 'stop' -and $script:active) {
        Stop-Session 'manual stop'
      }
    }

    if ($script:suppressedPid -ne 0 -or $script:suppressedName) {
      $suppressedProcess = $null
      if ($script:suppressedPid -ne 0) {
        $suppressedProcess = Get-Process -Id $script:suppressedPid -ErrorAction SilentlyContinue
      }
      if (-not $suppressedProcess -and $script:suppressedName) {
        $suppressedProcess = Get-Process -Name $script:suppressedName -ErrorAction SilentlyContinue
      }
      if (-not $suppressedProcess) {
        $script:suppressedPid = 0
        $script:suppressedName = ''
      }
    }

    if ($config.enabled -and $config.autoDetect -and -not $script:active) {
      $script:candidatePid = 0
      $script:candidateSince = $null
      # Only processes already present in the game list may auto-start.
      # Generic fullscreen windows (videos, browsers, players) are ignored.
      $libraryGame = Find-LibraryGame
      if (
        $libraryGame -and
        (
          $libraryGame.pid -eq $script:suppressedPid -or
          ($script:suppressedName -and $libraryGame.name -eq $script:suppressedName)
        )
      ) {
        $libraryGame = $null
      }
      if ($libraryGame) {
        if ($libraryGame.pid -ne $script:libraryCandidatePid) {
          $script:libraryCandidatePid = $libraryGame.pid
          $script:libraryCandidateSince = $now
        } elseif (
          $script:libraryCandidateSince -and
          ($now - $script:libraryCandidateSince).TotalSeconds -ge 2
        ) {
          Start-Session $libraryGame
          $script:libraryCandidatePid = 0
          $script:libraryCandidateSince = $null
        }
      } else {
        $script:libraryCandidatePid = 0
        $script:libraryCandidateSince = $null
      }
    }

    if ($script:active -and $script:session -and $script:session.preventSleep) {
      [PulseGameMode]::SetThreadExecutionState([uint32]2147483651) | Out-Null
    }

    try { [PulseGameMode]::ManagePulseZOrder() } catch { }
    Write-Status
    Start-Sleep -Milliseconds 1000
  }
} catch {
  $message = $_.Exception.ToString()
  Write-Log $message
  try {
    $script:errors = @($message)
    Write-Status
  } catch {}
  try { Stop-Session 'helper error' } catch {}
  exit 1
}
