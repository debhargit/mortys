' ===========================================================================
'  Connect To Shop Server.vbs
'
'  Sets this computer up as a till by redeeming a one-time connection link
'  from the shop's main PC. No password is typed anywhere: the link is traded
'  for the database settings over the network, works once, and expires.
'
'  Get a link on the main PC:  Admin -> Setup -> Terminals & access
'                              -> "Create a connection link"
'
'  This replaces having to type the database address, name, user and password
'  into Morty's Auto Parts Settings.vbs by hand. That file still exists for fixing a
'  connection when no link is available.
' ===========================================================================

Option Explicit

Dim fso, sh, scriptDir, appDir, nodeExe, enrolJs, answer, link, cmd, exitCode, tmp, out

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
appDir    = fso.BuildPath(scriptDir, "app")
nodeExe   = fso.BuildPath(scriptDir, "runtime\node.exe")
enrolJs   = fso.BuildPath(appDir, "enrol.js")

If Not fso.FileExists(nodeExe) Then
    MsgBox "This portable copy is incomplete - runtime\node.exe is missing.", vbCritical, "Connect To Shop Server"
    WScript.Quit 1
End If
If Not fso.FileExists(enrolJs) Then
    MsgBox "This portable copy is incomplete - app\enrol.js is missing." & vbCrLf & vbCrLf & _
           "It may have been built before connection links existed. Rebuild the package, " & _
           "or use ""Morty's Auto Parts Settings.vbs"" to enter the database details by hand.", _
           vbCritical, "Connect To Shop Server"
    WScript.Quit 1
End If

' --- Warn if this copy carries its own database ----------------------------
' A standalone copy has no business being pointed at another machine: it would
' abandon its own records and confuse whoever went looking for them later.
If fso.FolderExists(fso.BuildPath(scriptDir, "runtime\pgsql")) Then
    If MsgBox("This copy carries its OWN database (runtime\pgsql exists)." & vbCrLf & vbCrLf & _
              "Connecting it to another computer's database means the records " & _
              "already stored here will no longer be used." & vbCrLf & vbCrLf & _
              "Continue anyway?", vbExclamation + vbYesNo + vbDefaultButton2, _
              "Connect To Shop Server") <> vbYes Then WScript.Quit 0
End If

' --- Ask for the link ------------------------------------------------------
link = Trim(InputBox( _
    "Paste the connection link from the shop's main PC." & vbCrLf & vbCrLf & _
    "It looks like:" & vbCrLf & _
    "    http://192.168.1.20:3057/join#ABCD-EFGH-JKLM-NPQR-STUV" & vbCrLf & vbCrLf & _
    "Get one on the main PC under" & vbCrLf & _
    "    Admin -> Setup -> Terminals & access -> Create a connection link" & vbCrLf & vbCrLf & _
    "The link works once and expires, so it is safe to send by message." & vbCrLf & vbCrLf & _
    "Leave blank / press Cancel to abandon.", "Connect To Shop Server", ""))

If link = "" Then WScript.Quit 0

' --- Redeem ----------------------------------------------------------------
' Run through cmd so the output can be captured into a file and shown in a
' message box -- the whole point of this package is that no console appears.
tmp = fso.BuildPath(sh.ExpandEnvironmentStrings("%TEMP%"), "mh-enrol-" & CStr(Int(Rnd * 100000)) & ".txt")
cmd = "cmd /c """"" & nodeExe & """ """ & enrolJs & """ """ & link & """ > """ & tmp & """ 2>&1"""
exitCode = sh.Run(cmd, 0, True)

out = ""
If fso.FileExists(tmp) Then
    On Error Resume Next
    Dim ts
    Set ts = fso.OpenTextFile(tmp, 1)
    If Err.Number = 0 Then
        out = ts.ReadAll
        ts.Close
    End If
    On Error GoTo 0
    fso.DeleteFile tmp, True
End If

If exitCode = 0 Then
    MsgBox "Connected." & vbCrLf & vbCrLf & out & vbCrLf & _
           "Now start it with ""Morty's Auto Parts Admin.exe"".", vbInformation, "Connect To Shop Server"
Else
    MsgBox "Could not connect." & vbCrLf & vbCrLf & out & vbCrLf & _
           "Common causes:" & vbCrLf & _
           "  - the link has already been used, or has expired" & vbCrLf & _
           "  - the main PC is switched off, or on a different network" & vbCrLf & _
           "  - a firewall is blocking it (run ""Allow Network Access.vbs"" on the main PC)" & vbCrLf & vbCrLf & _
           "Ask for a fresh link and try again.", vbExclamation, "Connect To Shop Server"
End If

WScript.Quit 0
