// apps/api/src/infrastructure/services/NodeIdGenerator.ts

// Node.js native implementation of IIdGenerator.
//
// Generates opaque, globally-unique identifiers via crypto.randomUUID()
// (RFC 4122 version 4). No third-party UUID package is used and there are no
// database-specific concerns: persistence layers consume whatever string
// generate() returns.

import { randomUUID } from "node:crypto";
import type { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";

export class NodeIdGenerator implements IIdGenerator {
  generate(): string {
    return randomUUID();
  }
}
