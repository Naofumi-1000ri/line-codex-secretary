$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$tempPath = $null
try {
    Add-Type -AssemblyName System.Security
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if (-not [IO.Path]::IsPathRooted($request.path)) { throw "Invalid path" }
    $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($request.operation -eq "save") {
        if ([string]::IsNullOrWhiteSpace($request.token)) { throw "Empty token" }
        $bytes = [Text.Encoding]::UTF8.GetBytes($request.token)
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
        $directory = [IO.Path]::GetDirectoryName($request.path)
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $tempPath = [IO.Path]::Combine($directory, [IO.Path]::GetRandomFileName())
        [IO.File]::WriteAllBytes($tempPath, $encrypted)
        if ([IO.File]::Exists($request.path)) {
            # PowerShell coerces $null to an empty string for string arguments.
            # NullString passes a real null backup path to the .NET overload.
            [IO.File]::Replace($tempPath, $request.path, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [IO.File]::Move($tempPath, $request.path)
        }
    } elseif ($request.operation -eq "read") {
        $encrypted = [IO.File]::ReadAllBytes($request.path)
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, $scope)
        [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
    } else { throw "Invalid operation" }
} catch {
    [Console]::Error.WriteLine("TOKEN_STORE_FAILED")
    exit 1
} finally {
    if ($tempPath -and [IO.File]::Exists($tempPath)) { [IO.File]::Delete($tempPath) }
}
