---
id: dymo-lm-v2
name: DYMO LabelManager V2
summary: DYMO's escape-sequence tape protocol for the MobileLabeler — ESC D header plus raw raster per label; ESC A status on a separate command channel.
also_known_as: [DYMO V2 raster2dymolm]
transports: [serial]
acknowledges: false
raster:
  bit_order: msb-first
  polarity: 1-is-black
  row_padding: byte
  width_unit: dots
  compression:
    algorithm: none
  note: >-
    One raster line per print line, across the head. DYMO's Android app sends
    just the tape's printable band padded to whole bytes (64, 80, 96, 160 or 224
    bits for 6, 9, 12, 19 and 24 mm), filled from the label's bottom edge: dot 0
    is the bottom row. DYMO's macOS filter instead sends the full page width
    with the band inside it and a per-tape bit shift; both are accepted.
flow:
  control: none
  note: >-
    Jobs go to a channel that never answers. Status is a separate request and
    reply on the command channel.
commands:
  - opcode: 1b 41
    name: Status request
    direction: both
    payload: 1 lock byte (1 to claim the printer for a job, otherwise 0)
    description: >-
      Command channel. Replies with 28 bytes: print state (0), job id u32 (1–4),
      label index u16 (5–6), cutter (7), print head (8), density (9), main bay
      (10), media type u32 (11–14), secondary bay (15) and media type (16–19),
      power/charging nibbles (20), battery state/health nibbles (21), battery
      level (22), error id (23), alignment (27).
    status: confirmed
  - opcode: 1b 56
    name: Version request
    direction: both
    description: Command channel. Replies with 10 bytes (hardware revision, firmware revision, product id).
    status: inferred
  - opcode: 1b 57
    name: Sub-protocol message
    payload: length, control byte, u16 object id, payload
    description: Command channel. DYMO's app uses object 0x1007 to move the cutter (position 180 down, 0 up).
    status: inferred
  - opcode: 1b 73
    name: Start job
    payload: u32 LE job id
    description: The id is echoed in the status reply while the job prints.
    status: confirmed
  - opcode: 1b 6e
    name: Label index
    payload: u16 LE, starting at 1
    status: confirmed
  - opcode: 1b 6c
    name: Leader
    payload: u32 LE lines (DYMO default 36)
    status: confirmed
  - opcode: 1b 74
    name: Trailer
    payload: u32 LE lines (DYMO default 28)
    status: confirmed
  - opcode: 1b 44 01 02
    name: Print data header
    payload: u32 LE line count, u32 LE dots per line
    description: Followed directly by line count × dots/8 raster bytes, no per-line prefix.
    status: confirmed
  - opcode: 1b 45
    name: Form feed
    description: Between labels and at the end of the job, before the cut.
    status: confirmed
  - opcode: 1b 47
    name: Short form feed
    status: inferred
  - opcode: 1b 70 30
    name: Cut
    status: confirmed
  - opcode: 1b 70 31
    name: Chain mark
    description: Printed instead of a cut when chain marks are selected.
    status: inferred
  - opcode: 1b 51
    name: End job
    status: confirmed
implementations:
  - project: blewebler2
    module: packages/core/src/drivers/dymo-lm-v2
    url: https://github.com/opentlp/opentlp/tree/main/packages/core/src/drivers/dymo-lm-v2
    note: Print-only driver for the job channel, written from the wire-format facts on this page.
status: reported
sources:
  - kind: user-report
    note: >-
      Hardware test on a MobileLabeler: status read on RFCOMM 2, a test label
      printed upright from RFCOMM 3, with and without the status lock.
  - kind: vendor-doc
    title: DYMO Connect for Android 2.0.892 and DYMO's macOS CUPS driver package
    note: >-
      Interoperability analysis of DYMO's Android app and macOS filter and PPD.
      Only wire-format facts were recorded; no DYMO code is redistributed.
---

The V2 protocol is what DYMO's own software uses for the MobileLabeler. It is
unrelated to the older LabelManager protocol (`ESC B` dot tab, per-line `SYN`
prefixes) that open-source LabelManager tools implement.

## Channels

On Bluetooth the printer separates jobs from commands. DYMO's Android app opens
RFCOMM channel 3 for jobs and channel 2, which is not in the SDP record list,
for commands, both by channel number. A job sent on channel 3 prints even when
channel 2 is never opened.

## Job

```text
ESC s <job id>
per label:
  [ESC E, ESC p 0]                         between labels only
  ESC n <index>  ESC l <leader>  ESC t <trailer>
  ESC D 01 02 <lines> <dots per line>  <raster>
ESC E  ESC p 0  ESC Q
```

Label length is simply the line count; there are no fixed label sizes on the
wire. DYMO's encoder only fills in the dots-per-line field for labels longer
than 210 lines; keep labels above that.

Before a job, DYMO's app sends `ESC A 1` on the command channel, up to five
times three seconds apart, until the reply shows job id 0, print state idle,
print head OK, cutter idle and no error id.

## Status values

- Print state: 0 idle, 1 printing, 2 error, 3 cancelled.
- Cutter: 0 none, 1 idle, 2 cutting, 3 cleaning, 4 jammed.
- Main bay: 0 unknown, 1 open, 2 no media, 3 inserted improperly, 4 present
  (status unknown), 5 empty, 6 critically low, 7 low, 8 OK, 9 jammed,
  10 counterfeit.
- Media type: 0 empty; 1–15 cycle 24, 19, 12, 6, 9 mm.
- Battery level: percent, 255 when unknown.
- Error ids include 16 no cassette, 18 jam, 19 out of media, 22 door open,
  24 print head overheated, 25 cutter jam, 28 not enough power, 48/49 battery
  critically low / low.
