param([Parameter(Mandatory)][string]$BundleRoot)
$ErrorActionPreference = 'Stop'

function Test-MsiExecutables([string]$Path) {
    $engine = New-Object -ComObject WindowsInstaller.Installer
    $database = $engine.OpenDatabase($Path, 0) # Read-only, without running the installer.
    $view = $database.OpenView('SELECT `FileName`, `FileSize`, `Component_` FROM `File`')
    $view.Execute()
    $files = @(while ($record = $view.Fetch()) {
        [pscustomobject]@{
            Name = ($record.StringData(1) -split '\|')[-1]
            Size = $record.IntegerData(2)
            Component = $record.StringData(3)
        }
    })
    $view.Close()
    foreach ($name in 'draftmatter.exe', 'draftmatter-agent-host.exe', 'draftmatter-mcp.exe') {
        $entries = @($files | Where-Object Name -eq $name)
        if ($entries.Count -ne 1 -or $entries[0].Size -le 0) {
            throw "Expected one nonempty $name in the MSI File table, found $($entries.Count) entries."
        }
        Write-Output "MSI component $($entries[0].Component): $name ($($entries[0].Size) bytes)"
    }
}

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
    if ($format.Directory -eq 'msi') {
        Test-MsiExecutables $installer.FullName
    }
}
