/**
 * Batch printing: one template, one set of field values per label.
 *
 * Pure helpers, kept out of the component so they can be tested: turning
 * pasted spreadsheet rows into field values, and numbering a column.
 */
import type { TemplateParam } from 'universal-label-renderer';

export type BatchValue = string | number | boolean;
export type BatchRow = Record<string, BatchValue>;

export interface PastedRows {
    rows: BatchRow[];
    /** Field names the columns were matched to, in column order (undefined = ignored column). */
    columns: (string | undefined)[];
    /** True when the first line was read as a header row. */
    hadHeader: boolean;
}

const TRUE = /^(1|true|yes|y|x|on|✓|✔)$/i;

/** A cell's text as a value for this field. */
export function coerceValue(param: TemplateParam, raw: string): BatchValue {
    const text = raw.trim();
    switch (param.type) {
        case 'number': {
            const n = Number(text.replace(',', '.'));
            return text !== '' && Number.isFinite(n) ? n : param.default;
        }
        case 'boolean':
            return TRUE.test(text);
        default:
            return raw;
    }
}

/** Split delimited text into cells; double quotes group a cell, `""` is a quote. */
export function splitDelimited(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
            else if (ch === '"') quoted = false;
            else cell += ch;
        } else if (ch === '"' && cell === '') {
            quoted = true;
        } else if (ch === delimiter) {
            row.push(cell); cell = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i += 1;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else {
            cell += ch;
        }
    }
    if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));
}

const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Rows pasted from a spreadsheet (tab separated) or a CSV file.
 *
 * A first line whose cells name fields (by name or label, any case) is a
 * header and maps columns to those fields, ignoring the rest. Otherwise
 * columns fill the fields in order. A single field takes one value per line.
 */
export function parsePastedRows(text: string, params: readonly TemplateParam[]): PastedRows {
    if (params.length === 0) return { rows: [], columns: [], hadHeader: false };
    const delimiter = text.includes('\t') ? '\t' : params.length === 1 ? '\n' : ',';
    const table = delimiter === '\n'
        ? text.split(/\r?\n/).filter(line => line.trim() !== '').map(line => [line])
        : splitDelimited(text, delimiter);
    if (table.length === 0) return { rows: [], columns: [], hadHeader: false };

    const byKey = new Map<string, string>();
    for (const p of params) {
        byKey.set(key(p.name), p.name);
        byKey.set(key(p.label), p.name);
    }
    const headerColumns = table[0].map(cell => byKey.get(key(cell)));
    const hadHeader = headerColumns.some(Boolean);
    const columns = hadHeader ? headerColumns : table[0].map((_, i) => params[i]?.name);
    const body = hadHeader ? table.slice(1) : table;
    const paramByName = new Map(params.map(p => [p.name, p]));

    const rows = body.map(cells => {
        const row: BatchRow = {};
        cells.forEach((cell, i) => {
            const name = columns[i];
            const param = name ? paramByName.get(name) : undefined;
            if (param) row[param.name] = coerceValue(param, cell);
        });
        return row;
    });
    return { rows, columns, hadHeader };
}

/**
 * Number a field down the rows from its first value: 5 → 5, 6, 7…;
 * "Box 01" → "Box 01", "Box 02"…; anything else gets " 1", " 2"… appended.
 */
export function fillSequence(rows: readonly BatchRow[], name: string): BatchRow[] {
    if (rows.length === 0) return [];
    const first = rows[0][name];
    if (typeof first === 'number') return rows.map((row, i) => ({ ...row, [name]: first + i }));
    const text = String(first ?? '');
    const match = /^(.*?)(\d+)(\D*)$/.exec(text);
    return rows.map((row, i) => {
        if (!match) return { ...row, [name]: `${text}${text ? ' ' : ''}${i + 1}` };
        const [, before, digits, after] = match;
        const n = String(Number(digits) + i).padStart(digits.length, '0');
        return { ...row, [name]: `${before}${n}${after}` };
    });
}
