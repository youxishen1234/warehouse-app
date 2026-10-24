# Serial bridge for the K3. Node talks to this process over stdin/stdout with
# one JSON request per line; the process keeps COM3 open between requests.
param(
  [string]$PortName = 'COM3',
  [int]$BaudRate = 115200
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:port = $null

function Write-Reply([hashtable]$message) {
  [Console]::Out.WriteLine(($message | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

function Open-Port {
  if ($script:port -and $script:port.IsOpen) { return }
  $port = [System.IO.Ports.SerialPort]::new($PortName, $BaudRate, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  $port.ReadTimeout = 400
  $port.WriteTimeout = 3000
  $port.DtrEnable = $true
  $port.RtsEnable = $true
  $port.Handshake = [System.IO.Ports.Handshake]::None
  $port.Open()
  $port.DiscardInBuffer()
  $script:port = $port
}

function Close-Port {
  if ($script:port) {
    try { if ($script:port.IsOpen) { $script:port.Close() } } catch { }
    try { $script:port.Dispose() } catch { }
    $script:port = $null
  }
}

function Read-Bytes([int]$timeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  $buffer = [System.Collections.Generic.List[byte]]::new()
  $chunk = New-Object byte[] 4096
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $read = $script:port.Read($chunk, 0, $chunk.Length)
      if ($read -gt 0) {
        for ($i = 0; $i -lt $read; $i++) { $buffer.Add($chunk[$i]) }
      }
    } catch [System.TimeoutException] { }
    if ($buffer.Count -gt 0) {
      # Give the printer a short moment to finish a frame that is still arriving.
      Start-Sleep -Milliseconds 25
      if ($script:port.BytesToRead -eq 0) {
        try {
          $read = $script:port.Read($chunk, 0, $chunk.Length)
          if ($read -gt 0) { for ($i = 0; $i -lt $read; $i++) { $buffer.Add($chunk[$i]) } }
        } catch [System.TimeoutException] { }
        break
      }
    }
  }
  return ,$buffer.ToArray()
}

function Send-Bytes([byte[]]$bytes, [int]$readTimeoutMs = 600) {
  Open-Port
  $script:port.Write($bytes, 0, $bytes.Length)
  return Read-Bytes $readTimeoutMs
}

function Write-Only([byte[]]$bytes) {
  Open-Port
  $script:port.Write($bytes, 0, $bytes.Length)
}

try {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    try {
      $request = $line | ConvertFrom-Json
      switch ($request.op) {
        'open' {
          Open-Port
          Write-Reply @{ ok = $true; port = $PortName; baud = $BaudRate }
        }
        'close' {
          Close-Port
          Write-Reply @{ ok = $true }
          return
        }
        'write' {
          $data = [Convert]::FromBase64String([string]$request.data)
          $timeout = if ($null -ne $request.readTimeoutMs) { [int]$request.readTimeoutMs } else { 600 }
          $reply = Send-Bytes $data $timeout
          Write-Reply @{ ok = $true; data = [Convert]::ToBase64String($reply) }
        }
        'writeonly' {
          $data = [Convert]::FromBase64String([string]$request.data)
          Write-Only $data
          Write-Reply @{ ok = $true }
        }
        'read' {
          $timeout = if ($null -ne $request.timeoutMs) { [int]$request.timeoutMs } else { 400 }
          $reply = Read-Bytes $timeout
          Write-Reply @{ ok = $true; data = [Convert]::ToBase64String($reply) }
        }
        'drain' {
          if ($script:port -and $script:port.IsOpen) { $script:port.DiscardInBuffer() }
          Write-Reply @{ ok = $true }
        }
        'ping' { Write-Reply @{ ok = $true; port = $PortName } }
        default { Write-Reply @{ ok = $false; error = 'unknown op' } }
      }
    } catch {
      Close-Port
      Write-Reply @{ ok = $false; error = $_.Exception.Message }
    }
  }
} finally {
  Close-Port
}
