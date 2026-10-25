/**
 * Helpers for text that references template fields: `Asset: {asset}`.
 *
 * The template engine already compiles `{ … }` in any text or barcode data
 * (see renderer `compileText`); these are the editor-side pieces: splitting a
 * source string for highlighting, and naming a new field after its label.
 */

export type FieldTokenKind = 'text' | 'field' | 'unknown' | 'expr';

export interface FieldToken {
    text: string;
    kind: FieldTokenKind;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Split a source string into literal text and `{ … }` references, for
 * highlighting. `{{` and `}}` are literal braces. A bare name is a `field`
 * when it names one, else `unknown`; anything else in braces is an `expr`.
 * An unclosed `{` stays literal, as the engine treats it.
 */
export function tokenizeFieldSource(source: string, fieldNames: ReadonlySet<string>): FieldToken[] {
    const tokens: FieldToken[] = [];
    let text = '';
    const flush = () => { if (text) { tokens.push({ text, kind: 'text' }); text = ''; } };
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if ((ch === '{' || ch === '}') && source[i + 1] === ch) { text += ch + ch; i += 1; continue; }
        if (ch === '{') {
            const end = source.indexOf('}', i + 1);
            const nested = source.indexOf('{', i + 1);
            if (end < 0 || (nested >= 0 && nested < end)) { text += ch; continue; }
            flush();
            const inner = source.slice(i + 1, end).trim();
            const kind: FieldTokenKind = IDENT.test(inner) ? (fieldNames.has(inner) ? 'field' : 'unknown') : 'expr';
            tokens.push({ text: source.slice(i, end + 1), kind });
            i = end;
            continue;
        }
        text += ch;
    }
    flush();
    return tokens;
}

/**
 * An identifier for a new field, from its label: "Asset ID" → `assetId`,
 * kept unique against `existing`. Falls back to `field1`, `field2`…
 */
export function fieldNameFor(label: string, existing: readonly string[]): string {
    const words = label
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .split(/[^A-Za-z0-9]+/).filter(Boolean);
    let base = words
        .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
        .join('');
    if (!base || !IDENT.test(base)) base = /^\d/.test(base) ? `field${base}` : '';
    const taken = new Set(existing);
    if (base && !taken.has(base)) return base;
    const stem = base || 'field';
    for (let n = base ? 2 : existing.length + 1; ; n += 1) {
        if (!taken.has(`${stem}${n}`)) return `${stem}${n}`;
    }
}
