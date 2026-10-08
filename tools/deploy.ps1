# Package, install and relaunch the app on the connected TouchPad.
# Needs the Palm SDK and a Java runtime; set the two paths below for your machine.
$env:JAVA_HOME = "G:\Java\jdk17"
$env:Path = "G:\Java\jdk17\bin;G:\webOS\PalmSDK\Current\bin;" + $env:Path
$root = Split-Path $PSScriptRoot -Parent
$build = Join-Path $root "build"
New-Item -ItemType Directory -Force $build | Out-Null
Push-Location $build
# App, file service and package description go into one .ipk.
cmd /c "palm-package.bat `"$root\app`" `"$root\service`" `"$root\package`" 2>&1" | Select-Object -Last 1
$ipk = Get-ChildItem "com.stark.papers_*_all.ipk" | Sort-Object LastWriteTime | Select-Object -Last 1
cmd /c "palm-install.bat -d usb $($ipk.Name) 2>&1" | Select-Object -Last 1
cmd /c "palm-launch.bat -d usb -c com.stark.papers 2>&1" | Out-Null
cmd /c "palm-launch.bat -d usb com.stark.papers 2>&1" | Select-Object -Last 1
Pop-Location
