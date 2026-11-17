import { expect, test } from 'bun:test';
import { addDecimal, decimalFromNumber } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';

test('a sum inside twenty digits stays canonical', () => {
  expect(addDecimal('1.50', '2.50')).toBe('4');
  expect(addDecimal('99999999999999999998', '1')).toBe('99999999999999999999');
});

test('a sum past twenty digits is rejected', () => {
  expect(() => addDecimal('99999999999999999999', '1')).toThrow(HivemindError);
  expect(() => addDecimal('99999999999999999999', '1')).toThrow(/too large/);
});

test('a tiny finite reading becomes plain decimal text', () => {
  expect(decimalFromNumber(0.0000001)).toBe('0.0000001');
  expect(decimalFromNumber(1.5)).toBe('1.5');
});
