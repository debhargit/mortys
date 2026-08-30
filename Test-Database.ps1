<#
================================================================================
  Test-Database.ps1  --  why won't this copy's database start?

  Put this file in the Meltha Honda folder (beside "Meltha Honda Admin.exe")
  on the machine that is failing, right-click it and choose
  "Run with PowerShell". Or from a terminal in that folder:

      powershell -ExecutionPolicy Bypass -File .\Test-Database.ps1

  It talks to PostgreSQL directly, so it answers the question the admin page
  cannot: is the database broken, or is it the app? Nothing is written to the
  database -- it starts it if needed, counts a few rows, and puts it back the
  way it found it.
================================================================================
#>

$ErrorActionPreference = 'Continue'
$ROOT    = $PSScriptRoot
$PGDATA  = Join-Path $ROOT 'data\pgdata'
$PGBIN   = Join-Path $ROOT 'runtime\pgsql\bin'
$LOGDIR  = Join-Path $ROOT 'data\logs'
$problems = @()

function Head($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan; Write-Host ('-' * $t.Length) -ForegroundColor DarkGray }
function Ok($m)   { Write-Host "  [ ok ] $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:problems += $m }
function Info($m) { Write-Host "        $m" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '===============================================' -ForegroundColor White
Write-Host '  Meltha Honda -- database check'               -ForegroundColor White
Write-Host '===============================================' -ForegroundColor White
Info $ROOT

# ---- 1. is the package even complete -----------------------------------------
Head '1. Files'
# Long paths: this package contains names past Windows' 260-char limit, and
# Explorer skips those silently when copying. GetFiles with the \\?\ prefix
# sees them; a plain Get-ChildItem would report a shortfall that isn't real.
function CountFiles($p) {
  if (-not (Test-Path -LiteralPath $p)) { return -1 }
  try { return @([System.IO.Directory]::GetFiles("\\?\$p", '*', 'AllDirectories')).Count } catch { return -1 }
}
$expected = @{ 'app' = 7532; 'runtime\pgsql' = 1627; 'data\pgdata' = 1727 }
foreach ($k in 'app', 'runtime\pgsql', 'data\pgdata') {
  $n = CountFiles (Join-Path $ROOT $k)
  if ($n -lt 0) { Bad "$k is missing entirely" }
  elseif ($n -lt $expected[$k]) { Bad ("{0}: {1:N0} files, expected about {2:N0} -- {3:N0} did not copy" -f $k, $n, $expected[$k], ($expected[$k] - $n)) }
  else { Ok ("{0}: {1:N0} files" -f $k, $n) }
}
if ($problems.Count) {
  Info 'Windows Explorer silently skips files whose path passes 260 characters.'
  Info 'Unzip (or copy) to a short path such as C:\MelthaHonda and try again.'
}

# ---- 2. the empty folders PostgreSQL insists on ------------------------------
Head '2. Working folders'
# A ZIP cannot express an empty folder unless one is written deliberately, and
# many tools do not bother. PostgreSQL will not start without these.
$needed = 'pg_commit_ts','pg_dynshmem','pg_notify','pg_replslot','pg_serial',
          'pg_snapshots','pg_stat','pg_stat_tmp','pg_tblspc','pg_twophase'
$missing = @($needed | Where-Object { -not (Test-Path -LiteralPath (Join-Path $PGDATA $_)) })
if ($missing.Count) {
  Bad ("{0} missing: {1}" -f $missing.Count, ($missing -join ', '))
  foreach ($m in $missing) { New-Item -ItemType Directory -Force -Path (Join-Path $PGDATA $m) | Out-Null }
  Ok 'created them -- this alone usually fixes a fresh copy'
} else { Ok 'all ten present' }

# ---- 3. a database copied while it was running -------------------------------
Head '3. Copy consistency'
$pid_file = Join-Path $PGDATA 'postmaster.pid'
# A running database writes this file and removes it on shutdown, so its mere
# presence proves nothing -- on the machine the copy was taken FROM it is
# simply normal. It only indicates a hot copy when the database is not running
# and the file is still there.
& (Join-Path $PGBIN 'pg_ctl.exe') -D $PGDATA status *> $null
$alreadyRunning = ($LASTEXITCODE -eq 0)
if (-not (Test-Path -LiteralPath $pid_file)) {
  Ok 'clean shutdown -- no stale postmaster.pid'
} elseif ($alreadyRunning) {
  Ok 'postmaster.pid present because the database is running here -- expected'
} else {
  Bad 'stale postmaster.pid -- this copy was taken while the database was running'
  Info 'That makes it a "hot" copy: files captured at different moments.'
  Info 'It may still start, but the safe fix is to stop the source machine'
  Info 'first and take the copy again (or use the .zip, which is made clean).'
}

# ---- 4. can postgres.exe even load ------------------------------------------
Head '4. PostgreSQL binaries'
$pgExe = Join-Path $PGBIN 'postgres.exe'
if (-not (Test-Path -LiteralPath $pgExe)) { Bad 'runtime\pgsql\bin\postgres.exe is missing' }
else {
  $v = & $pgExe --version 2>&1
  if ($LASTEXITCODE -eq 0) { Ok ("runs: {0}" -f ($v -join ' ')) }
  else {
    Bad 'postgres.exe will not run on this machine'
    Info ($v -join ' ')
    Info 'A missing Microsoft Visual C++ Redistributable (x64) is the usual cause.'
    Info 'Install it from microsoft.com and run this again.'
  }
}

# ---- 5. start it and look inside --------------------------------------------
Head '5. Starting the database'
$port = 5433
try {
  $pj = Get-Content (Join-Path $ROOT 'app\portable.json') -Raw | ConvertFrom-Json
  if ($pj.pgPort) { $port = [int]$pj.pgPort }
} catch {}
Info "port $port"

$null = & (Join-Path $PGBIN 'pg_ctl.exe') -D $PGDATA status 2>&1
# A boolean, not the text pg_ctl printed. Testing the text meant "not running"
# was still truthy, so the contents check ran against a database that had never
# started and blamed the schema for a refused connection.
$dbRunning   = ($LASTEXITCODE -eq 0)
$startedByUs = $false

if ($dbRunning) { Ok 'already running' }
else {
  $diag = Join-Path $LOGDIR 'db-check.log'
  New-Item -ItemType Directory -Force -Path $LOGDIR | Out-Null
  & (Join-Path $PGBIN 'pg_ctl.exe') -D $PGDATA -o "-p $port" -l $diag -w -t 60 start | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok 'started'; $dbRunning = $true; $startedByUs = $true }
  else {
    Bad 'PostgreSQL would not start'
    $said = @(Get-Content $diag -Tail 12 -EA SilentlyContinue)
    Info 'Its own words:'
    $said | ForEach-Object { Write-Host "        $_" -ForegroundColor Yellow }

    # The one failure this package causes itself. postgresql.conf used to be
    # written with the certificate's full path, which is the path on the
    # machine the copy came from -- so PostgreSQL looks for a folder that is
    # not there. The names are resolved against the data directory, so bare
    # file names are both correct and portable.
    if ($said -match 'could not load server certificate file') {
      Write-Host ''
      Info 'That is a path from the machine this copy came from.'
      $conf = Join-Path $PGDATA 'postgresql.conf'
      try {
        $c = Get-Content $conf -Raw
        $c = $c -replace "(?m)^\s*ssl_cert_file\s*=.*$", "ssl_cert_file = 'server.crt'"
        $c = $c -replace "(?m)^\s*ssl_key_file\s*=.*$",  "ssl_key_file = 'server.key'"
        # WriteAllText with a BOM-less encoder, never Set-Content -Encoding UTF8:
        # that writes a byte order mark, and PostgreSQL will not parse a config
        # file that starts with one -- "syntax error in file ... line 1". The
        # repair would then leave the database worse off than it found it.
        [System.IO.File]::WriteAllText($conf, $c, (New-Object System.Text.UTF8Encoding($false)))
        Ok "rewrote ssl_cert_file / ssl_key_file to 'server.crt' and 'server.key'"
        & (Join-Path $PGBIN 'pg_ctl.exe') -D $PGDATA -o "-p $port" -l $diag -w -t 60 start | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'started after the fix'; $dbRunning = $true; $startedByUs = $true }
        else {
          Info 'Still will not start:'
          Get-Content $diag -Tail 6 -EA SilentlyContinue | ForEach-Object { Write-Host "        $_" -ForegroundColor Yellow }
        }
      } catch { Info "could not edit postgresql.conf: $($_.Exception.Message)" }
    }
  }
}

