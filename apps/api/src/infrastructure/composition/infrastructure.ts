// apps/api/src/infrastructure/composition/infrastructure.ts

// Constructs every concrete infrastructure implementation the application
// currently has, using exactly ONE shared instance of each dependency:
// logger, id generator, hashing, cryptography, session revocation, token
// service, queue service, transaction manager, and the Kysely database.
//
// Lifecycle ownership:
//   - Database: the existing Kysely singleton from database/connection/kysely.ts
//     is reused (never rebuilt); repositories resolve their connection through
//     its shared TransactionContext. Closed via db.destroy() on shutdown.
//   - Redis (session revocation): one dedicated ioredis client owned here.
//     Closed via redis.quit() on shutdown.
//   - BullMQ: the BullMQ connection CONFIG is derived from the same REDIS_URL
//     but BullMQ manages its own dedicated connections (both the queue service
//     and the workers). Closed via queueService.close() on shutdown. The
//     session-revocation ioredis client is deliberately NOT reused by BullMQ.
//
// This is the only module allowed to map domain interfaces to concrete
// infrastructure implementations.

import { Redis } from "ioredis";
import type { ConnectionOptions } from "bullmq";
import type { Kysely } from "kysely";
import { db, transactionContext } from "../database/connection/kysely";
import { TransactionContext } from "../database/transaction/TransactionContext";
import { KyselyTransactionManager } from "../database/transaction/KyselyTransactionManager";
import { PinoLogger } from "../services/PinoLogger";
import { NodeIdGenerator } from "../services/NodeIdGenerator";
import { BcryptHashingService } from "../services/BcryptHashingService";
import { NodeCryptographyService } from "../services/NodeCryptographyService";
import { RedisSessionRevocationService } from "../services/RedisSessionRevocationService";
import { JwtTokenService } from "../services/JwtTokenService";
import { BullMqQueueService } from "../services/BullMqQueueService";
import type { Database } from "../database/schema/types";
import type { AppConfig } from "./config";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import type { IHashingService } from "@api/domain/interfaces/services/IHashingService";
import type { ICryptographyService } from "@api/domain/interfaces/services/ICryptographyService";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type { IQueueService } from "@api/domain/interfaces/services/IQueueService";

export interface InfrastructureDependencies {
  config: AppConfig;
  /** Concrete PinoLogger; satisfies ILogger. */
  logger: PinoLogger;
  /** Concrete NodeIdGenerator; satisfies IIdGenerator. */
  idGenerator: NodeIdGenerator;
  /** Concrete BcryptHashingService; satisfies IHashingService. */
  hashingService: BcryptHashingService;
  /** Concrete NodeCryptographyService; satisfies ICryptographyService. */
  cryptographyService: NodeCryptographyService;
  /**
   * Single RedisSessionRevocationService instance. Satisfies BOTH
   * ISessionRevocationService and the infrastructure-internal
   * ITokenRevocationStore consumed by JwtTokenService.
   */
  sessionRevocationService: RedisSessionRevocationService;
  /** Concrete JwtTokenService; satisfies ITokenService. */
  tokenService: JwtTokenService;
  /** Concrete BullMqQueueService; satisfies IQueueService. */
  queueService: BullMqQueueService;
  /** Concrete KyselyTransactionManager; satisfies ITransactionManager. */
  transactionManager: KyselyTransactionManager;
  /** The shared Kysely singleton (existing pool, reused). */
  db: Kysely<Database>;
  /** The shared transaction context repositories resolve connections through. */
  transactionContext: TransactionContext;
  /** ioredis client dedicated to session revocation; owned by this module. */
  redis: Redis;
  /**
   * BullMQ connection config derived from REDIS_URL. BullMQ creates and
   * manages its own dedicated connections from this (queue service + workers).
   */
  bullConnection: ConnectionOptions;
}

export function buildInfrastructure(
  config: AppConfig,
): InfrastructureDependencies {
  const logger = new PinoLogger({ level: config.logLevel });
  const idGenerator = new NodeIdGenerator();
  const hashingService = new BcryptHashingService({
    saltRounds: config.bcryptSaltRounds,
  });
  const cryptographyService = new NodeCryptographyService();

  // Dedicated session-revocation client. Lazy: connects on first command.
  const redis = new Redis(config.redisUrl, { lazyConnect: true });
  const sessionRevocationService = new RedisSessionRevocationService({ redis });

  const tokenService = new JwtTokenService({
    secret: config.jwtSecret,
    expiresIn: config.jwtExpiresIn,
    revocationStore: sessionRevocationService,
  });

  // BullMQ's own connection config from the same REDIS_URL value. maxRetriesPerRequest
  // must be null for BullMQ so a blocked client (BRPOPLPUSH) is never killed by ioredis
  // max-retry handling.
  const bullConnection: ConnectionOptions = {
    url: config.redisUrl,
    maxRetriesPerRequest: null,
  };

  const queueService = new BullMqQueueService({ connection: bullConnection });
  const transactionManager = new KyselyTransactionManager(db, transactionContext);

  return {
    config,
    logger,
    idGenerator,
    hashingService,
    cryptographyService,
    sessionRevocationService,
    tokenService,
    queueService,
    transactionManager,
    db,
    transactionContext,
    redis,
    bullConnection,
  };
}

/**
 * Close every owned connection in dependency order: BullMQ queues first (no new
 * queue work), then the Postgres pool, then the session-revocation Redis
 * client. Best-effort: each resource gets a chance to close and the first
 * failure is rethrown.
 */
export async function disposeInfrastructure(
  infra: InfrastructureDependencies,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await infra.queueService.close();
  } catch (err) {
    errors.push(err);
  }
  try {
    await infra.db.destroy();
  } catch (err) {
    errors.push(err);
  }
  try {
    await infra.redis.quit();
  } catch (err) {
    errors.push(err);
  }
  if (errors.length > 0) {
    throw errors[0];
  }
}
