<#
  Morty's Auto Parts - Share Agent (shares this PC's printers, scanners and folders with every Morty's user)

  Download it from Morty's: Shared resources > Add a computer
  (the shop server's address and a one-time pairing code are then filled in below).
  Copy it to the PC that has the printer / scanner / folder, right-click > Run with PowerShell.
  It asks for administrator rights once.

  What it does
    1. Pairs this PC with the shop server (one-time code, good for 24 hours).
    2. Installs itself in %ProgramData%\MortysAuto\ShareAgent and adds a Windows task
       "Morty's Share Agent" that starts with the PC (before anyone signs in) and restarts if it stops.
    3. Tells Morty's which printers and scanners this PC has (every minute), and does the jobs
       Morty's users send: prints receipts / copies / test pages, saves documents and logs into
       shared folders on this PC, and scans on this PC's scanner (the picture goes back to Morty''s).
       Nothing is opened on screen; jobs that arrive while the PC is off are done when it is back on.

  Options:  -Server http://192.168.1.20:3057   -Code K7QM-3XRA   -Uninstall   -Status   -Quiet
            -Run   (the background loop the Windows task starts; not for people)
#>
[CmdletBinding()]
param([string]$Server, [string]$Code, [switch]$Run, [switch]$Uninstall, [switch]$Status, [switch]$Quiet)
$ErrorActionPreference = 'Stop'

# Filled in by Morty's when downloaded from Shared resources.
$DefaultServer = ''
$DefaultCode = ''

$Version  = '1.0.0'
$AppName  = 'Morty''s Share Agent'
$TaskName = 'Morty''s Share Agent'
$Folder   = Join-Path $env:ProgramData 'MortysAuto\ShareAgent'
$Config   = Join-Path $Folder 'agent.json'
$Script   = Join-Path $Folder 'Mortys-Share-Agent.ps1'
$LogFile  = Join-Path $Folder 'agent.log'

Add-Type -AssemblyName System.Drawing
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Log($t) {
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item $LogFile "$LogFile.old" -Force }
    Add-Content -Path $LogFile -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $t) -Encoding UTF8
  } catch {}
}
function Say($t, $c = 'Gray') { if (-not $Run) { Write-Host $t -ForegroundColor $c } }
function Box($t, $icon = 'Information') {
  if ($Quiet -or $Run) { return }
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($t, $AppName, 'OK', $icon)
}
function Ask($prompt, $default) {
  if ($Quiet) { return $default }
  Add-Type -AssemblyName Microsoft.VisualBasic
  return [Microsoft.VisualBasic.Interaction]::InputBox($prompt, $AppName, $default)
}
function Api($method, $path, $body, $timeout = 20) {
  $p = @{ Uri = "$($script:cfg.server)$path"; Method = $method; TimeoutSec = $timeout; UseBasicParsing = $true; Headers = @{ 'X-Share-Agent-Key' = $script:cfg.key } }
  if ($null -ne $body) {
    $p.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6 -Compress))
    $p.ContentType = 'application/json; charset=utf-8'
  }
  return Invoke-RestMethod @p
}
function ErrText($err) {
  $m = $null
  try { $m = ($err.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
  if (-not $m) { $m = $err.Exception.Message }
  return $m
}
function HttpCode($err) { try { return [int]$err.Exception.Response.StatusCode } catch { return 0 } }

# ------------------------------------------------------------ the printers --
function Get-Printers {
  $out = @()
  $wmi = @()
  try { $wmi = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop) } catch { try { $wmi = @(Get-WmiObject -Class Win32_Printer) } catch {} }
  foreach ($p in $wmi) {
    $status = 'Ready'
    if ($p.WorkOffline) { $status = 'Offline' }
    elseif ($p.PrinterStatus -eq 1) { $status = 'Other' }
    elseif ($p.PrinterStatus -eq 7) { $status = 'Offline' }
    elseif ($p.DetectedErrorState -eq 5) { $status = 'Out of paper' }
    elseif ($p.DetectedErrorState -eq 4) { $status = 'Low paper' }
    elseif ($p.DetectedErrorState -eq 9) { $status = 'Paper jam' }
    elseif ($p.DetectedErrorState -eq 8) { $status = 'Door open' }
    elseif ($p.DetectedErrorState -eq 10) { $status = 'Offline' }
    elseif ($p.DetectedErrorState -in 6, 7) { $status = 'Toner low or out' }
    $paper = $null
    try {
      $ps = New-Object System.Drawing.Printing.PrinterSettings
      $ps.PrinterName = $p.Name
      if ($ps.IsValid) { $paper = $ps.DefaultPageSettings.PaperSize.PaperName }
    } catch {}
    $out += @{ name = $p.Name; is_default = [bool]$p.Default; is_network = [bool]$p.Network; status = $status; paper = $paper }
  }
  return ,$out
}

# A Morty's document is a list of lines (text, two-column rows, rules, banners).
# It is laid out here with Windows' own printing, so any printer works:
# 58/80 mm receipt printers and A4/Letter office printers alike.
function Print-Doc($printerName, $doc, $title) {
  $pd = New-Object System.Drawing.Printing.PrintDocument
  $pd.PrinterSettings.PrinterName = $printerName
  if (-not $pd.PrinterSettings.IsValid) { throw "The printer '$printerName' is not installed on $env:COMPUTERNAME any more." }
  $pd.DocumentName = "Morty's - $title"
  $pd.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(12, 12, 12, 12)
  $script:pLines = @($doc.lines)
  $footer = [string]$doc.footer
  if ($footer) {
    $footer = $footer.Replace('{resource}', $printerName).Replace('{time}', (Get-Date -Format 'dd MMM yyyy h:mm tt'))
    $script:pLines += @([pscustomobject]@{ t = 'text'; s = ''; size = 0.5 }, [pscustomobject]@{ t = 'text'; s = $footer; align = 'center'; size = 0.75 })
  }
  $script:pIdx = 0
  $handler = {
    param($sender, $e)
    $g = $e.Graphics
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $mb = $e.MarginBounds
    $w = [single]$mb.Width
    if ($w -gt 500) { $w = 380 }                    # a receipt on an office printer: a neat 3.8" column
    $x = [single]$mb.Left
    $y = [single]$mb.Top
    $bottom = [single]$mb.Bottom
    $base = $(if ($w -le 230) { 7.5 } elseif ($w -le 320) { 8.5 } else { 10 })
    $black = [System.Drawing.Brushes]::Black
    $first = $true
    while ($script:pIdx -lt $script:pLines.Count) {
      $l = $script:pLines[$script:pIdx]
      $size = $(if ($l.size) { [single]$l.size } else { [single]1 })
      $style = $(if ($l.bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular })
      $font = New-Object System.Drawing.Font('Arial', [single]($base * $size), $style)
      $sf = New-Object System.Drawing.StringFormat
      $sf.Alignment = $(switch ([string]$l.align) { 'center' { 'Center' } 'right' { 'Far' } default { 'Near' } })
      $h = [single]0
      switch ([string]$l.t) {
        'rule'   { $h = [single]10 }
        'banner' { $bf = New-Object System.Drawing.Font('Arial', [single]($base * 1.2), [System.Drawing.FontStyle]::Bold); $h = $g.MeasureString([string]$l.s, $bf, [int]$w).Height + 12; $bf.Dispose() }
        'row'    {
          $rw = $g.MeasureString([string]$l.r, $font).Width
          if ($rw -gt $w * 0.6) { $rw = $w * 0.6 }
          $lh = $g.MeasureString([string]$l.l, $font, [int][Math]::Max(20, $w - $rw - 6)).Height
          $rh = $g.MeasureString([string]$l.r, $font, [int]$rw + 2).Height
          $h = [Math]::Max($lh, $rh) + 1
        }
        default  { $s = [string]$l.s; if (-not $s) { $s = ' ' }; $h = $g.MeasureString($s, $font, [int]$w).Height + 1 }
      }
      if (-not $first -and ($y + $h) -gt $bottom) { $font.Dispose(); $e.HasMorePages = $true; return }
      switch ([string]$l.t) {
        'rule' {
          $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 1)
          $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
          $g.DrawLine($pen, $x, $y + 5, $x + $w, $y + 5); $pen.Dispose()
        }
        'banner' {
          $bf = New-Object System.Drawing.Font('Arial', [single]($base * 1.2), [System.Drawing.FontStyle]::Bold)
          $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 2)
          $g.DrawRectangle($pen, $x + 1, $y + 3, $w - 2, $h - 6); $pen.Dispose()
          $c = New-Object System.Drawing.StringFormat; $c.Alignment = 'Center'; $c.LineAlignment = 'Center'
          $g.DrawString([string]$l.s, $bf, $black, (New-Object System.Drawing.RectangleF($x, $y, $w, $h)), $c); $bf.Dispose()
        }
        'row' {
          $rw = $g.MeasureString([string]$l.r, $font).Width
          if ($rw -gt $w * 0.6) { $rw = $w * 0.6 }
          $right = New-Object System.Drawing.StringFormat; $right.Alignment = 'Far'
          $g.DrawString([string]$l.l, $font, $black, (New-Object System.Drawing.RectangleF($x, $y, [single]([Math]::Max(20, $w - $rw - 6)), $h)))
          $g.DrawString([string]$l.r, $font, $black, (New-Object System.Drawing.RectangleF([single]($x + $w - $rw - 2), $y, [single]($rw + 2), $h)), $right)
        }
        default { $g.DrawString([string]$l.s, $font, $black, (New-Object System.Drawing.RectangleF($x, $y, $w, $h)), $sf) }
      }
      $font.Dispose()
      $y += $h
      $first = $false
      $script:pIdx++
    }
    $e.HasMorePages = $false
  }
  $pd.add_PrintPage($handler)
  try { $pd.Print() } finally { $pd.Dispose() }
}

