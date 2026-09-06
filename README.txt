===============================================================================
  MORTY'S AUTO PARTS  --  PORTABLE ADMIN
===============================================================================

  Everything needed to run the admin panel and POS is inside this folder.
  Nothing has to be installed on the computer: no Node.js, no npm install,
  no setup wizard. Copy the whole folder anywhere -- a USB stick, another
  PC on the shop network, a shared drive -- and run it from there.

  Nothing ever opens a black terminal window. The server runs completely
  hidden. The only windows you will see are your browser and the occasional
  message box.


-------------------------------------------------------------------------------
  WHICH COPY IS THIS?
-------------------------------------------------------------------------------

  There are two kinds of this folder. Check whether  runtime\pgsql  exists.

  runtime\pgsql EXISTS  ->  STANDALONE
        Carries its own PostgreSQL database. Needs nothing else on the
        network at all. Everything it records lives on this one computer,
        in data\pgdata. Use this for the shop's main PC, or for a single
        machine that is the whole system.

  runtime\pgsql MISSING  ->  NETWORK CLIENT
        Uses the database on another computer, so it shares the same stock,
        sales and customers as everyone else. On its very first run it
        searches the network for the main PC automatically and remembers
        what it finds. If nothing answers, run Morty's Auto Parts Settings.vbs
        and type the main PC's IP address.

  Both kinds run the full admin panel and POS. The only difference is where
  the records are kept.


-------------------------------------------------------------------------------
  32-BIT AND 64-BIT WINDOWS
-------------------------------------------------------------------------------

  The network client is built 32-bit, which runs on 32-bit AND 64-bit
  Windows -- so the same folder works on any PC in the shop, including old
  ones.

  The standalone copy is 64-bit only. That is not a choice: PostgreSQL has
  not been released for 32-bit Windows since version 10, so a copy that
  carries its own database cannot be 32-bit. On a 32-bit machine, use the
  network client and keep the database on a 64-bit PC.

  If you ever see "not a valid Win32 application", a 64-bit copy has been
  put on a 32-bit machine. Use the client build instead.


-------------------------------------------------------------------------------
  STARTING IT
-------------------------------------------------------------------------------

  Double-click:            Morty's Auto Parts Admin.exe

  It starts the server if it isn't already running, waits for it to be
  ready, then opens the admin panel in your browser. Double-clicking it
  again later just opens the panel -- it will not start a second copy.

  (There is also a Morty's Auto Parts Admin.vbs that does exactly the same job.
  It is a fallback for machines that block .exe files; use the .exe unless
  you have a reason not to.)

  First run can take up to a minute (the database schema has to be created).
  Later runs take a few seconds.

  Default sign-in, created automatically the first time the database is set
  up:

        Email     admin@mortysautoparts.com
        Password  password123

  ** Change that password immediately from Admin -> Staff. **
  It is public knowledge -- it is written in the source code.


-------------------------------------------------------------------------------
  STOPPING IT
-------------------------------------------------------------------------------

  Double-click:            Stop Morty's Auto Parts Admin.exe

  Because the server has no window, this is the only way to shut it down
  short of restarting Windows. Closing the browser does NOT stop it -- the
  server keeps running so other computers can keep using it.


-------------------------------------------------------------------------------
  USING IT FROM OTHER COMPUTERS ON THE NETWORK
-------------------------------------------------------------------------------

  While it is running on one PC, every other computer, tablet or phone on
  the same network can use it with just a browser -- they do not need a copy
  of this folder:

        http://<the-ip-of-that-pc>:3057/admin.html

  To find that IP: press Windows+R, type  cmd  , press Enter, type
  ipconfig, and look for "IPv4 Address" (something like 192.168.1.20).

  If other computers cannot connect but the browser on the host PC can,
  Windows Firewall is blocking it. On the host PC, run once:

        Allow Network Access.vbs

  It asks for administrator permission (Windows requires that to change
  firewall rules) and opens only the two ports needed, and only on private
  and domain networks -- never on public wifi.


-------------------------------------------------------------------------------
  POINTING IT AT A DIFFERENT DATABASE
-------------------------------------------------------------------------------

  Double-click:            Morty's Auto Parts Settings.vbs

  Use this when the admin panel will not load, or shows no data, because the
  database address is wrong. It asks for the database server address, port,
  name, user and password, plus the port the admin server should listen on.

  Normally you would change these from Admin -> Setup inside the panel
  instead -- that screen checks the connection before saving. But Setup is
  behind the login, and the login needs a working database, so if the
  database address is wrong you cannot get to the screen that fixes it.
  That is what this file is for.

  Two common setups:

    All on one PC          Database server address:  localhost
    (this copy has its
     own database)

    Shop network with a    Database server address:  the IP of the main PC,
    main PC holding the                              e.g. 192.168.1.20
    real database


-------------------------------------------------------------------------------
  STARTING AUTOMATICALLY WITH WINDOWS
