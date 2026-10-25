import EventEmitter from "eventemitter3";
import { IDeviceTransport } from "./transports/transport.interface";
import { IPrinterDriver, UniversalPrintOptions, PrinterModelProfile, PrinterKind, PrintPagesHooks } from "../drivers/driver.interface";
import type { LoadedMedia, PrinterStatus, StatusField } from "../drivers/printer-status";
import { PrinterError, toPrinterError } from "../drivers/printer-error";
import type { UniversalPage } from "../types/ink";
import { reduceToChannels } from "../types/ink";

import { MarklifeDriver } from "../drivers/marklife";
import { NiimbotDriver } from "../drivers/niimbot";
import { CatPrinterDriver } from "../drivers/catprinter-tiny";
import { CatPrinterMxw01Driver } from "../drivers/catprinter-mxw01";
import { CatPrinterV5gDriver } from "../drivers/catprinter-v5g";
import { CatPrinterV5cDriver } from "../drivers/catprinter-v5c";
import { FunnyLxDriver } from "../drivers/catprinter-funny-lx";
import { PhomemoDqDriver } from "../drivers/phomemo-dq";
import { PhomemoM110Driver } from "../drivers/phomemo-m110";
import { PhomemoM02Driver } from "../drivers/phomemo-m02";
import { PhomemoMSeriesDriver } from "../drivers/phomemo-m-series";
import { PhomemoP12Driver } from "../drivers/phomemo-p12";
import { PhomemoM04Driver } from "../drivers/phomemo-m04";
import { PhomemoTsplDriver } from "../drivers/phomemo-tspl";
import { OrgstaS001Driver } from "../drivers/yk";
import { PeriPageDriver } from "../drivers/peripage";
import { NelkoP21Driver } from "../drivers/nelko-p21";
import { DymoLmV2Driver } from "../drivers/dymo-lm-v2";
import { DummyDriver } from "../drivers/dummy";

export interface PrintManagerEvents {
    connected: (driver: IPrinterDriver) => void;
    disconnected: () => void;
    printing: () => void;
    idle: () => void;
    error: (error: Error) => void;
}

/** Diagnostic sink for the PrintManager. Defaults to silent; inject one to observe. */
export type DiagnosticLogger = (level: 'info' | 'warn', message: string) => void;

export interface PrinterDriverChoice {
    /** Stable driver id accepted by connect/connectWithTransport. */
    driverId: string;
    /** Human-readable name for display. */
    name: string;
    /** Number of model profiles explicitly associated with the driver. */
    modelCount: number;
}

export interface CandidateDriverInfo {
    driverId: string;
    driverName: string;
    matchedBy: 'name' | 'service' | 'both' | 'prefix-hint';
    reasons: string[];
    supportedModels: PrinterModelProfile[];
}

export interface DeviceDiagnostic {
    deviceName?: string;
    transportType: string;
    discoveredServices: string[];
    candidates: CandidateDriverInfo[];
    suggestedDriverId?: string;
}

/**
 * PrintManager acts as the central spooler orchestrating Transports and Drivers.
 * UI integrations will interface primarily with this class.
 */
export class PrintManager extends EventEmitter<PrintManagerEvents> {
    private activeTransport?: IDeviceTransport;
    private activeDriver?: IPrinterDriver;
    private activeModelProfile?: PrinterModelProfile;
    private registeredDrivers: IPrinterDriver[] = [];

    private isPrinting: boolean = false;
    private readonly logger: DiagnosticLogger;

