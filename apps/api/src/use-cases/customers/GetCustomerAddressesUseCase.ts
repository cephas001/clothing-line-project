// apps/api/src/use-cases/customers/GetCustomerAddressesUseCase.ts

import { AddressBookEntry } from "@api/domain/entities/Customer";
import { Customer } from "@api/domain/entities/Customer";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: list the authenticated customer's address book (read-only).
 *
 * Responsibilities:
 * - Validate and normalize the customerId input. The customerId is ALWAYS the
 *   JWT-derived actor identity — never read from a request body.
 * - Load the customer aggregate through the repository abstraction and short-
 *   circuit with RESOURCE_NOT_FOUND when the account does not exist.
 * - Return a defensive copy of the address book entries (the OpenAPI `Address`
 *   schema requires an id and allows unknown keys, which JSONB preserves).
 * - Map repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the read.
 */
export interface GetCustomerAddressesInput {
  customerId: string;
  /** The JWT-derived actor identity; the ONLY identity source. */
  actorId?: string;
}

export class GetCustomerAddressesUseCase {
  constructor(
    private readonly customerRepository: ICustomerRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: GetCustomerAddressesInput): Promise<AddressBookEntry[]> {
    const customerId = (input.customerId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    if (!customerId) {
      throw new DomainError("VALIDATION_ERROR", "customerId is required.");
    }

    let customer: Customer | null;
    try {
      customer = await this.customerRepository.findById(customerId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch customer address book", {
        err,
        customerId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while fetching customer.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while fetching customer.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch customer.");
    }

    if (!customer) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Customer not found.");
    }

    // Defensive copy: the stored entries are JSONB objects; surface only
    // shallow copies so the projection never shares mutable references.
    const addresses: AddressBookEntry[] = customer.addresses.map((entry) => ({
      ...entry,
    }));

    // Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "CUSTOMER_ADDRESSES_RETRIEVED", {
        auditId: this.idGenerator.generate(),
        customerId,
        addressCount: String(addresses.length),
        retrievedAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for customer address book retrieval", {
        err: auditErr,
        customerId,
      });
    }

    this.logger.info("Retrieved customer address book", {
      customerId,
      addressCount: addresses.length,
    });
    return addresses;
  }
}