-------------------------------------------------------------------------------

  Double-click:            Start With Windows.vbs

  Turns it on; run it again to turn it off. At login the server starts
  hidden and does NOT open a browser. Useful on the shop's main PC so the
  tills can reach it without anyone having to remember to start it.

  This is a per-user shortcut, not a Windows service: it starts when that
  Windows user signs in, not when the machine powers on to the lock screen.


-------------------------------------------------------------------------------
  LOADING YOUR STOCK FROM A SPREADSHEET
-------------------------------------------------------------------------------

  The catalogue starts empty. To fill it:

        Admin panel  ->  Inventory  ->  📥 Import inventory

  Pick a .csv, .tsv or Excel .xlsx file. Nothing is written straight away:
  you get a preview first showing how many parts would be added, how many
  updated, which of your columns were matched to which field, and any rows
  that need a look. Only when you press Import does anything change.

  You do not have to reformat your file. The stock listing exported from the
  parts system works as-is -- the title rows above the real header are
  skipped automatically, and columns called Item, Description, Bin 1, Bin 2
  and Quantity are recognised. So are the usual alternatives: Part No, SKU,
  Qty, On Hand, Price, Cost, Category, Location. Press "📄 Template" for a
  known-good example file.

  Things worth knowing:

    Parts are matched by part number.
        Importing the same file twice updates the existing parts instead of
        creating duplicates. This is how you post a new stock count: export
        again, import again.

    Prices you typed in are never wiped by a file that has no prices.
        The stock listing carries no pricing. Importing it updates
        quantities and bin locations and leaves your prices alone. A file
        that DOES have a price column will set prices for the parts in it.

    Quantities in the file win.
        The file is treated as the current count for the parts it contains.
        A missing or unreadable quantity is read as 0, never as a guess.

    "Treat this file as the complete stock list" is off by default.
        Turning it on hides every part NOT in the file from the shop and the
        POS. Use it for a full stocktake; leave it off when loading part of
        your stock. It asks for confirmation, and it hides rather than
        deletes, so sales history stays intact.

    If anything goes wrong mid-import, nothing is changed.
        The whole file is written in one transaction. A 23,000-line listing
        takes about half a minute.

    Old .xls files are not readable.
        Open in Excel, File -> Save As, choose .xlsx or .csv.


-------------------------------------------------------------------------------
  WHEN SOMETHING GOES WRONG
-------------------------------------------------------------------------------

  There is no console to read, so everything is written to log files:

        data\logs\boot.log        starting, stopping, database creation
        data\logs\server.log      the server's own output, and any crash
        data\logs\postgres.log    only if this copy carries its own database

  Open them with Notepad. The newest lines are at the bottom.

  "The admin server did not finish starting"
        Almost always the database. Check boot.log, then run
        Morty's Auto Parts Settings.vbs and confirm the address.

  The page loads but everything is empty
        The server is up but its database is not. Same fix as above.

  It was working, now the browser says it cannot connect
        The server may have stopped. Run Morty's Auto Parts Admin.vbs again.
        If it keeps happening, server.log will say why -- the supervisor
        restarts the server automatically after a crash and logs each one.


-------------------------------------------------------------------------------
  THINGS WORTH KNOWING
-------------------------------------------------------------------------------

  Photos are stored per-machine.
        A photo uploaded through an inquiry is saved in app\uploads on the
        machine that received the upload. Other machines on the network read
        the same database, so they will see that the photo exists, but the
        image itself only lives on the one PC. Keep uploads on one machine,
        or point everyone's browser at a single host PC rather than running
        a copy of this folder on each till.

  This folder holds the database password in plain text.
        app\.env and app\db-config.json both contain it, exactly as the
        original installation always has. Treat the folder as sensitive:
        anyone who can copy it can reach the database. That is also why the
        server refuses to serve those files over the network even though
        they sit in the folder it serves from.

  The connection is plain HTTP, not HTTPS.
        Fine on a shop LAN, which is what this is for. Do not port-forward
        it to the internet -- passwords would cross the internet in the
        clear. For public access use the Cloudflare tunnel setup instead.

  Rebuilding replaces app\ and runtime\ but never data\.
        If this copy carries its own database, that database survives a
        rebuild. Back up data\pgdata before doing anything drastic to it.

  Keep the folder somewhere SHORT, like  C:\MortysAutoParts
        Some of the product photos have file names over 200 characters long.
        Windows still refuses to handle a full path longer than 260, so if
        you put this folder somewhere deep -- inside Documents, inside
        OneDrive, inside a dated subfolder -- Windows Explorer will copy most
        of it and quietly skip those photos. The build prints how much room
        is left. C:\MortysAutoParts or D:\MortysAutoParts is always safe.

  If this copy carries its own database (runtime\pgsql exists)
        It runs a private PostgreSQL on port 5433, reachable only from this
        computer, started and stopped along with the admin server. Its data
        lives in data\pgdata. Nothing else on the network shares it -- if you
        want several machines working from the same records, one machine
        should hold the database and the rest should be pointed at its IP
        address with Morty's Auto Parts Settings.vbs.

===============================================================================
