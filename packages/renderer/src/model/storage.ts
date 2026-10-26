/**
 * The library — every label you own, persisted to localStorage.
 *
 * Entries store the unified {@link LabelTemplate} format (a plain label is just
 * a template with all-`px` placements) plus the working paper.
 *
 * A template and a one-off label share the same `LabelTemplate` document. The
 * presence of parameters is a property of an entry, so one library is enough.
 */
import type { InkBinding, PaperProfile } from 'universal-label-core';
import type { LabelTemplate } from '../template/template';
import { parseTemplate, serializeTemplate, type ParseResult } from '../template/validate';

const STORAGE_KEY = 'blewebler2.labels.v1';
/** Set after the bundled starter library has been installed once. */
const STARTERS_KEY = 'blewebler2.labels.starters.v1';
/** Starter ids already offered, so new releases can add starters without restoring deleted ones. */
const STARTERS_SEEN_KEY = 'blewebler2.labels.starters.seen.v1';
/**
 * The starters that shipped before {@link STARTERS_SEEN_KEY} existed. An install
 * that only has the old one-shot flag has been offered exactly these.
 */
const LEGACY_STARTER_IDS = [
    'example-asset-tag', 'example-barcode-product', 'example-hazard-label', 'example-name-badge',
    'example-price-tag', 'example-qr-url-card', 'example-retail-price-tag', 'example-spine-label',
];

export interface SavedLabel {
    template: LabelTemplate;
    /**
     * Where this design entered the catalogue. All origins use the same ULT
     * document, so a future community source is a library concern rather than
     * a second kind of design or editor flow.
     */
    origin?: DesignOrigin;
    /** Working paper/media (not part of the shared template). */
    paper?: PaperProfile;
    /**
     * Which colorant each of the template's ink slots is pointed at, per paper.
     *
     * Working state for the same reason `paper` is: the slot declarations belong
     * to the shared document, but what they come out as depends on the roll in
     * the machine, which is this user's business and nobody else's.
     */
    inkBindings?: InkBinding[];
    savedAt: string; // ISO timestamp
    favorite?: boolean;
}

export type DesignOrigin =
    | { kind: 'local' }
    | { kind: 'bundled'; collection?: string }
    | { kind: 'community'; provider: string; externalId: string; revision?: number };

export interface LabelStorageBackend {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function defaultBackend(): LabelStorageBackend {
    if (typeof localStorage !== 'undefined') return localStorage;
    const mem = new Map<string, string>();
    return {
        getItem: k => mem.get(k) ?? null,
        setItem: (k, v) => void mem.set(k, v)
    };
}

/** Validate + normalise a stored entry into a SavedLabel (re-gates the template). */
function readEntry(entry: unknown): SavedLabel | null {
    if (typeof entry !== 'object' || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (!e.template) return null;
    const res = parseTemplate(e.template);
    if (!res.ok) return null;
    return {
        template: res.template,
        origin: readOrigin(e.origin),
        paper: e.paper as PaperProfile | undefined,
        inkBindings: readBindings(e.inkBindings),
        savedAt: typeof e.savedAt === 'string' ? e.savedAt : '',
        favorite: e.favorite === true || undefined
    };
}

function readOrigin(raw: unknown): DesignOrigin | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const value = raw as Record<string, unknown>;
    if (value.kind === 'local') return { kind: 'local' };
    if (value.kind === 'bundled') {
        return { kind: 'bundled', ...(typeof value.collection === 'string' ? { collection: value.collection } : {}) };
    }
    if (value.kind === 'community' && typeof value.provider === 'string' && typeof value.externalId === 'string') {
        return {
            kind: 'community', provider: value.provider, externalId: value.externalId,
            ...(typeof value.revision === 'number' ? { revision: value.revision } : {})
        };
    }
    return undefined;
}

/**
 * Bindings from storage, reduced to string->string maps.
 *
 * Own-machine data, so the bar is low, but it still comes back through JSON:
 * a map with a non-string value would reach `resolveSlot` as a lookup key and
 * quietly match nothing, which is a bug that only shows up as a colour coming
 * out wrong on a print.
 */
function readBindings(raw: unknown): InkBinding[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: InkBinding[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.paperId !== 'string' || typeof e.map !== 'object' || e.map === null) continue;
        const map: Record<string, string> = {};
        for (const [slot, ink] of Object.entries(e.map as Record<string, unknown>)) {
            if (typeof ink === 'string') map[slot] = ink;
        }
        if (Object.keys(map).length) out.push({ paperId: e.paperId, map });
    }
    return out.length ? out : undefined;
}