    constructor(logger?: DiagnosticLogger) {
        super();
        this.logger = logger ?? (() => {});
        this.registerDriver(new MarklifeDriver('auto'));
        this.registerDriver(new MarklifeDriver('0x10ff'));
        this.registerDriver(new NiimbotDriver());
        this.registerDriver(new CatPrinterDriver('standard'));
        this.registerDriver(new CatPrinterDriver('prefixed'));
        this.registerDriver(new CatPrinterMxw01Driver());
        this.registerDriver(new CatPrinterV5gDriver());
        this.registerDriver(new CatPrinterV5cDriver());
        this.registerDriver(new FunnyLxDriver());
        this.registerDriver(new PhomemoDqDriver());
        this.registerDriver(new PhomemoM110Driver());
        this.registerDriver(new PhomemoM02Driver());
        this.registerDriver(new PhomemoMSeriesDriver());
        this.registerDriver(new PhomemoP12Driver());
        this.registerDriver(new PhomemoM04Driver());
        this.registerDriver(new PhomemoTsplDriver());
        this.registerDriver(new OrgstaS001Driver());
        this.registerDriver(new PeriPageDriver());
        this.registerDriver(new NelkoP21Driver());
        this.registerDriver(new DymoLmV2Driver());
        // Dummy is intentionally last because it accepts any virtual device.
        this.registerDriver(new DummyDriver());
    }

    /**
     * Register a new printer profile (Driver/Filter) into the system.
     */
    registerDriver(driver: IPrinterDriver) {
        this.registeredDrivers.push(driver);
    }

    /** Driver families a user can select when automatic detection is inconclusive. */
    getAvailableDriverChoices(): PrinterDriverChoice[] {
        return this.registeredDrivers
            .filter(driver => driver.driverType === 'hardware')
            .map(driver => ({ driverId: driver.id, name: driver.name, modelCount: driver.supportedModels?.length ?? 0 }));
    }

    /**
     * Get a flattened list of all printer models explicitly supported by registered drivers.
     * This allows the UI to build a "Default Printer" selection without needing a hardcoded registry.
     */
    getAvailablePrinterProfiles(): PrinterModelProfile[] {
        const seen = new Set<string>();
        const uniqueProfiles: PrinterModelProfile[] = [];
        for (const driver of this.registeredDrivers) {
            for (const profile of driver.supportedModels || []) {
                if (!seen.has(profile.id)) {
                    seen.add(profile.id);
                    const mergedProfile: PrinterModelProfile = {
                        ...profile,
                        app: profile.app ?? driver.app,
                        replacesApps: profile.replacesApps ?? driver.replacesApps,
                        kind: profile.kind ?? driver.defaultKind,
                        supportedKinds: profile.supportedKinds ?? driver.supportedKinds,
                        supportedTransports: profile.supportedTransports ?? driver.supportedTransports,
                        connectionHints: profile.connectionHints ?? driver.connectionHints
                    };
                    uniqueProfiles.push(mergedProfile);
                }
            }
        }
        
        // Sort alphabetically by brand, then model
        return uniqueProfiles.sort((a, b) => {
            if (a.brand !== b.brand) return a.brand.localeCompare(b.brand);
            return a.model.localeCompare(b.model);
        });
    }

    /**
     * Returns a sorted, unique list of all official manufacturer mobile apps
     * replaced across all registered drivers.
     */
    getReplacedApps(): string[] {
        const apps = new Set<string>();
        for (const driver of this.registeredDrivers) {
            if (driver.replacesApps) {
                for (const app of driver.replacesApps) {
                    if (app) apps.add(app);
                }
            } else if (driver.app) {
                apps.add(driver.app);
            }
            if (driver.supportedModels) {
                for (const m of driver.supportedModels) {
                    if (m.replacesApps) {
                        for (const app of m.replacesApps) {
                            if (app) apps.add(app);
                        }
                    } else if (m.app) {
                        apps.add(m.app);
                    }
                }
            }
        }
        return Array.from(apps).sort((a, b) => a.localeCompare(b));
    }

    /**
     * Finds all registered drivers that replace the given mobile app.
     */
    getDriversForApp(appName: string): IPrinterDriver[] {
        const lower = appName.toLowerCase().trim();
        return this.registeredDrivers.filter(driver => {
            const matchesReplaces = driver.replacesApps?.some(a => a.toLowerCase().trim() === lower);
            const matchesApp = driver.app && driver.app.toLowerCase().trim() === lower;
            const matchesModels = driver.supportedModels?.some(m =>
                m.replacesApps?.some(a => a.toLowerCase().trim() === lower) ||
                (m.app && m.app.toLowerCase().trim() === lower)
            );
            return Boolean(matchesReplaces || matchesApp || matchesModels);
        });
    }

