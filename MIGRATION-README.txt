===============================================================================
  MOVING THIS TILL TO A NEW COMPUTER  --  data and all
===============================================================================

  For replacing the computer that holds the database (the "standalone" copy:
  runtime\pgsql exists, data\pgdata is the live database). The new PC will
  have a different IP address; that is handled for you.

  No terminal window opens at any step. You get a small "working" box and one
  message box at the end. That is the whole interface.

  Everything the app needs is inside the folder already:

        runtime\node.exe        the Node.js it runs on
        runtime\pgsql           its own PostgreSQL
        prereq\vc_redist.x64    the one Windows component PostgreSQL needs
        app\node_modules        every npm dependency, already installed

  Nothing is downloaded or "npm installed" on the new machine.


-------------------------------------------------------------------------------
  THE TWO TOOLS
-------------------------------------------------------------------------------

  Make Migration Package.exe   Run on the OLD PC. Builds the single migration
                               folder -- program files plus a live, consistent
                               copy of the database. It uses PostgreSQL's
                               online backup, so the till is NOT taken offline
                               while it runs. (If the online backup cannot be
                               taken it falls back to briefly stopping the
                               service, and says so.)

  Restore On New PC.exe        Run on the NEW PC, from inside the migration
                               folder. Sets this computer up as the till with
                               all the old machine's records, and points it at
                               this PC's own IP address.

  Each has a .ps1 of the same name beside it -- the source, and a fallback for
  machines that block .exe. Build-Installers.ps1 rebuilds the .exe files from
  the .ps1 (needs internet once, to fetch the ps2exe compiler).


-------------------------------------------------------------------------------
  STEP 1  --  on the OLD computer
-------------------------------------------------------------------------------

  Double-click   Make Migration Package.exe   and click Yes at the Windows
  permission prompt.

  Pick where to build the folder (a USB stick, an external drive, any folder
  -- keep the path short). It builds  <that place>\MortysAutoParts-Migration ,
  about 400 MB, and tells you when it is done. The till keeps serving the
  whole time.


-------------------------------------------------------------------------------
  STEP 2  --  on the NEW computer
-------------------------------------------------------------------------------

  Copy the  MortysAutoParts-Migration  folder onto the new PC's C: drive (so it
  becomes  C:\MortysAutoParts-Migration ), or just leave it on the USB stick.

  Open the folder. Double-click   Restore On New PC.exe   and click Yes at the
  permission prompt.

  When the "This computer is the till now" message appears, open the
  "Morty's Auto Parts Admin" desktop shortcut and sign in with the same email and
  password as the old machine.

  The new PC now starts the till automatically, hidden, every time it is
  switched on.


-------------------------------------------------------------------------------
  ABOUT THE DIFFERENT IP ADDRESS
-------------------------------------------------------------------------------

  Nothing to do. The bundled database only ever listens on localhost, so its
  address moving changes nothing. The one file that records "which PC is the
  till" (app\machine-config.json) is rewritten to the new PC's address by the
  restore tool, and again every time the service starts.

  If other computers on the network could reach the old till but not the new
  one, run  Allow Network Access.vbs  once on the new machine. Other PCs then
  use   http://<new-PC-IP>:3057/admin.html


-------------------------------------------------------------------------------
  IMPORTANT
-------------------------------------------------------------------------------

  * Do not run both machines as the till at once. Once the new PC is verified,
    switch the old one off for good -- two live databases diverge and cannot
    be merged.

  * app\.env and app\db-config.json hold the database password in plain text,
    exactly as they always have. The migration folder is as sensitive as this
    folder. Do not leave the USB stick lying around.

  * Keep paths short (C:\... , or the USB root). Some product-photo file names
    are over 200 characters; a deep path pushes them past Windows' 260-char
    limit and Explorer drops them silently. The tools use robocopy, which does
    not.

  * Re-running Restore On New PC.exe later replaces the program files and
    leaves C:\MortysAutoParts\data alone -- it will not overwrite records the new
    till has taken since the move.

  * Logs, if a step fails: C:\MortysAutoParts\data\logs (boot.log, server.log,
    postgres.log), plus the tool's own log under %TEMP%\MortysAutoParts.

===============================================================================
