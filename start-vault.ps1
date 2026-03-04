# Vault Auto-Start Helper Script
# Saved at: D:\AG\Vault\apps\vault\start-vault.ps1
# This script is triggered by Windows Task Scheduler at login.

$wslExe = "wsl.exe"
$distro = "Ubuntu-24.04"
$serverPath = "/mnt/d/AG/Vault/apps/vault/server.mjs"

# Start the Vault server in WSL in the background (hidden window)
Start-Process -WindowStyle Hidden $wslExe -ArgumentList @("-d", $distro, "-e", "bash", "-c", "node $serverPath >> /mnt/d/AG/Vault/db/vault.log 2>&1")

Write-Host "Knowledge Vault server started."
