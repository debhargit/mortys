' ===========================================================================
'  Morty's Auto Parts Admin — stop
'
'  Because the server runs with no window, there is nothing to close and no
'  Ctrl+C to press. This is how you shut it down. Also stops the bundled
'  PostgreSQL if this build shipped with one.
' ===========================================================================
Option Explicit

Dim fso, sh, scriptDir, nodeExe, bootJs, answer

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

If LCase(fso.GetFileName(WScript.FullName)) = "cscript.exe" Then
    sh.Run "wscript.exe //nologo """ & WScript.ScriptFullName & """", 0, False
    WScript.Quit 0
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe   = fso.BuildPath(scriptDir, "runtime\node.exe")
bootJs    = fso.BuildPath(scriptDir, "app\boot.js")

If Not fso.FileExists(nodeExe) Then
    MsgBox "runtime\node.exe is missing - nothing to stop.", vbCritical, "Morty's Auto Parts Admin"
    WScript.Quit 1
End If

' A till mid-sale is the thing most likely to be hurt by this, and the person
' clicking Stop can't see whether anyone else on the LAN is using the admin
' panel right now — so confirm rather than just killing it.
answer = MsgBox("Stop the Morty's Auto Parts admin server?" & vbCrLf & vbCrLf & _
                "Anyone else on the network using the admin panel or POS on this " & _
                "machine will be disconnected immediately.", _
                vbQuestion + vbYesNo + vbDefaultButton2, "Morty's Auto Parts Admin")
If answer <> vbYes Then WScript.Quit 0

' Run --stop and wait for it (True), so the message below is the truth rather
' than a guess. Style 0 keeps it invisible.
sh.Run """" & nodeExe & """ """ & bootJs & """ --stop", 0, True

MsgBox "Morty's Auto Parts admin server stopped.", vbInformation, "Morty's Auto Parts Admin"
WScript.Quit 0
