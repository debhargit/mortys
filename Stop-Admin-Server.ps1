<#
================================================================================
  Stop-Admin-Server.ps1  ->  "Stop Morty's Auto Parts Admin.exe"

  Double-click equivalent of "Stop Morty's Auto Parts Admin.vbs": the server
  runs with no window, so this is how it gets shut down. Also stops the bundled
  PostgreSQL if this build shipped with one. All the real work is boot.js --stop;
  this is just a windowless, confirm-first wrapper.

  Compiled to the .exe by Build-Installers.ps1 (ps2exe, noConsole). Kept as a
  .ps1 so the .exe is reproducible -- the earlier hand-built one had no source.
================================================================================
#>

$ErrorActionPreference = 'Stop'

# ps2exe runs from a temp dir, so anchor on the compiled exe's own location,
# falling back to the script path when run as .ps1.
$root = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath }
        elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
        else { (Get-Location).Path }

$node  = Join-Path $root 'runtime\node.exe'
$boot  = Join-Path $root 'app\boot.js'

Add-Type -AssemblyName System.Windows.Forms | Out-Null
function Box($text, $title, $buttons, $icon) {
  [System.Windows.Forms.MessageBox]::Show($text, $title, $buttons, $icon)
}

if (-not (Test-Path $node) -or -not (Test-Path $boot)) {
  Box 'runtime\node.exe or app\boot.js is missing - nothing to stop.' `
      'Morty''s Auto Parts Admin' 'OK' 'Error' | Out-Null
  exit 1
}

# A till mid-sale is what this is most likely to hurt, and whoever clicks Stop
# can't see who else on the LAN is on the admin panel right now -- so confirm.
$answer = Box ("Stop the Morty's Auto Parts admin server?`r`n`r`n" +
               "Anyone else on the network using the admin panel or POS on " +
               "this machine will be disconnected immediately.") `
              'Morty''s Auto Parts Admin' 'YesNo' 'Question'
if ($answer -ne 'Yes') { exit 0 }

& $node $boot --stop | Out-Null

Box 'Morty''s Auto Parts admin server stopped.' `
    'Morty''s Auto Parts Admin' 'OK' 'Information' | Out-Null
exit 0
