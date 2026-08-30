' ===========================================================================
'  Meltha Honda Admin — portable launcher
'
'  Double-click this file. It will:
'     1. make sure it is running under wscript (no console window)
'     2. start the admin server hidden, if it isn't already running
'     3. wait until the server answers /api/health
'     4. open the admin panel in the default browser
'
'  Nothing here is ever visible except the browser window. The only reason
'  this file is VBScript at all is that VBScript is the one thing on a stock
'  Windows box that can launch a console program with the window genuinely
'  hidden (Run style 0) rather than minimised or flashed. All the real logic
'  lives in app\boot.js.
' ===========================================================================
Option Explicit

Dim fso, sh, scriptDir, nodeExe, bootJs, port, url, i, ready

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' --- Force wscript ---------------------------------------------------------
' If .vbs is associated with cscript.exe on this machine (some hardened or
' developer setups do this), double-clicking would pop a console window --
' exactly what we're here to avoid. Relaunch ourselves under wscript and quit.
If LCase(fso.GetFileName(WScript.FullName)) = "cscript.exe" Then
    sh.Run "wscript.exe //nologo """ & WScript.ScriptFullName & """", 0, False
    WScript.Quit 0
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe   = fso.BuildPath(scriptDir, "runtime\node.exe")
bootJs    = fso.BuildPath(scriptDir, "app\boot.js")

If Not fso.FileExists(nodeExe) Then
    MsgBox "This portable copy is incomplete - runtime\node.exe is missing." & vbCrLf & vbCrLf & _
           "Copy the whole Meltha Honda Admin folder again, don't copy files out of it one at a time.", _
           vbCritical, "Meltha Honda Admin"
    WScript.Quit 1
End If
If Not fso.FileExists(bootJs) Then
    MsgBox "This portable copy is incomplete - app\boot.js is missing.", vbCritical, "Meltha Honda Admin"
    WScript.Quit 1
End If

port = ReadPort(scriptDir)
url  = "http://localhost:" & port & "/admin.html"

' --- Already up? Just open the panel ---------------------------------------
If ServerAnswers(port, 1500) Then
    OpenBrowser url
    WScript.Quit 0
End If

' --- Start hidden ----------------------------------------------------------
' Window style 0 = SW_HIDE. node.exe is a console program, so Windows still
' creates a console for it, but creates it hidden — there is no window to see
' and nothing appears in the taskbar.
sh.Run """" & nodeExe & """ """ & bootJs & """", 0, False

' --- Wait for readiness ----------------------------------------------------
' Up to ~75s. A first run with a bundled Postgres has to initdb and apply
' schema.sql before the port opens, which is by far the slowest case.
ready = False
For i = 1 To 75
    WScript.Sleep 1000
    If ServerAnswers(port, 1500) Then
        ready = True
        Exit For
    End If
Next

If ready Then
    OpenBrowser url
Else
    MsgBox "The Meltha Honda admin server did not finish starting." & vbCrLf & vbCrLf & _
           "Check the log:" & vbCrLf & _
           fso.BuildPath(scriptDir, "data\logs\boot.log") & vbCrLf & _
           fso.BuildPath(scriptDir, "data\logs\server.log") & vbCrLf & vbCrLf & _
           "Most common cause: the database it is pointed at is not reachable. " & _
           "Run ""Meltha Honda Settings.vbs"" to change the database address.", _
           vbExclamation, "Meltha Honda Admin"
End If

WScript.Quit 0

' ===========================================================================
'  Helpers
' ===========================================================================

' Shell.Application.ShellExecute is the documented way to hand a URL to
' whatever the user's default browser is. WshShell.Run happens to work for
' URLs too, but it is really a CreateProcess wrapper and its URL handling is
' incidental rather than promised -- so try the documented call first and keep
' Run as the fallback. If both fail, say so with the address, because the
' server is up at that point and typing the URL by hand is a real workaround.
Sub OpenBrowser(u)
    Dim ok
    ok = False
    On Error Resume Next
    CreateObject("Shell.Application").ShellExecute u, "", "", "open", 1
    If Err.Number = 0 Then ok = True
    Err.Clear
    If Not ok Then
        sh.Run u, 1, False
        If Err.Number = 0 Then ok = True
        Err.Clear
    End If
    On Error GoTo 0
    If Not ok Then
        MsgBox "The admin server is running, but the browser could not be " & _
               "opened automatically." & vbCrLf & vbCrLf & _
               "Open this address by hand:" & vbCrLf & u, _
               vbExclamation, "Meltha Honda Admin"
    End If
End Sub

' Port precedence matches the server's own: server-config.json (written by
' Admin -> Setup -> Server connection) wins over the build-time default in
' portable.json, because that's the file the operator can actually change.
Function ReadPort(dir)
    Dim p
    p = ReadJsonNumber(fso.BuildPath(dir, "app\server-config.json"), "port")
    If p = 0 Then p = ReadJsonNumber(fso.BuildPath(dir, "app\portable.json"), "appPort")
    If p = 0 Then p = 3040
    ReadPort = p
End Function

' Deliberately not a real JSON parser — these two files are written by our own
' code and only ever hold flat scalars, so a scan for "key": <digits> is both
' sufficient and impossible to get wrong in a way that matters.
Function ReadJsonNumber(file, key)
    Dim ts, txt, needle, pos, ch, num
    ReadJsonNumber = 0
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
    pos = InStr(pos, txt, ":")
    If pos = 0 Then Exit Function
    pos = pos + 1

    num = ""
    Do While pos <= Len(txt)
        ch = Mid(txt, pos, 1)
        If ch >= "0" And ch <= "9" Then
            num = num & ch
        ElseIf num <> "" Then
            Exit Do
        ElseIf ch <> " " And ch <> vbTab Then
            Exit Do
        End If
        pos = pos + 1
    Loop
    If num <> "" Then ReadJsonNumber = CLng(num)
End Function

' True when something on this machine answers the health endpoint. Wrapped in
' On Error Resume Next because a closed port raises, and a raise here would
' otherwise put a script error dialog on screen during the normal startup wait.
Function ServerAnswers(p, timeoutMs)
    Dim httpReq
    ServerAnswers = False
    On Error Resume Next
    Set httpReq = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    If Err.Number <> 0 Then
        Err.Clear
        Set httpReq = CreateObject("MSXML2.XMLHTTP")
        If Err.Number <> 0 Then Err.Clear : Exit Function
    End If
    ' resolve, connect, send, receive
    httpReq.setTimeouts timeoutMs, timeoutMs, timeoutMs, timeoutMs
    Err.Clear
    httpReq.open "GET", "http://127.0.0.1:" & p & "/api/health", False
    httpReq.send
    If Err.Number = 0 Then
        If httpReq.status = 200 Then ServerAnswers = True
    End If
    Err.Clear
    On Error GoTo 0
End Function
