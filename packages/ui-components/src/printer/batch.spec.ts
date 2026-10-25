import { describe, expect, it } from 'vitest';
import type { TemplateParam } from 'universal-label-renderer';
import { coerceValue, fillSequence, parsePastedRows, splitDelimited } from './batch';

const name: TemplateParam = { name: 'name', label: 'Name', type: 'text', default: '' };
const qty: TemplateParam = { name: 'qty', label: 'Quantity', type: 'number', default: 1 };
const fragile: TemplateParam = { name: 'fragile', label: 'Fragile', type: 'boolean', default: false };

describe('batch rows', () => {
    it('reads a pasted spreadsheet with a header, in any column order, ignoring unknown columns', () => {
        const text = 'Quantity\tNotes\tname\n3\tx\tScrews\n12\t\tWashers\n';
        const pasted = parsePastedRows(text, [name, qty]);
        expect(pasted.hadHeader).toBe(true);
        expect(pasted.columns).toEqual(['qty', undefined, 'name']);
        expect(pasted.rows).toEqual([{ qty: 3, name: 'Screws' }, { qty: 12, name: 'Washers' }]);
    });

    it('fills fields in order when there is no header, and reads CSV quoting', () => {
        const pasted = parsePastedRows('"Nuts, M3",5,yes\r\nBolts,x,no', [name, qty, fragile]);
        expect(pasted.hadHeader).toBe(false);
        expect(pasted.rows).toEqual([
            { name: 'Nuts, M3', qty: 5, fragile: true },
            { name: 'Bolts', qty: 1, fragile: false },
        ]);
    });

    it('takes one value per line for a single field, commas included', () => {
        expect(parsePastedRows('Kitchen\nGarage, left shelf\n\n', [name]).rows)
            .toEqual([{ name: 'Kitchen' }, { name: 'Garage, left shelf' }]);
    });

    it('splits quoted cells with embedded quotes and newlines', () => {
        expect(splitDelimited('"a ""b""","c\nd"\ne,f', ',')).toEqual([['a "b"', 'c\nd'], ['e', 'f']]);
    });

    it('coerces numbers and booleans', () => {
        expect(coerceValue(qty, ' 2,5 ')).toBe(2.5);
        expect(coerceValue(qty, '')).toBe(1);
        expect(coerceValue(fragile, '✓')).toBe(true);
    });

    it('numbers a column down the rows', () => {
        const rows = [{ name: 'Box 08', qty: 4 }, { name: 'x', qty: 0 }, { name: 'y', qty: 0 }];
        expect(fillSequence(rows, 'name').map(r => r.name)).toEqual(['Box 08', 'Box 09', 'Box 10']);
        expect(fillSequence(rows, 'qty').map(r => r.qty)).toEqual([4, 5, 6]);
        expect(fillSequence([{ name: 'Shelf' }, { name: '' }], 'name').map(r => r.name)).toEqual(['Shelf 1', 'Shelf 2']);
    });
});
