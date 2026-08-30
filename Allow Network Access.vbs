' ===========================================================================
'  Meltha Honda Admin — open the Windows Firewall for the shop LAN
'
'  Run this ONCE, on the computer that hosts the admin server, if the other
'  computers on the network can't reach http://<this-pc>:3040/admin.html even
'  though it works fine in a browser on this machine itself. That symptom is
'  almost always Windows Firewall silently dropping the inbound connection.
'
'  Adds two inbound rules, scoped to private/domain networks only — never to
'  a public network, so plugging this laptop into airport wifi doesn't expose
'  the shop's admin panel:
'     TCP <app port>   the admin panel and API
'     UDP 41235        the LAN discovery announce/reply the app already uses
'                      so a second machine can find this one without typing
'                      its IP address
'
'  A UAC prompt is unavoidable here — changing the firewall requires it. This
'  is the only part of the portable install that ever asks for admin rights,
'  and nothing about the running server needs them.
' ===========================================================================
Option Explicit

Dim fso, sh, scriptDir, port, cmdLine, answer

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

If LCase(fso.GetFileName(WScript.FullName)) = "cscript.exe" Then
    sh.Run "wscript.exe //nologo """ & WScript.ScriptFullName & """", 0, False
    WScript.Quit 0
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
port = ReadPort(scriptDir)

answer = MsgBox("Allow other computers on this network to reach the Meltha Honda " & _
                "admin server?" & vbCrLf & vbCrLf & _
                "This adds Windows Firewall rules for:" & vbCrLf & _
                "    TCP port " & port & "  (admin panel)" & vbCrLf & _
                "    UDP port 41235  (finding this machine on the LAN)" & vbCrLf & vbCrLf & _
                "Private and domain networks only - not public wifi." & vbCrLf & vbCrLf & _
                "Windows will ask for administrator permission.", _
                vbQuestion + vbYesNo, "Meltha Honda Admin")
If answer <> vbYes Then WScript.Quit 0

' Delete-then-add so re-running after a port change replaces the old rule
' instead of leaving a stale hole open on the previous port. The deletes are
' expected to fail on a first run; that's why they're chained with & and not
' checked.
cmdLine = "netsh advfirewall firewall delete rule name=""Meltha Honda Admin"" & " & _
          "netsh advfirewall firewall delete rule name=""Meltha Honda Discovery"" & " & _
          "netsh advfirewall firewall add rule name=""Meltha Honda Admin"" " & _
          "dir=in action=allow protocol=TCP localport=" & port & " profile=private,domain & " & _
          "netsh advfirewall firewall add rule name=""Meltha Honda Discovery"" " & _
          "dir=in action=allow protocol=UDP localport=41235 profile=private,domain"

' ShellExecute with the "runas" verb is what raises the UAC prompt; the final
' 0 keeps the elevated console hidden, so even this admin step never shows a
' terminal.
On Error Resume Next
CreateObject("Shell.Application").ShellExecute "cmd.exe", "/c " & cmdLine, "", "runas", 0
If Err.Number <> 0 Then
    MsgBox "Could not change the firewall - permission was refused." & vbCrLf & vbCrLf & _
           "You can add the rules by hand from an Administrator command prompt:" & vbCrLf & vbCrLf & _
           "netsh advfirewall firewall add rule name=""Meltha Honda Admin"" dir=in " & _
           "action=allow protocol=TCP localport=" & port & " profile=private,domain", _
           vbExclamation, "Meltha Honda Admin"
    WScript.Quit 1
End If
On Error GoTo 0

WScript.Sleep 2500
MsgBox "Firewall rules added." & vbCrLf & vbCrLf & _
        "Other computers on this network can now open:" & vbCrLf & _
        "    http://" & sh.ExpandEnvironmentStrings("%COMPUTERNAME%") & ":" & port & "/admin.html", _
        vbInformation, "Meltha Honda Admin"
WScript.Quit 0

' ===========================================================================
Function ReadPort(dir)
    Dim p
    p = ReadJsonNumber(fso.BuildPath(dir, "app\server-config.json"), "port")
    If p = 0 Then p = ReadJsonNumber(fso.BuildPath(dir, "app\portable.json"), "appPort")
    If p = 0 Then p = 3040
    ReadPort = p
End Function

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
