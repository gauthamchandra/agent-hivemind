import type { NeutralStatus } from '@/domain/model.ts';
import type { Capability, PlatformErrorClass, SendResult } from '@/domain/platform.ts';

/** Knobs a conformance run uses instead of a recorded platform server. */
export type ConformanceControls = {
  documentedCapabilities: readonly Capability[];
  documentedStatuses: readonly { platform: string; neutral: NeutralStatus }[];
  unrecognizedStatus: string;
  credential: string;
  promptMarker: string;
  messageMarker: string;
  setPlatformStatus(status: string): void;
  queueError(operation: string, errorClass: PlatformErrorClass): void;
  setSendResult(result: SendResult): void;
  setReportedUsage(value: number): void;
  logs(): readonly string[];
  calls(): readonly string[];
  loseNextStartResponse(): void;
};
