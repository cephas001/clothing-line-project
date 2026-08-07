// apps/api/src/domain/entities/Customer.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { JsonObject } from "@api/domain/shared/json";

export interface AddressBookEntry extends JsonObject {
  id: string;
}

export interface CustomerProps {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  activeCartId?: string | null;
  passwordHash?: string | null;
  registeredAt?: string | null;
  phone?: string | null;
  addresses?: AddressBookEntry[];
  securityStamp?: string | null;
  passwordUpdatedAt?: string | null;
  failed?: number | null;
  lastFailedAt?: string | null;
  lockUntil?: string | null;
  lastLoginAt?: string | null;
  disabled?: boolean;
  roles?: string[];
  passwordResetTokenId?: string | null;
  passwordResetTokenHash?: string | null;
  passwordResetRequestedAt?: string | null;
  passwordResetExpiresAt?: string | null;
  metadata?: JsonObject;
}

export class Customer {
  readonly id: string;
  public firstName: string;
  public lastName: string;
  private _email!: string;
  public activeCartId: string | null;
  public passwordHash: string | null;
  public registeredAt: string | null;
  public phone: string | null;
  public addresses: AddressBookEntry[];
  public securityStamp: string | null;
  public passwordUpdatedAt: string | null;
  public failed: number | null;
  public lastFailedAt: string | null;
  public lockUntil: string | null;
  public lastLoginAt: string | null;
  public disabled: boolean;
  public roles: string[];
  public passwordResetTokenId: string | null;
  public passwordResetTokenHash: string | null;
  public passwordResetRequestedAt: string | null;
  public passwordResetExpiresAt: string | null;
  public metadata: JsonObject;

  constructor(props: CustomerProps) {
    this.id = props.id;
    this.firstName = props.firstName;
    this.lastName = props.lastName;
    this.activeCartId = props.activeCartId ?? null;
    this.setEmail(props.email);
    this.passwordHash = props.passwordHash ?? null;
    this.registeredAt = props.registeredAt ?? null;
    this.phone = props.phone ?? null;
    this.addresses = props.addresses ? [...props.addresses] : [];
    this.securityStamp = props.securityStamp ?? null;
    this.passwordUpdatedAt = props.passwordUpdatedAt ?? null;
    this.failed = props.failed ?? null;
    this.lastFailedAt = props.lastFailedAt ?? null;
    this.lockUntil = props.lockUntil ?? null;
    this.lastLoginAt = props.lastLoginAt ?? null;
    this.disabled = props.disabled ?? false;
    this.roles = props.roles ? [...props.roles] : [];
    this.passwordResetTokenId = props.passwordResetTokenId ?? null;
    this.passwordResetTokenHash = props.passwordResetTokenHash ?? null;
    this.passwordResetRequestedAt = props.passwordResetRequestedAt ?? null;
    this.passwordResetExpiresAt = props.passwordResetExpiresAt ?? null;
    this.metadata = props.metadata ? { ...props.metadata } : {};
  }

  public setEmail(newEmail: string): void {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      throw new DomainError(
        "INVALID_EMAIL",
        "The provided email address is malformed.",
      );
    }
    this._email = newEmail.toLowerCase();
  }

  get email(): string {
    return this._email;
  }

  public setActiveCart(cartId: string): void {
    if (!cartId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    this.activeCartId = cartId;
  }

  public setPasswordHash(
    passwordHash: string,
    props?: { updatedAt?: string },
  ): void {
    if (!passwordHash || passwordHash.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "passwordHash is required.");
    }
    this.passwordHash = passwordHash;
    this.passwordUpdatedAt = props?.updatedAt ?? new Date().toISOString();
  }

  public bumpSecurityStamp(): void {
    this.securityStamp = new Date().getTime().toString();
  }

  public addAddress(address: AddressBookEntry): void {
    if (!address || !address.id) {
      throw new DomainError("VALIDATION_ERROR", "Address id is required.");
    }
    this.addresses.push(address);
  }

  public updateAddress(addressId: string, addressData: JsonObject): void {
    const existingIndex = this.addresses.findIndex(
      (a) => String(a.id) === String(addressId),
    );
    if (existingIndex === -1) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "Address not found for update.",
      );
    }
    this.addresses[existingIndex] = {
      ...this.addresses[existingIndex],
      ...addressData,
      id: this.addresses[existingIndex].id,
    };
  }

  public removeAddress(addressId: string): void {
    const existingIndex = this.addresses.findIndex(
      (a) => String(a.id) === String(addressId),
    );
    if (existingIndex === -1) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "Address not found for deletion.",
      );
    }
    this.addresses.splice(existingIndex, 1);
  }

  public anonymizePII(props: {
    reason: string;
    erasedBy: string;
    erasedAt?: string;
  }): void {
    if (!props.reason || props.reason.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "reason is required.");
    }
    if (!props.erasedBy || props.erasedBy.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "erasedBy is required.");
    }
    this._email = `${props.erasedBy}-erased@deleted.local`;
    this.firstName = "Erased";
    this.lastName = "User";
    this.phone = null;
    this.addresses = [];
    this.metadata = {
      ...this.metadata,
      erasedAt: props.erasedAt ?? new Date().toISOString(),
      erasedBy: props.erasedBy,
      eraseReason: props.reason,
    };
  }
}