# ------------------------------------------------------------ the scanners --
# Windows Image Acquisition (WIA): every scanner Windows knows about.
function Get-Scanners {
  $out = @()
  try {
    $dm = New-Object -ComObject WIA.DeviceManager
    foreach ($info in $dm.DeviceInfos) {
      if ($info.Type -ne 1) { continue }                 # 1 = scanner
      $name = $null
      try { $name = $info.Properties.Item('Name').Value } catch {}
      if (-not $name) { $name = $info.DeviceID }
      $out += @{ name = [string]$name; device_id = [string]$info.DeviceID; status = 'Ready' }
    }
  } catch {}
  return ,$out
}
function Scan-Doc($job) {
  $dm = New-Object -ComObject WIA.DeviceManager
  $info = $null
  foreach ($d in $dm.DeviceInfos) {
    if ($d.Type -ne 1) { continue }
    $n = $null; try { $n = $d.Properties.Item('Name').Value } catch {}
    if (($job.doc.device_id -and $d.DeviceID -eq $job.doc.device_id) -or $n -eq $job.target) { $info = $d; break }
  }
  if (-not $info) { throw "The scanner '$($job.target)' is not connected to $env:COMPUTERNAME." }
  $dev = $info.Connect()
  $item = $dev.Items.Item(1)
  $intent = $(switch ([string]$job.doc.color) { 'gray' { 2 } 'bw' { 4 } default { 1 } })
  $dpi = [int]$job.doc.dpi; if (-not $dpi) { $dpi = 200 }
  foreach ($p in $item.Properties) {
    try {
      if ($p.PropertyID -eq 6146) { $p.Value = $intent }        # colour / grey / black and white
      elseif ($p.PropertyID -eq 6147 -or $p.PropertyID -eq 6148) { $p.Value = $dpi }   # resolution
    } catch {}
  }
  $img = $item.Transfer('{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}')   # JPEG
  return [byte[]]$img.FileData.BinaryData
}

