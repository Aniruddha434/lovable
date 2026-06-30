$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Dist = Join-Path $Root "dist"
$OutDir = Join-Path $Dist "extension"
$Zip = Join-Path $Dist "lovable-extension.zip"

if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
New-Item -ItemType Directory -Path $OutDir | Out-Null

$Include = @(
  "assets",
  "background.js",
  "content-bridge.js",
  "content-templates.js",
  "content.js",
  "extension-config.js",
  "floating.css",
  "jszip.min.js",
  "license-gate.js",
  "lovable-auth.js",
  "lovable-feature-api.js",
  "manifest.json",
  "pageHook.js",
  "sidepanel-templates.js",
  "sidepanel.css",
  "sidepanel.html",
  "sidepanel.js",
  "sounds.js",
  "theme.css",
  "user-messages.js"
)

foreach ($Item in $Include) {
  $Source = Join-Path $Root $Item
  if (Test-Path -LiteralPath $Source) {
    Copy-Item -LiteralPath $Source -Destination $OutDir -Recurse
  }
}

Compress-Archive -Path (Join-Path $OutDir "*") -DestinationPath $Zip
"Created $Zip"
