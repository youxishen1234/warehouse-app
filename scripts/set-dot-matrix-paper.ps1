param(
    [string]$PrinterName = 'EPSON LQ-630KII ESC/P2',
    [string]$PaperName = '复写 9.5 x 5.5 英寸',
    [double]$WidthMm = 0,
    [double]$HeightMm = 0,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DotMatrixUserPreferences {
    [StructLayout(LayoutKind.Sequential)]
    private struct PrinterInfo9 { public IntPtr DevMode; }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int DocumentProperties(IntPtr window, IntPtr printer, string name, IntPtr output, IntPtr input, int mode);
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetPrinter(IntPtr printer, int level, ref PrinterInfo9 info, int command);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalFree(IntPtr memory);

    public static byte[] Snapshot(IntPtr memory) {
        int size = checked((int)GlobalSize(memory).ToUInt64());
        if (size <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr data = GlobalLock(memory);
        if (data == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            byte[] bytes = new byte[size];
            Marshal.Copy(data, bytes, 0, size);
            return bytes;
        } finally { GlobalUnlock(memory); }
    }

    public static void Save(string name, IntPtr memory) {
        IntPtr printer;
        if (!OpenPrinter(name, out printer, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            IntPtr data = GlobalLock(memory);
            if (data == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                // Validate the complete DEVMODE (including vendor-specific data), without showing UI.
                if (DocumentProperties(IntPtr.Zero, printer, name, data, data, 10) != 1)
                    throw new InvalidOperationException("The printer driver rejected the requested paper settings.");
                // Level 9 changes only this user's preferences, not the machine-wide printer defaults.
                var info = new PrinterInfo9 { DevMode = data };
                if (!SetPrinter(printer, 9, ref info, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            } finally { GlobalUnlock(memory); }
        } finally { ClosePrinter(printer); }
    }
}
'@

$needleSettings = New-Object System.Drawing.Printing.PrinterSettings
$needleSettings.PrinterName = $PrinterName
if (-not $needleSettings.IsValid) { throw "Printer not found: $PrinterName" }
if ($WidthMm -ne 0 -or $HeightMm -ne 0) {
    if ($WidthMm -lt 180 -or $WidthMm -gt 300 -or $HeightMm -lt 80 -or $HeightMm -gt 400) { throw 'Custom paper dimensions are out of range.' }
    $needlePaper = @(New-Object System.Drawing.Printing.PaperSize($PaperName, [int][math]::Round($WidthMm / 0.254), [int][math]::Round($HeightMm / 0.254)))
} else {
    $needlePaper = @($needleSettings.PaperSizes | Where-Object { $_.PaperName -eq $PaperName })
    if ($needlePaper.Count -ne 1) { throw "Expected exactly one supported paper named: $PaperName" }
}

$needleBefore = [ordered]@{
    Printer = $PrinterName
    Paper = $needleSettings.DefaultPageSettings.PaperSize.PaperName
    WidthMm = [math]::Round($needleSettings.DefaultPageSettings.PaperSize.Width * 0.254, 1)
    HeightMm = [math]::Round($needleSettings.DefaultPageSettings.PaperSize.Height * 0.254, 1)
    Landscape = $needleSettings.DefaultPageSettings.Landscape
}
$needleAlreadyConfigured = $needleSettings.DefaultPageSettings.PaperSize.Width -eq $needlePaper[0].Width -and
    $needleSettings.DefaultPageSettings.PaperSize.Height -eq $needlePaper[0].Height -and
    -not $needleSettings.DefaultPageSettings.Landscape
$needleBackup = $null
if ($Apply -and -not $needleAlreadyConfigured) {
    $needleBackupDirectory = Join-Path $PSScriptRoot '../release/dot-matrix-check'
    [void](New-Item -ItemType Directory -Force -Path $needleBackupDirectory)
    $needleBackup = Join-Path $needleBackupDirectory ('epson-preferences-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.devmode')
    $needleOriginal = $needleSettings.GetHdevmode($needleSettings.DefaultPageSettings)
    try { [IO.File]::WriteAllBytes($needleBackup, [DotMatrixUserPreferences]::Snapshot($needleOriginal)) }
    finally { [void][DotMatrixUserPreferences]::GlobalFree($needleOriginal) }
}

$needleSettings.DefaultPageSettings.PaperSize = $needlePaper[0]
$needleSettings.DefaultPageSettings.Landscape = $false
if ($Apply -and -not $needleAlreadyConfigured) {
    $needleNewMode = $needleSettings.GetHdevmode($needleSettings.DefaultPageSettings)
    try { [DotMatrixUserPreferences]::Save($PrinterName, $needleNewMode) }
    finally { [void][DotMatrixUserPreferences]::GlobalFree($needleNewMode) }

    $needleReadBack = New-Object System.Drawing.Printing.PrinterSettings
    $needleReadBack.PrinterName = $PrinterName
    # Some GDI drivers normalize vendor paper identifiers to Custom while retaining the exact dimensions.
    if ($needleReadBack.DefaultPageSettings.PaperSize.Width -ne $needlePaper[0].Width -or
        $needleReadBack.DefaultPageSettings.PaperSize.Height -ne $needlePaper[0].Height -or
        $needleReadBack.DefaultPageSettings.Landscape) {
        throw 'Saved printer preferences did not match the requested paper; inspect the saved backup before retrying.'
    }
}

[pscustomobject]@{
    Applied = [bool]$Apply -and -not $needleAlreadyConfigured
    AlreadyConfigured = [bool]$needleAlreadyConfigured
    Before = $needleBefore
    Paper = $needlePaper[0].PaperName
    WidthMm = [math]::Round($needlePaper[0].Width * 0.254, 1)
    HeightMm = [math]::Round($needlePaper[0].Height * 0.254, 1)
    Landscape = $false
    Backup = $needleBackup
} | ConvertTo-Json -Depth 4

