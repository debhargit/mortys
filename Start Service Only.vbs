' ===========================================================================
'  Morty's Auto Parts Admin — start the server only, no browser, no window
'
'  Same as "Morty's Auto Parts Admin.vbs" minus the "wait for it, then open the
'  admin panel" part. This is what the Windows-login autostart shortcut runs:
'  at login you want the till/server PC to start serving the LAN, not to have
'  a browser window thrown at whoever walks in first.
'
'  Safe to run when it's already running — boot.js holds a lock file and a
'  second copy just exits.
' ===========================================================================
Option Explicit

Dim fso, sh, scriptDir, nodeExe, bootJs

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

If LCase(fso.GetFileName(WScript.FullName)) = "cscript.exe" Then
    sh.Run "wscript.exe //nologo """ & WScript.ScriptFullName & """", 0, False
    WScript.Quit 0
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe   = fso.BuildPath(scriptDir, "runtime\node.exe")
bootJs    = fso.BuildPath(scriptDir, "app\boot.js")

If fso.FileExists(nodeExe) And fso.FileExists(bootJs) Then
    sh.Run """" & nodeExe & """ """ & bootJs & """", 0, False
End If

WScript.Quit 0
