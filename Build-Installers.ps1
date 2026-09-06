<#
================================================================================
  Build-Installers.ps1  --  compile the migration scripts into .exe files

  Turns
        Make-Migration-Package.ps1  ->  Make Migration Package.exe
        Restore-On-New-PC.ps1       ->  Restore On New PC.exe
        Stop-Admin-Server.ps1       ->  Stop Morty's Auto Parts Admin.exe

  so they can be double-clicked like the other tools in this folder, with no
  "Run with PowerShell" and no execution-policy prompt.

  Uses ps2exe (PowerShell Gallery). It compiles with the .NET Framework C#
  compiler that ships in Windows -- no Visual Studio, no dotnet SDK. The
  result is the same kind of small .NET exe as Morty's Auto Parts Service.exe.

  Run once on a machine with internet:

      powershell -ExecutionPolicy Bypass -File .\Build-Installers.ps1

  The .exe files it makes are self-contained and run on any Windows 10/11
  offline. Re-run this only when you change the .ps1 scripts.
================================================================================
#>

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

# --- ps2exe present? ---------------------------------------------------------
if (-not (Get-Module -ListAvailable ps2exe)) {
  Write-Host 'Installing ps2exe from PowerShell Gallery...' -ForegroundColor Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  try { Get-PackageProvider -Name NuGet -ForceBootstrap -ErrorAction Stop | Out-Null } catch {}
  Install-Module ps2exe -Scope CurrentUser -Force -AllowClobber -Repository PSGallery
}
Import-Module ps2exe

$common = @{
  noConsole    = $true          # no PowerShell window -- ever. The scripts talk
                                # through a small status box and one final dialog.
  company      = 'Morty''s Auto Parts'
  version      = '1.0.0.0'
}

# Admin = $true adds the manifest so Windows shows one clean UAC prompt at
# launch. The migration tools touch the service and pgdata and need it; the
# stop tool only signals boot.js and does not.
$targets = @(
  @{ In = 'Make-Migration-Package.ps1'; Out = 'Make Migration Package.exe'; Admin = $true;
     Title = 'Morty''s Auto Parts -- Make Migration Package';
     Desc  = 'Copy this till, database and all, to a drive for another PC' }
  @{ In = 'Restore-On-New-PC.ps1';      Out = 'Restore On New PC.exe';      Admin = $true;
     Title = 'Morty''s Auto Parts -- Restore On New PC';
     Desc  = 'Rebuild the till on this computer from a migration package' }
  @{ In = 'Stop-Admin-Server.ps1';      Out = 'Stop Morty''s Auto Parts Admin.exe'; Admin = $false;
     Title = 'Stop Morty''s Auto Parts Admin';
     Desc  = 'Shut down the windowless admin/POS server on this machine' }
)

foreach ($t in $targets) {
  $in  = Join-Path $here $t.In
  $out = Join-Path $here $t.Out
  if (-not (Test-Path $in)) { Write-Host "  skip: $($t.In) not found" -ForegroundColor Yellow; continue }
  Write-Host ""
  Write-Host "Compiling $($t.In)  ->  $($t.Out)" -ForegroundColor Cyan
  $opts = $common.Clone()
  if ($t.Admin) { $opts.requireAdmin = $true }
  Invoke-ps2exe -inputFile $in -outputFile $out -title $t.Title -product $t.Title -description $t.Desc @opts
  if (Test-Path $out) {
    Write-Host ("  ok  {0:N0} KB" -f ((Get-Item $out).Length / 1KB)) -ForegroundColor Green
  } else {
    Write-Host "  FAILED" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Done. The .exe files sit next to the .ps1 scripts." -ForegroundColor White
Write-Host "Keep both -- the .ps1 stays the source, the .exe is what you hand out." -ForegroundColor DarkGray
