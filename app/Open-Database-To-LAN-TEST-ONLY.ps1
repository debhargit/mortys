<#
================================================================================
  Open-Database-To-LAN-TEST-ONLY.ps1

  Lets a Morty's Auto Parts CLIENT folder on another PC connect to the PostgreSQL
  that a STANDALONE server package carries inside it.

  Why this is needed
  ------------------
  The bundled PostgreSQL is deliberately bound to localhost only, on port 5433
  (see initPostgres() in app\boot.js). That is a security decision: on a normal
  shop install the app server on port 3057 is the only thing the LAN talks to,
  and nothing outside the machine has any business opening a raw database
  connection. A client folder, however, connects straight to PostgreSQL -- so
  with the shipped settings it can never reach a standalone server.

  This script relaxes that binding so the two packages can be tested against
  each other on a private network.

  ** TEST / LAB USE ONLY. **
  It exposes the whole database to every machine on the subnet, authenticated
  by one password that is stored in plain text in every copy of the folder.
  For a real shop, use one of the two documented topologies instead:
     - browser-only tills  ->  INSTALL-CLIENT.md section 1, Option 1
     - a real shared PostgreSQL  ->  INSTALL-SERVER.md section 7

  Usage
  -----
  On the SERVER laptop, in PowerShell:

      .\Open-Database-To-LAN-TEST-ONLY.ps1

  It elevates itself (needed for the firewall rule), edits the two config
  files, opens TCP 5433 on private/domain networks only, and restarts the app.

  To undo everything:

      .\Open-Database-To-LAN-TEST-ONLY.ps1 -Revert
================================================================================
#>

[CmdletBinding()]
param(
    # Root of the installed server package. Default: this script's own folder.
    [string] $Root,

    # Put the loopback-only binding back and remove the firewall rule.
    [switch] $Revert
)

$ErrorActionPreference = 'Stop'

