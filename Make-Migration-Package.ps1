<#
================================================================================
  Make-Migration-Package.ps1  --  copy THIS till, database and all, into a
                                   single migration folder for another computer

  Compiled to "Make Migration Package.exe" by Build-Installers.ps1. The .exe
  shows NO console window: a small "working" box while it runs, one message
  box at the end, and a log file. This .ps1 is the source and a fallback for
  machines that block .exe.

  Run it ON THE CURRENT MACHINE. It:

    1. Asks where the migration folder should go (or takes -Target).
    2. Stops the Windows service and the bundled PostgreSQL, so the database
       is copied cold -- a copy taken while PostgreSQL is writing can refuse
       to start. This till is offline for the minute or two the copy takes.
    3. Copies the WHOLE folder -- app, runtime, prereq AND data -- with
       robocopy (long-path aware; Explorer silently drops the long photo
       names). Leaves out only run locks and logs.
    4. Drops the restore tool and the instructions into the same folder.
    5. Starts the service again (unless -LeaveStopped).

  The result is one self-contained folder. Copy it to the new PC and run
  "Restore On New PC" from inside it.

  Parameters (all optional):
    -Target <path>     where to build the folder; skips the picker
    -LeaveStopped      do not restart the service here (use if retiring this PC)
    -Zip               also write MortysAutoParts-Migration-<date>.zip beside it
================================================================================
#>

param(
  [string] $Target,
  [switch] $LeaveStopped,
  [switch] $Zip
)

$ErrorActionPreference = 'Stop'
$APPNAME = 'Morty''s Auto Parts'
# The service name is compiled into "Morty's Auto Parts Service.exe" (no
# source in this repo), so it stays 'MortysAutoPartsAdmin' even after the rebrand.
# Renaming it means rebuilding that binary and teaching Install.ps1 to remove
# the old-named service on upgrade.
$SVCNAME = 'MortysAutoPartsAdmin'

# ------------------------------------------------------------------ GUI layer
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:fail    = New-Object System.Collections.Generic.List[string]
$script:log     = New-Object System.Collections.Generic.List[string]
$script:logFile = $null
$script:stForm  = $null
$script:stLabel = $null

function LogInit($dir) {
  foreach ($d in @($dir, $env:TEMP)) {
    try {
      if ($d -and -not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
      if ($d) { $script:logFile = Join-Path $d ('migrate-package-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log'); break }
    } catch { }
  }
}
function Line($m) {
  $script:log.Add([string]$m)
  if ($script:logFile) { try { Add-Content -LiteralPath $script:logFile -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m) } catch { } }
  Write-Host $m
}
function Head($t) { Line ''; Line ('--- ' + $t + ' ---') }
function Ok($m)   { Line ('  ok   ' + $m) }
function Info($m) { Line ('       ' + $m) }
function Bad($m)  { Line ('  FAIL ' + $m); $script:fail.Add([string]$m) }