    /**
     * Returns the printer kinds (form factors) supported by the drivers that replace the given app.
     */
    getKindsForApp(appName: string): PrinterKind[] {
        const drivers = this.getDriversForApp(appName);
        const kinds = new Set<PrinterKind>();
        for (const driver of drivers) {
            if (driver.supportedKinds) {
                for (const k of driver.supportedKinds) kinds.add(k);
            } else if (driver.defaultKind) {
                kinds.add(driver.defaultKind);
            }
            if (driver.supportedModels) {
                for (const m of driver.supportedModels) {
                    if (m.kind) kinds.add(m.kind);
                }
            }
        }
        return Array.from(kinds);
    }

    /**
     * Finds a registered driver associated with the given mobile app name and optional form factor kind.
     */
    getDriverForApp(appName: string, kind?: PrinterKind): IPrinterDriver | undefined {
        const drivers = this.getDriversForApp(appName);
        if (drivers.length === 0) return undefined;
        if (!kind) return drivers[0];

        const match = drivers.find(d => {
            if (d.supportedKinds?.includes(kind)) return true;
            if (d.defaultKind === kind) return true;
            return d.supportedModels?.some(m => m.kind === kind);
        });
        // When a form factor is requested, only return a driver that actually
        // supports it — falling back to the first driver would silently pick a
        // different protocol (e.g. a label driver for a pocket request).
        return match;
    }

    /**
     * Resolves the closest matching physical PrinterModelProfile from a driver's supported models
     * using the advertised Bluetooth/device name.
     */
    detectModelForDriver(driver: IPrinterDriver, deviceName?: string): PrinterModelProfile | undefined {
        if (!driver.supportedModels || driver.supportedModels.length === 0) {
            return undefined;
        }

        if (deviceName) {
            const cleanDeviceName = deviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
            // Sort longest model name first to avoid short prefix shadowing (e.g. D11 vs D110 or P12 vs P12_PRO)
            const sortedModels = [...driver.supportedModels].sort((a, b) => b.model.length - a.model.length);

            for (const m of sortedModels) {
                const cleanModel = m.model.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (cleanDeviceName.includes(cleanModel)) {
                    return m;
                }
                if (m.aliases) {
                    for (const alias of m.aliases) {
                        const cleanAlias = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (cleanDeviceName.includes(cleanAlias)) {
                            return m;
                        }
                    }
                }
            }
        }

        return driver.supportedModels[0];
    }

    /**
     * Finds a registered driver that explicitly supports the given model ID or model name.
     */
    getDriverForModel(modelId: string): IPrinterDriver | undefined {
        const idLower = modelId.toLowerCase();
        if (idLower.startsWith('auto:')) {
            const key = idLower.slice(5);
            if (key === 'pocket_print_label' || key === 'pocket_printer_label') {
                return this.registeredDrivers.find(d => d.id === 'marklife-0x10ff');
            }
            if (key === 'tiny_print') {
                return this.registeredDrivers.find(d => d.id === 'catprinter-tiny-standard');
            }
            if (key === 'marklife') {
                return this.registeredDrivers.find(d => d.id === 'marklife-0x1f');
            }
            if (key === 'niimbot') {
                return this.registeredDrivers.find(d => d.id === 'niimbot');
            }
            if (key === 'walkprint') {
                return this.registeredDrivers.find(d => d.id === 'catprinter-mxw01');
            }
            if (key === 'fun_print') {
                return this.registeredDrivers.find(d => d.id === 'catprinter-funny-lx');
            }
            if (key === 'phomemo_pocket') {
                return this.registeredDrivers.find(d => d.id === 'phomemo-m02');
            }
            if (key === 'phomemo_label' || key === 'print_master') {
                return this.registeredDrivers.find(d => d.id === 'phomemo-m110');
            }
            if (key === 'labelife') {
                return this.registeredDrivers.find(d => d.id === 'phomemo-tspl');
            }
            if (key === 'peripage') {
                return this.registeredDrivers.find(d => d.id === 'peripage');
            }
            const cleanApp = key.replace(/_/g, ' ');
            const byApp = this.getDriverForApp(cleanApp);
            if (byApp) return byApp;
        }

        const cleanId = idLower.replace(/[^a-z0-9]/g, '');
        return this.registeredDrivers.find(driver =>
            driver.supportedModels?.some(m =>
                m.id.toLowerCase() === idLower ||
                m.id.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanId ||
                m.model.toLowerCase() === idLower ||
                m.model.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanId ||
                (m.aliases && m.aliases.some(alias => {
                    const aliasLower = alias.toLowerCase();
                    const cleanAlias = aliasLower.replace(/[^a-z0-9]/g, '');
                    return aliasLower.includes(idLower) ||
                        idLower.includes(aliasLower) ||
                        cleanAlias.includes(cleanId) ||
                        cleanId.includes(cleanAlias);
                }))
            )
        );
    }

