' ===========================================================================
'  Meltha Honda Admin — start with Windows (toggle)
'
'  Adds or removes a shortcut in this user's Startup folder so the admin
'  server comes up automatically at login, hidden, without opening a browser.
'  No admin rights needed — it's a per-user shortcut, not a Windows service.
'
'  Run it again to turn it back off.
' ===========================================================================
Option Explicit

Dim fso, sh, scriptDir, startupDir, linkPath, target, lnk, answer

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

If LCase(fso.GetFileName(WScript.FullName)) = "cscript.exe" Then
    sh.Run "wscript.exe //nologo """ & WScript.ScriptFullName & """", 0, False
    WScript.Quit 0
End If

scriptDir  = fso.GetParentFolderName(WScript.ScriptFullName)
startupDir = sh.SpecialFolders("Startup")
linkPath   = fso.BuildPath(startupDir, "Meltha Honda Admin.lnk")

' Prefer the compiled launcher. It is a Windows-subsystem executable, so at
' login it creates no console at all, and it cannot be re-associated with
' cscript the way a .vbs can. The .vbs stays as a fallback for a build made
' on a machine that had no C# compiler.
target = fso.BuildPath(scriptDir, "Start Service Only.exe")
If Not fso.FileExists(target) Then target = fso.BuildPath(scriptDir, "Start Service Only.vbs")

If Not fso.FileExists(target) Then
    MsgBox "This portable copy is incomplete - ""Start Service Only"" is missing.", _
           vbCritical, "Meltha Honda Admin"
    WScript.Quit 1
End If

' --- Already on? offer to turn it off --------------------------------------
If fso.FileExists(linkPath) Then
    answer = MsgBox("The Meltha Honda admin server currently starts automatically " & _
                    "when you sign in to Windows." & vbCrLf & vbCrLf & _
                    "Turn that off?", vbQuestion + vbYesNo, "Meltha Honda Admin")
    If answer = vbYes Then
        fso.DeleteFile linkPath, True
        MsgBox "Autostart turned off." & vbCrLf & vbCrLf & _
               "The server is not stopped - use ""Stop Meltha Honda Admin.vbs"" for that.", _
               vbInformation, "Meltha Honda Admin"
    End If
    WScript.Quit 0
End If

' --- Turn it on ------------------------------------------------------------
answer = MsgBox("Start the Meltha Honda admin server automatically when you " & _
                "sign in to Windows?" & vbCrLf & vbCrLf & _
                "It starts hidden and does not open a browser - use " & _
                """Meltha Honda Admin"" when you want the panel on screen." & vbCrLf & vbCrLf & _
                "This only applies to the current Windows user on this computer.", _
                vbQuestion + vbYesNo, "Meltha Honda Admin")
If answer <> vbYes Then WScript.Quit 0

Set lnk = sh.CreateShortcut(linkPath)
If LCase(Right(target, 4)) = ".exe" Then
    ' The compiled launcher is pointed at directly -- it is its own program.
    lnk.TargetPath = target
    lnk.Arguments  = ""
Else
    ' Falling back to the script. TargetPath is wscript.exe rather than the
    ' .vbs itself, because a shortcut straight to a .vbs is launched through
    ' the file association, and on a machine where .vbs is mapped to cscript
    ' that flashes a console at every login -- the exact thing this install
    ' exists to avoid.
    lnk.TargetPath = fso.BuildPath(sh.ExpandEnvironmentStrings("%WINDIR%"), "System32\wscript.exe")
    lnk.Arguments  = "//nologo """ & target & """"
End If
lnk.WorkingDirectory = scriptDir
lnk.WindowStyle      = 7                     ' minimised; the script itself is hidden anyway
lnk.Description      = "Start the Meltha Honda admin server (hidden)"
lnk.Save

MsgBox "Autostart turned on." & vbCrLf & vbCrLf & _
       "The admin server will start hidden the next time you sign in to Windows.", _
       vbInformation, "Meltha Honda Admin"
WScript.Quit 0
