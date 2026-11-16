import { describe, expect, test } from 'bun:test';
import { layerViolations } from './check-layers.ts';

describe('layer check', () => {
  test('rejects a multiline import that crosses from domain into core', () => {
    const violations = layerViolations([
      {
        path: 'src/domain/example.ts',
        text: `import {\n  reportTransition,\n} from '@/core/records.ts';\n`,
      },
    ]);

    expect(violations).toEqual([
      'src/domain/example.ts (domain) imports src/core/records.ts (core)',
    ]);
  });

  test('allows a multiline import that stays inside the permitted layers', () => {
    const violations = layerViolations([
      {
        path: 'src/policy/example.ts',
        text: `import {\n  sessionRoles,\n} from '@/domain/model.ts';\n`,
      },
    ]);

    expect(violations).toEqual([]);
  });
});