    /**
     * Connects to a printer utilizing the provided transport.
     * The Manager aggregates connection requirements from all registered drivers
     * so that any supported printer can be discovered.
     */
    async connect(transport: IDeviceTransport, preferredDriverId?: string, modelId?: string): Promise<void> {
        if (this.activeTransport && this.activeTransport.isConnected()) {
            await this.disconnect();
        }

        this.activeTransport = transport;

        const resolvedModelDriver = (modelId && modelId !== 'none' && modelId !== 'unknown')
            ? this.getDriverForModel(modelId)
            : undefined;

        // Aggregate All Services from all drivers to request proper BLE permissions
        // and name prefixes for discovery hints
        const allServices = new Set<string>();
        const allPrefixes = new Set<string>();
        const preferredDriver = preferredDriverId
            ? this.registeredDrivers.find(driver => driver.id === preferredDriverId)
            : resolvedModelDriver;
        if (preferredDriverId && !preferredDriver) {
            throw new Error(`Unknown printer driver: ${preferredDriverId}`);
        }
        const discoveryDrivers = preferredDriver ? [preferredDriver] : this.registeredDrivers;
        for (const driver of discoveryDrivers) {
            for (const service of driver.connectionRequirements.services) {
                allServices.add(service);
            }
            if (driver.connectionRequirements.namePrefixes) {
                for (const prefix of driver.connectionRequirements.namePrefixes) {
                    allPrefixes.add(prefix);
                }
            }
        }

        const filters = [];
        if (allPrefixes.size > 0) {
            for (const prefix of allPrefixes) {
                filters.push({
                    namePrefix: prefix,
                    services: Array.from(allServices)
                });
            }
        } else {
            filters.push({
                services: Array.from(allServices)
            });
        }

        try {
            // Initiate connection prompt
            await this.activeTransport.connect(
                this.activeTransport.filterType === 'usb' ? undefined : filters
            );
            await this.bindDriver(preferredDriverId ?? preferredDriver?.id, modelId);
        } catch (error: any) {
            this.activeTransport = undefined;
            this.emit("error", error);
            throw error;
        }
    }

    /**
     * Like `connect()`, but the transport is already connected to a device.
     * Skips BLE scanning and goes straight to driver matching.
     *
     * Use this when you have manually called `transport.connectByDeviceId()` or
     * otherwise established the transport connection yourself.
     */
    async connectWithTransport(transport: IDeviceTransport, preferredDriverId?: string, modelId?: string): Promise<void> {
        if (!transport.isConnected()) {
            throw new Error("connectWithTransport() requires an already-connected transport.");
        }

        if (this.activeTransport && this.activeTransport.isConnected()) {
            await this.disconnect();
        }

        this.activeTransport = transport;

        const resolvedModelDriver = (modelId && modelId !== 'none' && modelId !== 'unknown')
            ? this.getDriverForModel(modelId)
            : undefined;
        const preferredDriver = preferredDriverId
            ? this.registeredDrivers.find(driver => driver.id === preferredDriverId)
            : resolvedModelDriver;

        try {
            await this.bindDriver(preferredDriverId ?? preferredDriver?.id, modelId);
        } catch (error: any) {
            this.activeTransport = undefined;
            this.emit("error", error);
            throw error;
        }
    }

