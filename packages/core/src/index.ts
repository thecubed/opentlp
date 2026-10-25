import { PrintManager as _PrintManager } from "./core/print-manager";
export type PrintManager = _PrintManager;
export const PrintManager = _PrintManager;
export type { PrinterDriverChoice, DiagnosticLogger, DeviceDiagnostic, CandidateDriverInfo } from "./core/print-manager";

// Interfaces (transport + driver contracts — always safe to import)
export * from "./core/transports/transport.interface";
export type { RfcommBridge, RfcommBridgeDevice, RfcommBridgeTransportOptions } from "./core/transports/rfcomm-bridge-transport";
export * from "./drivers/driver.interface";
// Printer artwork: the picture of each model and what its parts can do.
export * from "./drivers/printer-artwork";
export * from "./drivers/printer-status";
export * from "./drivers/printer-error";
export { MARKLIFE_ARTWORK, MARKLIFE_P12_ARTWORK, MARKLIFE_P50_ARTWORK, marklifeArtwork } from "./drivers/marklife";
export * from "./types/paper";
export * from "./types/ink";
// Drivers
import { MarklifeDriver as _MarklifeDriver, MARKLIFE_PROFILES } from "./drivers/marklife";
export type MarklifeDriver = _MarklifeDriver;
export const MarklifeDriver = _MarklifeDriver;
export { MARKLIFE_PROFILES };

import { CatPrinterDriver as _CatPrinterDriver, CATPRINTER_MODELS } from "./drivers/catprinter-tiny";
export type CatPrinterDriver = _CatPrinterDriver;
export const CatPrinterDriver = _CatPrinterDriver;
export { CATPRINTER_MODELS };

import { CatPrinterMxw01Driver as _CatPrinterMxw01Driver, CATPRINTER_MXW01_MODELS } from "./drivers/catprinter-mxw01";
export type CatPrinterMxw01Driver = _CatPrinterMxw01Driver;
export const CatPrinterMxw01Driver = _CatPrinterMxw01Driver;
export { CATPRINTER_MXW01_MODELS };

import { CatPrinterV5gDriver as _CatPrinterV5gDriver, CATPRINTER_V5G_MODELS } from "./drivers/catprinter-v5g";
export type CatPrinterV5gDriver = _CatPrinterV5gDriver;
export const CatPrinterV5gDriver = _CatPrinterV5gDriver;
export { CATPRINTER_V5G_MODELS };

import { CatPrinterV5cDriver as _CatPrinterV5cDriver, CATPRINTER_V5C_MODELS } from "./drivers/catprinter-v5c";
export type CatPrinterV5cDriver = _CatPrinterV5cDriver;
export const CatPrinterV5cDriver = _CatPrinterV5cDriver;
export { CATPRINTER_V5C_MODELS };

import { FunnyLxDriver as _FunnyLxDriver, FUNNY_LX_MODELS } from "./drivers/catprinter-funny-lx";
export type FunnyLxDriver = _FunnyLxDriver;
export const FunnyLxDriver = _FunnyLxDriver;
export { FUNNY_LX_MODELS };

import { PhomemoDqDriver as _PhomemoDqDriver, PHOMEMO_DQ_MODELS } from "./drivers/phomemo-dq";
export type PhomemoDqDriver = _PhomemoDqDriver;
export const PhomemoDqDriver = _PhomemoDqDriver;
export { PHOMEMO_DQ_MODELS };

import { PhomemoM110Driver as _PhomemoM110Driver, PHOMEMO_M110_MODELS } from "./drivers/phomemo-m110";
export type PhomemoM110Driver = _PhomemoM110Driver;
export const PhomemoM110Driver = _PhomemoM110Driver;
export { PHOMEMO_M110_MODELS };

import { PhomemoM02Driver as _PhomemoM02Driver, PHOMEMO_M02_MODELS } from "./drivers/phomemo-m02";
export type PhomemoM02Driver = _PhomemoM02Driver;
export const PhomemoM02Driver = _PhomemoM02Driver;
export { PHOMEMO_M02_MODELS };

