// apps/api/src/use-cases/customers/ManageAddressBookUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { Customer } from "@api/domain/entities/Customer";
import {
  AddressBookEntry,
  JsonObject,
} from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: manage a customer's address book (add, update, delete).
 *
 * Responsibilities:
 * - Validate inputs and normalize values.
 * - Load the customer and short-circuit if not found.
 * - Use domain methods when available to preserve invariants.
 * - Persist changes and map repository errors to DomainError codes.
 * - Emit a non-blocking audit log entry recording the action and outcome.
 * - Log structured events and failures for observability.
 */
export interface ManageAddressBookInput {
  customerId: string;
  action: "add" | "update" | "delete";
  addressData: JsonObject;
  addressId?: string;
  actorId?: string;
}

export class ManageAddressBookUseCase {
  private static readonly MAX_ADDRESS_SIZE = 10_000; // defensive limit for JSONB size

  constructor(
    private readonly customerRepository: ICustomerRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: ManageAddressBookInput): Promise<void> {
    const customerId = (input.customerId ?? "").trim();
    const action = input.action;
    const addressData = input.addressData ?? null;
    const addressId = (input.addressId ?? "").trim() || undefined;
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Validate inputs
    if (!customerId) {
      throw new DomainError("VALIDATION_ERROR", "customerId is required.");
    }
    if (!["add", "update", "delete"].includes(action)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "action must be one of: add, update, delete.",
      );
    }
    if (action === "add" || action === "update") {
      if (!addressData || typeof addressData !== "object") {
        throw new DomainError(
          "VALIDATION_ERROR",
          "addressData must be a valid object for add/update actions.",
        );
      }
      try {
        const preview = JSON.stringify(addressData);
        if (preview.length > ManageAddressBookUseCase.MAX_ADDRESS_SIZE) {
          throw new DomainError(
            "VALIDATION_ERROR",
            "addressData exceeds maximum allowed size.",
          );
        }
      } catch {
        throw new DomainError(
          "VALIDATION_ERROR",
          "addressData must be serializable to JSON.",
        );
      }
    }
    if ((action === "update" || action === "delete") && !addressId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "addressId is required for update and delete actions.",
      );
    }

    // --- Load customer
    let customer: Customer | null;
    try {
      customer = await this.customerRepository.findById(customerId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to fetch customer for address book management",
        { err, customerId, action },
      );
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

    // --- Perform action using domain methods when available
    try {
      if (action === "add") {
        const newAddressId = this.idGenerator.generate();
        const addressPayload: AddressBookEntry = {
          id: newAddressId,
          ...addressData,
        };
        customer.addAddress(addressPayload);

        await this.customerRepository.save(customer);

        // Audit log (non-blocking)
        try {
          await this.auditLogService.logAction(actorId, "ADDRESS_ADDED", {
            auditId: this.idGenerator.generate(),
            customerId,
            addressId: newAddressId,
            createdAt: new Date().toISOString(),
          });
        } catch (auditErr: unknown) {
          this.logger.warn("Audit log failed for address add", {
            err: auditErr,
            customerId,
            addressId: newAddressId,
          });
        }

        this.logger.info("Address added to customer address book", {
          customerId,
          addressId: newAddressId,
        });
        return;
      }

      if (action === "update") {
        customer.updateAddress(addressId as string, addressData);

        await this.customerRepository.save(customer);

        try {
          await this.auditLogService.logAction(actorId, "ADDRESS_UPDATED", {
            auditId: this.idGenerator.generate(),
            customerId,
            addressId,
            updatedAt: new Date().toISOString(),
          });
        } catch (auditErr: unknown) {
          this.logger.warn("Audit log failed for address update", {
            err: auditErr,
            customerId,
            addressId,
          });
        }

        this.logger.info("Address updated in customer address book", {
          customerId,
          addressId,
        });
        return;
      }

      if (action === "delete") {
        customer.removeAddress(addressId as string);

        await this.customerRepository.save(customer);

        try {
          await this.auditLogService.logAction(actorId, "ADDRESS_DELETED", {
            auditId: this.idGenerator.generate(),
            customerId,
            addressId,
            deletedAt: new Date().toISOString(),
          });
        } catch (auditErr: unknown) {
          this.logger.warn("Audit log failed for address deletion", {
            err: auditErr,
            customerId,
            addressId,
          });
        }

        this.logger.info("Address removed from customer address book", {
          customerId,
          addressId,
        });
        return;
      }
    } catch (err: unknown) {
      // If a DomainError was thrown above, rethrow it
      if (err instanceof DomainError) {
        throw err;
      }

      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist customer address book change", {
        err,
        customerId,
        action,
        addressId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Address operation conflict detected.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving customer.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving customer.",
        );
      }

      throw new DomainError("INTERNAL_ERROR", "Failed to manage address book.");
    }
  }
}