    /** Internal: wire up event listeners and match a driver for the active transport. */
    private async bindDriver(preferredDriverId?: string, modelId?: string): Promise<void> {
        if (!this.activeTransport) throw new Error("No active transport.");

        this.activeTransport.on("disconnected", this.handleDisconnect);
        this.activeTransport.on("error", this.handleError);

        const deviceName = this.activeTransport.getDeviceName();
        this.logger('info', `[PrintManager] Device connected. Name: ${deviceName || 'Unknown'}`);

        if (preferredDriverId) {
            const preferred = this.registeredDrivers.find(driver => driver.id === preferredDriverId);
            if (!preferred) throw new Error(`Unknown printer driver: ${preferredDriverId}`);
            await this.bindMatchedDriver(preferred, modelId);
            return;
        }

        const nameMatches = deviceName
            ? this.registeredDrivers.filter(driver => driver.isCompatible(deviceName))
            : [];

        let serviceMatches: IPrinterDriver[] = [];
        if (this.activeTransport.getPrimaryServices) {
            try {
                const discoveredServices = await this.activeTransport.getPrimaryServices();
                const discovered = new Set(discoveredServices.map(normalizeUuid));
                serviceMatches = this.registeredDrivers.filter(driver =>
                    driver.connectionRequirements.services.some(service =>
                        discovered.has(normalizeUuid(service))));
            } catch (e) {
                this.logger('warn', `[PrintManager] Failed to discover services for matching: ${e}`);
            }
        }

        const modelDriver = (modelId && modelId !== 'none' && modelId !== 'unknown')
            ? this.getDriverForModel(modelId)
            : undefined;

        let matchedDriver = chooseDriver(nameMatches, serviceMatches, deviceName, modelDriver);

        if (!matchedDriver && modelDriver) {
            matchedDriver = modelDriver;
            this.logger('info', `[PrintManager] Device name/services inconclusive, matched driver by modelId '${modelId}': ${matchedDriver.name}`);
        }

        if (!matchedDriver) {
            // Fallback: If name is missing and only one hardware driver is registered, use it.
            const hardwareDrivers = this.registeredDrivers.filter(d => d.driverType === 'hardware');
            if (hardwareDrivers.length === 1) {
                const onlyDriver = hardwareDrivers[0];
                this.logger('info', `[PrintManager] Still no match, but only one hardware driver registered (${onlyDriver.name}). Using fallback.`);
                await this.bindMatchedDriver(onlyDriver, modelId);
                return;
            }
        }

        if (!matchedDriver) {
            throw new Error(`Connected to ${deviceName || 'Unknown device'} but no compatible driver was found. Please select your printer protocol manually.`);
        }

        await this.bindMatchedDriver(matchedDriver, modelId);
    }

    private async bindMatchedDriver(driver: IPrinterDriver, modelId?: string): Promise<void> {
        if (!this.activeTransport) throw new Error("No active transport.");
        let targetModelId = modelId;
        if (!targetModelId || targetModelId.startsWith('auto:') || targetModelId === 'unknown' || targetModelId === 'none') {
            const detected = this.detectModelForDriver(driver, this.activeTransport.getDeviceName());
            if (detected) {
                targetModelId = detected.id;
                this.activeModelProfile = detected;
            } else if (driver.supportedModels && driver.supportedModels.length > 0) {
                this.activeModelProfile = driver.supportedModels[0];
            }
        } else {
            this.activeModelProfile = driver.supportedModels?.find(m => m.id === targetModelId)
                ?? this.detectModelForDriver(driver, this.activeTransport.getDeviceName());
        }

        if (targetModelId && driver.setModel) {
            driver.setModel(targetModelId);
        }
        this.activeDriver = driver;
        await driver.bindTransport(this.activeTransport);
        this.emit("connected", driver);
    }

