# Helpers for working on the TouchPad over novacom. Dot-source this file:
#     . .\tools\tp-tools.ps1
$script:Nov = "C:\Program Files\Palm, Inc\novacom.exe"

# Run a shell script on the TouchPad. Going through a file avoids PowerShell's quoting problems.
function Invoke-Tp([string]$Script) {
    $f = Join-Path $env:TEMP "tp-cmd.sh"
    [IO.File]::WriteAllText($f, ($Script -replace "`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))
    cmd /c "`"$script:Nov`" -d usb put file:///tmp/tp-cmd.sh < `"$f`"" | Out-Null
    & $script:Nov -d usb run file:///bin/sh /tmp/tp-cmd.sh 2>&1
}

# Copy a file from the TouchPad to this PC.
function Get-TpFile([string]$Remote, [string]$Local) {
    cmd /c "`"$script:Nov`" -d usb get file://$Remote > `"$Local`""
}

# Take a screenshot of the TouchPad. The image comes out in the panel's own orientation.
function Get-TpShot([string]$Out) {
    Invoke-Tp "luna-send -n 1 palm://com.palm.systemmanager/takeScreenShot '{`"file`":`"/media/internal/pp-shot.png`"}' >/dev/null 2>&1" | Out-Null
    Get-TpFile "/media/internal/pp-shot.png" $Out
}

# Launch the app (or send params to the running app), wait, print what the app and
# its service logged, and take a screenshot. See App.js testLaunch for the params.
#     Show-PpScreen '{"path":"/Photos"}' shot.png 5
function Show-PpScreen([string]$ParamsJson, [string]$Shot, [int]$Seconds = 5, [switch]$Restart) {
    if ($Restart) {
        $env:JAVA_HOME = "G:\Java\jdk17"
        $env:Path = "G:\Java\jdk17\bin;G:\webOS\PalmSDK\Current\bin;" + $env:Path
        cmd /c "palm-launch.bat -d usb -c com.stark.papers 2>&1" | Out-Null
    }
    $launch = '{"id":"com.stark.papers","params":' + $ParamsJson + '}'
    $lines = @(
        'sleep 1',
        'wc -l < /var/log/messages > /tmp/pp-mark',
        "luna-send -n 1 palm://com.palm.applicationManager/launch '$launch' >/dev/null 2>&1",
        "sleep $Seconds",
        'tail -n +$(cat /tmp/pp-mark) /var/log/messages > /tmp/pp-new.log',
        'grep -E "\[papers\]|\[ppfiles\]|Uncaught|stark.papers.*[Ee]rror" /tmp/pp-new.log | sed -e "s/^[^ ]* \[[0-9]*\] [^ ]* //" -e "s/, file:.*//" | cut -c1-260 | tail -n 15'
    )
    Invoke-Tp ($lines -join "`n")
    if ($Shot) { Get-TpShot $Shot }
}
