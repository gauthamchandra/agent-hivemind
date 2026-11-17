import type { EvidenceEntry } from '@/domain/model.ts';

export const note = 'Cited from the work that just finished.';

export const pullRequestEvidence: EvidenceEntry[] = [
  { label: 'pull request', kind: 'address', value: 'https://example.com/pr/1' },
];

export const passingCheckEvidence: EvidenceEntry[] = [
  { label: 'check', kind: 'text', value: 'the suite passed' },
];

/** The group most tests open. Spread it and override only what the test is about. */
export const checkoutGroup = {
  name: 'Checkout',
  goal: 'Move tax calculation behind an interface.',
  budget: '100',
  instructions: 'Plan the work.',
};
