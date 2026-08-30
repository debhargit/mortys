' ===========================================================================
'  Meltha Honda Admin — settings
'
'  Points this portable copy at a database and a port, without a terminal and
'  without needing to sign in first.
'
'  Why this exists at all: everything in Admin -> Setup is behind requireAdmin,
'  and requireAdmin needs a working database to check who you are. So if the
'  database address is wrong, the one screen that could fix the database
'  address is the one screen you can't reach. This script writes the same
'  files that Setup writes (app\db-config.json, app\server-config.json,
'  app\machine-config.json) from outside that loop.
'
'  Once the server can reach its database, prefer Admin -> Setup — it
'  validates connections before saving; this does not.
' ===========================================================================
Option Explicit

Dim fso, sh, scriptDir, appDir, nodeExe, bootJs
Dim dbHost, dbPort, dbName, dbUser, dbPass, appPort, machine
Dim answer, wasRunning

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

If LCase(fso.GetFileName(WScript.FullName)) = "cscript.exe" Then
    sh.Run "wscript.exe //nologo """ & WScript.ScriptFullName & """", 0, False
    WScript.Quit 0
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
appDir    = fso.BuildPath(scriptDir, "app")
nodeExe   = fso.BuildPath(scriptDir, "runtime\node.exe")
bootJs    = fso.BuildPath(appDir, "boot.js")

If Not fso.FolderExists(appDir) Then
    MsgBox "This portable copy is incomplete - the app folder is missing.", vbCritical, "Meltha Honda Settings"
    WScript.Quit 1
End If

' --- Current values --------------------------------------------------------
dbHost  = JsonStr(fso.BuildPath(appDir, "db-config.json"), "host")
dbPort  = JsonStr(fso.BuildPath(appDir, "db-config.json"), "port")
dbName  = JsonStr(fso.BuildPath(appDir, "db-config.json"), "database")
dbUser  = JsonStr(fso.BuildPath(appDir, "db-config.json"), "user")
dbPass  = JsonStr(fso.BuildPath(appDir, "db-config.json"), "password")
appPort = JsonStr(fso.BuildPath(appDir, "server-config.json"), "port")
machine = JsonStr(fso.BuildPath(appDir, "machine-config.json"), "name")

If dbHost  = "" Then dbHost  = JsonStr(fso.BuildPath(appDir, "portable.json"), "dbHost")
If dbPort  = "" Then dbPort  = "5432"
If dbName  = "" Then dbName  = "melthahonda"
If dbUser  = "" Then dbUser  = "postgres"
If appPort = "" Then appPort = "3040"
If dbHost  = "" Then dbHost  = "localhost"

' --- Prompt ----------------------------------------------------------------
dbHost = AskRequired("Database server address." & vbCrLf & vbCrLf & _
             "Use ""localhost"" if PostgreSQL runs on this same computer, " & _
             "otherwise the IP address of the shop's main computer (e.g. 192.168.1.20)." & vbCrLf & vbCrLf & _
             "Leave blank / press Cancel to abandon these changes.", dbHost)

dbPort = AskRequired("Database port (PostgreSQL default is 5432).", dbPort)

dbName = AskRequired("Database name.", dbName)

dbUser = AskRequired("Database user.", dbUser)

' Shown in clear text: InputBox has no password mode, and this value is stored
' unencrypted anyway (same as .env and db-config.json always have been).
' Anyone who can read this folder can already read the password, so masking it
' at the prompt would be theatre.
dbPass = AskRequired("Database password for user """ & dbUser & """." & vbCrLf & vbCrLf & _
             "(Stored in plain text in app\db-config.json, same as before.)", dbPass)

appPort = AskRequired("Port this admin server should listen on." & vbCrLf & vbCrLf & _
              "Other computers on the network reach it at http://<this-pc-ip>:<port>/admin.html", appPort)

machine = AskOptional("A name for this computer, shown in Admin -> Setup so you can " & _
              "tell the tills apart. Leave blank to use the Windows computer name.", machine)

' --- Confirm ---------------------------------------------------------------
answer = MsgBox("Save these settings?" & vbCrLf & vbCrLf & _
                "Database : " & dbUser & "@" & dbHost & ":" & dbPort & "/" & dbName & vbCrLf & _
                "Admin port : " & appPort & vbCrLf & _
                "Machine name : " & IIfStr(machine = "", "(Windows computer name)", machine) & vbCrLf & vbCrLf & _
                "The admin server will be restarted if it is running.", _
                vbQuestion + vbYesNo, "Meltha Honda Settings")
If answer <> vbYes Then WScript.Quit 0

' --- Write -----------------------------------------------------------------
WriteFile fso.BuildPath(appDir, "db-config.json"), _
    "{" & vbCrLf & _
    "  ""local"": {" & vbCrLf & _
    "    ""host"": """ & JsonEsc(dbHost) & """," & vbCrLf & _
    "    ""port"": " & CleanInt(dbPort, 5432) & "," & vbCrLf & _
    "    ""database"": """ & JsonEsc(dbName) & """," & vbCrLf & _
    "    ""user"": """ & JsonEsc(dbUser) & """," & vbCrLf & _
    "    ""password"": """ & JsonEsc(dbPass) & """" & vbCrLf & _
    "  }," & vbCrLf & _
    "  ""online"": null" & vbCrLf & _
    "}"

WriteFile fso.BuildPath(appDir, "server-config.json"), _
    "{" & vbCrLf & "  ""port"": " & CleanInt(appPort, 3040) & vbCrLf & "}"

WriteFile fso.BuildPath(appDir, "machine-config.json"), _
    "{" & vbCrLf & "  ""name"": """ & JsonEsc(machine) & """" & vbCrLf & "}"

' --- Restart if it was running ---------------------------------------------
wasRunning = fso.FileExists(fso.BuildPath(scriptDir, "data\admin.lock"))
If wasRunning And fso.FileExists(nodeExe) Then
    sh.Run """" & nodeExe & """ """ & bootJs & """ --stop", 0, True
    WScript.Sleep 1500
    sh.Run """" & nodeExe & """ """ & bootJs & """", 0, False
    MsgBox "Settings saved. The admin server is restarting." & vbCrLf & vbCrLf & _
           "Give it a few seconds, then open ""Meltha Honda Admin.vbs"".", _
           vbInformation, "Meltha Honda Settings"
