// apps/api/src/domain/entities/Role.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface RoleProps {
  id: string;
  name: string;
  permissions: string[];
}

export class Role {
  readonly id: string;
  readonly name: string;

  private _permissions: string[];

  constructor(props: RoleProps) {
    if (!props.name.trim()) {
      throw new DomainError("VALIDATION_ERROR", "Role name is required.");
    }

    this.id = props.id;
    this.name = props.name.trim();
    this._permissions = this.normalizePermissions(props.permissions);
  }

  get permissions(): string[] {
    return [...this._permissions];
  }

  public updatePermissions(permissions: string[]): void {
    this._permissions = this.normalizePermissions(permissions);
  }

  public hasPermission(permission: string): boolean {
    return this._permissions.includes(permission.toLowerCase());
  }

  private normalizePermissions(permissions: string[]): string[] {
    if (!Array.isArray(permissions)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Permissions must be an array.",
      );
    }

    const pattern = /^[a-z0-9]+:[a-z0-9-]+$/;

    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const permission of permissions) {
      if (typeof permission !== "string") {
        continue;
      }

      const value = permission.trim().toLowerCase();

      if (!value) {
        continue;
      }

      if (!pattern.test(value)) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Invalid permission: "${permission}".`,
        );
      }

      if (!seen.has(value)) {
        seen.add(value);
        normalized.push(value);
      }
    }

    if (normalized.length === 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "A role must contain at least one permission.",
      );
    }

    return normalized;
  }
}
