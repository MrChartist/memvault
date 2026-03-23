Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd.exe /c cd /d """ & "D:\AG\Mam Valut\memvault" & """ && npm run sync:all", 0, False