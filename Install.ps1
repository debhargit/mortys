<#
================================================================================
  Install.ps1  --  set this PC up as a Meltha Honda till

  Right-click and choose "Run with PowerShell", or from an elevated prompt:

      powershell -ExecutionPolicy Bypass -File .\Install.ps1

  What it does, and why each step is here rather than left to whoever is
  standing at the counter:

    1. Copies the package to C:\MelthaHonda.
       Not cosmetic. This package contains file names past Windows' 260-character
       limit, and Explorer skips those silently when copying -- no error, no
       prompt, just a folder that looks complete and is not. A short destination
       is what keeps every file inside the limit.

    2. Checks for the Microsoft Visual C++ runtime.
       The bundled PostgreSQL is built against it. A machine without it gets
       "postgres.exe will not run", the database never starts, and the admin
       page then refuses every sign-in as though the password were wrong.

    3. Registers the Windows Service.
       Starts at boot, before anyone signs in; survives sign-out; restarts
       itself if it fails; and is launched by Windows rather than by
       double-clicking an unsigned executable, which Smart App Control will
       sometimes refuse outright.

    4. Puts a shortcut on the desktop that opens the till page.

  Run it again any time -- it replaces the program files and leaves the
  database alone.
================================================================================
#>

param(
  [string] $Destination = 'C:\MelthaHonda',
  [switch] $KeepDatabase = $true
)

$ErrorActionPreference = 'Stop'
$SOURCE = $PSScriptRoot
$fail = @()

