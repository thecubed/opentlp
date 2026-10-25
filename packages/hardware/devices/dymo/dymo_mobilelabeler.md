---
id: dymo_mobilelabeler
brand: DYMO
model: MobileLabeler
summary: 300-dpi D1 tape labeler (6–24 mm) on Bluetooth Classic; jobs on RFCOMM 3, commands and status on an unadvertised RFCOMM 2.
kind: label
protocol:
  family: dymo-lm-v2
print:
  width_dots: 224
  width_mm: 19
  media_width_mm: 24
  dpi: 300
  media: [continuous]
  colour: monochrome
  colour_planes: 1
mechanism:
  cutter: true
connectivity:
  serial: true
support:
  blewebler2:
    level: listed
    driver: dymo-lm-v2
    notes: >-
      Print-only over the printer's serial port (RFCOMM 3), which is what Web
      Serial can reach. The tape width comes from the selected paper; status
      and cassette detection need RFCOMM 2 and are not read.
status: reported
sources:
  - id: owner-hardware-test
    kind: user-report
    note: >-
      A standalone macOS test (IOBluetooth RFCOMM) against a paired unit with a
      12 mm cassette: ESC A on RFCOMM 2 returned the 28-byte status (media type
      3, battery 84 %); a 400-line test label sent on RFCOMM 3 printed upright,
      both after an ESC A 1 lock and with RFCOMM 3 alone. Status polled during
      the job reported printing, then the cutter cutting, then idle. ESC A sent
      on RFCOMM 3 is never answered.
    covers: [print.dpi, print.width_dots, mechanism.cutter, connectivity.serial]
  - id: owner-sdp-listing
    kind: user-report
    note: >-
      SDP records read on macOS: "iAP Accessory" (RFCOMM 1, Apple iAP UUID),
      "MLS DataPort" (RFCOMM 3, Serial Port 0x1101), HCRP print (0x1126, L2CAP
      PSM 4097), SDP server and PnP Information (0x1200). macOS Bluetooth info:
      name "DYMO ML 0EB7", vendor id 0x0922, product id 0x1009, firmware 0.0.2.
    covers: [connectivity.serial]
  - id: dymo-android-app
    kind: vendor-doc
    title: DYMO Connect for Android 2.0.892 (2017)
    note: >-
      Interoperability analysis of the app's .NET assemblies and native printer
      library: RFCOMM 2 for commands and 3 for jobs, opened by channel number;
      the 28-byte status field layout; the lock-then-print sequence; the D1
      paper table (printable widths); and that the job encoder is the same V2
      encoder as DYMO's macOS filter. Wire-format facts only.
    covers: [print.width_dots, print.width_mm, protocol.family]
  - id: dymo-macos-ppd
    kind: vendor-doc
    title: DYMO MobileLabeler PPD (lmmls.ppd) from DYMO's macOS CUPS driver package
    note: >-
      300 dpi, the five D1 widths and their cupsMediaType indices, imageable
      areas, and the cut / chain-mark / alignment options.
    covers: [print.dpi, print.media_width_mm, print.media]
  - id: opentlp-driver
    kind: oss-project
    url: https://github.com/opentlp/opentlp/tree/main/packages/core/src/drivers/dymo-lm-v2
    licence: MIT
    note: OpenTLP Core driver listing this model.
    covers: [support.blewebler2]
---

The DYMO MobileLabeler prints on D1 tape cassettes at 300 dpi over Bluetooth
Classic. It does not use the older LabelManager protocol of the PnP, 280 and
420P; DYMO drives it with the "V2" escape protocol described on the family
page.

## Bluetooth channels

| RFCOMM | Advertised as | Used for |
| --- | --- | --- |
| 1 | iAP Accessory | iOS app (Apple accessory protocol) |
| 2 | not advertised | commands: status, version, cutter |
| 3 | MLS DataPort (Serial Port) | print jobs only; never replies |

DYMO's Android app opens channels 2 and 3 by number and keeps both open. A
browser's Web Serial, and an operating system serial port, can only reach the
advertised serial port, so they can print but cannot read status. The printer
also offers an HCRP print service, which macOS uses when it is set up as a
Bluetooth printer.

While macOS holds a connection to the printer, other clients cannot open its
channels; disconnecting it from the Bluetooth menu frees them.

## Printable band

From DYMO's Android paper table, at 300 dpi:

| Tape | Printable | Raster line |
| --- | --- | --- |
| 6 mm | 60 dots (5.1 mm) | 64 bits |
| 9 mm | 80 dots (6.8 mm) | 80 bits |
| 12 mm | 94 dots (8.0 mm) | 96 bits |
| 19 mm | 158 dots (13.4 mm) | 160 bits |
| 24 mm | 224 dots (19.0 mm) | 224 bits |

## Not yet recorded

USB printing, and how the printer behaves when a job's line width does not
match the loaded cassette.
