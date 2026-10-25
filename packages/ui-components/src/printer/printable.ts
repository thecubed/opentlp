import type { PrinterCapabilities } from 'universal-label-core';

type BandCaps = Pick<PrinterCapabilities, 'physical'> | undefined;

/**
 * Width across the media that can carry ink, in mm, before the head limit.
 *
 * Normally the label itself (`labelWidthMm`, else the tape). Printers that
 * place a narrower band by media width (DYMO D1) declare it in
 * `physical.printableBandsMm`, and the band wins when it is narrower.
 */
export function printableAcrossMm(caps: BandCaps, tapeWidthMm: number, labelWidthMm?: number): number {
    const across = labelWidthMm || tapeWidthMm;
    const band = caps?.physical?.printableBandsMm
        ?.find(entry => Math.abs(entry.mediaWidthMm - tapeWidthMm) < 0.75)
        ?.printableWidthMm;
    return band !== undefined ? Math.min(across, band) : across;
}

/** Canvas height for this media on this printer: the printable width, capped by the head. */
export function printableHeightPx(
    caps: Pick<PrinterCapabilities, 'physical' | 'canvasHeightPx' | 'dpmm'>,
    tapeWidthMm: number,
    labelWidthMm?: number
): number {
    const dpmm = caps.dpmm || 8;
    return Math.min(caps.canvasHeightPx, Math.round(printableAcrossMm(caps, tapeWidthMm, labelWidthMm) * dpmm));
}