# ---------------------------------------------------------- shared folders --
function Test-Folder($path) {
  try {
    if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
    $t = Join-Path $path ('.vision-test-' + [guid]::NewGuid().ToString('N'))
    Set-Content -LiteralPath $t -Value 'ok' -Encoding ASCII
    Remove-Item -LiteralPath $t -Force
    return @{ ok = $true; status = 'Ready' }
  } catch { return @{ ok = $false; status = ('Cannot write: ' + $_.Exception.Message).Substring(0, [Math]::Min(60, ('Cannot write: ' + $_.Exception.Message).Length)) } }
}
function Save-ToFolder($job) {
  $path = [string]$job.target
  if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
  $now = Get-Date
  $safe = ([string]$job.title) -replace '[\\/:*?"<>|\r\n\t]+', '-'
  if ($safe.Length -gt 80) { $safe = $safe.Substring(0, 80) }
  $fmt = [string]$job.doc.format
  if ($fmt -eq 'log' -or $job.job_kind -eq 'activity') {
    $file = Join-Path $path ('Morty''s log ' + $now.ToString('yyyy-MM-dd') + '.txt')
    $block = $(if ($job.job_kind -eq 'activity') { ($job.doc.lines | ForEach-Object { $_.s }) -join "`r`n" } else { "===== $($now.ToString('yyyy-MM-dd HH:mm:ss'))  $($job.title) =====`r`n" + (([string]$job.doc.text) -replace "`r?`n", "`r`n") + "`r`n" })
    Add-Content -LiteralPath $file -Value $block -Encoding UTF8
    return "Added to $file"
  }
  $ext = $(if ($fmt -eq 'html') { '.html' } else { '.txt' })
  $file = Join-Path $path ($now.ToString('yyyy-MM-dd HHmmss') + ' ' + $safe + $ext)
  $body = $(if ($fmt -eq 'html') { [string]$job.doc.html } else { ([string]$job.doc.text) -replace "`r?`n", "`r`n" })
  [IO.File]::WriteAllText($file, $body, (New-Object Text.UTF8Encoding($true)))
  return "Saved $file"
}

