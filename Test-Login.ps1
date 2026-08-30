<#
================================================================================
  Test-Login.ps1  --  where exactly does sign-in break?

  Put this beside "Meltha Honda Admin.exe" on the machine that will not let you
  in, then:

      powershell -ExecutionPolicy Bypass -File .\Test-Login.ps1
      powershell -ExecutionPolicy Bypass -File .\Test-Login.ps1 -Email you@shop.com -Password whatever

  Sign-in is a chain -- database up, user row present, password hash stored,
  bcrypt agrees, account is an admin, server answers -- and the admin page
  reports the same red message however it breaks. This walks the chain and
  names the first link that fails.

  It does NOT bypass anything. It checks the same password the same way the
  server does, using the same bcrypt library, so a pass here means the real
  sign-in will pass too.
================================================================================
#>

param(
  [string] $Email    = 'admin@melthahonda.com',
  [string] $Password = 'password123'
)

$ErrorActionPreference = 'Continue'
$ROOT   = $PSScriptRoot
$PGBIN  = Join-Path $ROOT 'runtime\pgsql\bin'
$NODE   = Join-Path $ROOT 'runtime\node.exe'
$APP    = Join-Path $ROOT 'app'
$fail   = $null

function Head($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ ok ] $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red; if (-not $script:fail) { $script:fail = $m } }
function Info($m) { Write-Host "        $m" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '===============================================' -ForegroundColor White
Write-Host '  Meltha Honda -- sign-in check'                 -ForegroundColor White
Write-Host '===============================================' -ForegroundColor White
Info "account: $Email"

# ---- connection details, the same ones the server uses ----------------------
$dbHost = '127.0.0.1'; $dbPort = 5433; $dbName = 'melthahonda'; $dbUser = 'postgres'; $dbPass = 'postgres'
try {
  $cfg = Get-Content (Join-Path $APP 'db-config.json') -Raw -EA Stop | ConvertFrom-Json
  if ($cfg.local) {
    if ($cfg.local.host)     { $dbHost = $cfg.local.host }
    if ($cfg.local.port)     { $dbPort = [int]$cfg.local.port }
    if ($cfg.local.database) { $dbName = $cfg.local.database }
    if ($cfg.local.user)     { $dbUser = $cfg.local.user }
    if ($cfg.local.password) { $dbPass = $cfg.local.password }
  }
} catch {
  try {
    $pj = Get-Content (Join-Path $APP 'portable.json') -Raw | ConvertFrom-Json
    if ($pj.pgPort) { $dbPort = [int]$pj.pgPort }
    if ($pj.database) { $dbName = $pj.database }
  } catch {}
}
Info "database: $dbUser@${dbHost}:$dbPort/$dbName"
$env:PGPASSWORD = $dbPass

function PsqlOne($sql) {
  $r = & (Join-Path $PGBIN 'psql.exe') -h $dbHost -p $dbPort -U $dbUser -d $dbName -t -A -c $sql 2>&1
  return @{ ok = ($LASTEXITCODE -eq 0); out = ($r -join "`n").Trim() }
}

# ---- 1. database ------------------------------------------------------------
Head '1. Is the database answering?'
$r = PsqlOne 'SELECT 1'
if (-not $r.ok) {
  Bad 'cannot reach PostgreSQL'
  Info $r.out
  Info 'Nothing else can be checked until it starts. Run Test-Database.ps1.'
  Write-Host ''; Read-Host 'Press Enter to close'; exit 1
}
Ok 'connected'

# ---- 2. the users table -----------------------------------------------------
Head '2. Is the schema there?'
$r = PsqlOne "SELECT COUNT(*) FROM users"
if (-not $r.ok) {
  Bad 'the users table is missing -- the database never finished setting up'
  Info $r.out
  Info 'Look in data\logs\server.log for lines beginning [initDb].'
  Write-Host ''; Read-Host 'Press Enter to close'; exit 1
}
Ok "users table present ($($r.out) accounts)"

# ---- 3. the account ---------------------------------------------------------
Head '3. Does this account exist?'
$esc = $Email.Replace("'", "''")
# CASE rather than is_admin::text: that renders as 'true'/'false', which is easy
# to compare against the wrong literal and report a perfectly good owner account
# as "not an admin".
$r = PsqlOne "SELECT id || '|' || COALESCE(admin_role,'') || '|' || CASE WHEN is_admin THEN 'YES' ELSE 'NO' END || '|' || COALESCE(length(password_hash)::text,'0') FROM users WHERE lower(email) = lower('$esc')"
if (-not $r.ok -or -not $r.out) {
  Bad "no account with the address $Email"
  Info 'Accounts on this database:'
  (PsqlOne "SELECT '  ' || email || '   admin=' || is_admin::text FROM users ORDER BY id").out |
    ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
  Write-Host ''; Read-Host 'Press Enter to close'; exit 1
}
$parts = $r.out.Split('|')
Ok "found (id $($parts[0]), role $($parts[1]))"
if ($parts[2] -ne 'YES') { Bad 'this account is not an admin -- the panel will refuse it even with the right password' }
else { Ok 'account is an admin' }
if ([int]$parts[3] -eq 0) {
  Bad 'no password is stored for this account'
  Info 'Reset it: POST /api/auth/reset-default-admin  (restores admin@melthahonda.com / password123)'
} else { Ok "password hash stored ($($parts[3]) chars)" }

# ---- 4. the password itself -------------------------------------------------
Head '4. Does the password match?'
# Compared with the same bcryptjs the server uses, so this is not an
# approximation of the check -- it is the check.
$hash = (PsqlOne "SELECT password_hash FROM users WHERE lower(email) = lower('$esc')").out
# argv[0] is node, argv[1] is this script -- the real arguments start at [2].
# Reading [1] and [2] compares the script's own path against the hash and
# always says NO-MATCH, which looks exactly like a wrong password.
$js = @'
const bcrypt = require('bcryptjs');
const hash = process.argv[2];
const pw   = process.argv[3];
bcrypt.compare(pw, hash).then(ok => console.log(ok ? 'MATCH' : 'NO-MATCH'))
  .catch(e => console.log('ERROR ' + e.message));
'@
# Written into app\, not %TEMP%: Node resolves require() from the script's own
# folder, and bcryptjs lives in app\node_modules. From the temp folder the
# require simply fails and the check reports nothing useful.
$jsFile = Join-Path $APP '_mh-pwcheck.js'
[System.IO.File]::WriteAllText($jsFile, $js, (New-Object System.Text.UTF8Encoding($false)))
$res = & $NODE $jsFile $hash $Password 2>&1
Remove-Item $jsFile -Force -EA SilentlyContinue
if ("$res".Trim() -eq 'MATCH') { Ok 'the password is correct for this account' }
elseif ("$res".Trim() -eq 'NO-MATCH') {
  Bad 'the password does not match the stored hash'
  Info 'The database and schema are fine -- this really is the wrong password.'
  Info 'To put admin@melthahonda.com back to password123, restart the server:'
  Info 'initDb resets that one account on every boot.'
} else { Bad "could not run the check: $res" }

# ---- 5. the server ----------------------------------------------------------
Head '5. Does the server accept it?'
$port = 3040
try { $sc = Get-Content (Join-Path $APP 'server-config.json') -Raw | ConvertFrom-Json; if ($sc.port) { $port = [int]$sc.port } } catch {}
try {
  $body = @{ email = $Email; password = $Password } | ConvertTo-Json
  $resp = Invoke-WebRequest "http://127.0.0.1:$port/api/auth/signin" -Method POST -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 20
  Ok "signed in ($($resp.StatusCode))"
} catch {
  # ErrorDetails.Message is where PowerShell puts an HTTP error body. Reading
  # the response stream by hand usually comes back empty here, which reported
  # "the server refused it:" with nothing after it -- the one detail that
  # actually says why.
  $txt = $null
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $txt = $_.ErrorDetails.Message }
  elseif ($_.Exception.Response) {
    try {
      $st = $_.Exception.Response.GetResponseStream()
      $st.Position = 0
      $rd = New-Object System.IO.StreamReader($st)
      $txt = $rd.ReadToEnd(); $rd.Close()
    } catch {}
  }
  if ($txt) { Bad "the server refused it: $txt" }
  elseif ($_.Exception.Response) { Bad ("the server refused it (HTTP {0})" -f [int]$_.Exception.Response.StatusCode) }
  else {
    Bad "the server is not answering on port $port"
    Info 'The database can be perfectly healthy while the app is not running.'
  }
}

Write-Host ''
Write-Host '===============================================' -ForegroundColor White
if ($fail) { Write-Host "  First thing that failed:" -ForegroundColor Red; Write-Host "    $fail" -ForegroundColor Red }
else { Write-Host '  Sign-in works end to end.' -ForegroundColor Green }
Write-Host '===============================================' -ForegroundColor White
Write-Host ''
Read-Host 'Press Enter to close'