    /**
     * Retrieves the model profile currently active for the connected printer.
     */
    public getActiveModelProfile(): PrinterModelProfile | undefined {
        return this.activeModelProfile;
    }

    async disconnect(): Promise<void> {
        this.isPrinting = false;
        if (this.activeTransport) {
            try {
                await this.activeTransport.disconnect();
            } catch (e) {
                this.logger('warn', `[PrintManager] Error during transport disconnect: ${e}`);
            }
        }
        await this.handleDisconnect();
    }

    /**
     * Retrieves the capabilities of the currently connected printer.
     */
    getCapabilities() {
        if (!this.activeDriver) {
            throw new Error("No printer currently connected.");
        }
        return this.activeDriver.getCapabilities();
    }

    /**
     * Retrieves the connected device's name, if any.
     */
    public getConnectedDeviceName(): string | undefined {
        return this.activeTransport?.getDeviceName();
    }

    /**
     * What the active driver can report, without asking the printer.
     *
     * Empty when nothing is connected or the driver reports nothing — the same
     * answer, because a UI treats both the same way: show no status slots.
     */
    public getReportedFields(): readonly StatusField[] {
        return this.activeDriver?.reports ?? [];
    }

    /**
     * Service UUIDs declared by the active driver.
     *
     * These are protocol facts, not identifiers for an individual printer.
     * They are useful in support reports even when the transport cannot expose
     * its complete discovered-service list after connection.
     */
    public getActiveDriverServiceUuids(): readonly string[] {
        return this.activeDriver?.connectionRequirements.services ?? [];
    }

    /**
     * Read the connected printer's state, or `null` if this driver cannot ask.
     *
     * `null` rather than an empty status, so a caller can tell "this printer
     * says nothing" from "this printer says everything is fine". Failures of
     * the read itself surface as a thrown {@link PrinterError}.
     */
    public async getStatus(): Promise<PrinterStatus | null> {
        if (!this.activeDriver) {
            throw new PrinterError('not-connected', 'No printer currently connected.');
        }
        if (!this.activeDriver.getStatus) return null;
        try {
            return await this.activeDriver.getStatus();
        } catch (err) {
            throw toPrinterError(err, 'protocol');
        }
    }

    /** Let the active driver resolve manufacturer-specific media catalogue data. */
    public async resolveMedia(media: LoadedMedia): Promise<LoadedMedia> {
        if (!this.activeDriver) {
            throw new PrinterError('not-connected', 'No printer currently connected.');
        }
        return this.activeDriver.resolveMedia?.(media) ?? media;
    }

