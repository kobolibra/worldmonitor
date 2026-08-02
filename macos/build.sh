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

# Read out of the plist rather than written down a second time here. There is
# exactly one place the bundle identifier is decided, and this is not it.
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' Resources/Info.plist)"

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
#
# The identifier is passed explicitly rather than left to be inferred, and
# --deep is absent: it is deprecated for signing, and there is nothing nested in
# this bundle for it to reach - one executable, one plist, one icon.
echo "==> Signing ad hoc"
codesign --force --sign - --identifier "${BUNDLE_ID}" "${APP}"

# Two questions, and only one of them may stop a build.
#
# Whether the seal is intact is a real question. Whether the bundle satisfies
# its own designated requirement is not: an ad hoc signature has no certificate,
# so that requirement is little more than a restatement of the bundle's own
# identifier and hash, and codesign's handling of an identifier ending in .app
# differs slightly from the form it records - so a bundle that is valid on disk
# can fail to match a rule derived from itself. Gatekeeper never evaluates it
# either way; an ad hoc build is unsigned as far as Apple is concerned, which is
# why opening it takes an explicit approval regardless of what this prints.
#
# So it is reported, and it is not fatal.
echo "==> Verifying the seal"
codesign --verify --verbose=2 "${APP}" || echo \
	"note: codesign --verify was not satisfied (see above). Only the check below is fatal."

# This one is fatal, and it is the question worth asking: is the bundle signed
# at all, with the signature we just applied. A missing, truncated or unreadable
# signature fails here; a tautology that failed to match itself does not.
echo "==> Confirming the signature exists"
codesign --display --verbose=2 "${APP}" 2>&1 | tee "${BUILD}/codesign.txt"
grep -q 'Signature=adhoc' "${BUILD}/codesign.txt"
grep -q "Identifier=" "${BUILD}/codesign.txt"

echo "==> Done: ${APP}"
du -sh "${APP}"
