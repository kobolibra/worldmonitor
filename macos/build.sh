#!/usr/bin/env bash
#
# Assembles "Bloomberg Live.app" by hand. There is no Xcode project on purpose:
# a .pbxproj is thousands of lines of generated noise, and this app is one
# source file, one plist and an icon. Everything here is reviewable.
#
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="Bloomberg Live"
BIN_NAME="BloombergLive"
BUILD="build"
APP="${BUILD}/${APP_NAME}.app"
DEPLOY_TARGET="11.0"

rm -rf "${BUILD}"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"

echo "==> Compiling for Apple Silicon"
swiftc -O \
	-target "arm64-apple-macos${DEPLOY_TARGET}" \
	-o "${BUILD}/${BIN_NAME}-arm64" \
	Sources/main.swift

echo "==> Compiling for Intel"
swiftc -O \
	-target "x86_64-apple-macos${DEPLOY_TARGET}" \
	-o "${BUILD}/${BIN_NAME}-x86_64" \
	Sources/main.swift

echo "==> Fusing into a universal binary"
lipo -create \
	-output "${APP}/Contents/MacOS/${BIN_NAME}" \
	"${BUILD}/${BIN_NAME}-arm64" \
	"${BUILD}/${BIN_NAME}-x86_64"
chmod +x "${APP}/Contents/MacOS/${BIN_NAME}"
lipo -info "${APP}/Contents/MacOS/${BIN_NAME}"

echo "==> Drawing the icon"
swiftc -O -o "${BUILD}/makeicon" tools/MakeIcon.swift
"${BUILD}/makeicon" "${BUILD}/AppIcon.iconset"
iconutil -c icns "${BUILD}/AppIcon.iconset" -o "${APP}/Contents/Resources/AppIcon.icns"

echo "==> Installing Info.plist"
cp Resources/Info.plist "${APP}/Contents/Info.plist"

# An ad hoc signature. This does not satisfy Gatekeeper, which wants a paid
# Developer ID plus notarisation, but it does give the bundle a stable identity
# so macOS keeps its granted permissions across launches instead of treating
# every launch as a brand new app.
echo "==> Signing ad hoc"
codesign --force --deep --sign - "${APP}"
codesign --verify --verbose=2 "${APP}"

echo "==> Done: ${APP}"
du -sh "${APP}"
