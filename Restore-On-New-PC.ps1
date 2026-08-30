<#
================================================================================
  Restore-On-New-PC.ps1  --  rebuild this till on a new computer from a
                             migration folder, keeping every record as-is

  Compiled to "Restore On New PC.exe" by Build-Installers.ps1. The .exe shows
  NO console window: a small "working" box, one message box at the end, and a
  log file. This .ps1 is the source and a fallback for machines that block .exe.

  Run it ON THE NEW MACHINE, from inside the migration folder. It:

    1. Copies the folder to C:\MelthaHonda (short path -- long photo names).
       The database (data\) comes across on the first run; on any later run
       C:\MelthaHonda\data is left untouched, so re-running never overwrites
       records the new till has taken since.
    2. Clears the old machine's run locks.
    3. Installs the bundled Visual C++ runtime if PostgreSQL needs it.
    4. Works out THIS computer's IP address (boot.js --refresh-ip). The
       bundled database only listens on localhost, so a different network
       address changes nothing for it; only the "which PC is the till"
       pointer is updated, here and on every service start.
    5. Registers the Windows service so the till starts at boot, hidden.
    6. Puts the till shortcut on the desktop and waits for it to answer.

  Safe to re-run.
================================================================================
#>

param(
  [string] $Destination = 'C:\MelthaHonda'
)

$ErrorActionPreference = 'Stop'
$APPNAME = 'Meltha Honda'
$SVCNAME = 'MelthaHondaAdmin'

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
      if ($d) { $script:logFile = Join-Path $d ('restore-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log'); break }
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
function Finish {
  StatusDone
  if ($script:fail.Count -eq 0) { Tell $script:successText 'done' 'Information'; exit 0 }
  $m = "Some steps did not complete:`r`n`r`n" + (($script:fail | ForEach-Object { '  -  ' + $_ }) -join "`r`n")
  $m += "`r`n`r`nLogs are in  C:\MelthaHonda\data\logs  (boot.log, server.log, postgres.log)."
  if ($script:logFile) { $m += "`r`nThis run's log:`r`n" + $script:logFile }
  Tell $m 'problems' 'Warning'
  exit 1
}