Else
    MsgBox "Settings saved." & vbCrLf & vbCrLf & _
           "Open ""Meltha Honda Admin.vbs"" to start the admin server.", _
           vbInformation, "Meltha Honda Settings"
End If

WScript.Quit 0

' ===========================================================================
'  Helpers
' ===========================================================================

' VBScript's InputBox returns an empty string for Cancel AND for a blank
' answer -- there is no way to tell them apart (VB6's StrPtr trick does not
' exist here). For every field except the machine name, blank is not a
' meaningful answer anyway, so "" is treated as "cancel" and AskRequired
' aborts the script. AskOptional keeps blank as a real value.
Function AskRequired(prompt, currentValue)
    Dim v
    v = Trim(InputBox(prompt, "Meltha Honda Settings", currentValue))
    If v = "" Then
        WScript.Quit 0
    End If
    AskRequired = v
End Function

Function AskOptional(prompt, currentValue)
    AskOptional = Trim(InputBox(prompt, "Meltha Honda Settings", currentValue))
End Function

Function IIfStr(cond, a, b)
    If cond Then IIfStr = a Else IIfStr = b
End Function

Function CleanInt(s, fallback)
    Dim i, ch, num
    num = ""
    For i = 1 To Len(s)
        ch = Mid(s, i, 1)
        If ch >= "0" And ch <= "9" Then num = num & ch
    Next
    If num = "" Then CleanInt = fallback Else CleanInt = CLng(num)
End Function

' Enough JSON escaping for the values that actually turn up here: a Windows
' password can easily contain \ or ", and either one unescaped would produce a
' db-config.json that the server can't parse — which would look, confusingly,
' exactly like a wrong password.
Function JsonEsc(s)
    Dim t
    t = s
    t = Replace(t, "\", "\\")
    t = Replace(t, """", "\""")
    t = Replace(t, vbCr, "")
    t = Replace(t, vbLf, "")
    t = Replace(t, vbTab, " ")
    JsonEsc = t
End Function

Function JsonStr(file, key)
    Dim ts, txt, needle, pos, ch, out, inQuotes, esc
    JsonStr = ""
    If Not fso.FileExists(file) Then Exit Function
    On Error Resume Next
    Set ts = fso.OpenTextFile(file, 1)
    txt = ts.ReadAll
    ts.Close
    On Error GoTo 0
    If Len(txt) = 0 Then Exit Function

    needle = """" & key & """"
    pos = InStr(1, txt, needle, vbTextCompare)
    If pos = 0 Then Exit Function
    pos = InStr(pos + Len(needle), txt, ":")
    If pos = 0 Then Exit Function
    pos = pos + 1

    out = "" : inQuotes = False : esc = False
    Do While pos <= Len(txt)
        ch = Mid(txt, pos, 1)
        If Not inQuotes Then
            If ch = """" Then
                inQuotes = True
            ElseIf ch = "," Or ch = "}" Or ch = vbCr Or ch = vbLf Then
                Exit Do
            ElseIf ch <> " " And ch <> vbTab Then
                out = out & ch          ' bare number / null
            End If
        Else
            If esc Then
                If ch = "n" Then
                    out = out & vbLf
                ElseIf ch = "t" Then
                    out = out & vbTab
                Else
                    out = out & ch
                End If
                esc = False
            ElseIf ch = "\" Then
                esc = True
            ElseIf ch = """" Then
                Exit Do
            Else
                out = out & ch
            End If
        End If
        pos = pos + 1
    Loop
    If LCase(Trim(out)) = "null" Then out = ""
    JsonStr = Trim(out)
End Function

Sub WriteFile(path, contents)
    Dim ts
    Set ts = fso.CreateTextFile(path, True)
    ts.Write contents & vbCrLf
    ts.Close
End Sub
