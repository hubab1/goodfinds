#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
free_kb="$(df -Pk "$repo" | awk 'NR==2 { print $4 }')"
if [ "$free_kb" -lt 262144 ]; then
  echo 'At least 256 MB of free disk space is required to package and verify the installer.' >&2
  exit 1
fi
payload="${1:-$repo/dist/goodfinds-marketplace}"
output="${GOODFINDS_INSTALLER_OUTPUT:-$repo/dist}"
if { [ -n "${GOODFINDS_SIGN_IDENTITY:-}" ] && [ -z "${GOODFINDS_INSTALLER_SIGN_IDENTITY:-}" ]; } ||
   { [ -z "${GOODFINDS_SIGN_IDENTITY:-}" ] && [ -n "${GOODFINDS_INSTALLER_SIGN_IDENTITY:-}" ]; } ||
   { [ -n "${GOODFINDS_NOTARY_PROFILE:-}" ] && [ -z "${GOODFINDS_INSTALLER_SIGN_IDENTITY:-}" ]; }; then
  echo 'Signed packages require both Developer ID Application and Developer ID Installer identities.' >&2
  exit 1
fi
version="$(bun -e 'const p=process.argv[1]; console.log(JSON.parse(await Bun.file(p+"/.codex-plugin/plugin.json").text()).version)' "$payload")"
target="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]+"/server/build.json").text()).target)' "$payload")"
case "$target" in
  aarch64-apple-darwin) cpu=arm64 ;;
  x86_64-apple-darwin) cpu=x86_64 ;;
  universal-apple-darwin) cpu=universal ;;
  *) echo 'The macOS installer requires a macOS plugin build.' >&2; exit 1 ;;
esac
build="$output/installers/macos-$cpu"
app="$build/Goodfinds Setup.app"
artwork="$build/artwork"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
rm -rf "$app/Contents/Resources/plugin"
cp -R "$payload" "$app/Contents/Resources/plugin"
cp "$repo/assets/logo.png" "$app/Contents/Resources/logo.png"
swift "$repo/installers/macos/artwork.swift" "$artwork" "$repo/assets/logo.png"
iconutil -c icns "$artwork/Goodfinds.iconset" -o "$app/Contents/Resources/Goodfinds.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>GoodfindsInstaller</string>
<key>CFBundleIdentifier</key><string>com.thirdtech.goodfinds.installer</string>
<key>CFBundleName</key><string>Goodfinds Setup</string>
<key>CFBundleDisplayName</key><string>Goodfinds Setup</string>
<key>CFBundleIconFile</key><string>Goodfinds.icns</string>
<key>CFBundleVersion</key><string>$version</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
if [ "$cpu" = universal ]; then
  for architecture in arm64 x86_64; do
    lipo "$app/Contents/Resources/plugin/server/goodfinds" -verify_arch "$architecture"
    swiftc -O -whole-module-optimization -target "$architecture-apple-macos13.0" "$repo/installers/macos/main.swift" -o "$build/installer-$architecture"
  done
  lipo -create "$build/installer-arm64" "$build/installer-x86_64" -output "$app/Contents/MacOS/GoodfindsInstaller"
  for architecture in arm64 x86_64; do
    lipo "$app/Contents/MacOS/GoodfindsInstaller" -verify_arch "$architecture"
  done
else
  swiftc -O -whole-module-optimization -target "$cpu-apple-macos13.0" "$repo/installers/macos/main.swift" -o "$app/Contents/MacOS/GoodfindsInstaller"
fi
if [ -n "${GOODFINDS_SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$GOODFINDS_SIGN_IDENTITY" "$app/Contents/Resources/plugin/server/goodfinds"
  codesign --force --options runtime --timestamp --sign "$GOODFINDS_SIGN_IDENTITY" "$app"
  codesign --verify --deep --strict "$app"
fi
archive="$output/Goodfinds-$version-macos-$cpu.pkg"
partial="$output/Goodfinds-$version-macos-$cpu.partial.pkg"
staging="$(mktemp -d "$build/package.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/scripts" "$staging/resources"
ditto "$app" "$staging/scripts/Goodfinds Setup.app"
cp "$repo/installers/macos/postinstall" "$staging/scripts/postinstall"
chmod 755 "$staging/scripts/postinstall"
cp "$repo/installers/macos/welcome.html" "$repo/installers/macos/conclusion.html" "$staging/resources/"

# Keep the helper in the package's temporary scripts directory. Only the
# immutable plugin copy and the personal catalog remain after installation.
pkgbuild --nopayload --scripts "$staging/scripts" --identifier com.thirdtech.goodfinds \
  --version "$version" "$staging/Goodfinds-component.pkg"
cat > "$staging/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Goodfinds</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <volume-check><allowed-os-versions><os-version min="13.0"/></allowed-os-versions></volume-check>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default" visible="false"><pkg-ref id="com.thirdtech.goodfinds"/></choice>
  <pkg-ref id="com.thirdtech.goodfinds" version="$version" auth="none">Goodfinds-component.pkg</pkg-ref>
</installer-gui-script>
XML
sign_args=()
if [ -n "${GOODFINDS_INSTALLER_SIGN_IDENTITY:-}" ]; then
  sign_args=(--sign "$GOODFINDS_INSTALLER_SIGN_IDENTITY" --timestamp)
fi
productbuild --distribution "$staging/distribution.xml" --package-path "$staging" \
  --resources "$staging/resources" ${sign_args[@]+"${sign_args[@]}"} "$partial"
pkgutil --expand-full "$partial" "$staging/verified"
verified_app="$staging/verified/Goodfinds-component.pkg/Scripts/Goodfinds Setup.app"
test -x "$verified_app/Contents/MacOS/GoodfindsInstaller"
cmp "$app/Contents/MacOS/GoodfindsInstaller" "$verified_app/Contents/MacOS/GoodfindsInstaller"
cmp "$app/Contents/Resources/plugin/server/goodfinds" "$verified_app/Contents/Resources/plugin/server/goodfinds"
if [ -n "${GOODFINDS_INSTALLER_SIGN_IDENTITY:-}" ]; then
  codesign --verify --deep --strict "$verified_app"
  pkgutil --check-signature "$partial"
fi
if [ -n "${GOODFINDS_NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$partial" --keychain-profile "$GOODFINDS_NOTARY_PROFILE" --wait
  xcrun stapler staple "$partial"
fi
mv "$partial" "$archive"
printf '%s\n' "$archive"
