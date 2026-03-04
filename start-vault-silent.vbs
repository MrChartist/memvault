' Knowledge Vault Auto-Start
' Place this in: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
' It launches the Vault WSL server silently at Windows login.
Set oShell = CreateObject("WScript.Shell")
oShell.Run "wsl.exe -d Ubuntu-24.04 -e bash -c ""node /mnt/d/AG/Vault/apps/vault/server.mjs >> /mnt/d/AG/Vault/db/vault.log 2>&1""", 0, False
