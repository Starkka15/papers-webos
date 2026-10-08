# Opens one document in Papers from a cold start: the app is closed, given time to go,
# and started once with the file to open. Nothing is pushed into a running app.
# Reports graphics dumps and crash reports before and after, then takes a screenshot.
# Every device call has a time limit.
#   tools/open-doc.ps1 -Params '{"target":"file:///..."}' -Shot out.png [-Install]
param([string]$Params, [string]$Shot = "", [switch]$Install, [int]$Wait = 14)

$env:JAVA_HOME = "G:\Java\jdk17"
$env:Path = "G:\Java\jdk17\bin;G:\webOS\PalmSDK\Current\bin;" + $env:Path

function Invoke-Limited([scriptblock]$Block, [int]$Seconds, [object[]]$Arguments = @()) {
    $job = Start-Job -ScriptBlock $Block -ArgumentList $Arguments
    if (Wait-Job $job -Timeout $Seconds) {
        Receive-Job $job
        Remove-Job $job
        return
    }
    Stop-Job $job
    Remove-Job $job -Force
    Get-Process novacom -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
    "TIMED OUT after $Seconds s"
}

if ($Install) {
    $build = "H:\papers-webos\build"
    New-Item -ItemType Directory -Force $build | Out-Null
    Push-Location $build
    cmd /c "palm-package.bat H:\papers-webos\app H:\papers-webos\service H:\papers-webos\package 2>&1" | Select-Object -Last 1
    cmd /c "palm-launch.bat -d usb -c com.stark.papers 2>&1" | Out-Null
    Start-Sleep 3
    cmd /c "palm-install.bat -d usb com.stark.papers_0.1.0_all.ipk 2>&1" | Select-Object -Last 1
    Pop-Location
    Start-Sleep 4
} else {
    cmd /c "palm-launch.bat -d usb -c com.stark.papers 2>&1" | Out-Null
    Start-Sleep 5
}

$launch = '{"id":"com.stark.papers","params":' + $Params + '}'
$script = @"
before_dumps=`$(grep -c 'Dump Finished' /var/log/messages)
before_reports=`$(ls /var/log/reports/librdx/ | wc -l)
luna-send -n 1 palm://com.palm.applicationManager/launch '$launch' >/dev/null 2>&1 &
sleep $Wait
echo "graphics dumps: `$before_dumps -> `$(grep -c 'Dump Finished' /var/log/messages)   crash reports: `$before_reports -> `$(ls /var/log/reports/librdx/ | wc -l)"
grep -E '\[papers\]' /var/log/messages | tail -n 1 | sed -e 's/.*\[papers\] //' -e 's/, file:.*//'
grep -E "MemFree|^Cached" /proc/meminfo | tr -s ' ' | tr '\n' ' '
echo "WebAppMgr `$(for p in /proc/[0-9]*; do if grep -qs '^Name:.WebAppMgr' `$p/status; then grep VmRSS `$p/status | tr -s ' ' | cut -d' ' -f2; fi; done) kB"
rm -f /media/internal/pp-shot.png
luna-send -n 1 palm://com.palm.systemmanager/takeScreenShot '{"file":"/media/internal/pp-shot.png"}' >/dev/null 2>&1 &
n=0; while [ `$n -lt 15 ]; do [ -s /media/internal/pp-shot.png ] && break; sleep 1; n=`$((n+1)); done; sleep 1
"@
Invoke-Limited {
    param($s)
    . H:\papers-webos\tools\tp-tools.ps1
    Invoke-Tp $s
} ($Wait + 45) @($script)

if ($Shot) {
    Invoke-Limited {
        param($out)
        . H:\papers-webos\tools\tp-tools.ps1
        Get-TpFile "/media/internal/pp-shot.png" $out
    } 25 @($Shot)
}