# ---- 6. is the shop's data actually in there ---------------------------------
if (-not $dbRunning) {
  Head '6. Contents'
  Info 'Skipped -- the database never started, so there is nothing to read.'
  Info 'Fix the error above first; everything else follows from it.'
} else {
  Head '6. Contents'
  $env:PGPASSWORD = 'postgres'
  $sql = "SELECT (SELECT COUNT(*) FROM products) || ' products, ' || " +
         "(SELECT COUNT(*) FROM users) || ' users, ' || " +
         "(SELECT COUNT(*) FROM roles) || ' roles'"
  $out = & (Join-Path $PGBIN 'psql.exe') -h 127.0.0.1 -p $port -U postgres -d melthahonda -t -A -c $sql 2>&1
  if ($LASTEXITCODE -eq 0) {
    Ok ($out -join ' ')
    Info 'The database is fine. If sign-in still fails, the fault is elsewhere --'
    Info 'send data\logs\server.log and data\logs\boot.log.'
  } else {
    # Distinguish "cannot reach it" from "reached it, the tables are wrong".
    # Reporting a refused connection as an incomplete schema sends people to
    # the wrong logs entirely.
    $txt = ($out -join ' ')
    if ($txt -match 'Connection refused|could not connect|server closed') {
      Bad 'could not connect to the database to read the tables'
      Info $txt
      Info 'It reported as started but is not accepting connections on this port.'
    } else {
      Bad 'connected to PostgreSQL, but could not read the shop tables'
      Info $txt
      Info 'The database is running and its schema is incomplete -- check'
      Info 'data\logs\server.log for lines beginning [initDb].'
    }
  }
  if ($startedByUs) {
    & (Join-Path $PGBIN 'pg_ctl.exe') -D $PGDATA -m fast -w -t 30 stop | Out-Null
    Info 'stopped again (left as found)'
  }
}

# ---- verdict -----------------------------------------------------------------
Write-Host ''
Write-Host '===============================================' -ForegroundColor White
if ($problems.Count -eq 0) {
  Write-Host '  No problems found with the database.' -ForegroundColor Green
} else {
  Write-Host ("  {0} problem(s) found:" -f $problems.Count) -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "    - $p" -ForegroundColor Red }
}
Write-Host '===============================================' -ForegroundColor White
Write-Host ''
Read-Host 'Press Enter to close'
