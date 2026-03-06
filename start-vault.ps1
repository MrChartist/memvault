# MemVault — Persistent Auto-Start Helper
# Run as Administrator for netsh portproxy (or ensure WSL mirrored mode works)
# Saved at: D:\AG\Vault\apps\vault\start-vault.ps1

$distro = "Ubuntu-24.04"
$serverScript = "/mnt/d/AG/Vault/apps/vault/server.mjs"
$logFile = "/mnt/d/AG/Vault/db/vault.log"
$port = 7800

# Kill any previous instance
wsl -d $distro -e bash -c "pkill -f 'server.mjs' 2>/dev/null; sleep 0.5" 2>$null
Start-Sleep 1

# Start the Vault server keeping the WSL session alive via a persistent bash
$job = Start-Process wsl -ArgumentList @(
    "-d", $distro,
    "-e", "bash", "-c",
    "node $serverScript >> $logFile 2>&1"
) -WindowStyle Hidden -PassThru

Start-Sleep 3

# In mirrored mode, set up port proxy as fallback
try {
    $wslIp = (wsl -d $distro -e bash -c "hostname -I 2>/dev/null | awk '{print $1}'").Trim()
    if ($wslIp -and $wslIp -ne "") {
        # Remove old proxy rule if exists
        netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=$port 2>$null
        # Add new proxy rule WSL2 IP → Windows localhost
        netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=$port connectaddress=$wslIp connectport=$port 2>$null
        Write-Host "Port proxy: 127.0.0.1:$port → ${wslIp}:$port"
    }
} catch {
    Write-Host "Port proxy setup skipped (run as Admin to enable)"
}

Write-Host "MemVault server started. URL: http://127.0.0.1:$port"
