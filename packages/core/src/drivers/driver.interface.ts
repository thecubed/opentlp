import { IDeviceTransport } from "../core/transports/transport.interface";
import type { LoadedMedia, PrinterStatus, StatusField } from "./printer-status";

export type SupportLevel = 
    | 'Tested' 
    | 'Untested' 
    | 'Unsupported';

export type TransportKind =
    | 'bluetooth-le'
    | 'bluetooth-classic'
    | 'usb-serial'
    | 'usb';

export type PrinterKind =
    | 'pocket'
    | 'label'
    | 'receipt';

/**
 * Definition of a specific physical printer model for offline simulation and UI selection.
 */
export interface PrinterModelProfile {
    id: string; // e.g., 'marklife_p12', 'niimbot_d11', 'generic_12mm'
    /**
     * Stable id in packages/hardware/devices when it differs from this
     * driver's internal profile id. Omit when both ids are identical.
     *
     * The reference is one-way: every value here must resolve to a hardware
     * entry, while a hardware entry is allowed to have no driver at all.
     */
    tohId?: string;
    brand: string;
    model: string;
    family?: string;
    /**
     * Public commercial name of the manufacturer's original mobile app
     * (e.g. 'Tiny Print', 'Pocket Print', 'WalkPrint', 'Fun Print', 'Phomemo', 'NIIMBOT', 'Marklife').
     */
    app?: string;
    /**
     * List of commercial manufacturer apps this model or its driver replaces.
     */
    replacesApps?: readonly string[];
    /**
     * General hardware form factor: 'pocket' (continuous 58mm), 'label' (die-cut / tape), 'receipt' (POS).
     */
    kind?: PrinterKind;
    /**
     * Hardware form factor(s) supported by this profile.
     */
    supportedKinds?: readonly PrinterKind[];
    /**
     * Physical transport kinds supported by this specific hardware model.
     * (e.g. ['bluetooth-le'], or ['bluetooth-le', 'bluetooth-classic', 'usb-serial'])
     */
    supportedTransports?: readonly TransportKind[];
    /**
     * Other names this exact product is sold under — house brands, rebadges,
     * the name on the box rather than on the firmware.
     *
     * Purely for finding it. Someone who bought a "SilverCrest" searches for
     * SilverCrest, and a table that only knows `brand`, `model` and `family`
     * returns nothing, which reads as "not supported" rather than "listed under
     * another name". Curated per model, because a rebadge is a fact somebody
     * confirmed, not something to infer from a similar-looking part number.
     *
     * Explicitly *not* a mechanism for sharing capabilities, artwork or
     * anything else between models. Two products with the same insides can
     * still differ in the ways that matter, and an alias must never be the
     * reason the app claims something about hardware.
     */
    aliases?: string[];
    /**
     * True when no product is actually sold as `brand` + `model`.
     *
     * Some machines only ever reach buyers rebadged. The L13 is one: it is
     * driven by the Marklife driver and belongs to that family technically, but
     * Marklife sells no L13 of their own — it ships as SilverCrest, MUNBYN,
     * luckjingle and unbranded. Listing it as "Marklife L13" states a product
     * that does not exist, and someone would go looking for it.
     *
     * `brand` still records which driver family the machine belongs to, because
     * that is what determines whether the app can talk to it. This flag is how
     * the UI knows not to read that as a name on a box.
     */
    rebadgeOnly?: boolean;
    imageUrl?: string;
    capabilities: PrinterCapabilities;
    
    // UI Documentation fields
    supportLevel?: SupportLevel;
    /**
     * Static product facts as markdown — manufacturer, certification ids,
     * physical size, cell capacity.
     *
     * Keep these source-maintained facts separate from live device readings such
     * as battery level, firmware version and serial number.
     */
    notes?: string;
    manualUrl?: string;
    /**
     * Optional model-specific connection guidance and pairing hints overriding driver defaults.
     */
    connectionHints?: ConnectionHints;
}

/**
 * Optional pairing, connection, and device discovery hints supplied by a driver or model profile.
 */
export interface ConnectionHints {
    /** Custom advice or device name hints for Web Bluetooth / BLE discovery */
    bleHint?: string;
    /** Custom advice or device name hints for OS Bluetooth Classic pairing */
    bluetoothClassicHint?: string;
    /** Windows-specific Bluetooth Classic hint (e.g. "SPP Slave") */
    windowsClassicHint?: string;
    /** PIN code if required (e.g. "0000" or "1234") */
    pairingPin?: string;
}

/**
 * Definition of the printer's capabilities exposed to the designer UI.
 */
