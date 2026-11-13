<#
  Vision Auto Solutions - set up remote support (Chrome Remote Desktop) on a shop PC

  Run as Administrator (right-click > Run with PowerShell, or use
  "Set Up Remote Support.bat", which asks for Administrator itself).

  With no options it shows a menu. Options for IT:
    -Install            install / update the Chrome Remote Desktop host (needed for both kinds of help)
    -Policies           apply the shop's safety settings
    -Unattended "<cmd>" set up unattended access, using the command copied from
                        https://remotedesktop.google.com/headless  (add -Pin 123456 -HostName "TILL-1")
    -Status             show what is installed and set
    -Remove             remove unattended access and the host software
    -Quiet              no menu, no pauses
#>
[CmdletBinding()]
param(
  [switch]$Install, [switch]$Policies, [string]$Unattended, [string]$Pin, [string]$HostName,
  [switch]$Status, [switch]$Remove, [switch]$Quiet
)
$ErrorActionPreference = 'Stop'

# Filled in by Vision when this file is downloaded from System management > Remote help.
$ShopAllowsUnattended = $false
$ShopAllowsFileTransfer = $true

$MsiUrl     = 'https://dl.google.com/edgedl/chrome-remote-desktop/chromeremotedesktophost.msi'
$PolicyKey  = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
$HostData   = Join-Path $env:ProgramData 'Google\Chrome Remote Desktop'
$ServiceName = 'chromoting'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Pause-IfMenu { if (-not $Quiet) { [void](Read-Host 'Press Enter to continue') } }

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Say 'Please run this as Administrator (right-click > Run as administrator).' Red
    Pause-IfMenu; exit 1
  }
}

function Get-HostExe($name) {
  foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if (-not $root) { continue }
    $p = Join-Path $root "Google\Chrome Remote Desktop\CurrentVersion\$name"
    if (Test-Path $p) { return $p }
    $dir = Join-Path $root 'Google\Chrome Remote Desktop'
    if (Test-Path $dir) {
      $hit = Get-ChildItem $dir -Recurse -Filter $name -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($hit) { return $hit.FullName }
    }
  }
  return $null
}

function Get-HostProduct {
  $keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Chrome Remote Desktop Host*' } | Select-Object -First 1
}

function Install-Host {
  Say 'Downloading Chrome Remote Desktop from Google...' Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $msi = Join-Path $env:TEMP 'chromeremotedesktophost.msi'
  Invoke-WebRequest -Uri $MsiUrl -OutFile $msi -UseBasicParsing
  # Only ever install something Google signed.
  $sig = Get-AuthenticodeSignature $msi
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Google LLC') {
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    throw "The download is not signed by Google ($($sig.Status)). Not installing."
  }
  Say 'Installing (this takes a minute)...' Cyan
  $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -notin 0, 3010) { throw "The installer failed (code $($p.ExitCode))." }
  Say 'Chrome Remote Desktop is installed.' Green
}

function Set-Policies {
  Say 'Applying shop safety settings...' Cyan
  if (-not (Test-Path $PolicyKey)) { New-Item $PolicyKey -Force | Out-Null }
  $set = @{
    # One-time help codes (staff share them inside Vision).
    'RemoteAccessHostAllowRemoteSupportConnections'   = 1
    # Let the technician click on Administrator windows (the Vision till runs as Administrator).
    'RemoteAccessHostAllowUiAccessForRemoteAssistance' = 1
    # Always ask for the PIN; never remember a computer.
    'RemoteAccessHostAllowClientPairing'               = 0
    'RemoteAccessHostFirewallTraversal'                = 1
    # Unattended access only where the shop allows it.
    'RemoteAccessHostAllowRemoteAccessConnections'     = [int]$ShopAllowsUnattended
    'RemoteAccessHostAllowFileTransfer'                = [int]$ShopAllowsFileTransfer
  }
  foreach ($k in $set.Keys) { New-ItemProperty -Path $PolicyKey -Name $k -Value $set[$k] -PropertyType DWord -Force | Out-Null }
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) { Restart-Service $ServiceName -ErrorAction SilentlyContinue }
  Say ('Done. Unattended access: ' + ($(if ($ShopAllowsUnattended) { 'allowed' } else { 'blocked' })) + '. File transfer: ' + ($(if ($ShopAllowsFileTransfer) { 'allowed' } else { 'blocked' })) + '.') Green
}

