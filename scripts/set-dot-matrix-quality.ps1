param(
    [string]$PrinterName = 'EPSON LQ-630KII ESC/P2',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName ReachFramework
Add-Type -AssemblyName System.Printing
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DotMatrixQualityPreferences {
    [StructLayout(LayoutKind.Sequential)]
    private struct PrinterInfo9 { public IntPtr DevMode; }
    [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError=true)]
    private static extern bool ClosePrinter(IntPtr printer);
    [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern int DocumentProperties(IntPtr window, IntPtr printer, string name, IntPtr output, IntPtr input, int mode);
    [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool SetPrinter(IntPtr printer, int level, ref PrinterInfo9 info, int command);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr GlobalFree(IntPtr memory);

    public static byte[] Snapshot(IntPtr memory) {
        int size = checked((int)GlobalSize(memory).ToUInt64());
        IntPtr data = GlobalLock(memory);
        if (data == IntPtr.Zero || size <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { byte[] bytes = new byte[size]; Marshal.Copy(data, bytes, 0, size); return bytes; }
        finally { GlobalUnlock(memory); }
    }
    public static void Save(string name, byte[] bytes) {
        IntPtr printer;
        if (!OpenPrinter(name, out printer, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr data = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, data, bytes.Length);
            if (DocumentProperties(IntPtr.Zero, printer, name, data, data, 10) != 1)
                throw new InvalidOperationException("The driver rejected the quality settings.");
            var info = new PrinterInfo9 { DevMode = data };
            // Current-user preferences only, never machine-wide defaults.
            if (!SetPrinter(printer, 9, ref info, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(data); ClosePrinter(printer); }
    }
}
'@

function Read-QualitySnapshot {
    $printerSettings = New-Object System.Drawing.Printing.PrinterSettings
    $printerSettings.PrinterName = $PrinterName
    if (-not $printerSettings.IsValid) { throw "Printer not found: $PrinterName" }
    $memory = $printerSettings.GetHdevmode($printerSettings.DefaultPageSettings)
    try { $bytes = [DotMatrixQualityPreferences]::Snapshot($memory) }
    finally { [void][DotMatrixQualityPreferences]::GlobalFree($memory) }
    $ticket = $converter.ConvertDevModeToPrintTicket($bytes)
    $stream = $ticket.GetXmlStream()
    $reader = New-Object IO.StreamReader($stream)
    try { [xml]$xml = $reader.ReadToEnd() }
    finally { $reader.Dispose() }
    $summary = [ordered]@{
        DpiX = $printerSettings.DefaultPageSettings.PrinterResolution.X
        DpiY = $printerSettings.DefaultPageSettings.PrinterResolution.Y
        Width = $printerSettings.DefaultPageSettings.PaperSize.Width
        Height = $printerSettings.DefaultPageSettings.PaperSize.Height
        Landscape = $printerSettings.DefaultPageSettings.Landscape
        Direction = $null
        FontMode = $null
    }
    foreach ($feature in $xml.DocumentElement.ChildNodes) {
        if ($feature.LocalName -ne 'Feature') { continue }
        if ($feature.GetAttribute('name') -match ':JobPrintDirection$') { $summary.Direction = $feature.ChildNodes | Where-Object LocalName -eq 'Option' | ForEach-Object { $_.GetAttribute('name') } }
        if ($feature.GetAttribute('name') -match ':PageTrueTypeFontMode$') { $summary.FontMode = $feature.ChildNodes | Where-Object LocalName -eq 'Option' | ForEach-Object { $_.GetAttribute('name') } }
    }
    return @{ Settings=$printerSettings; Bytes=$bytes; Ticket=$ticket; Xml=$xml; Summary=$summary }
}

$converter = New-Object System.Printing.Interop.PrintTicketConverter($PrinterName, 1)
$server = New-Object System.Printing.LocalPrintServer
$queue = $server.GetPrintQueue($PrinterName)
try {
    $before = Read-QualitySnapshot
    $capStream = $queue.GetPrintCapabilitiesAsXml($before.Ticket)
    $capReader = New-Object IO.StreamReader($capStream)
    try { [xml]$capabilities = $capReader.ReadToEnd() }
    finally { $capReader.Dispose() }
    $schema = 'http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework'
    $namespace = New-Object Xml.XmlNamespaceManager($capabilities.NameTable)
    $namespace.AddNamespace('psf', $schema)
    $resolutionFeature = $capabilities.SelectSingleNode('psf:PrintCapabilities/psf:Feature[@name="psk:PageResolution"]', $namespace)
    $resolutions = @($resolutionFeature.SelectNodes('psf:Option', $namespace) | ForEach-Object {
        [pscustomobject]@{
            Option=$_
            X=[int]$_.SelectSingleNode('psf:ScoredProperty[@name="psk:ResolutionX"]/psf:Value', $namespace).InnerText
            Y=[int]$_.SelectSingleNode('psf:ScoredProperty[@name="psk:ResolutionY"]/psf:Value', $namespace).InnerText
        }
    })
    $best = $resolutions | Where-Object { $_.X -gt 0 -and $_.Y -gt 0 } | Sort-Object @{Expression={$_.X*$_.Y};Descending=$true} | Select-Object -First 1
    if (-not $best) { throw 'The driver did not report an explicit supported resolution.' }
    # Vendor options are discovered by their driver descriptions, never by guessing private DEVMODE bytes.
    $directionFeature = $capabilities.DocumentElement.ChildNodes | Where-Object { $_.LocalName -eq 'Feature' -and $_.GetAttribute('name') -match ':JobPrintDirection$' } | Select-Object -First 1
    $direction = $directionFeature.SelectNodes('psf:Option', $namespace) | Where-Object {
        $_.SelectSingleNode('psf:Property[@name="psk:DisplayName"]/psf:Value', $namespace).InnerText -match '^(单向|Unidirectional)$'
    } | Select-Object -First 1
    if (-not $direction) { throw 'The driver did not report a supported unidirectional option.' }
    $fontFeature = $capabilities.SelectSingleNode('psf:PrintCapabilities/psf:Feature[@name="psk:PageTrueTypeFontMode"]', $namespace)
    # Render the selected Chinese typeface as a bitmap.  The driver's
    # DownloadAsRasterFont path substitutes a small resident dot-matrix font,
    # which made Chinese body text broken on this LQ-630KII sample.
    $fontOption = $fontFeature.SelectSingleNode('psf:Option[@name="psk:RenderAsBitmap"]', $namespace)
    if (-not $fontOption) { $fontOption = $fontFeature.SelectSingleNode('psf:Option[@name="psk:DownloadAsRasterFont"]', $namespace) }
    if (-not $fontOption) { throw 'The driver did not report a supported text font mode.' }
    $requested = @{ DpiX=$best.X; DpiY=$best.Y; Direction=$direction.GetAttribute('name'); FontMode=$fontOption.GetAttribute('name') }
    $already = $before.Summary.DpiX -eq $best.X -and $before.Summary.DpiY -eq $best.Y -and
        $before.Summary.Direction -eq $requested.Direction -and $before.Summary.FontMode -eq $requested.FontMode
    $backup = $null
    if ($Apply -and -not $already) {
        # Reuse the driver's actual namespace declarations and copy only the three supported quality features.
        foreach ($attribute in $capabilities.DocumentElement.Attributes) {
            if ($attribute.Prefix -eq 'xmlns') { $before.Xml.DocumentElement.SetAttribute($attribute.Name, $attribute.Value) }
        }
        foreach ($pair in @(@($resolutionFeature,$best.Option), @($directionFeature,$direction), @($fontFeature,$fontOption))) {
            $name = $pair[0].GetAttribute('name')
            $old = @($before.Xml.DocumentElement.ChildNodes | Where-Object { $_.LocalName -eq 'Feature' -and $_.GetAttribute('name') -eq $name })
            foreach ($node in $old) { [void]$before.Xml.DocumentElement.RemoveChild($node) }
            $feature = $before.Xml.CreateElement('psf', 'Feature', $schema)
            $feature.SetAttribute('name',$name)
            $option = $before.Xml.CreateElement('psf', 'Option', $schema)
            $option.SetAttribute('name',$pair[1].GetAttribute('name'))
            foreach ($child in $pair[1].ChildNodes) {
                if ($child.LocalName -eq 'ScoredProperty') { [void]$option.AppendChild($before.Xml.ImportNode($child,$true)) }
            }
            [void]$feature.AppendChild($option)
            [void]$before.Xml.DocumentElement.AppendChild($feature)
        }
        $ticketBytes = [Text.Encoding]::UTF8.GetBytes($before.Xml.OuterXml)
        $ticketStream = New-Object IO.MemoryStream(,$ticketBytes)
        try { $requestedTicket = New-Object System.Printing.PrintTicket($ticketStream) }
        finally { $ticketStream.Dispose() }
        $mode = $converter.ConvertPrintTicketToDevMode($requestedTicket, [System.Printing.Interop.BaseDevModeType]::UserDefault)
        $backupDirectory = Join-Path $PSScriptRoot '../release/dot-matrix-check'
        [void](New-Item -ItemType Directory -Force -Path $backupDirectory)
        $backup = Join-Path $backupDirectory ('epson-quality-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.devmode')
        [IO.File]::WriteAllBytes($backup,$before.Bytes)
        [DotMatrixQualityPreferences]::Save($PrinterName,$mode)
        try {
            $after = Read-QualitySnapshot
            if ($after.Summary.DpiX -ne $best.X -or $after.Summary.DpiY -ne $best.Y -or
                $after.Summary.Direction -ne $requested.Direction -or $after.Summary.FontMode -ne $requested.FontMode -or
                $after.Summary.Width -ne $before.Summary.Width -or $after.Summary.Height -ne $before.Summary.Height -or
                $after.Summary.Landscape -ne $before.Summary.Landscape) { throw 'The saved quality did not match, or paper settings changed.' }
        } catch {
            [DotMatrixQualityPreferences]::Save($PrinterName,$before.Bytes)
            throw
        }
    } else { $after = $before }
    [pscustomobject]@{Printer=$PrinterName;Applied=[bool]$Apply -and -not $already;AlreadyConfigured=[bool]$already;
        Before=$before.Summary;Current=$after.Summary;Requested=$requested;Backup=$backup} | ConvertTo-Json -Depth 5 -Compress
} finally { $queue.Dispose(); $server.Dispose(); $converter.Dispose() }