    /**
     * Probes an unknown or ambiguous connected device to discover its advertised
     * name, transport type, and GATT primary service UUIDs. Compares observations
     * against registered printer drivers and ranks candidates. Presentation and
     * report formatting belong to the caller so Core remains UI-agnostic.
     */
    public async diagnoseDevice(transport: IDeviceTransport): Promise<DeviceDiagnostic> {
        if (!transport.isConnected()) {
            const allServices = new Set<string>();
            for (const driver of this.registeredDrivers) {
                for (const service of driver.connectionRequirements.services) {
                    allServices.add(service);
                }
            }
            await transport.connect(
                transport.filterType === 'usb' ? undefined : [{ services: Array.from(allServices) }]
            );
        }

        const deviceName = transport.getDeviceName();
        const transportType = transport.type;
        let discoveredServices: string[] = [];
        if (transport.getPrimaryServices) {
            try {
                discoveredServices = await transport.getPrimaryServices();
            } catch (e) {
                this.logger('warn', `[PrintManager] Failed to discover services during diagnosis: ${e}`);
            }
        }

        const normDiscovered = new Set(discoveredServices.map(normalizeUuid));
        const candidates: CandidateDriverInfo[] = [];
        const hardwareDrivers = this.registeredDrivers.filter(d => d.driverType === 'hardware');

        for (const driver of hardwareDrivers) {
            const reasons: string[] = [];
            let nameMatched = false;
            let serviceMatched = false;

            if (deviceName && driver.isCompatible(deviceName)) {
                nameMatched = true;
                reasons.push(`Device name "${deviceName}" matches driver pattern`);
            }

            const matchedServices = driver.connectionRequirements.services.filter(s =>
                normDiscovered.has(normalizeUuid(s))
            );
            if (matchedServices.length > 0) {
                serviceMatched = true;
                reasons.push(`Advertises service UUID (${matchedServices.join(', ')})`);
            }

            let prefixHint = false;
            if (!nameMatched && deviceName && driver.connectionRequirements.namePrefixes) {
                const upperName = deviceName.toUpperCase();
                for (const p of driver.connectionRequirements.namePrefixes) {
                    if (upperName.includes(p.toUpperCase()) || p.toUpperCase().includes(upperName)) {
                        prefixHint = true;
                        reasons.push(`Device name contains prefix clue "${p}"`);
                        break;
                    }
                }
            }

            if (nameMatched || serviceMatched || prefixHint) {
                const matchedBy = (nameMatched && serviceMatched)
                    ? 'both'
                    : nameMatched
                    ? 'name'
                    : serviceMatched
                    ? 'service'
                    : 'prefix-hint';
                candidates.push({
                    driverId: driver.id,
                    driverName: driver.name,
                    matchedBy,
                    reasons,
                    supportedModels: driver.supportedModels || []
                });
            }
        }

        const rank = (c: CandidateDriverInfo) => {
            if (c.matchedBy === 'both') return 3;
            if (c.matchedBy === 'name') return 2;
            if (c.matchedBy === 'service') return 1;
            return 0;
        };
        candidates.sort((a, b) => rank(b) - rank(a));

        const suggestedDriverId = candidates.length > 0 ? candidates[0].driverId : undefined;

        return {
            deviceName,
            transportType,
            discoveredServices,
            candidates,
            suggestedDriverId
        };
    }


    /**
     * Commences a print job, handing the page over to the matched driver.
     *
     * Enforces the contract `printPage` relies on: the page arrives carrying no
     * more planes than the driver declared it accepts. Callers are expected to
     * have rasterised against the same budget (that is where 'merge' and 'drop'
     * are actually applied, while there is still a design to re-render); the
     * reduction here is the guarantee that a caller which did not cannot reach
     * the driver with a page it has no way to handle.
     *
     * @param page Separated planes or a full-gamut bitmap, with dimensions.
     * @param options Printing options like density and label type
     */
    async print(page: UniversalPage, options: UniversalPrintOptions): Promise<void> {
        if (!this.activeDriver) {
            throw new Error("Cannot print, no active printer driver.");
        }

        if (this.isPrinting) {
            throw new Error("Printer is currently busy.");
        }

        const channels = this.activeDriver.getCapabilities().colorSupport.channels ?? 1;
        const forDriver = reduceToChannels(page, channels);

        this.isPrinting = true;
        this.emit("printing");

        try {
            await this.activeDriver.printInit(options);
            await this.activeDriver.printPage(forDriver);
            await this.activeDriver.printEnd();
        } catch (error: any) {
            this.emit("error", error);
            throw error;
        } finally {
            this.isPrinting = false;
            this.emit("idle");
        }
    }

    /**
     * Print several pages: as one job when the driver can separate labels
     * inside a job, otherwise one job per page. Stops between pages once
     * `hooks.signal` aborts, and resolves with how many pages were sent.
     */
    async printBatch(pages: readonly UniversalPage[], options: UniversalPrintOptions, hooks: PrintPagesHooks = {}): Promise<number> {
        const driver = this.activeDriver;
        if (!driver) throw new Error("Cannot print, no active printer driver.");
        if (this.isPrinting) throw new Error("Printer is currently busy.");
        if (pages.length === 0) return 0;

        const channels = driver.getCapabilities().colorSupport.channels ?? 1;
        const forDriver = pages.map(page => reduceToChannels(page, channels));
        const single = { ...options, copies: 1 };
        let done = 0;
        const onPage = () => {
            done += 1;
            hooks.onPage?.(done, forDriver.length);
        };

        this.isPrinting = true;
        this.emit("printing");
        try {
            if (driver.printPages) {
                await driver.printInit(single);
                await driver.printPages(forDriver, { signal: hooks.signal, onPage });
                await driver.printEnd();
            } else {
                for (const page of forDriver) {
                    if (hooks.signal?.aborted) break;
                    await driver.printInit(single);
                    await driver.printPage(page);
                    await driver.printEnd();
                    onPage();
                }
            }
            return done;
        } catch (error: any) {
            this.emit("error", error);
            throw error;
        } finally {
            this.isPrinting = false;
            this.emit("idle");
        }
    }

