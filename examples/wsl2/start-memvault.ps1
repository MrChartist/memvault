# Start MemVault inside WSL2 from Windows.
# Edit the two variables below, then run:  powershell -ExecutionPolicy Bypass -File start-memvault.ps1
$distro  = "Ubuntu"                      # `wsl -l -v` shows your distro name
$repoDir = "/home/you/memvault"          # folder inside WSL that contains server.mjs

# Stop a previous instance, then start the server hidden.
wsl -d $distro -e bash -c "pkill -f '$repoDir/server.mjs' 2>/dev/null; true" 2>$null
Start-Process wsl -ArgumentList @("-d", $distro, "-e", "bash", "-c", "cd '$repoDir' && node server.mjs") -WindowStyle Hidden

Write-Host "MemVault started. Open it with:  wsl -d $distro -e bash -c ""cd '$repoDir' && node cli.mjs open"""
Write-Host "Windows reaches the server at http://127.0.0.1:7799 through WSL2's built-in localhost forwarding."
Write-Host "If forwarding is disabled on your machine, see the 'WSL2' section of the README before changing the bind address."