# --------------------------------------------------------------- the loop --
if ($Run) {
  $mutex = New-Object System.Threading.Mutex($false, 'Global\MortysShareAgent')
  if (-not $mutex.WaitOne(0)) { exit 0 }               # already running on this PC
  try { $script:cfg = Get-Content $Config -Raw | ConvertFrom-Json; $script:folders = @() } catch { Log "No settings in $Config. Run the setup again."; exit 1 }
  Log "Started (version $Version) for $($script:cfg.server)"
  $lastHello = [datetime]::MinValue
  $fails = 0
  while ($true) {
    try {
      if (((Get-Date) - $lastHello).TotalSeconds -ge 60) {
        $folderState = @()
        foreach ($f in @($script:folders)) { if ($f) { $t = Test-Folder $f.path; $folderState += @{ id = $f.id; ok = $t.ok; status = $t.status } } }
        $h = Api 'POST' '/api/share-agent/hello' @{ computer = $env:COMPUTERNAME; version = $Version; windows_user = "$env:USERDOMAIN\$env:USERNAME"; printers = (Get-Printers); scanners = (Get-Scanners); folders = $folderState }
        $newIds = (@($h.folders) | ForEach-Object { $_.id }) -join ','
        $oldIds = (@($script:folders) | ForEach-Object { $_.id }) -join ','
        $script:folders = @($h.folders)
        $lastHello = $(if ($newIds -ne $oldIds) { [datetime]::MinValue } else { Get-Date })   # a new folder: check it right away
      }
      $r = Api 'GET' '/api/share-agent/jobs?wait=20' $null 40
      $fails = 0
      foreach ($j in @($r.jobs)) {
        if (-not $j) { continue }
        $ok = $true; $err = $null; $note = $null; $sent = $false
        try {
          switch ([string]$j.kind) {
            'printer' {
              $n = [Math]::Max(1, [int]$j.copies)
              for ($i = 0; $i -lt $n; $i++) { Print-Doc $j.target $j.doc $j.title }
              $note = "Printed on $($j.target)"
            }
            'folder' { $note = Save-ToFolder $j }
            'scanner' {
              $bytes = Scan-Doc $j
              $p = @{ Uri = "$($script:cfg.server)/api/share-agent/jobs/$($j.id)/file"; Method = 'POST'; Body = $bytes; ContentType = 'application/octet-stream'; TimeoutSec = 120; UseBasicParsing = $true; Headers = @{ 'X-Share-Agent-Key' = $script:cfg.key } }
              [void](Invoke-RestMethod @p)
              $sent = $true; $note = "Scanned on $($j.target) ($([Math]::Round($bytes.Length / 1024)) KB)"
            }
            default { throw "This agent does not know how to handle '$($j.kind)'." }
          }
          Log "Job $($j.id) '$($j.title)': $note"
        } catch { $ok = $false; $err = $_.Exception.Message; Log "Job $($j.id) failed on $($j.target): $err" }
        if (-not $sent) { try { [void](Api 'POST' "/api/share-agent/jobs/$($j.id)/result" @{ ok = $ok; error = $err; note = $note }) } catch { Log "Could not report job $($j.id): $(ErrText $_)" } }
      }
    } catch {
      $code = HttpCode $_
      if ($code -eq 401 -or $code -eq 403) { Log "The server refused this PC ($(ErrText $_)). Stopping. Set it up again from Morty's > Shared resources."; exit 2 }
      $fails++
      if ($fails -le 3 -or $fails % 60 -eq 0) { Log "Cannot reach the server ($(ErrText $_)); trying again." }
      Start-Sleep -Seconds ([Math]::Min(30, 3 * $fails))
    }
  }
}

