import type { StartSessionInput } from '@/ports/platform.ts';

export function startInput(key: string, prompt: string): StartSessionInput {
  return {
    prompt,
    title: 'Checkout - Planner 1',
    idempotencyKey: key,
    settings: { model_tier: null, repositories: [], platform_settings: {}, role_tiers: {} },
    secret: null,
    onBehalfOf: null,
    usageCeiling: null,
    tags: { workspaceId: 'ws_default', groupId: 'grp', sessionId: 'ses', role: 'planner' },
  };
}

export function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function check(condition: boolean, detail: string): void {
  if (!condition) throw new Error(detail);
}