import { PhomemoMSeriesDriver as _PhomemoMSeriesDriver, PHOMEMO_M_SERIES_MODELS } from "./drivers/phomemo-m-series";
export type PhomemoMSeriesDriver = _PhomemoMSeriesDriver;
export const PhomemoMSeriesDriver = _PhomemoMSeriesDriver;
export { PHOMEMO_M_SERIES_MODELS };

import { PhomemoP12Driver as _PhomemoP12Driver, PHOMEMO_P12_MODELS } from "./drivers/phomemo-p12";
export type PhomemoP12Driver = _PhomemoP12Driver;
export const PhomemoP12Driver = _PhomemoP12Driver;
export { PHOMEMO_P12_MODELS };

import { PhomemoM04Driver as _PhomemoM04Driver, PHOMEMO_M04_MODELS } from "./drivers/phomemo-m04";
export type PhomemoM04Driver = _PhomemoM04Driver;
export const PhomemoM04Driver = _PhomemoM04Driver;
export { PHOMEMO_M04_MODELS };

import { PhomemoTsplDriver as _PhomemoTsplDriver, PHOMEMO_TSPL_MODELS } from "./drivers/phomemo-tspl";
export type PhomemoTsplDriver = _PhomemoTsplDriver;
export const PhomemoTsplDriver = _PhomemoTsplDriver;
export { PHOMEMO_TSPL_MODELS };

import { OrgstaS001Driver as _OrgstaS001Driver, ORGSTA_S001_MODELS } from "./drivers/yk";
export type OrgstaS001Driver = _OrgstaS001Driver;
export const OrgstaS001Driver = _OrgstaS001Driver;
export { ORGSTA_S001_MODELS };

import { PeriPageDriver as _PeriPageDriver, PERIPAGE_MODELS } from "./drivers/peripage";
export type PeriPageDriver = _PeriPageDriver;
export const PeriPageDriver = _PeriPageDriver;
export { PERIPAGE_MODELS };
import { NelkoP21Driver as _NelkoP21Driver, NELKO_P21_MODELS } from "./drivers/nelko-p21";
export type NelkoP21Driver = _NelkoP21Driver;
export const NelkoP21Driver = _NelkoP21Driver;
export { NELKO_P21_MODELS };

import { DymoLmV2Driver as _DymoLmV2Driver, DYMO_LM_V2_MODELS } from "./drivers/dymo-lm-v2";
export type DymoLmV2Driver = _DymoLmV2Driver;
export const DymoLmV2Driver = _DymoLmV2Driver;
export { DYMO_LM_V2_MODELS };

import { NiimbotDriver as _NiimbotDriver } from "./drivers/niimbot";
export type NiimbotDriver = _NiimbotDriver;
export const NiimbotDriver = _NiimbotDriver;

import { DummyDriver as _DummyDriver } from "./drivers/dummy";
export type DummyDriver = _DummyDriver;
export const DummyDriver = _DummyDriver;

// NOTE: Transports are NOT exported from the main index to prevent cross-environment
// bundling failures (e.g. Node BLE native bindings breaking web builds).
// Import the transport you need via its dedicated subpath:
//   import { NodeBleTransport }       from "universal-label-core/transport/node"
//   import { BluetoothTransport }     from "universal-label-core/transport/web"
//   import { CapacitorBleTransport }  from "universal-label-core/transport/capacitor"
//   import { CapacitorUsbTransport }  from "universal-label-core/transport/capacitor-usb"
//   import { CapacitorClassicTransport } from "universal-label-core/transport/capacitor-classic"
//   import { WebUsbTransport }        from "universal-label-core/transport/usb"
//   import { WebSerialTransport }     from "universal-label-core/transport/web-serial"
//   import { RfcommBridgeTransport }  from "universal-label-core/transport/rfcomm-bridge"
//   import { NodeUsbTransport }       from "universal-label-core/transport/node-usb"
//   import { NodeSerialTransport }    from "universal-label-core/transport/node-serial"
//   import { DummyTransport }         from "universal-label-core/transport/dummy"
