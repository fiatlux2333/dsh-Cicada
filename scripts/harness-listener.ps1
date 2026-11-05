param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
  Where-Object { $_.LocalPort -eq $Port } |
  ForEach-Object { @{ address = [string]$_.LocalAddress; pid = [int]$_.OwningProcess } })
[Console]::WriteLine((ConvertTo-Json -InputObject $rows -Compress))
