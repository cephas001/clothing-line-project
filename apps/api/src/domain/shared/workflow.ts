import { JsonValue } from "@api/domain/shared/json";

export interface DeadLetterJob {
  id: string;
  name?: string;
  data?: Record<string, JsonValue>;
  failedReason?: string;
  attemptsMade?: number;
  timestamp?: string | number;
  failedAt?: string | number;
  [key: string]: JsonValue | undefined;
}
