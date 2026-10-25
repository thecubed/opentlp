#!/bin/sh
# Build the macOS RFCOMM bridge as a universal binary at build/rfcomm-bridge.
# Needs the Xcode command line tools (xcode-select --install).
set -eu
cd "$(dirname "$0")"
mkdir -p build
for arch in arm64 x86_64; do
    xcrun swiftc -O \
        -target "$arch-apple-macos11" \
        -framework IOBluetooth \
        -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
        Sources/Bridge.swift Sources/IOBluetoothBackend.swift Sources/main.swift \
        -o "build/rfcomm-bridge-$arch"
done
lipo -create build/rfcomm-bridge-arm64 build/rfcomm-bridge-x86_64 -output build/rfcomm-bridge
rm build/rfcomm-bridge-arm64 build/rfcomm-bridge-x86_64
codesign --force --sign - build/rfcomm-bridge
echo "Built $(pwd)/build/rfcomm-bridge"
