# rfcomm-bridge (macOS)

A small helper that opens Bluetooth Classic RFCOMM channels by number with
IOBluetooth and relays their bytes over stdin/stdout as JSON lines. The
desktop app starts it only when you connect through **DYMO MobileLabeler
(native Bluetooth)**, and it exits when its stdin closes, so it never outlives
the app.

Browsers and OS serial ports reach only a printer's advertised serial port.
Some printers, such as the DYMO MobileLabeler, keep status on a second,
unadvertised channel; this helper can open both.

## Build

Needs the Xcode command line tools (`xcode-select --install`).

```sh
apps/desktop/native/macos/rfcomm-bridge/build.sh
```

This writes a universal (arm64 + x86_64) binary to `build/rfcomm-bridge`,
with an embedded Info.plist carrying the Bluetooth usage description, and
ad-hoc signs it. The Electron main process looks for it there in development
and in the app's resources folder when packaged.

## Try it by hand

```sh
cd apps/desktop/native/macos/rfcomm-bridge
printf '%s\n' '{"id":1,"op":"list"}' | build/rfcomm-bridge
```

Status from a MobileLabeler. Open the print channel (3) first and then the
command channel (2), the order DYMO's app uses and the desktop app follows;
`ESC A 0` is `G0EA` in base64. Opens can take several seconds, so each step
waits for the one before:

```sh
{ echo '{"id":1,"op":"open","address":"F8:5A:00:01:0E:B7","channel":3}'; sleep 8
  echo '{"id":2,"op":"open","address":"F8:5A:00:01:0E:B7","channel":2}'; sleep 8
  echo '{"id":3,"op":"write","handle":2,"data":"G0EA"}'; sleep 3; } | build/rfcomm-bridge
```

Handles count up from 1 per run, including failed opens. If `list` shows the
printer as `"connected":true` before you start, something else holds the link;
disconnect it in the Bluetooth menu first.

The protocol is documented at the top of `Sources/Bridge.swift`. The bridge
knows nothing about printers: drivers stay in TypeScript, in
`packages/core`, where they are tested against mocks.