# ------------------------------------------------------------------ elevation
$pr = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $pr.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  try { Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"",'-Destination',"`"$Destination`"") } catch { }
  exit
}

$SOURCE = (Resolve-Path $PSScriptRoot).Path
LogInit (Join-Path $env:TEMP 'MelthaHonda')

Line "$APPNAME  --  restore on this PC"
Info "from : $SOURCE"
Info "to   : $Destination"

if (-not (Test-Path (Join-Path $SOURCE 'app\boot.js'))) {
  Bad "this folder is not a Meltha Honda migration folder (no app\boot.js beside this tool)"
  Finish
}
if ((Resolve-Path $SOURCE).Path -ieq (Resolve-Path -LiteralPath $Destination -EA SilentlyContinue).Path) {
  Bad "run this from the migration folder, not from C:\MelthaHonda itself"
  Finish
}

$firstTime = -not (Test-Path (Join-Path $Destination 'data\pgdata\PG_VERSION'))
if (-not (Confirm (
  "Set up the Meltha Honda till on THIS computer from:`r`n`r`n$SOURCE`r`n`r`n" +
  $(if ($firstTime) { "All stock, sales, customers and staff logins from the old machine will be brought across." }
    else { "C:\MelthaHonda already has a database -- the program files will be updated and the existing database left as it is." }) +
  "`r`n`r`nContinue?") 'restore on new PC')) {
  Info 'cancelled by user'; StatusDone; exit
}

# ------------------------------------------------------------ copy
Head '1. Copying the program files and the database'
if ($SOURCE -ieq $Destination) { Ok 'already at the install location' }
else {
  Status 'Copying files... this can take a few minutes. Do not close this window.'
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $rc = @("$SOURCE", "$Destination", '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1',
          '/NFL','/NDL','/NP','/NJH','/NJS',
          '/XF', 'admin.lock', 'postmaster.pid', 'postmaster.opts',
                 'Restore On New PC.exe', 'Restore-On-New-PC.ps1', 'START HERE.txt')
  if (-not $firstTime) { $rc += @('/XD', (Join-Path $SOURCE 'data')); Info 'existing C:\MelthaHonda\data left untouched (re-run)' }
  & robocopy @rc | Out-Null
  if ($LASTEXITCODE -ge 8) { Bad "copy failed (robocopy exit $LASTEXITCODE)" }
  else {
    $n = @([System.IO.Directory]::GetFiles("\\?\$Destination", '*', 'AllDirectories')).Count
    Ok ("{0:N0} files in place" -f $n)
    if (Test-Path (Join-Path $Destination 'data\pgdata\PG_VERSION')) {
      Ok ("database present (PostgreSQL " + (Get-Content (Join-Path $Destination 'data\pgdata\PG_VERSION')) + ")")
    } else { Bad 'no data\pgdata in place -- the migrated database is missing from the folder' }
  }
}

# ------------------------------------------------------------ clear old locks
Head '2. Clearing the old machine''s run state'
foreach ($rel in 'data\admin.lock','data\pgdata\postmaster.pid','data\pgdata\postmaster.opts') {
  $p = Join-Path $Destination $rel
  if (Test-Path $p) { Remove-Item $p -Force -EA SilentlyContinue; Info "removed $rel" }
}
Ok 'run locks cleared'

# ------------------------------------------------------------ prerequisites
Head '3. Checking what PostgreSQL needs'
Status 'Checking the PostgreSQL prerequisite...'
$vcOk = $false
foreach ($k in 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64',
               'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64') {
  if (Test-Path $k) { $p = Get-ItemProperty $k -EA SilentlyContinue; if ($p.Installed -eq 1) { $vcOk = $true } }
}
if (-not $vcOk -and (Test-Path 'C:\Windows\System32\vcruntime140.dll')) { $vcOk = $true }
if ($vcOk) { Ok 'Microsoft Visual C++ runtime present' }
else {
  $bundled = Join-Path $Destination 'prereq\vc_redist.x64.exe'
  if (Test-Path $bundled) {
    Status 'Installing the Visual C++ runtime...'
    $p = Start-Process $bundled -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru
    if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) { Ok 'installed' }
    else { Bad "the Visual C++ runtime installer returned $($p.ExitCode)" }
  } else { Bad 'Microsoft Visual C++ runtime is missing and not bundled' }
}
$pgExe = Join-Path $Destination 'runtime\pgsql\bin\postgres.exe'
if (Test-Path $pgExe) {
  $v = & $pgExe --version 2>&1
  if ($LASTEXITCODE -eq 0) { Ok ("PostgreSQL runs here: " + ($v -join ' ')) }
  else { Bad 'postgres.exe will not run on this machine'; Info ($v -join ' ') }
}

# ------------------------------------------------------------ this PC's address
Head '4. Network address for this computer'
Status 'Setting the network address for this PC...'
$node = Join-Path $Destination 'runtime\node.exe'
$boot = Join-Path $Destination 'app\boot.js'
if ((Test-Path $node) -and (Test-Path $boot)) {
  try {
    $out = & $node $boot --refresh-ip 2>&1
    if ($LASTEXITCODE -eq 0) { Ok (($out | Select-Object -Last 1) -replace '^lan_ip = ', 'this PC is ') }
    else { Bad "address refresh exited $LASTEXITCODE"; $out | ForEach-Object { Info $_ } }
  } catch { Bad "could not refresh the network address: $($_.Exception.Message)" }
} else { Info 'skipped -- boot.js or node.exe is not in place' }

# ------------------------------------------------------------ service
Head '5. Registering the Windows service'
Status 'Registering the Windows service...'
$svcExe = Join-Path $Destination 'Meltha Honda Service.exe'
if (-not (Test-Path $svcExe)) { Bad 'Meltha Honda Service.exe is missing from the folder' }
else {
  $existing = Get-Service -Name $SVCNAME -EA SilentlyContinue
  if ($existing) { Info 'already registered -- stopping it to update'; & sc.exe stop $SVCNAME | Out-Null; Start-Sleep -Seconds 6 }
  $out = & $svcExe --install 2>&1
  $out | ForEach-Object { Info $_ }
  Start-Sleep -Seconds 3
  $svc = Get-Service -Name $SVCNAME -EA SilentlyContinue
  if ($svc) { Ok "service registered, currently $($svc.Status)" } else { Bad 'the service did not register' }
}

# ------------------------------------------------------------ shortcut
Head '6. Desktop shortcut'
$port = 3040
try {
  $sc = Join-Path $Destination 'app\server-config.json'
  if (Test-Path $sc) { $j = Get-Content $sc -Raw | ConvertFrom-Json; if ($j.port) { $port = [int]$j.port } }
  $lnk = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Meltha Honda Admin.lnk'
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut($lnk)
  $s.TargetPath = "http://localhost:$port/admin.html"
  $s.Description = 'Open the Meltha Honda admin panel and POS'
  $s.Save()
  Ok "created -> http://localhost:$port/admin.html"
} catch { Bad "could not create the shortcut: $($_.Exception.Message)" }

# ------------------------------------------------------------ health
Head '7. Waiting for the till to come up'
Status 'Waiting for the till to start (the database is already built, so this is quick)...'
$deadline = (Get-Date).AddMinutes(5)
$up = $false
while ((Get-Date) -lt $deadline -and -not $up) {
  Start-Sleep -Seconds 5
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$port/api/health" -TimeoutSec 5 -UseBasicParsing
    if (($r.Content | ConvertFrom-Json).db -eq 'up') { $up = $true }
  } catch { }
}
if ($up) { Ok 'the till is running and the database is ready' }
else { Bad 'the till has not answered yet -- see the logs' }

$script:successText =
  "This computer is the till now.`r`n`r`n" +
  "Open:    http://localhost:$port/admin.html  (shortcut on the desktop)`r`n" +
  "Sign in: the same accounts and password as the old machine.`r`n`r`n" +
  "Other computers on the network reach it at this PC's new address:`r`n" +
  "   http://<this-PC-IP>:$port/admin.html`r`n" +
  "(the address is written in  C:\MelthaHonda\app\machine-config.json)`r`n`r`n" +
  "If other PCs cannot connect, run  Allow Network Access.vbs  once here.`r`n" +
  "Then switch the OLD machine off for good, so two tills cannot diverge."
Finish