# ---------------------------------------------------- administrator rights --
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  foreach ($p in $PSBoundParameters.GetEnumerator()) { if ($p.Value -is [switch]) { if ($p.Value) { $args2 += "-$($p.Key)" } } else { $args2 += "-$($p.Key)", "`"$($p.Value)`"" } }
  try { Start-Process powershell.exe -Verb RunAs -ArgumentList $args2 } catch { Box 'The Morty''s Share Agent needs administrator rights to set up this PC.' 'Warning' }
  exit
}

if ($Status) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $state = $(if ($t) { $t.State } else { 'not installed' })
  $tail = $(if (Test-Path $LogFile) { (Get-Content $LogFile -Tail 15) -join "`r`n" } else { '(no log yet)' })
  Say "Task: $state`n$tail"
  Box "Morty's Share Agent: $state`r`n`r`nLast lines of the log:`r`n$tail"
  exit 0
}

if ($Uninstall) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*Mortys-Share-Agent.ps1*-Run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (Test-Path $Folder) { Remove-Item $Folder -Recurse -Force -ErrorAction SilentlyContinue }
  Say 'Morty''s Share Agent removed from this PC.' Green
  Box 'The Morty''s Share Agent was removed from this computer. Also remove the computer in Morty''s: System management > Shared resources.'
  exit 0
}

# ------------------------------------------------------------------ setup --
try {
  $old = $null
  if (Test-Path $Config) { try { $old = Get-Content $Config -Raw | ConvertFrom-Json } catch { $old = $null } }
  if (-not $Server) { $Server = $(if ($DefaultServer) { $DefaultServer } elseif ($old) { $old.server } else { '' }) }
  $Server = Ask 'Address of the shop server (from the main PC), for example http://192.168.1.20:3057' $Server
  if (-not $Server) { throw 'No server address given.' }
  $Server = $Server.Trim().TrimEnd('/')
  if ($Server -notmatch '^https?://') { $Server = 'http://' + $Server }
  Say "Checking $Server ..." Cyan
  try { [void](Invoke-RestMethod -Uri "$Server/api/health" -TimeoutSec 8 -UseBasicParsing) } catch { throw "Cannot reach the shop server at $Server. Is the main PC on, and is this PC on the shop network?" }

  if (-not $Code) { $Code = $DefaultCode }
  $Code = Ask 'Pairing code from Morty''s (System management > Shared resources), for example K7QM-3XRA' $Code
  if (-not $Code) { throw 'No pairing code given.' }
  $body = @{ code = $Code; computer = $env:COMPUTERNAME; version = $Version; windows_user = 'SYSTEM (all users)' } | ConvertTo-Json
  try { $r = Invoke-RestMethod -Uri "$Server/api/share-agent/pair" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15 -UseBasicParsing }
  catch { throw "The server did not accept the pairing code: $(ErrText $_)" }

  New-Item -ItemType Directory -Force -Path $Folder | Out-Null
  # Only administrators and Windows itself can read the agent's key.
  & icacls $Folder /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  $cfgOut = [ordered]@{ server = $Server; key = $r.key; agent_id = $r.agent_id; name = $r.name; computer = $env:COMPUTERNAME; installed = (Get-Date).ToString('s') }
  ($cfgOut | ConvertTo-Json) | Set-Content -Path $Config -Encoding UTF8
  if ($PSCommandPath -ne $Script) { Copy-Item -Path $PSCommandPath -Destination $Script -Force }

  # Starts with the PC, as Windows itself (so it runs before anyone signs in), restarts if it stops.
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  $action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" -Run"
  $trigger  = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Does the Morty''s jobs sent to this PC''s printers, scanners and shared folders (Morty''s Auto Parts).' | Out-Null
  Start-ScheduledTask -TaskName $TaskName

  $names = @(Get-Printers | ForEach-Object { 'Printer: ' + $_.name }) + @(Get-Scanners | ForEach-Object { 'Scanner: ' + $_.name })
  $names = $names -join "`r`n  "
  Say "Paired as '$($r.name)'. Found on this PC:`n  $names" Green
  Box "This PC is now '$($r.name)' in Morty's.`r`n`r`nFound on this PC:`r`n  $names`r`n`r`nIn Morty's (Shared resources) give each one a name everyone will recognise and send a test. You can also add shared folders on this PC there.`r`n`r`nThe agent starts by itself with Windows. To check it: run this file with -Status. To remove it: -Uninstall."
} catch {
  Say $_.Exception.Message Red
  Box ("Setup did not finish:`r`n`r`n" + $_.Exception.Message) 'Error'
  exit 1
}
