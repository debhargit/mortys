<#
  Vision Auto Solutions - install a terminal (a PC that uses Vision on the shop server)

  Download it from Vision: System management > Device access > Download terminal installer
  (the shop server's address is then filled in below). Right-click > Run with PowerShell.
  It asks for administrator rights once, because it sets the terminal up for EVERY user of this PC.

  What it does
    1. Terminal folder for the whole PC:  %ProgramData%\VisionAuto\Terminal
         settings.json           server address, terminal name, registration ID
         Open Vision Terminal.vbs, vision.ico, Registration.txt
       Everyone can read it; only administrators can change it.
    2. A personal settings folder for each Windows user, made the first time they
       open Vision Terminal:  %LOCALAPPDATA%\VisionAuto\Terminal
         user-settings.json      this user's font, colour and other display choices (future update)
         browser-profile\        that user's own Vision window (their sign-in stays theirs)
    3. A registration ID for this terminal (VT-XXXX-XXXX-XXXX), kept on re-install, registered
       with the shop server. Admin accounts (owners, managers) can use it once a manager approves
       it under System management > Device access; cashiers and other staff can use it straight away.
    4. A "Vision Terminal" icon on every user's desktop and in the Start menu.

  Options:  -Server http://192.168.1.20:3056   -Name "Front counter"   -Kiosk   -Uninstall   -Quiet
#>
[CmdletBinding()]
param([string]$Server, [string]$Name, [switch]$Kiosk, [switch]$Uninstall, [switch]$Quiet)
$ErrorActionPreference = 'Stop'

# Filled in by Vision when downloaded from Device access.
$DefaultServer = ''

$AppName  = 'Vision Terminal'
$Folder   = Join-Path $env:ProgramData 'VisionAuto\Terminal'
$Settings = Join-Path $Folder 'settings.json'
$Launcher = Join-Path $Folder 'Open Vision Terminal.vbs'
$IconFile = Join-Path $Folder 'vision.ico'
$RegKey   = 'HKLM:\SOFTWARE\VisionAuto\Terminal'
$Desktop  = [Environment]::GetFolderPath('CommonDesktopDirectory')
$Programs = [Environment]::GetFolderPath('CommonPrograms')
$Links    = @((Join-Path $Desktop "$AppName.lnk"), (Join-Path $Programs "$AppName.lnk"))

Add-Type -AssemblyName System.Windows.Forms
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Box($t, $icon = 'Information') { if (-not $Quiet) { [void][System.Windows.Forms.MessageBox]::Show($t, $AppName, 'OK', $icon) } }
function Ask($prompt, $default) {
  if ($Quiet) { return $default }
  Add-Type -AssemblyName Microsoft.VisualBasic
  return [Microsoft.VisualBasic.Interaction]::InputBox($prompt, $AppName, $default)
}

# ---------------------------------------------- administrator (all users) --
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  foreach ($p in $PSBoundParameters.GetEnumerator()) { if ($p.Value -is [switch]) { if ($p.Value) { $args2 += "-$($p.Key)" } } else { $args2 += "-$($p.Key)", "`"$($p.Value)`"" } }
  try { Start-Process powershell.exe -Verb RunAs -ArgumentList $args2 } catch { Box 'Vision Terminal needs administrator rights to set up this PC for all users.' 'Warning' }
  exit
}

# ------------------------------------------------------------- uninstall --
if ($Uninstall) {
  foreach ($l in $Links) { Remove-Item $l -Force -ErrorAction SilentlyContinue }
  Remove-Item $RegKey -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $Folder) { Remove-Item $Folder -Recurse -Force }
  Say 'Vision Terminal removed from this PC. (Each user''s personal folder %LOCALAPPDATA%\VisionAuto\Terminal is left alone.)' Green
  Box 'Vision Terminal was removed from this computer. A manager can also block it under Device access.'
  exit 0
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  # ------------------------------------------------- 1. terminal folder --
  $old = $null
  if (Test-Path $Settings) { try { $old = Get-Content $Settings -Raw | ConvertFrom-Json } catch { $old = $null } }
  New-Item -ItemType Directory -Force -Path $Folder | Out-Null
  # Everyone on this PC can read it (they all open Vision with it); only administrators can change it.
  & icacls $Folder /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null

  # ------------------------------------------------------ server address --
  if (-not $Server) { $Server = $(if ($old -and $old.server) { $old.server } else { $DefaultServer }) }
  $Server = Ask "Address of the shop server (from the main PC), for example http://192.168.1.20:3056" $Server
  if (-not $Server) { throw 'No server address given.' }
  $Server = $Server.Trim().TrimEnd('/')
  if ($Server -notmatch '^https?://') { $Server = 'http://' + $Server }
  Say "Checking $Server ..." Cyan
  try { [void](Invoke-RestMethod -Uri "$Server/api/health" -TimeoutSec 8 -UseBasicParsing) } catch { throw "Cannot reach the shop server at $Server. Is the main PC on, and is this PC on the shop network?" }

  # ---------------------------------------------------- 3. registration --
  if (-not $Name) { $Name = $(if ($old -and $old.name) { $old.name } else { $env:COMPUTERNAME }) }
  $Name = Ask 'Name for this terminal (for example Front counter till)' $Name
  if (-not $Name) { $Name = $env:COMPUTERNAME }
  $regId = $(if ($old -and $old.reg_id) { $old.reg_id } else { $null })
  $token = $(if ($old -and $old.token) { $old.token } else { $null })
  if (-not $regId) {
    $abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $b = New-Object byte[] 12; $rng.GetBytes($b)
    $s = -join ($b | ForEach-Object { $abc[$_ % $abc.Length] })
    $regId = 'VT-' + $s.Substring(0, 4) + '-' + $s.Substring(4, 4) + '-' + $s.Substring(8, 4)
  }
  $body = @{ reg_id = $regId; token = $token; name = $Name; hostname = $env:COMPUTERNAME; os_user = 'all users' } | ConvertTo-Json
  try { $r = Invoke-RestMethod -Uri "$Server/api/device/register" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 15 -UseBasicParsing }
  catch {
    $msg = $_.ErrorDetails.Message; try { $msg = ($msg | ConvertFrom-Json).error } catch {}
    throw "The server refused the registration: $msg"
  }
  $token = $r.token
  $cfg = [ordered]@{ server = $Server; name = $Name; reg_id = $regId; device_code = $r.code; token = $token; kiosk = [bool]$Kiosk; installed = (Get-Date).ToString('s'); computer = $env:COMPUTERNAME; for_users = 'all' }
  ($cfg | ConvertTo-Json) | Set-Content -Path $Settings -Encoding UTF8
  New-Item -Path $RegKey -Force | Out-Null
  Set-ItemProperty -Path $RegKey -Name RegistrationId -Value $regId
  Set-ItemProperty -Path $RegKey -Name Server -Value $Server
  Set-ItemProperty -Path $RegKey -Name TerminalFolder -Value $Folder
  Set-ItemProperty -Path $RegKey -Name UserSettingsFolder -Value '%LOCALAPPDATA%\VisionAuto\Terminal'
  @"
Vision Terminal registration
----------------------------
Terminal name      : $Name
Registration ID    : $regId
Device code        : $($r.code)
Server             : $Server
Computer           : $env:COMPUTERNAME (all users)
Installed          : $(Get-Date)

Admin accounts (owners, managers) can use this terminal once a manager approves it in
Vision: System management > Device access (type the registration ID or the device code).
Cashiers and other staff can use it straight away.

Personal settings for each user live in %LOCALAPPDATA%\VisionAuto\Terminal (future update).
"@ | Set-Content -Path (Join-Path $Folder 'Registration.txt') -Encoding UTF8

  # ------------------------------------------------- 4. launcher + icon --
  $browser = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  try { Invoke-WebRequest -Uri "$Server/favicon.ico" -OutFile $IconFile -TimeoutSec 8 -UseBasicParsing } catch {}
  $claim = "$Server/api/device/claim?reg=$regId&t=$token"
  $mode = $(if ($Kiosk) { '--kiosk' } else { '--start-maximized' })
  $browserVbs = $(if ($browser) { $browser } else { '' })
  # The launcher runs as whichever user clicks the icon: it makes that user's personal
  # folder the first time, then opens Vision in that user's own browser profile.
  $vbs = @"
' Vision Terminal launcher (made by Install-Vision-Terminal.ps1). Opens Vision on the shop server.
Option Explicit
Dim sh, fso, http, ok, tries, base, userDir, prof, us, browser, q
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
base = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\VisionAuto"
userDir = base & "\Terminal"
prof = userDir & "\browser-profile"
If Not fso.FolderExists(base) Then fso.CreateFolder base
If Not fso.FolderExists(userDir) Then fso.CreateFolder userDir
If Not fso.FolderExists(prof) Then fso.CreateFolder prof
If Not fso.FileExists(userDir & "\user-settings.json") Then
  Set us = fso.CreateTextFile(userDir & "\user-settings.json", True)
  us.WriteLine "{"
  us.WriteLine "  " & q & "version" & q & ": 1,"
  us.WriteLine "  " & q & "user" & q & ": " & q & Replace(sh.ExpandEnvironmentStrings("%USERDOMAIN%\%USERNAME%"), "\", "\\") & q & ","
  us.WriteLine "  " & q & "terminal" & q & ": " & q & "$regId" & q & ","
  us.WriteLine "  " & q & "settings" & q & ": { " & q & "font" & q & ": null, " & q & "fontSize" & q & ": null, " & q & "colorTheme" & q & ": null },"
  us.WriteLine "  " & q & "note" & q & ": " & q & "This user's own look and feel on this terminal (font, text size, colours and more). Used by a future Vision update. Device approval is for the terminal, not the user." & q
  us.WriteLine "}"
  us.Close
End If
ok = False
For tries = 1 To 2
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 3000, 3000, 4000, 4000
  http.Open "GET", "$Server/api/health", False
  http.Send
  If Err.Number = 0 Then ok = (http.Status = 200)
  On Error GoTo 0
  If ok Then Exit For
  If MsgBox("Cannot reach the shop server at $Server." & vbCrLf & vbCrLf & "Is the main PC switched on, and is this PC on the shop network?", vbRetryCancel + vbExclamation, "$AppName") = vbCancel Then WScript.Quit 1
Next
browser = "$browserVbs"
If browser <> "" And fso.FileExists(browser) Then
  sh.Run q & browser & q & " --app=" & q & "$claim" & q & " --user-data-dir=" & q & prof & q & " --no-first-run --no-default-browser-check $mode", 1, False
Else
  sh.Run q & "$claim" & q, 1, False
End If
"@
  [IO.File]::WriteAllText($Launcher, ($vbs -replace "`r?`n", "`r`n"), [Text.Encoding]::Unicode)

  $wsh = New-Object -ComObject WScript.Shell
  foreach ($l in $Links) {
    $lnk = $wsh.CreateShortcut($l)
    $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
    $lnk.Arguments = '"' + $Launcher + '"'
    $lnk.WorkingDirectory = $Folder
    $lnk.Description = "Open Vision on the shop server ($Server)"
    $lnk.IconLocation = $(if (Test-Path $IconFile) { "$IconFile,0" } elseif ($browser) { "$browser,0" } else { "$env:WINDIR\System32\shell32.dll,13" })
    $lnk.Save()
  }

  $state = $(if ($r.status -eq 'approved') { 'It is approved for admin accounts too.' } else { "Cashiers and other staff can use it now.`nFor owners and managers, approve it in Vision:`n  System management > Device access`n  (type the registration ID or the device code)." })
  Say "Done. Registration ID $regId, device code $($r.code)." Green
  Box ("Vision Terminal is set up on this computer for all users.`n`nTerminal:  $Name`nRegistration ID:  $regId`nDevice code:  $($r.code)`n`n$state`n`nOpen it with the ""$AppName"" icon on the desktop.")
} catch {
  Say ('Problem: ' + $_.Exception.Message) Red
  Box ('Vision Terminal could not be set up:' + "`n`n" + $_.Exception.Message) 'Error'
  exit 1
}
