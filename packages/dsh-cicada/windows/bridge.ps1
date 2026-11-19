param([Parameter(Mandatory=$true)][ValidateSet('protect','unprotect','mutex','close-browser','apps','uninstall','traces','events')][string]$Operation, [int]$OwnerPid = 0)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Reply($Value) { [Console]::WriteLine(($Value | ConvertTo-Json -Compress -Depth 12)) }
function Assert-PlainPath([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse-point-rejected' }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }
    $current = $parent
  }
}
try {
  if ($Operation -eq 'mutex') {
    if ($OwnerPid -le 0) { throw 'invalid-monitor-owner' }
    $owner = Get-Process -Id $OwnerPid -ErrorAction Stop
    $ownerStart = $owner.StartTime.ToUniversalTime().Ticks.ToString()
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = [Threading.Mutex]::new($false, "Global\DSH-Cicada-$sid")
    $owned = $false; $registered = $false; $released = $false
    $leaseKey = 'HKCU:\Software\DeepSeek Harness\Cicada'
    $leaseId = [Guid]::NewGuid().ToString()
    try {
      try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
      if ($owned) {
        $old = Get-ItemProperty -LiteralPath $leaseKey -Name 'MonitorOwner' -ErrorAction SilentlyContinue
        if ($old -and $old.MonitorOwner) {
          $record = $old.MonitorOwner | ConvertFrom-Json
          if (-not $record.pid -or -not $record.start) { throw 'invalid-monitor-owner-record' }
          $previous = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
          # A dead helper must not allow takeover while its Host can still finish an in-flight write.
          if ($previous -and $previous.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$record.start) {
            Reply @{ acquired = $false }
            exit 0
          }
        }
        if (-not (Test-Path -LiteralPath $leaseKey)) { $null = New-Item -Path $leaseKey -Force }
        $record = @{ pid = $OwnerPid; start = $ownerStart; lease = $leaseId } | ConvertTo-Json -Compress
        $null = New-ItemProperty -LiteralPath $leaseKey -Name 'MonitorOwner' -Value $record -PropertyType String -Force
        $registered = $true
      }
      Reply @{ acquired = $owned }
      if ($owned) {
        $releaseLine = [Console]::ReadLine()
        $released = $null -ne $releaseLine
      }
    } finally {
      if ($registered -and $released) {
        $record = (Get-ItemProperty -LiteralPath $leaseKey -Name 'MonitorOwner' -ErrorAction Stop).MonitorOwner | ConvertFrom-Json
        if ($record.lease -eq $leaseId) { Remove-ItemProperty -LiteralPath $leaseKey -Name 'MonitorOwner' -ErrorAction Stop }
      }
      if ($owned) { $mutex.ReleaseMutex() }
      $mutex.Dispose()
    }
    exit 0
  }
  $line = [Console]::ReadLine()
  if (-not $line -or $line.Length -gt 1048576) { throw 'invalid-input' }
  $inputData = $line | ConvertFrom-Json
  if ($Operation -eq 'protect' -or $Operation -eq 'unprotect') {
    Add-Type -AssemblyName System.Security
    if ($Operation -eq 'protect') {
      $bytes = [Text.Encoding]::UTF8.GetBytes([string]$inputData.text)
      $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      Reply @{ text = [Convert]::ToBase64String($result) }
    } else {
      $bytes = [Convert]::FromBase64String([string]$inputData.text)
      $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      Reply @{ text = [Text.Encoding]::UTF8.GetString($result) }
    }
  } elseif ($Operation -eq 'close-browser') {
    if ($inputData.browser -notin @('chrome','edge')) { throw 'invalid-browser' }
    $name = if ($inputData.browser -eq 'chrome') { 'chrome' } else { 'msedge' }
    $processes = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    foreach ($p in $processes) { $null = $p.CloseMainWindow() }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline -and @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) { Start-Sleep -Milliseconds 250 }
    # Never kill the browser forcibly: unsaved tabs and profile WAL must remain intact.
    if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) { throw 'browser-busy' }
    Reply @{ ok = $true }
  } elseif ($Operation -eq 'apps' -or $Operation -eq 'uninstall') {
    $roots = @('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall')
    $entries = @()
    foreach ($root in $roots) {
      foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
        $v = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if ($v.DisplayName -and ($v.QuietUninstallString -or $v.UninstallString)) {
          $entries += [pscustomobject]@{ name = [string]$v.DisplayName; quiet = [string]$v.QuietUninstallString; command = [string]$v.UninstallString }
        }
      }
    }
    if ($Operation -eq 'apps') { Reply @{ names = @($entries | Select-Object -ExpandProperty name -Unique) } }
    else {
      $target = [string]$inputData.name
      if (-not $target -or $target.Length -gt 256) { throw 'invalid-app' }
      # Only exact registry identities are accepted; never interpret a supplied command.
      $matches = @($entries | Where-Object { $_.name -eq $target })
      $info = [Diagnostics.ProcessStartInfo]::new()
      $info.UseShellExecute = $false; $info.CreateNoWindow = $true
      $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
      if ($matches.Count -eq 0) {
        $info.FileName = 'winget.exe'
        # Windows quoting: reject quotes/control characters before assembling argv.
        if ($target -match '["\x00-\x1f]' -or $target.EndsWith('\')) { throw 'invalid-app' }
        $info.Arguments = 'uninstall --exact --name "' + $target + '" --silent --accept-source-agreements --disable-interactivity'
      } else {
        if ($matches.Count -ne 1) { throw 'ambiguous-app-identity' }
        $e = $matches[0]
        if ($e.quiet) { $command = $e.quiet }
        elseif ($e.command -match '(?i)msiexec.*?(\{[0-9a-f-]{36}\})') { $command = 'msiexec.exe /x ' + $Matches[1] + ' /qn /norestart' }
        else { $command = $e.command + ' /S' }
        if ($command -match '^\s*"([^"]+)"\s*(.*)$') { $info.FileName = $Matches[1]; $info.Arguments = $Matches[2] }
        elseif ($command -match '^\s*([^\s"]+\.exe)\s*(.*)$') { $info.FileName = $Matches[1]; $info.Arguments = $Matches[2] }
        else { throw 'ambiguous-uninstall-command' }
        if ([IO.Path]::GetFileName($info.FileName) -match '^(?i:cmd|powershell|pwsh|wscript|cscript|rundll32|regsvr32|mshta)\.exe$') { throw 'shell-uninstaller-rejected' }
        if (-not [IO.Path]::IsPathRooted($info.FileName) -and $info.FileName -ne 'msiexec.exe') { throw 'relative-uninstaller-rejected' }
      }
      $p = [Diagnostics.Process]::Start($info)
      $outTask = $p.StandardOutput.ReadToEndAsync(); $errTask = $p.StandardError.ReadToEndAsync()
      if (-not $p.WaitForExit(900000)) { $p.Kill(); throw 'uninstall-timeout' }
      $null = $outTask.GetAwaiter().GetResult(); $null = $errTask.GetAwaiter().GetResult()
      Reply @{ ok = ($p.ExitCode -eq 0); code = $p.ExitCode }
      $p.Dispose()
    }
  } elseif ($Operation -eq 'traces') {
    $ok = 0; $failed = 0
    $recent = Join-Path $env:APPDATA 'Microsoft\Windows\Recent'
    $explorer = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
    $files = @()
    foreach ($dir in @($recent, (Join-Path $recent 'AutomaticDestinations'), (Join-Path $recent 'CustomDestinations'))) {
      Assert-PlainPath $dir
      $files += @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)
    }
    Assert-PlainPath $explorer
    Assert-PlainPath (Join-Path $env:SystemRoot 'Prefetch')
    $files += @(Get-ChildItem -LiteralPath $explorer -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'thumbcache_*.db' -or $_.Name -like 'iconcache_*.db' })
    $files += @(Get-ChildItem -LiteralPath (Join-Path $env:SystemRoot 'Prefetch') -Filter '*.pf' -File -ErrorAction SilentlyContinue)
    foreach ($file in $files) { try { Remove-Item -LiteralPath $file.FullName -Force; $ok++ } catch { $failed++ } }
    foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU','HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\TypedPaths')) {
      if (Test-Path -LiteralPath $key) {
        foreach ($name in @((Get-Item -LiteralPath $key).Property)) { try { Remove-ItemProperty -LiteralPath $key -Name $name; $ok++ } catch { $failed++ } }
      }
    }
    & "$env:SystemRoot\System32\ipconfig.exe" /flushdns | Out-Null
    if ($LASTEXITCODE -ne 0) { $failed++ }
    try { Clear-RecycleBin -Force -ErrorAction Stop } catch { $failed++ }
    Reply @{ ok = ($failed -eq 0); count = $ok; failed = $failed }
  } elseif ($Operation -eq 'events') {
    $failed = 0
    foreach ($name in @('Application','System')) { & "$env:SystemRoot\System32\wevtutil.exe" cl $name; if ($LASTEXITCODE -ne 0) { $failed++ } }
    Reply @{ ok = ($failed -eq 0); failed = $failed }
  }
} catch {
  # Exception text can contain sensitive paths or software names.
  Reply @{ error = 'windows-operation-failed' }
  exit 1
}
