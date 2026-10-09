' Launch MemVault in WSL2 silently at Windows login.
' 1. Edit DISTRO and REPO_DIR.   2. Copy this file to:
'    %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
Const DISTRO = "Ubuntu"
Const REPO_DIR = "/home/you/memvault"
Set oShell = CreateObject("WScript.Shell")
oShell.Run "wsl.exe -d " & DISTRO & " -e bash -c ""cd '" & REPO_DIR & "' && node server.mjs""", 0, False
