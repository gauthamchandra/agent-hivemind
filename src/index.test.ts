import { describe, expect, test } from 'bun:test';
import { greet } from './index';

describe('greet', () => {
  test('returns a greeting for the given name', () => {
    expect(greet('hivemind')).toBe('hello, hivemind');
  });
});
