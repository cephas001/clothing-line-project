// apps/api/src/use-cases/admin/ManageAdminRolePermissionsUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IRoleRepository } from "@api/domain/interfaces/repositories/IRoleRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for managing admin role permissions.
 * - adminId is required for audit logging and accountability.
 */
export interface ManageAdminRolePermissionsInput {
  adminId: string;
  roleId: string;
  permissions: string[]; // e.g., ["read:products", "write:pricing"]
}

/**
 * Use case: update the permissions assigned to an admin role.
 *
 * Responsibilities:
 * - Validate and normalize inputs.
 * - Ensure role exists.
 * - Validate permission values (basic sanity checks).
 * - Persist the change (atomically via the transaction manager).
 * - Map repository errors to DomainError for consistent API surface.
 * - Emit a non-blocking audit log entry.
 * - Log important events and failures via injected logger.
 */
export class ManageAdminRolePermissionsUseCase {
  constructor(
    private roleRepository: IRoleRepository,
    private auditLogService: IAuditLogService,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: ManageAdminRolePermissionsInput): Promise<void> {
    // --- Normalize and validate inputs
    const adminId = (input.adminId ?? "").trim();
    const roleId = (input.roleId ?? "").trim();
    const rawPermissions = input.permissions;

    if (!adminId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "adminId is required for audit logging.",
      );
    }

    if (!roleId) {
      throw new DomainError("VALIDATION_ERROR", "roleId is required.");
    }

    if (!Array.isArray(rawPermissions)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Permissions must be an array of strings.",
      );
    }

    // Normalize, dedupe and validate permission strings
    const permissions = rawPermissions
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // Remove duplicates while preserving order
    const seen = new Set<string>();
    const normalizedPermissions: string[] = [];
    for (const p of permissions) {
      const normalized = p.toLowerCase(); // normalize case for storage/compare
      if (!seen.has(normalized)) {
        seen.add(normalized);
        normalizedPermissions.push(normalized);
      }
    }

    if (normalizedPermissions.length === 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "At least one valid permission is required.",
      );
    }

    // Basic permission format validation (adjust regex to your rules)
    const permissionPattern = /^[a-z0-9]+:[a-z0-9-]+$/;
    for (const p of normalizedPermissions) {
      if (!permissionPattern.test(p)) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Invalid permission format: "${p}". Expected format "resource:action".`,
        );
      }
    }

    // --- Ensure role exists
    let role;
    try {
      role = await this.roleRepository.findById(roleId);
    } catch (err: any) {
      this.logger.error("Failed to fetch role", { err, roleId });
      throw new DomainError("INTERNAL_ERROR", "Failed to validate role.");
    }

    if (!role) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "The specified role does not exist.",
      );
    }

    // --- Apply permission changes on the role entity
    // Keep a copy of previous permissions for audit
    const previousPermissions = Array.isArray(role.permissions)
      ? [...role.permissions]
      : [];

    role.updatePermissions(normalizedPermissions);

    // --- Persist (atomic via the transaction manager)
    try {
      const saveFn = async () => {
        await this.roleRepository.save(role);
      };

      await this.transactionManager.execute(saveFn);

      // --- Audit log success (non-blocking)
      try {
        await this.auditLogService.logAction(
          adminId,
          "ROLE_PERMISSIONS_UPDATED",
          {
            roleId,
            previousPermissions,
            newPermissions: normalizedPermissions,
          },
        );
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for role permissions update", {
          err: auditErr,
          roleId,
          adminId,
        });
      }

      this.logger.info("Role permissions updated", {
        roleId,
        adminId,
        previousCount: previousPermissions.length,
        newCount: normalizedPermissions.length,
      });
      return;
    } catch (err: any) {
      // Map repository duplicate or transient errors to DomainError where appropriate
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // Unlikely for permissions update, but handle defensively
        this.logger.warn(
          "Repository reported duplicate constraint while saving role",
          { err, roleId },
        );
        throw new DomainError(
          "INVALID_OPERATION",
          "Failed to update role due to a uniqueness constraint.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while saving role", {
          err,
          roleId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving role.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving role", { err, roleId });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving role.",
        );
      }

      // Fallback: log and wrap unexpected errors
      this.logger.error("Failed to persist role permissions", { err, roleId });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist role permissions.",
      );
    }
  }
}