export interface PrinterCapabilities {
    /** Maximum print density level */
    maxDensity: number;
    /** 
     * The fixed height of the software canvas (in pixels), typically matching the physical printhead resolution.
     * COORDINATE SYSTEM CONVENTION: Height = Fixed, Width = Variable (Length of tape)
     */
    canvasHeightPx: number;
    /** Whether printer supports multiple print darkness modes like 'speed' vs 'clarity' */
    supportsSpeedMode: boolean;
    /** The color capabilities of the printer. */
    colorSupport: {
        type: 'color' | 'grayscale' | 'monochrome';
        shades?: number;
        /**
         * Which form of page this driver's `printPage` accepts.
         *
         * 'spot' means separated planes, one per developed channel — plain
         * monochrome is simply the one-plane case, which is why it is not a
         * third option and why every existing driver keeps working unchanged.
         * 'rgb' means a full-gamut bitmap the device halftones itself.
         *
         * Omitted means 'spot'.
         */
        model?: 'spot' | 'rgb';
        /**
         * How many separated planes this driver accepts ('spot' only).
         *
         * The renderer treats this as its channel budget, so a design using more
         * inks than the hardware can develop is resolved down *before* it is
         * drawn rather than merged afterwards. Omitted means 1.
         */
        channels?: number;
    };
    /** Device resolution in dots per millimeter (dpmm). E.g. 203 DPI = 8 dpmm, 300 DPI = 12 dpmm. */
    dpmm: number;
    /** Stable id of the driver handling this printer (e.g. "marklife-0x1f"). */
    driverId?: string;
    /** Display name of the driver handling this printer. */
    driverName?: string;
    /** Physical geometry of the printer mechanism */
    physical?: {
        /** Measured printhead-to-cutter distance in dots. A fresh cut edge already has this much blank tape before the first printable dot. */
        headToCutterPx?: number;
        /** Supported physical paper/media widths in millimeters. Can be a single width or a min/max range. */
        supportedMediaWidthsMm?: number | { min: number; max: number };
        /**
         * How much of each media width can carry ink, for printers that place a
         * narrower printable band on the media by its width rather than using
         * the whole head (DYMO D1 cassettes: 13.4 mm of 19 mm tape). The band is
         * centred on the media. Widths not listed print across the media, up to
         * the head.
         */
        printableBandsMm?: ReadonlyArray<{ mediaWidthMm: number; printableWidthMm: number }>;
        /** Indicates if the printer requires special paper with an RFID/NFC chip */
    };
    /** 
     * Default or detected properties of the loaded media (spool/tape).
     * If the printer cannot auto-detect these, they serve as sensible defaults for the UI.
     */
    mediaDefaults?: {
        /** Minimum commanded feed before the raster (continuous only), excluding the physical head-to-cutter distance. */
        feedBeforeMinPx?: number;
        /** Maximum feed before printing starts (continuous only) in dots/pixels */
        feedBeforeMaxPx?: number;
        /** Default commanded feed before the raster in dots. */
        feedBeforeDefaultPx?: number;

        /** Minimum commanded feed after the raster in dots; cutter models need at least headToCutterPx to reach a clean cut. */
        feedAfterMinPx?: number;
        /** Maximum feed after printing ends (continuous only) in dots/pixels */
        feedAfterMaxPx?: number;
        /** Default commanded feed after the raster in dots; the cut label's trailing margin is this minus headToCutterPx. */
        feedAfterDefaultPx?: number;
    };
}

import type { PaperProfile } from "../types/paper";
import type { UniversalPage } from "../types/ink";

/** Progress and cancellation for a multi-page print. */
export interface PrintPagesHooks {
    /** Called after each page is sent, with how many are done. */
    onPage?(done: number, total: number): void;
    /** Stop after the current page. */
    signal?: AbortSignal;
}

/**
 * Unified Print Task Options sent from the UI designer hook
 */
export interface UniversalPrintOptions {
    density: number;
    copies: number;
    speed?: number; // Optional speed setting if supported
    
    /** The physical paper being printed on */
    paper?: PaperProfile;
    
    /** Optional manual overrides for continuous feed */
    feedOverrides?: {
        feedBeforeMm?: number;
        feedAfterMm?: number;
    };
}

/**
 * Universal container for image buffers carrying dimension metadata together.
 * Designed to structurally match browser ImageData.data layout for zero-friction Web integrations.
 * 
 * COORDINATE SYSTEM CONVENTION:
 * The software canvas is defined using the User Interface coordinate system:
 * - Height: Fixed to the printhead's resolution (e.g., 96px for 12mm tape).
 * - Width: Variable, representing the length of the label tape.
 * 
 * This convention MUST be followed by all UI and core modules. 
 * Any required rotation or deconstruction for hardware protocols must be 
 * handled entirely within the specific device driver's `printPage` implementation.
 */
export interface UniversalImageData {
    data: Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
}

/**
 * IPrinterDriver is the "PPD + Filter" equivalent.
 * It encapsulates capabilities, and converts standard inputs 
 * (like an ImageData object) into the printer's specific control sequences.
 */
export interface IPrinterDriver {
    /**
     * Stable, machine-readable driver identifier (e.g. "marklife-0x1f",
     * "catprinter-tiny-standard", "niimbot"). Consumers key off this rather
     * than {@link name}, which is a human-readable display label that may change.
     */
    readonly id: string;

    /**
     * Human-readable driver name for display (e.g., "Marklife-0x1F",
     * "Niimbot Generic Printer"). Not a stable identifier; use {@link id} for
     * matching and selection.
     */
    readonly name: string;

