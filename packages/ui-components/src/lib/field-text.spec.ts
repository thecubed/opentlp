import { describe, expect, it } from 'vitest';
import { fieldNameFor, tokenizeFieldSource } from './field-text';

describe('field text', () => {
    const names = new Set(['asset', 'qty']);

    it('splits text and field references', () => {
        expect(tokenizeFieldSource('Asset: {asset} x{ qty }', names)).toEqual([
            { text: 'Asset: ', kind: 'text' },
            { text: '{asset}', kind: 'field' },
            { text: ' x', kind: 'text' },
            { text: '{ qty }', kind: 'field' },
        ]);
    });

    it('marks unknown names and expressions, and keeps escapes and unclosed braces literal', () => {
        expect(tokenizeFieldSource('{nope} {qty > 1 ? "s" : ""} {{lit}} {open', names)).toEqual([
            { text: '{nope}', kind: 'unknown' },
            { text: ' ', kind: 'text' },
            { text: '{qty > 1 ? "s" : ""}', kind: 'expr' },
            { text: ' {{lit}} {open', kind: 'text' },
        ]);
    });

    it('names fields after their labels, uniquely', () => {
        expect(fieldNameFor('Asset ID', [])).toBe('assetId');
        expect(fieldNameFor('Asset ID', ['assetId'])).toBe('assetId2');
        expect(fieldNameFor('Café owner', [])).toBe('cafeOwner');
        expect(fieldNameFor('2nd line', [])).toBe('field2ndLine');
        expect(fieldNameFor('', ['field1'])).toBe('field2');
        expect(fieldNameFor('!!!', [])).toBe('field1');
    });
});