    private handleDisconnect = async () => {
        this.isPrinting = false;
        if (this.activeDriver) {
            try {
                await this.activeDriver.unbindTransport();
            } catch (e) {
                this.logger('warn', `[PrintManager] Error during driver unbindTransport: ${e}`);
            }
            this.activeDriver = undefined;
        }
        this.activeModelProfile = undefined;
        this.activeTransport?.removeAllListeners();
        this.activeTransport = undefined;
        this.emit("disconnected");
    }

    private handleError = (err: Error) => {
        this.emit("error", err);
    }
}

/** Bluetooth UUIDs compare by value, not by the spelling returned by a stack. */
function normalizeUuid(uuid: string): string {
    const clean = uuid.toLowerCase().replace(/-/g, '');
    if (clean.length === 4) return `0000${clean}00001000800000805f9b34fb`;
    if (clean.length === 8) return `${clean}00001000800000805f9b34fb`;
    return clean;
}

/**
 * Select only when the observations identify one driver.
 *
 * A name is useful but not authoritative: `Printer` is used by unrelated
 * ESC/POS and vendor-specific devices. A service is useful but not
 * authoritative either: common vendor services are shared by unrelated devices.
 * Their intersection is strong; either signal on its own is accepted only when
 * it names exactly one driver. Registration order must never decide which wire
 * protocol receives a print job.
 *
 * When an explicit `modelDriver` is provided (e.g. user selected their printer model),
 * it serves as the tiebreaker when multiple drivers match an ambiguous name or service.
 */
function chooseDriver(
    nameMatches: IPrinterDriver[],
    serviceMatches: IPrinterDriver[],
    deviceName?: string,
    modelDriver?: IPrinterDriver
): IPrinterDriver | undefined {
    if (nameMatches.length && serviceMatches.length) {
        const services = new Set(serviceMatches);
        const intersection = nameMatches.filter(driver => services.has(driver));
        if (intersection.length === 1) return intersection[0];
        if (intersection.length > 1) {
            if (modelDriver && intersection.includes(modelDriver)) {
                return modelDriver;
            }
            throw ambiguousDriverError(deviceName, intersection);
        }
        // A readable, specific name is more useful than a generic service list
        // which may include only the services the platform allowed us to see.
        if (nameMatches.length === 1) return nameMatches[0];
        if (modelDriver && nameMatches.includes(modelDriver)) {
            return modelDriver;
        }
        throw ambiguousDriverError(deviceName, nameMatches);
    }
    if (nameMatches.length === 1) return nameMatches[0];
    if (nameMatches.length > 1) {
        if (modelDriver && nameMatches.includes(modelDriver)) {
            return modelDriver;
        }
        throw ambiguousDriverError(deviceName, nameMatches);
    }
    if (serviceMatches.length === 1) return serviceMatches[0];
    if (serviceMatches.length > 1) {
        if (modelDriver && serviceMatches.includes(modelDriver)) {
            return modelDriver;
        }
        throw ambiguousDriverError(deviceName, serviceMatches);
    }
    if (modelDriver) {
        return modelDriver;
    }
    return undefined;
}

function ambiguousDriverError(deviceName: string | undefined, drivers: IPrinterDriver[]): Error {
    const candidates = [...new Set(drivers.map(driver => driver.name))].join(', ');
    return new Error(
        `Connected to ${deviceName || 'Unknown device'}, but its name and services match multiple drivers: ` +
        `${candidates}. Select the exact printer model instead of guessing the protocol.`
    );
}