    /**
     * Distinguishes physical hardware drivers from virtual/simulation drivers.
     * The PrintManager uses this for fallback logic instead of comparing name strings.
     */
    readonly driverType: 'hardware' | 'virtual';

    /**
     * Services / Characteristics needed to interact with this printer.
     * The PrintManager uses this to ask the Transport to request proper BLE permissions.
     */
    readonly connectionRequirements: {
        services: string[];
        namePrefixes?: string[];
    };

    /**
     * Optional static/instance list of explicitly supported physical models.
     * This is used by the UI to build offline model simulation dropdowns,
     * so that the UI does not need to maintain its own hardcoded registries.
     */
    supportedModels?: PrinterModelProfile[];

    /**
     * Default commercial mobile app name associated with this driver family.
     */
    readonly app?: string;

    /**
     * Official commercial mobile app name(s) this driver family replaces
     * (e.g. ['Tiny Print', 'Pocket Print', 'iPrint']).
     */
    readonly replacesApps?: readonly string[];

    /**
     * Default device form factor for models in this driver family.
     */
    readonly defaultKind?: PrinterKind;

    /**
     * Device form factor(s) supported by this driver family.
     */
    readonly supportedKinds?: readonly PrinterKind[];

    /**
     * Physical transport kinds accepted by this driver.
     * Defaults to ['bluetooth-le', 'bluetooth-classic', 'usb-serial'] if unspecified.
     */
    readonly supportedTransports?: readonly TransportKind[];

    /**
     * Optional connection guidance and pairing hints specific to this driver family.
     */
    readonly connectionHints?: ConnectionHints;

    /**
     * Match function used by the PrintManager to verify if this driver 
     * is compatible with the connected device (e.g. comparing device name prefix).
     */
    isCompatible(deviceName: string): boolean;

    /**
     * Inform the driver of the user-selected or matched model ID/name,
     * allowing it to configure model-specific offsets, dimensions, or protocol options
     * when connecting via generic transports (e.g. serial ports without advertised device names).
     */
    setModel?(model: string): void;

    /**
     * Bind the driver to a connected transport.
     */
    bindTransport(transport: IDeviceTransport): Promise<void>;

    /**
     * Release the transport binding and clean up all event listeners,
     * timers, and any open handles. Called by PrintManager on disconnect.
     * 
     * Must be implemented even if the driver has nothing to clean up (use an empty body).
     * BLE connection leaks are a common source of "device busy" errors on reconnect.
     */
    unbindTransport(): Promise<void>;

    /**
     * Get the hardware capabilities of this printer model.
     */
    getCapabilities(): PrinterCapabilities;

    /**
     * Readings this driver can produce, declared up front.
     *
     * Answered without talking to the printer, so a UI can lay out a battery
     * slot or a media row *before* the first read — and, more importantly, can
     * leave them out entirely on hardware that will never fill them. Absent
     * means the driver reports nothing.
     */
    readonly reports?: readonly StatusField[];

    /**
     * Read the printer's current state.
     *
     * Returns values, not prose: battery as a fraction, widths in millimetres,
     * faults as codes. Optional, because most of the supported hardware is
     * write-only and cannot answer questions at all — a driver that omits this
     * is making a true statement about its protocol.
     *
     * Throws {@link PrinterError} rather than a bare `Error`, so a caller can
     * distinguish a timeout worth retrying from a command the firmware will
     * never support.
     */
    getStatus?(): Promise<PrinterStatus>;

    /**
     * Enrich an identified consumable with facts the driver can resolve locally,
     * such as dimensions held in a bundled manufacturer-specific mapping.
     * Optional and driver-owned so vendor semantics never leak into
     * shared UI. Connection-time resolution must not make network requests.
     */
    resolveMedia?(media: LoadedMedia): Promise<LoadedMedia>;

    /**
     * Initialize a print job (e.g. Handshake, Set density, Set Paper Type)
     */
    printInit(options: UniversalPrintOptions): Promise<void>;

    /**
     * Encodes and transmits the page to the printer.
     * The driver must handle flow control and chunking internally using the connected transport.
     *
     * The page always arrives in the colour model this driver declared, carrying
     * no more planes than its declared `colorSupport.channels`. That is a
     * guarantee from PrintManager, not a hint — a single-channel driver can call
     * `singlePlane(page)` and get on with encoding, and must never contain logic
     * for degrading colour it cannot print.
     *
     * @param page Separated planes (spot) or a full-gamut bitmap (rgb), with dimensions.
     */
    printPage(page: UniversalPage): Promise<void>;

    /**
     * Print several pages as ONE job, between `printInit` and `printEnd`.
     *
     * For printers that separate labels inside a job (a cut between them)
     * rather than needing a job per label. Optional: without it, PrintManager
     * prints a batch as one job per page. Must stop after the current page
     * once `signal` aborts, still closing the job properly.
     */
    printPages?(pages: readonly UniversalPage[], hooks?: PrintPagesHooks): Promise<void>;

    /**
     * Commits the print job and closes the session. (e.g. Send print end command, align or cut)
     */
    printEnd(): Promise<void>;
}
