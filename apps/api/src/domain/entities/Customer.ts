// apps/api/src/domain/entities/Customer.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { JsonObject } from "@api/domain/shared/json";

/**
 * AddressBookEntry
 * - Simple address shape that extends JsonObject and requires an id.
 */
export interface AddressBookEntry extends JsonObject {
  id: string;
}

/**
 * CustomerProps
 * - Plain data shape used to construct a Customer entity.
 */
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
  passwordResetRequestIp?: string | null;
  metadata?: JsonObject;
}

/**
 * Customer
 *
 * Domain entity representing a user/customer.
 * - All setters validate inputs and throw DomainError on invalid state.
 * - Methods encapsulate authentication-related metadata and address book management.
 */
export class Customer {
  // -------------------------
  // Identity / basic profile
  // -------------------------
  readonly id: string;
  public firstName: string;
  public lastName: string;
  private _email!: string;

  // -------------------------
  // Session / cart / auth state
  // -------------------------
  public activeCartId: string | null;
  public passwordHash: string | null;
  public registeredAt: string | null;
  public phone: string | null;

  // -------------------------
  // Address book
  // -------------------------
  public addresses: AddressBookEntry[];

  // -------------------------
  // Security / auth metadata
  // -------------------------
  public securityStamp: string | null;
  public passwordUpdatedAt: string | null;
  public failed: number | null;
  public lastFailedAt: string | null;
  public lockUntil: string | null;
  public lastLoginAt: string | null;
  public disabled: boolean;
  public roles: string[];

  // -------------------------
  // Password reset metadata
  // -------------------------
  public passwordResetTokenId: string | null;
  public passwordResetTokenHash: string | null;
  public passwordResetRequestedAt: string | null;
  public passwordResetExpiresAt: string | null;
  public passwordResetRequestIp: string | null;

  // -------------------------
  // Misc
  // -------------------------
  public metadata: JsonObject;

  // -------------------------
  // Constructor and initialization
  // -------------------------
  constructor(props: CustomerProps) {
    this.id = props.id;

    // Basic profile
    this.firstName = props.firstName;
    this.lastName = props.lastName;
    this.setEmail(props.email);

    // Cart / registration
    this.activeCartId = props.activeCartId ?? null;
    this.passwordHash = props.passwordHash ?? null;
    this.registeredAt = props.registeredAt ?? null;
    this.phone = props.phone ?? null;

    // Addresses (defensive copy)
    this.addresses = props.addresses ? [...props.addresses] : [];

    // Security metadata
    this.securityStamp = props.securityStamp ?? null;
    this.passwordUpdatedAt = props.passwordUpdatedAt ?? null;
    this.failed = props.failed ?? null;
    this.lastFailedAt = props.lastFailedAt ?? null;
    this.lockUntil = props.lockUntil ?? null;
    this.lastLoginAt = props.lastLoginAt ?? null;
    this.disabled = props.disabled ?? false;
    this.roles = props.roles ? [...props.roles] : [];

    // Password reset metadata
    this.passwordResetTokenId = props.passwordResetTokenId ?? null;
    this.passwordResetTokenHash = props.passwordResetTokenHash ?? null;
    this.passwordResetRequestedAt = props.passwordResetRequestedAt ?? null;
    this.passwordResetExpiresAt = props.passwordResetExpiresAt ?? null;
    this.passwordResetRequestIp = props.passwordResetRequestIp ?? null;

    // Misc metadata (defensive copy)
    this.metadata = props.metadata ? { ...props.metadata } : {};
  }

  // -------------------------
  // Email handling
  // -------------------------

  /**
   * setEmail
   * - Validates email format and stores a normalized (lowercased) value.
   * - Throws DomainError with code INVALID_EMAIL on malformed input.
   */
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

  /**
   * email (getter)
   * - Exposes the normalized email address.
   */
  get email(): string {
    return this._email;
  }

  // -------------------------
  // Cart association
  // -------------------------

  /**
   * setActiveCart
   * - Bind a cart to the customer; validates non-empty cartId.
   */
  public setActiveCart(cartId: string): void {
    if (!cartId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    this.activeCartId = cartId;
  }

  // -------------------------
  // Password and security helpers
  // -------------------------

  /**
   * setPasswordHash
   * - Persist a password hash and update the passwordUpdatedAt timestamp.
   * - Throws if passwordHash is empty.
   */
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

  /**
   * bumpSecurityStamp
   * - Change the security stamp to invalidate existing tokens/sessions.
   * - Uses a timestamp string for simplicity.
   */
  public bumpSecurityStamp(): void {
    this.securityStamp = new Date().getTime().toString();
  }

  // -------------------------
  // Password reset lifecycle
  // -------------------------

  /**
   * requestPasswordReset
   * - Store token id/hash and request metadata when initiating a reset.
   */
  public requestPasswordReset(props: {
    tokenId: string;
    tokenHash: string;
    requestIp?: string | null;
    requestedAt: string;
    expiresAt: string;
  }): void {
    this.passwordResetTokenId = props.tokenId;
    this.passwordResetTokenHash = props.tokenHash;
    this.passwordResetRequestedAt = props.requestedAt;
    this.passwordResetExpiresAt = props.expiresAt;
    this.passwordResetRequestIp = props.requestIp ?? null;
  }

  /**
   * clearPasswordResetMetadata
   * - Remove any stored password reset tokens and related timestamps.
   */
  public clearPasswordResetMetadata(): void {
    this.passwordResetTokenId = null;
    this.passwordResetTokenHash = null;
    this.passwordResetRequestedAt = null;
    this.passwordResetExpiresAt = null;
    this.passwordResetRequestIp = null;
  }

  // -------------------------
  // Address book management
  // -------------------------

  /**
   * addAddress
   * - Add an address entry to the customer's address book.
   * - Validates that the address has an id.
   */
  public addAddress(address: AddressBookEntry): void {
    if (!address || !address.id) {
      throw new DomainError("VALIDATION_ERROR", "Address id is required.");
    }
    this.addresses.push(address);
  }

  /**
   * updateAddress
   * - Update an existing address by id; merges provided fields.
   * - Throws RESOURCE_NOT_FOUND if the address does not exist.
   */
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

  /**
   * removeAddress
   * - Remove an address by id from the address book.
   * - Throws RESOURCE_NOT_FOUND if the address does not exist.
   */
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

  // -------------------------
  // Data erasure / privacy
  // -------------------------

  /**
   * anonymizePII
   * - Wipe or replace personally identifiable information in-place.
   * - Validates required reason and erasedBy values.
   * - Updates metadata with erasure audit fields.
   */
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

    // Replace email with an erased sentinel and normalize other fields
    this._email = `${props.erasedBy}-erased@deleted.local`;
    this.firstName = "Erased";
    this.lastName = "User";
    this.phone = null;
    this.addresses = [];

    // Preserve and extend metadata with erasure audit info
    this.metadata = {
      ...this.metadata,
      erasedAt: props.erasedAt ?? new Date().toISOString(),
      erasedBy: props.erasedBy,
      eraseReason: props.reason,
    };
  }
}