function Status($msg) {
  Info $msg
  if (-not $script:stForm) {
    $f = New-Object System.Windows.Forms.Form
    $f.Text = $APPNAME
    $f.FormBorderStyle = 'FixedDialog'
    $f.StartPosition = 'CenterScreen'
    $f.ControlBox = $false; $f.MinimizeBox = $false; $f.MaximizeBox = $false
    $f.ClientSize = New-Object System.Drawing.Size(460, 96)
    $f.TopMost = $true
    $l = New-Object System.Windows.Forms.Label
    $l.Dock = 'Fill'; $l.TextAlign = 'MiddleCenter'
    $l.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $f.Controls.Add($l)
    $script:stForm = $f; $script:stLabel = $l
    $f.Show()
  }
  $script:stLabel.Text = $msg
  $script:stForm.Refresh()
  [System.Windows.Forms.Application]::DoEvents()
}
function StatusDone {
  if ($script:stForm) { $script:stForm.Close(); $script:stForm.Dispose(); $script:stForm = $null; $script:stLabel = $null }
}
function Confirm($text, $caption) {
  $r = [System.Windows.Forms.MessageBox]::Show($text, "$APPNAME  --  $caption",
        [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Question)
  return ($r -eq [System.Windows.Forms.DialogResult]::OK)
}
function Tell($text, $caption, $icon) {
  [System.Windows.Forms.MessageBox]::Show($text, "$APPNAME  --  $caption",
    [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::$icon) | Out-Null
}
function PickFolder($desc) {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $desc; $d.ShowNewFolderButton = $true
  if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $d.SelectedPath }
  return $null
}
function Finish {
  StatusDone
  if ($script:fail.Count -eq 0) {
    Tell $script:successText 'done' 'Information'
    exit 0
  }
  $m = "Some steps did not complete:`r`n`r`n" + (($script:fail | ForEach-Object { '  -  ' + $_ }) -join "`r`n")
  if ($script:logFile) { $m += "`r`n`r`nFull log:`r`n" + $script:logFile }
  Tell $m 'problems' 'Warning'
  exit 1
}

# ------------------------------------------------------------------ elevation
$pr = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $pr.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
  if ($Target)       { $a += @('-Target',"`"$Target`"") }
  if ($LeaveStopped) { $a += '-LeaveStopped' }
  if ($Zip)          { $a += '-Zip' }
  try { Start-Process powershell -Verb RunAs -ArgumentList $a } catch { }
  exit
}

# ------------------------------------------------------------ find live install
$SOURCE = $null
$svcDir = $null
try {
  $pn = (Get-CimInstance Win32_Service -Filter "Name='$SVCNAME'" -EA SilentlyContinue).PathName
  if ($pn) { $svcDir = Split-Path ($pn -replace '^"([^"]+)".*$','$1') -Parent }
} catch { }
foreach ($c in @($PSScriptRoot, $svcDir, 'C:\MortysAutoParts', 'C:\mortysautoparts', 'C:\MortysAutoParts', 'C:\mortysautoparts')) {
  if ($c -and (Test-Path (Join-Path $c 'app\boot.js'))) { $SOURCE = (Resolve-Path $c).Path; break }
}
LogInit ($(if ($SOURCE) { Join-Path $SOURCE 'data\logs' } else { $env:TEMP }))

Line "$APPNAME  --  make migration package"
Info "run from : $PSScriptRoot"
Info "install  : $SOURCE"

if (-not $SOURCE) {
  Bad 'could not find the Morty''s Auto Parts install (no app\boot.js in the usual places)'
  Finish
}

# ------------------------------------------------------------ choose destination
if (-not $Target) {
  if ((Test-Path (Join-Path $PSScriptRoot 'Restore-On-New-PC.ps1')) -and
      ((Resolve-Path $PSScriptRoot).Path -ne $SOURCE)) {
    $Target = $PSScriptRoot                       # running from inside the kit
  } else {
    $picked = PickFolder 'Choose where to build the migration folder (a USB drive, an external disk, or any folder). Keep the path short.'
    if (-not $picked) { Bad 'no destination chosen'; Finish }
    $Target = $picked
  }
}

$looksLikeKit = (Test-Path (Join-Path $Target 'Restore-On-New-PC.ps1')) -or (Test-Path (Join-Path $Target 'Restore On New PC.exe'))
if ($looksLikeKit) { $dest = (Resolve-Path $Target).Path }
else               { $dest = Join-Path $Target 'MortysAutoParts-Migration' }

if ((Resolve-Path -LiteralPath $dest -EA SilentlyContinue).Path -eq $SOURCE) {
  Bad 'the destination is the live install itself -- pick another folder'; Finish
}
Info "building  : $dest"

if (-not (Confirm (
  "This builds a complete migration folder at:`r`n`r`n$dest`r`n`r`n" +
  "The database is copied live -- the till keeps serving while it runs. Only if the " +
  "live copy cannot be taken will the service stop briefly, and it will say so.`r`n`r`n" +
  "Build it now?") 'make migration package')) {
  Info 'cancelled by user'; StatusDone; exit
}

$script:didStop = $false
$pgCtl  = Join-Path $SOURCE 'runtime\pgsql\bin\pg_ctl.exe'
$pgBase = Join-Path $SOURCE 'runtime\pgsql\bin\pg_basebackup.exe'
$pgData = Join-Path $SOURCE 'data\pgdata'
$svc    = Get-Service -Name $SVCNAME -EA SilentlyContinue

# ------------------------------------------------------------ 1. program files
Head '1. Copying the program files'
Status 'Copying program files... this can take a few minutes. Do not close this window.'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$rc = @(
  "$SOURCE", "$dest", '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1',
  '/NFL', '/NDL', '/NP', '/NJH', '/NJS',
  '/XD', (Join-Path $SOURCE 'data'), 'MortysAutoParts-Migration',
  '/XF', 'admin.lock', '.~lock.*#'
)
& robocopy @rc | Out-Null
if ($LASTEXITCODE -ge 8) { Bad "program-file copy failed (robocopy exit $LASTEXITCODE)" }
else {
  $n = @([System.IO.Directory]::GetFiles("\\?\$dest", '*', 'AllDirectories')).Count
  Ok ("{0:N0} files copied" -f $n)
}

# ------------------------------------------------------------ 2. the database
Head '2. Copying the database'
$destPgData = Join-Path $dest 'data\pgdata'
New-Item -ItemType Directory -Force -Path (Split-Path $destPgData -Parent) | Out-Null
if (Test-Path $destPgData) { Remove-Item $destPgData -Recurse -Force -EA SilentlyContinue }

# credentials for the online backup, from the same file the app uses
$pw = 'postgres'; $pgUser = 'postgres'; $pgPort = '5433'
try {
  $c = Get-Content (Join-Path $SOURCE 'app\db-config.json') -Raw | ConvertFrom-Json
  if ($c.local.password) { $pw     = [string]$c.local.password }
  if ($c.local.user)     { $pgUser = [string]$c.local.user }
  if ($c.local.port)     { $pgPort = [string]$c.local.port }
} catch { }

$onlineOk = $false
if (Test-Path $pgBase) {
  Status 'Copying the database live (the till stays online)...'
  $env:PGPASSWORD = $pw
  & $pgBase -h 127.0.0.1 -p $pgPort -U $pgUser -D "$destPgData" -X stream -c fast --no-password 2>&1 |
    ForEach-Object { Info $_ }
  $rc0 = $LASTEXITCODE
  $env:PGPASSWORD = ''
  if ($rc0 -eq 0 -and (Test-Path (Join-Path $destPgData 'PG_VERSION'))) {
    $onlineOk = $true
    Ok ("database copied live (PostgreSQL " + (Get-Content (Join-Path $destPgData 'PG_VERSION')) + ")")
  } else {
    Info 'live copy did not succeed -- falling back to a brief service stop'
    if (Test-Path $destPgData) { Remove-Item $destPgData -Recurse -Force -EA SilentlyContinue }
  }
}

if (-not $onlineOk) {
  if ($svc -and $svc.Status -ne 'Stopped') {
    Status 'Stopping the till service for a cold copy...'
    & sc.exe stop $SVCNAME | Out-Null
    try { $svc.WaitForStatus('Stopped', (New-TimeSpan -Seconds 90)); $script:didStop = $true; Ok 'service stopped' }
    catch { Bad 'the service did not stop within 90s' }
  }
  if ((Test-Path $pgCtl) -and (Test-Path (Join-Path $pgData 'postmaster.pid'))) {
    & $pgCtl -D "$pgData" -m fast -w -t 60 stop 2>&1 | ForEach-Object { Info $_ }
  }
  Get-CimInstance Win32_Process -Filter "Name = 'postgres.exe'" -EA SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($SOURCE, 'OrdinalIgnoreCase') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
  for ($i = 0; $i -lt 20 -and (Test-Path (Join-Path $pgData 'postmaster.pid')); $i++) { Start-Sleep -Milliseconds 500 }
  if (Test-Path (Join-Path $pgData 'postmaster.pid')) { Bad 'PostgreSQL has not shut down -- do not trust this copy' }
  Status 'Copying the database...'
  $rc2 = @("$pgData", "$destPgData", '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1',
           '/NFL','/NDL','/NP','/NJH','/NJS', '/XF','postmaster.pid','postmaster.opts', '/XD','pg_stat_tmp')
  & robocopy @rc2 | Out-Null
  if ($LASTEXITCODE -ge 8) { Bad "database copy failed (robocopy exit $LASTEXITCODE)" }
  elseif (Test-Path (Join-Path $destPgData 'PG_VERSION')) {
    Ok ("database copied (PostgreSQL " + (Get-Content (Join-Path $destPgData 'PG_VERSION')) + ")")
  } else { Bad 'data\pgdata did NOT come across' }
}

# never ship a stale run lock
foreach ($v in 'data\admin.lock','data\pgdata\postmaster.pid','data\pgdata\postmaster.opts') {
  $p = Join-Path $dest $v; if (Test-Path $p) { Remove-Item $p -Force -EA SilentlyContinue }
}

# ------------------------------------------------------------ drop in the tools
Head '3. Adding the restore tool and instructions'
foreach ($name in 'Restore On New PC.exe','Restore-On-New-PC.ps1','MIGRATION-README.txt','START HERE.txt') {
  $src = Join-Path $SOURCE $name
  if ((Test-Path $src) -and -not (Test-Path (Join-Path $dest $name))) {
    Copy-Item $src $dest -Force; Info "added $name"
  }
}
if (-not (Test-Path (Join-Path $dest 'Restore On New PC.exe')) -and
    -not (Test-Path (Join-Path $dest 'Restore-On-New-PC.ps1'))) {
  Bad 'no restore tool in the folder -- copy "Restore On New PC.exe" into it by hand'
}

# ------------------------------------------------------------ optional zip
if ($Zip -and $script:fail.Count -eq 0) {
  Head '4. Also writing a .zip'
  Status 'Compressing...'
  $zipPath = Join-Path (Split-Path $dest -Parent) ('MortysAutoParts-Migration-' + (Get-Date -Format 'yyyy-MM-dd') + '.zip')
  $sevenZip = @('C:\Program Files\7-Zip\7z.exe','C:\Program Files (x86)\7-Zip\7z.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
  try {
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    if ($sevenZip) { & $sevenZip a -tzip -bso0 -bsp0 "$zipPath" "$dest" | Out-Null; if ($LASTEXITCODE -ne 0) { throw "7-Zip exit $LASTEXITCODE" } }
    else { Compress-Archive -Path $dest -DestinationPath $zipPath -CompressionLevel Optimal -Force }
    Ok ("{0}  ({1:N0} MB)" -f $zipPath, ((Get-Item $zipPath).Length / 1MB))
  } catch { Bad "zip step failed: $($_.Exception.Message) -- the folder copy is still complete" }
}

# ------------------------------------------------------------ bring the till back
Head '5. This machine'
if ($script:didStop -and -not $LeaveStopped) {
  Status 'Starting the till service again...'
  & sc.exe start $SVCNAME | Out-Null
  Start-Sleep -Seconds 3
  $s2 = Get-Service -Name $SVCNAME -EA SilentlyContinue
  if ($s2 -and $s2.Status -eq 'Running') { Ok 'service running again -- this till is back online' }
  else { Bad "service is $($s2.Status) -- start it with:  sc start $SVCNAME" }
} elseif ($script:didStop -and $LeaveStopped) {
  Info "left stopped as asked. Start it again with:  sc start $SVCNAME"
} else {
  Ok 'the till was not interrupted (live copy)'
}

$script:successText =
  "Migration folder ready:`r`n`r`n$dest`r`n`r`n" +
  "Copy that WHOLE folder to the new computer (onto its C: drive, or run it from the USB stick) " +
  "and run `"Restore On New PC`".`r`n`r`n" +
  "The new PC keeps all data as-is and picks up its own IP address." +
  $(if ($script:didStop) { "`r`n`r`nThis till is back online." } else { "`r`n`r`nThis till was not interrupted." })
Finish
