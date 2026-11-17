import { afterEach } from 'bun:test';
import { runPendingTeardowns } from '@/testing/teardown.ts';

afterEach(runPendingTeardowns);