function Head($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan; Write-Host ('-' * $t.Length) -ForegroundColor DarkGray }
function Ok($m)   { Write-Host "  [ ok ] $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:fail += $m }
function Info($m) { Write-Host "        $m" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '===============================================' -ForegroundColor White
Write-Host '  Meltha Honda -- install this till'             -ForegroundColor White
Write-Host '===============================================' -ForegroundColor White
Info "from : $SOURCE"
Info "to   : $Destination"

# ---- 0. elevation ------------------------------------------------------------
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host ''
  Write-Host '  This needs to run as administrator (it registers a Windows service).' -ForegroundColor Yellow
  Write-Host '  Re-launching with the elevation prompt...' -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"",'-Destination',"`"$Destination`"")
  return
}

# ---- 1. copy -----------------------------------------------------------------
Head '1. Copying the program files'
if ($SOURCE -ieq $Destination) {
  Ok 'already running from the install location'
} else {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  # robocopy, not Copy-Item: it is long-path aware, and this package has names
  # that plain Windows copying drops without saying so.
  # data\ is excluded so re-running never touches a till's live database.
  $args = @($SOURCE, $Destination, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
  if ($KeepDatabase) { $args += @('/XD', (Join-Path $SOURCE 'data')) }
  & robocopy @args | Out-Null
  if ($LASTEXITCODE -ge 8) { Bad "copy failed (robocopy exit $LASTEXITCODE)" }
  else {
    $n = @([System.IO.Directory]::GetFiles("\\?\$Destination", '*', 'AllDirectories')).Count
    Ok ("{0:N0} files in place" -f $n)
    if ($KeepDatabase -and (Test-Path (Join-Path $Destination 'data\pgdata'))) {
      Info 'existing database left untouched'
    }
  }
}

# Any config file that carries an IP address -- this server's own advertised
# address, a client's "which PC is the database" pointer, the bundled
# database's LAN allow-list -- is re-derived from this machine's current
# adapter now, and again on every service start (the supervisor runs the same
# --refresh-ip pass). Without this, a DHCP change between installs leaves those
# files naming an address that has since moved.
Head 'Network address'
$refreshNode = Join-Path $Destination 'runtime\node.exe'
$refreshBoot = Join-Path $Destination 'app\boot.js'
if ((Test-Path $refreshNode) -and (Test-Path $refreshBoot)) {
  try {
    $out = & $refreshNode $refreshBoot --refresh-ip 2>&1
    if ($LASTEXITCODE -eq 0) { Ok (($out | Select-Object -Last 1) -replace '^lan_ip = ', 'this PC is ') }
    else { Bad "address refresh exited $LASTEXITCODE"; $out | ForEach-Object { Info $_ } }
  } catch { Bad "could not refresh the network address: $($_.Exception.Message)" }
} else {
  Info 'skipped -- boot.js or the bundled node.exe is not in place'
}

# ---- 2. prerequisites --------------------------------------------------------
Head '2. Checking what PostgreSQL needs'
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
    Info 'installing the Visual C++ runtime (bundled)...'
    $p = Start-Process $bundled -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru
    if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) { Ok 'installed' }
    else { Bad "the Visual C++ runtime installer returned $($p.ExitCode)" }
  } else {
    Bad 'Microsoft Visual C++ runtime is missing and not bundled'
    Info 'PostgreSQL will not start without it. Install "Microsoft Visual C++'
    Info 'Redistributable (x64)" from microsoft.com, then run this again.'
  }
}

# prove the binary actually loads on this machine, rather than trusting registry
$pgExe = Join-Path $Destination 'runtime\pgsql\bin\postgres.exe'
if (Test-Path $pgExe) {
  $v = & $pgExe --version 2>&1
  if ($LASTEXITCODE -eq 0) { Ok ("PostgreSQL runs here: " + ($v -join ' ')) }
  else { Bad 'postgres.exe still will not run on this machine'; Info ($v -join ' ') }
}

# ---- 3. the service ----------------------------------------------------------
Head '3. Registering the Windows service'
$svcExe = Join-Path $Destination 'Meltha Honda Service.exe'
if (-not (Test-Path $svcExe)) { Bad 'Meltha Honda Service.exe is missing from the package' }
else {
  $existing = Get-Service -Name 'MelthaHondaAdmin' -EA SilentlyContinue
  if ($existing) { Info 'already registered -- stopping it to update'; & sc.exe stop MelthaHondaAdmin | Out-Null; Start-Sleep -Seconds 6 }
  $out = & $svcExe --install 2>&1
  $out | ForEach-Object { Info $_ }
  Start-Sleep -Seconds 3
  $svc = Get-Service -Name 'MelthaHondaAdmin' -EA SilentlyContinue
  if ($svc) { Ok "service registered, currently $($svc.Status)" } else { Bad 'the service did not register' }
}

# ---- 4. shortcut -------------------------------------------------------------
Head '4. Desktop shortcut'
try {
  $port = 3040
  $sc = Join-Path $Destination 'app\server-config.json'
  if (Test-Path $sc) { $j = Get-Content $sc -Raw | ConvertFrom-Json; if ($j.port) { $port = [int]$j.port } }
  $lnk = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Meltha Honda Admin.lnk'
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut($lnk)
  # Points at the URL, not at an executable: the service is already running the
  # app, so there is nothing to launch -- and nothing for Application Control
  # to refuse.
  $s.TargetPath = "http://localhost:$port/admin.html"
  $s.Description = 'Open the Meltha Honda admin panel and POS'
  $s.Save()
  Ok "created for all users -> http://localhost:$port/admin.html"
} catch { Bad "could not create the shortcut: $($_.Exception.Message)" }

# ---- 5. does it actually answer ----------------------------------------------
Head '5. Waiting for the till to come up'
Info 'first run builds the database and loads the catalogue -- a few minutes'
$port = 3040
try { $sc = Join-Path $Destination 'app\server-config.json'; if (Test-Path $sc) { $j = Get-Content $sc -Raw | ConvertFrom-Json; if ($j.port) { $port = [int]$j.port } } } catch {}
$deadline = (Get-Date).AddMinutes(6)
$up = $false
while ((Get-Date) -lt $deadline -and -not $up) {
  Start-Sleep -Seconds 5
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$port/api/health" -TimeoutSec 5 -UseBasicParsing
    if (($r.Content | ConvertFrom-Json).db -eq 'up') { $up = $true }
  } catch {}
}
if ($up) { Ok 'the till is running and the database is ready' }
else {
  Bad 'it has not come up yet'
  Info 'Run Test-Database.ps1 in the install folder -- it reports exactly why.'
}

# ---- verdict -----------------------------------------------------------------
Write-Host ''
Write-Host '===============================================' -ForegroundColor White
if ($fail.Count -eq 0) {
  Write-Host '  Installed. This PC is ready.' -ForegroundColor Green
  Write-Host ''
  Write-Host "    Open:      http://localhost:$port/admin.html"
  Write-Host '    Sign in:   admin@melthahonda.com / password123'
  Write-Host '    Change that password once you are in.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  It starts on its own every time this PC is switched on.'
} else {
  Write-Host ("  {0} problem(s):" -f $fail.Count) -ForegroundColor Red
  foreach ($f in $fail) { Write-Host "    - $f" -ForegroundColor Red }
}
Write-Host '===============================================' -ForegroundColor White
Write-Host ''
Read-Host 'Press Enter to close'