# --- Elevate ------------------------------------------------------------------
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Needs administrator rights (firewall rule) -- relaunching elevated...' -ForegroundColor Yellow
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Root)   { $argList += @('-Root', "`"$Root`"") }
    if ($Revert) { $argList += '-Revert' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
    return
}

if (-not $Root) { $Root = $PSScriptRoot }
$PgData  = Join-Path $Root 'data\pgdata'
$Conf    = Join-Path $PgData 'postgresql.conf'
$Hba     = Join-Path $PgData 'pg_hba.conf'
$StopExe = Join-Path $Root 'Stop Morty''s Auto Parts Admin.exe'
$StartExe= Join-Path $Root 'Morty''s Auto Parts Admin.exe'
$RuleName= 'Morty''s Auto Parts DB (TEST)'
$Marker  = '# --- Morty''s Auto Parts LAN test override ---'

Write-Host ''
Write-Host '=======================================================' -ForegroundColor White
Write-Host '  Morty''s Auto Parts -- open bundled database to the LAN'      -ForegroundColor White
Write-Host '=======================================================' -ForegroundColor White
Write-Host ("  Package : {0}" -f $Root)

if (-not (Test-Path -LiteralPath $Conf)) {
    Write-Host ''
    Write-Host "  No bundled database found at:" -ForegroundColor Red
    Write-Host ("    {0}" -f $PgData) -ForegroundColor Red
    Write-Host ''
    Write-Host '  Either this is a CLIENT package (no runtime\pgsql), or the server'
    Write-Host '  has never been started -- the data directory is created on first run.'
    Write-Host '  Start "Morty''s Auto Parts Admin.exe" once, let it finish, then re-run this.'
    Write-Host ''
    Read-Host 'Press Enter to close'
    return
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# --- Stop the app so Postgres is not mid-write --------------------------------
if (Test-Path -LiteralPath $StopExe) {
    Write-Host ''
    Write-Host '  Stopping the admin server...'
    & $StopExe | Out-Null
    Start-Sleep -Seconds 3
}

if ($Revert) {
    # postgresql.conf: drop our appended override block
    $lines = [System.IO.File]::ReadAllLines($Conf)
    $keep = New-Object System.Collections.Generic.List[string]
    $skip = $false
    foreach ($l in $lines) {
        if ($l.Trim() -eq $Marker) { $skip = $true; continue }
        if ($skip -and $l.Trim() -eq '# --- end Morty''s Auto Parts LAN test override ---') { $skip = $false; continue }
        if (-not $skip) { $keep.Add($l) }
    }
    [System.IO.File]::WriteAllLines($Conf, $keep, $Utf8NoBom)
    Write-Host '  postgresql.conf : LAN override removed (back to localhost only)'

    # pg_hba.conf: drop lines we tagged
    $hba = [System.IO.File]::ReadAllLines($Hba) | Where-Object { $_ -notmatch "(?:mortys|vision|meltha)-lan-test" }
    [System.IO.File]::WriteAllLines($Hba, $hba, $Utf8NoBom)
    Write-Host '  pg_hba.conf     : test rules removed'

    & netsh advfirewall firewall delete rule name="$RuleName" | Out-Null
    Write-Host '  firewall        : rule removed'
}
else {
    # --- Work out the subnet ---------------------------------------------------
    $ip = Get-WmiObject Win32_NetworkAdapterConfiguration |
          Where-Object { $_.IPEnabled -and $_.DefaultIPGateway } |
          Select-Object -First 1
    if (-not $ip) { throw 'Could not determine this machine''s IP address.' }
    $addr = ($ip.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1)
    $mask = ($ip.IPSubnet  | Select-Object -First 1)

    # CIDR from the dotted mask
    $bits = ($mask.Split('.') | ForEach-Object {
        [Convert]::ToString([int]$_, 2).ToCharArray() | Where-Object { $_ -eq '1' }
    }).Count
    $o = $addr.Split('.'); $m = $mask.Split('.')
    $net = (0..3 | ForEach-Object { [int]$o[$_] -band [int]$m[$_] }) -join '.'
    $cidr = "$net/$bits"

    Write-Host ''
    Write-Host ("  This PC   : {0}" -f $addr) -ForegroundColor Cyan
    Write-Host ("  Subnet    : {0}" -f $cidr) -ForegroundColor Cyan

    # --- postgresql.conf -------------------------------------------------------
    # Appended at the very end so it wins over the build's own override block,
    # which already sets listen_addresses = 'localhost'. Last setting wins.
    $conf = [System.IO.File]::ReadAllText($Conf)
    if ($conf -notmatch [regex]::Escape($Marker)) {
        $conf += "`r`n$Marker`r`n" +
                 "listen_addresses = '*'`r`n" +
                 "# --- end Morty's Auto Parts LAN test override ---`r`n"
        [System.IO.File]::WriteAllText($Conf, $conf, $Utf8NoBom)
        Write-Host "  postgresql.conf : listen_addresses = '*'"
    } else {
        Write-Host '  postgresql.conf : already opened'
    }

    # --- pg_hba.conf -----------------------------------------------------------
    # hostssl, NOT host. `host` would accept an unencrypted connection just as
    # happily as an encrypted one, so a till with TLS misconfigured would fall
    # back to clear text and nobody would ever notice. hostssl refuses the
    # connection outright, which is a failure you can see and fix.
    $hba = [System.IO.File]::ReadAllText($Hba)
    if ($hba -notmatch "(?:mortys|vision|meltha)-lan-test") {
        $hba += "`r`n# mortys-lan-test`r`n" +
                ("hostssl all             all             {0}          scram-sha-256    # mortys-lan-test`r`n" -f $cidr)
        [System.IO.File]::WriteAllText($Hba, $hba, $Utf8NoBom)
        Write-Host ("  pg_hba.conf     : allow {0} over TLS only (hostssl, scram-sha-256)" -f $cidr)
    } else {
        Write-Host '  pg_hba.conf     : already allowed'
    }

    # --- Firewall --------------------------------------------------------------
    & netsh advfirewall firewall delete rule name="$RuleName" 2>$null | Out-Null
    & netsh advfirewall firewall add rule name="$RuleName" dir=in action=allow `
        protocol=TCP localport=5433 profile=private,domain | Out-Null
    Write-Host '  firewall        : TCP 5433 open (private + domain only)'

    Write-Host ''
    Write-Host '  On the CLIENT laptop, point it at:' -ForegroundColor Green
    Write-Host ('      Database server address :  {0}' -f $addr) -ForegroundColor White
    Write-Host  '      Database port           :  5433'          -ForegroundColor White
    Write-Host  '      Database name           :  mortysautoparts'   -ForegroundColor White
    Write-Host  '      Database user           :  postgres'      -ForegroundColor White
    Write-Host  '      Database password       :  postgres'      -ForegroundColor White
}

# --- Restart ------------------------------------------------------------------
if (Test-Path -LiteralPath $StartExe) {
    Write-Host ''
    Write-Host '  Restarting the admin server...'
    Start-Process -FilePath $StartExe
    Write-Host '  Give it up to a minute, then check the panel.'
}

Write-Host ''
Read-Host 'Press Enter to close'