function Set-Unattended($cmd) {
  if (-not $ShopAllowsUnattended) { throw 'This shop does not allow unattended access. An owner can allow it in Vision: System management > Remote help > Settings, then download this script again.' }
  $exe = Get-HostExe 'remoting_start_host.exe'
  if (-not $exe) { Install-Host; $exe = Get-HostExe 'remoting_start_host.exe' }
  if (-not $exe) { throw 'Could not find remoting_start_host.exe after installing.' }
  if (-not $cmd) {
    Say ''
    Say 'On any computer: open https://remotedesktop.google.com/headless and sign in with the SHOP Google account.' Yellow
    Say 'Click Begin > Next > Authorize, then copy the line under "Windows (Cmd)" and paste it here.' Yellow
    Say 'It only works for a few minutes, so do it straight away.' Yellow
    $cmd = Read-Host 'Paste the command'
  }
  $code = [regex]::Match($cmd, '--code="?([^"\s]+)"?').Groups[1].Value
  $redirect = [regex]::Match($cmd, '--redirect-url="?([^"\s]+)"?').Groups[1].Value
  if (-not $code -or -not $redirect) { throw 'That does not look like the command from remotedesktop.google.com/headless (no --code / --redirect-url).' }
  if ($redirect -notmatch '^https://remotedesktop\.google\.com/') { throw 'The redirect address is not Google''s. Not using it.' }
  if (-not $HostName) { $HostName = $env:COMPUTERNAME }
  if (-not $Pin) {
    $s1 = Read-Host 'Choose a PIN of at least 6 digits for this PC' -AsSecureString
    $s2 = Read-Host 'Type the PIN again' -AsSecureString
    $p1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1))
    $p2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2))
    if ($p1 -ne $p2) { throw 'The PINs do not match.' }
    $Pin = $p1
  }
  if ($Pin -notmatch '^\d{6,}$') { throw 'The PIN must be at least 6 digits.' }
  if ($Pin -match '^(\d)\1+$' -or '0123456789012345678909876543210'.Contains($Pin)) { throw 'Pick a PIN that is not all one digit or a run like 123456.' }
  Say "Setting up unattended access as '$HostName'..." Cyan
  $p = Start-Process $exe -ArgumentList "--code=`"$code`"", "--redirect-url=`"$redirect`"", "--name=`"$HostName`"", "--pin=$Pin" -Wait -PassThru -NoNewWindow
  if ($p.ExitCode -ne 0) { throw "Setting up unattended access failed (code $($p.ExitCode)). The pasted command may have expired; get a fresh one." }
  Say "Done. '$HostName' now shows under https://remotedesktop.google.com/access for the shop Google account." Green
  Say 'Record it in Vision: System management > Remote help > Devices (mode Unattended, host name, Google account).' Yellow
}

function Show-Status {
  $prod = Get-HostProduct
  $svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
  Say ''
  Say ('Computer:            ' + $env:COMPUTERNAME)
  Say ('Chrome Remote Desktop: ' + ($(if ($prod) { 'installed, version ' + $prod.DisplayVersion } else { 'NOT installed' })))
  Say ('Service:             ' + ($(if ($svc) { $svc.Status } else { 'none' })))
  $cfg = Get-ChildItem $HostData -Filter 'host*.json' -ErrorAction SilentlyContinue
  if ($cfg) {
    foreach ($f in $cfg) {
      try { $j = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { continue }
      if ($j.host_name -or $j.host_owner) { Say ('Unattended access:   ON as "' + $j.host_name + '"' + ($(if ($j.host_owner) { ' owned by ' + $j.host_owner } else { '' }))) Yellow; break }
    }
  } else { Say 'Unattended access:   off' }
  if (Test-Path $PolicyKey) {
    Say 'Shop settings:'
    (Get-ItemProperty $PolicyKey).PSObject.Properties | Where-Object { $_.Name -like 'RemoteAccessHost*' } | ForEach-Object { Say ('  ' + $_.Name + ' = ' + $_.Value) }
  } else { Say 'Shop settings:       not applied' }
}

function Remove-Remote {
  Say 'Removing unattended access and Chrome Remote Desktop...' Cyan
  Stop-Service $ServiceName -ErrorAction SilentlyContinue
  if (Test-Path $HostData) { Get-ChildItem $HostData -Filter 'host*.json' -ErrorAction SilentlyContinue | Remove-Item -Force }
  $prod = Get-HostProduct
  if ($prod -and $prod.PSChildName -match '^\{') {
    $p = Start-Process msiexec.exe -ArgumentList '/x', $prod.PSChildName, '/qn', '/norestart' -Wait -PassThru
    if ($p.ExitCode -notin 0, 3010, 1605) { throw "Uninstall failed (code $($p.ExitCode))." }
  }
  Say 'Removed. Also delete this PC under https://remotedesktop.google.com/access (shop Google account) if it is still listed.' Green
}

# ------------------------------------------------------------------ main --
Assert-Admin
try {
  $any = $Install -or $Policies -or $Unattended -or $Status -or $Remove
  if ($any) {
    if ($Remove)     { Remove-Remote }
    if ($Install)    { Install-Host }
    if ($Policies)   { Set-Policies }
    if ($Unattended) { Set-Unattended $Unattended }
    if ($Status)     { Show-Status }
    exit 0
  }
  while ($true) {
    Clear-Host
    Say 'Vision Auto Solutions - Remote support set-up' Cyan
    Say ''
    Say '  1  Set up this PC for remote help (install + shop settings)  <- start here'
    Say '  2  Set up unattended access (IT can connect with a PIN when nobody is here)'
    Say '  3  Show what is set up'
    Say '  4  Remove remote access from this PC'
    Say '  Q  Quit'
    Say ''
    switch ((Read-Host 'Choose').Trim().ToUpper()) {
      '1' { Install-Host; Set-Policies; Pause-IfMenu }
      '2' { Set-Unattended $null; Pause-IfMenu }
      '3' { Show-Status; Pause-IfMenu }
      '4' { if ((Read-Host 'Type YES to remove remote access') -eq 'YES') { Remove-Remote }; Pause-IfMenu }
      'Q' { exit 0 }
    }
  }
} catch {
  Say ('Problem: ' + $_.Exception.Message) Red
  Pause-IfMenu
  exit 1
}
