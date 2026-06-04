$port = 7777
$conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq 'Listen' }
if ($conns) {
  $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($p in $pids) {
    Write-Host "Killing PID $p on port $port..."
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

npx prisma generate
npm run dev