export class LabelLibrary {
    private backend: LabelStorageBackend;

    constructor(backend: LabelStorageBackend = defaultBackend()) {
        this.backend = backend;
    }

    /** Entries sorted favorites-first, then most recently saved. */
    list(): SavedLabel[] {
        return this.read(STORAGE_KEY).sort((a, b) =>
            Number(b.favorite ?? false) - Number(a.favorite ?? false)
            || b.savedAt.localeCompare(a.savedAt)
        );
    }

    /**
     * Add bundled starter templates once, without overwriting existing work.
     * The marker makes deletion durable: a starter removed by the user is not
     * resurrected on the next launch.
     */
    installDefaults(templates: readonly LabelTemplate[]): void {
        const seen = this.offeredStarters();
        const current = this.read(STORAGE_KEY);
        const existingIds = new Set(current.map(entry => entry.template.id));
        const installedAt = new Date().toISOString();
        // Each starter is offered once: one the user deleted stays deleted, and
        // one added in a later release still arrives.
        const additions = templates
            .filter(template => !seen.has(template.id) && !existingIds.has(template.id))
            .map(template => ({
                template,
                origin: { kind: 'bundled', collection: 'starter' },
                savedAt: installedAt
            } satisfies SavedLabel));

        if (additions.length > 0) this.write([...current, ...additions]);
        for (const template of templates) seen.add(template.id);
        this.backend.setItem(STARTERS_SEEN_KEY, JSON.stringify([...seen]));
        this.backend.setItem(STARTERS_KEY, '1');
    }

    private offeredStarters(): Set<string> {
        const raw = this.backend.getItem(STARTERS_SEEN_KEY);
        if (raw) {
            try {
                const ids: unknown = JSON.parse(raw);
                if (Array.isArray(ids)) return new Set(ids.filter((id): id is string => typeof id === 'string'));
            } catch { /* fall through to the legacy flag */ }
        }
        return new Set(this.backend.getItem(STARTERS_KEY) ? LEGACY_STARTER_IDS : []);
    }

    /** Validated entries under one key, unsorted. */
    private read(key: string): SavedLabel[] {
        const raw = this.backend.getItem(key);
        if (!raw) return [];
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.map(readEntry).filter((e): e is SavedLabel => e !== null);
        } catch {
            return [];
        }
    }

    /** Insert or overwrite by template id, preserving the favorite flag. */
    save(
        template: LabelTemplate,
        paper?: PaperProfile,
        inkBindings?: InkBinding[],
        origin?: DesignOrigin
    ): SavedLabel {
        const existing = this.get(template.id);
        const entry: SavedLabel = {
            template, paper,
            origin: origin ?? existing?.origin ?? { kind: 'local' },
            inkBindings: inkBindings?.length ? inkBindings : undefined,
            savedAt: new Date().toISOString(),
            favorite: existing?.favorite
        };
        const rest = this.list().filter(e => e.template.id !== template.id);
        this.write([entry, ...rest]);
        return entry;
    }

    /** Import untrusted JSON text; on success, persist it. */
    import(text: string): ParseResult {
        let data: unknown;
        try { data = JSON.parse(text); } catch { return { ok: false, errors: ['Invalid JSON'] }; }
        const res = parseTemplate(data);
        if (res.ok) this.save(res.template);
        return res;
    }

    export(id: string): string | null {
        const entry = this.get(id);
        return entry ? serializeTemplate(entry.template) : null;
    }

    toggleFavorite(id: string): void {
        this.write(this.list().map(e => (e.template.id === id ? { ...e, favorite: !e.favorite } : e)));
    }

    remove(id: string): void {
        this.write(this.list().filter(e => e.template.id !== id));
    }

    get(id: string): SavedLabel | undefined {
        return this.list().find(e => e.template.id === id);
    }

    private write(entries: SavedLabel[]): void {
        this.backend.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
}
