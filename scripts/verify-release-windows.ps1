param([Parameter(Mandatory)][string]$BundleRoot)
$ErrorActionPreference = 'Stop'

foreach ($format in @(
    @{ Directory = 'nsis'; Pattern = '*-setup.exe' },
    @{ Directory = 'msi'; Pattern = '*.msi' }
)) {
    $directory = Join-Path $BundleRoot $format.Directory
    $installers = @(Get-ChildItem -LiteralPath $directory -Filter $format.Pattern -File)
    if ($installers.Count -ne 1) {
        throw "Expected one $($format.Pattern) installer in $directory, found $($installers.Count)."
    }
    $installer = $installers[0]
    $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
    if ($signature.Status -ne 'NotSigned') {
        throw "Expected an unsigned installer, but $($installer.Name) returned $($signature.Status)."
    }
    Write-Output "$($installer.Name): NotSigned"
}
