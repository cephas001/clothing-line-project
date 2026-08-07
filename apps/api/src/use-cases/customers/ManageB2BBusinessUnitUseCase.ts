// apps/api/src/use-cases/customers/ManageB2BBusinessUnitUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IBusinessUnitRepository } from "@api/domain/interfaces/repositories/IBusinessUnitRepository";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { BusinessUnitRecord } from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: create or manage a B2B business unit and attach an admin customer.
 *
 * Responsibilities:
 * - Validate and normalize inputs.
 * - Ensure the admin customer exists.
 * - Enforce uniqueness constraints (registration number / unit name) when possible.
 * - Persist the business unit (transactionally).
 * - Map repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the creation.
 * - Log structured events and failures for observability.
 */
export interface ManageB2BBusinessUnitInput {
  unitName: string;
  adminCustomerId: string;
  companyRegistrationNumber: string;
  salesChannelId: string;
  actorId?: string;
}

export class ManageB2BBusinessUnitUseCase {
  private static readonly MAX_NAME_LENGTH = 256;
  private static readonly REG_NUM_MAX_LENGTH = 128;

  constructor(
    private readonly businessUnitRepository: IBusinessUnitRepository,
    private readonly customerRepository: ICustomerRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(
    input: ManageB2BBusinessUnitInput,
  ): Promise<BusinessUnitRecord> {
    const unitName = (input.unitName ?? "").trim();
    const adminCustomerId = (input.adminCustomerId ?? "").trim();
    const companyRegistrationNumber = (
      input.companyRegistrationNumber ?? ""
    ).trim();
    const salesChannelId = (input.salesChannelId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Validate inputs
    if (!unitName) {
      throw new DomainError("VALIDATION_ERROR", "unitName is required.");
    }
    if (unitName.length > ManageB2BBusinessUnitUseCase.MAX_NAME_LENGTH) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `unitName cannot exceed ${ManageB2BBusinessUnitUseCase.MAX_NAME_LENGTH} characters.`,
      );
    }
    if (!adminCustomerId) {
      throw new DomainError("VALIDATION_ERROR", "adminCustomerId is required.");
    }
    if (!companyRegistrationNumber) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "companyRegistrationNumber is required.",
      );
    }
    if (
      companyRegistrationNumber.length >
      ManageB2BBusinessUnitUseCase.REG_NUM_MAX_LENGTH
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `companyRegistrationNumber cannot exceed ${ManageB2BBusinessUnitUseCase.REG_NUM_MAX_LENGTH} characters.`,
      );
    }
    if (!salesChannelId) {
      throw new DomainError("VALIDATION_ERROR", "salesChannelId is required.");
    }

    // --- Ensure admin customer exists
    try {
      const adminUser = await this.customerRepository.findById(adminCustomerId);

      if (!adminUser) {
        throw new DomainError(
          "RESOURCE_NOT_FOUND",
          "Admin customer not found.",
        );
      }

      // --- Check uniqueness by registration number or name if repository supports it
      try {
        if (
          typeof this.businessUnitRepository.findByRegistrationNumber ===
          "function"
        ) {
          const existingByReg =
            await this.businessUnitRepository.findByRegistrationNumber(
              companyRegistrationNumber,
            );
          if (existingByReg) {
            this.logger.info(
              "Attempt to create duplicate business unit by registration number",
              { companyRegistrationNumber },
            );
            throw new DomainError(
              "BUSINESS_UNIT_ALREADY_EXISTS",
              "A business unit with this registration number already exists.",
            );
          }
        }

        if (typeof this.businessUnitRepository.findByName === "function") {
          const existingByName =
            await this.businessUnitRepository.findByName(unitName);
          if (existingByName) {
            this.logger.info(
              "Attempt to create duplicate business unit by name",
              { unitName },
            );
            throw new DomainError(
              "BUSINESS_UNIT_ALREADY_EXISTS",
              "A business unit with this name already exists.",
            );
          }
        }
      } catch (err: unknown) {
        if (err instanceof DomainError) throw err;
        const repoErr = err as RepositoryError | undefined;
        this.logger.error("Failed to check existing business unit uniqueness", {
          err,
          unitName,
          companyRegistrationNumber,
        });
        if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database connection error while checking business unit uniqueness.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database timeout while checking business unit uniqueness.",
          );
        }
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to verify business unit uniqueness.",
        );
      }

      // --- Build business unit payload
      const businessUnit: BusinessUnitRecord = {
        id: this.idGenerator.generate(),
        name: unitName,
        registrationNumber: companyRegistrationNumber,
        salesChannelId,
        members: [{ customerId: adminUser.id, role: "COMPANY_ADMIN" }],
        createdAt: new Date().toISOString(),
      };

      // --- Persist business unit (transactional)
      try {
        const persist = async () => {
          await this.businessUnitRepository.save(businessUnit);
        };

        await this.transactionManager.execute(persist);
      } catch (err: unknown) {
        const repoErr = err as RepositoryError | undefined;
        this.logger.error("Failed to persist business unit", {
          err,
          businessUnit,
        });

        if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
          throw new DomainError(
            "BUSINESS_UNIT_ALREADY_EXISTS",
            "A business unit with this registration number or name already exists.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database connection error while saving business unit.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database timeout while saving business unit.",
          );
        }

        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to create business unit.",
        );
      }

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(actorId, "BUSINESS_UNIT_CREATED", {
          auditId: this.idGenerator.generate(),
          businessUnitId: businessUnit.id,
          registrationNumber: businessUnit.registrationNumber,
          salesChannelId: businessUnit.salesChannelId,
          adminCustomerId: adminUser.id,
          createdAt: businessUnit.createdAt,
        });
      } catch (auditErr: unknown) {
        this.logger.warn("Audit log failed for business unit creation", {
          err: auditErr,
          businessUnitId: businessUnit.id,
        });
      }

      this.logger.info("Business unit created", {
        businessUnitId: businessUnit.id,
        registrationNumber: businessUnit.registrationNumber,
      });
      return businessUnit;
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch admin customer", {
        err,
        adminCustomerId,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while fetching admin customer.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while fetching admin customer.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to verify admin customer.",
      );
    }
  }
}
