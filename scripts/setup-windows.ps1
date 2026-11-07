# One-time setup for Better Passwords on Windows.
#
# Browsers only let an extension start a native program that a small JSON "host manifest" names.
# iCloud for Windows registers one for Apple's own extension; this script writes the same kind of
# file for ours. It points at Apple's unmodified helper, so passwords still go through Apple's
# pairing and encryption. It changes nothing else and needs no admin rights.
#
# Usage, in PowerShell:
#   irm https://github.com/fanckush/better-passwords-extension/raw/main/scripts/setup-windows.ps1 | iex
# or, from a downloaded copy:
#   powershell -ExecutionPolicy Bypass -File setup-windows.ps1 [-Uninstall] [-ExtensionId ID] [-HelperPath EXE]
#   -ExtensionId  also allow another Chromium extension ID (e.g. a local build)
#   -HelperPath   use this helper instead of the one found automatically

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string[]]$ExtensionId = @(),
    [string]$HelperPath = ""
)

# Everything lives in this function: piped into iex, the script runs in the user's own session,
# where `exit` would close the window and script-level settings would stay behind.
function Invoke-BetterPasswordsSetup([bool]$Uninstall, [string[]]$ExtensionId, [string]$HelperPath) {
    Set-StrictMode -Version 2.0
    $ErrorActionPreference = "Stop"

    $hostName = "io.github.fanckush.betterpasswords.bridge"
    $chromiumIds = @("ocongmkplhijgajnipnhhggfcjfdilgj") + $ExtensionId
    $firefoxId = "better-passwords@fanckush.github.io"
    $manifestDir = Join-Path $env:LOCALAPPDATA "Better Passwords\NativeMessagingHosts"
    $chromiumManifest = Join-Path $manifestDir "$hostName.json"
    $firefoxManifest = Join-Path $manifestDir "$hostName.firefox.json"
    $firefoxLauncher = Join-Path $manifestDir "$hostName.firefox.bat"
    $storeUrl = "https://apps.microsoft.com/detail/9PKTQ5699M62"

    # Where browsers look up native messaging hosts, and which manifest each gets. Other Chromium
    # browsers (Vivaldi, Opera, Arc...) read Chrome's key.
    $registrations = @(
        @{ Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"; Manifest = $chromiumManifest },
        @{ Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"; Manifest = $chromiumManifest },
        @{ Key = "HKCU:\Software\Chromium\NativeMessagingHosts\$hostName"; Manifest = $chromiumManifest },
        @{ Key = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName"; Manifest = $chromiumManifest },
        @{ Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"; Manifest = $firefoxManifest }
    )

    if ($Uninstall) {
        foreach ($r in $registrations) {
            if (Test-Path -LiteralPath $r.Key) {
                Remove-Item -LiteralPath $r.Key -Recurse -Force
                Write-Host "  removed $($r.Key)"
            }
        }
        foreach ($file in @($chromiumManifest, $firefoxManifest, $firefoxLauncher)) {
            if (Test-Path -LiteralPath $file) {
                Remove-Item -LiteralPath $file -Force
                Write-Host "  removed $file"
            }
        }
        Write-Host "Done. Better Passwords can no longer reach Apple's helper."
        return 0
    }

    foreach ($id in $chromiumIds) {
        if ($id -cnotmatch "^[a-p]{32}$") { throw "Invalid extension ID: $id" }
    }

    # App execution aliases are zero-byte links; File.Exists sees them where Test-Path may not.
    $present = { param([string]$Path) (Test-Path -LiteralPath $Path) -or [System.IO.File]::Exists($Path) }

    # Apple's helper ships inside the iCloud for Windows package, whose folder name changes with each
    # update. The package's app execution alias keeps the same path, so it's preferred.
    $package = $null
    try {
        $package = Get-AppxPackage -Name "AppleInc.iCloud" | Select-Object -First 1
    } catch {
        # some PowerShell versions can't list packages; the alias below still works
        $package = $null
    }

    $helper = $null
    $note = ""
    if ($HelperPath -ne "") {
        if (-not (& $present $HelperPath)) { throw "No helper at $HelperPath" }
        $helper = $HelperPath
        $note = "given with -HelperPath"
    } else {
        $alias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\iCloudPasswordsExtensionHelper.exe"
        if (& $present $alias) {
            $helper = $alias
        } elseif ($package) {
            $inPackage = Join-Path $package.InstallLocation "iCloud\iCloudPasswordsExtensionHelper.exe"
            if (& $present $inPackage) {
                $helper = $inPackage
                $note = "its alias is off, so this path changes when iCloud updates; run this setup again after an update"
            }
        }
    }
    if (-not $helper) {
        if ($package) {
            throw ("iCloud for Windows is installed, but its password helper wasn't found. Turn on " +
                "'iCloud Passwords Extension Helper' in Settings > Apps > Advanced app settings > App execution aliases, " +
                "then run this again.")
        }
        throw "Apple Passwords on Windows needs iCloud for Windows. Install it from $storeUrl, sign in, then run this again."
    }
    if ($package) { Write-Host "iCloud for Windows $($package.Version)" }
    if ($note) { Write-Host "Helper: $helper ($note)" } else { Write-Host "Helper: $helper" }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    function Write-Manifest([string]$Path, [string]$AllowKey, [string[]]$Allowed, [string]$Target) {
        $manifest = [ordered]@{
            name = $hostName
            description = "Better Passwords: connects the extension to Apple's password helper"
            path = $Target
            type = "stdio"
        }
        $manifest[$AllowKey] = [object[]]$Allowed
        $json = ConvertTo-Json -InputObject $manifest -Depth 3
        # Browsers expect plain UTF-8; Windows PowerShell's own writers would add a byte order mark.
        [System.IO.File]::WriteAllText($Path, $json, $utf8)
        Write-Host "  wrote $Path"
    }

    New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
    $origins = @($chromiumIds | ForEach-Object { "chrome-extension://$_/" })
    Write-Manifest $chromiumManifest "allowed_origins" $origins $helper

    # Firefox won't start a host whose path is a link, and the app execution alias is one. It does
    # run .bat hosts through cmd.exe, which follows the alias (Chromium starts every host that way).
    # cmd reads a .bat in the OEM code page, so the user's folder goes in as %LOCALAPPDATA%.
    $target = $helper.Replace("%", "%%")
    if ($helper.StartsWith("$env:LOCALAPPDATA\", [System.StringComparison]::OrdinalIgnoreCase)) {
        $target = "%LOCALAPPDATA%" + $helper.Substring($env:LOCALAPPDATA.Length).Replace("%", "%%")
    }
    $oem = [System.Text.Encoding]::ASCII
    try {
        $oem = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
    } catch {
        # PowerShell without code-page encodings; the usual helper path is plain ASCII anyway
        $oem = [System.Text.Encoding]::ASCII
    }
    [System.IO.File]::WriteAllText($firefoxLauncher, "@`"$target`" %*`r`n", $oem)
    Write-Host "  wrote $firefoxLauncher"
    Write-Manifest $firefoxManifest "allowed_extensions" @($firefoxId) $firefoxLauncher

    foreach ($r in $registrations) {
        New-Item -Path $r.Key -Force | Out-Null
        Set-Item -LiteralPath $r.Key -Value $r.Manifest
        Write-Host "  registered $($r.Key)"
    }

    Write-Host ""
    Write-Host "Done. Click the Better Passwords icon in your browser to pair."
    return 0
}

$code = 1
try {
    $code = Invoke-BetterPasswordsSetup $Uninstall.IsPresent $ExtensionId $HelperPath
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
}
Remove-Item Function:\Invoke-BetterPasswordsSetup -ErrorAction SilentlyContinue
# a file run with -File reports how it went; piped into iex, the window stays open
if ($PSCommandPath) { exit $code }
