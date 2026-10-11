$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$payload = Join-Path $repo 'dist/goodfinds-marketplace'
$build = Get-Content (Join-Path $payload 'server/build.json') | ConvertFrom-Json
if ($build.target -ne 'x86_64-pc-windows-msvc') { throw 'Build the Windows x64 plugin before packaging the installer.' }
$version = (Get-Content (Join-Path $payload '.codex-plugin/plugin.json') | ConvertFrom-Json).version
$output = Join-Path $repo 'dist/installers/windows'
New-Item -ItemType Directory -Force $output | Out-Null
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $csc /nologo /optimize+ /target:exe /reference:System.Web.Extensions.dll "/out:$output/GoodfindsRegister.exe" (Join-Path $PSScriptRoot 'Register.cs')
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the plugin registration helper.' }
$iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe'
& $iscc "/DPluginVersion=$version" "/DPayload=$payload" (Join-Path $PSScriptRoot 'Goodfinds.iss')
if ($LASTEXITCODE -ne 0) { throw 'Could not build the Windows installer.' }
