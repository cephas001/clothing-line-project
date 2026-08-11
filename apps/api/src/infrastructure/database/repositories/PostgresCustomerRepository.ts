// apps/api/src/infrastructure/database/repositories/PostgresCustomerRepository.ts

// Postgres-backed implementation of ICustomerRepository.
//
// Full read/write access to the customer aggregate. JSONB columns (addresses,
// roles, metadata) are serialized on write and parsed on read. email is stored
// lowercase (enforced by the domain entity) with a unique index.

import { Customer } from "@api/domain/entities/Customer";
import type { CustomerAuthenticationMetadata } from "@api/domain/shared/contracts";
import type { ICustomerRepository } from "@api-domain-interfaces/repositories/ICustomerRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type CustomerRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  active_cart_id: string | null;
  password_hash: string | null;
  registered_at: string | null;
  phone: string | null;
  addresses: unknown;
  security_stamp: string | null;
  password_updated_at: string | null;
  failed: number | null;
  last_failed_at: string | null;
  lock_until: string | null;
  last_login_at: string | null;
  disabled: boolean;
  roles: unknown;
  password_reset_token_id: string | null;
  password_reset_token_hash: string | null;
  password_reset_requested_at: string | null;
  password_reset_expires_at: string | null;
  password_reset_request_ip: string | null;
  metadata: unknown;
};

function toDomain(row: CustomerRow): Customer {
  return new Customer({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    activeCartId: row.active_cart_id,
    passwordHash: row.password_hash,
    registeredAt: row.registered_at,
    phone: row.phone,
    addresses: Array.isArray(row.addresses) ? row.addresses : [],
    securityStamp: row.security_stamp,
    passwordUpdatedAt: row.password_updated_at,
    failed: row.failed,
    lastFailedAt: row.last_failed_at,
    lockUntil: row.lock_until,
    lastLoginAt: row.last_login_at,
    disabled: row.disabled,
    roles: Array.isArray(row.roles) ? row.roles : [],
    passwordResetTokenId: row.password_reset_token_id,
    passwordResetTokenHash: row.password_reset_token_hash,
    passwordResetRequestedAt: row.password_reset_requested_at,
    passwordResetExpiresAt: row.password_reset_expires_at,
    passwordResetRequestIp: row.password_reset_request_ip,
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
  });
}

export class PostgresCustomerRepository implements ICustomerRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(customerId: string): Promise<Customer | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("customer")
        .selectAll()
        .where("id", "=", customerId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByEmail(email: string): Promise<Customer | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("customer")
        .selectAll()
        .where("email", "=", email.toLowerCase())
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(customer: Customer): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("customer")
        .values({
          id: customer.id,
          first_name: customer.firstName,
          last_name: customer.lastName,
          email: customer.email,
          active_cart_id: customer.activeCartId,
          password_hash: customer.passwordHash,
          registered_at: customer.registeredAt,
          phone: customer.phone,
          addresses: JSON.stringify(customer.addresses),
          security_stamp: customer.securityStamp,
          password_updated_at: customer.passwordUpdatedAt,
          failed: customer.failed,
          last_failed_at: customer.lastFailedAt,
          lock_until: customer.lockUntil,
          last_login_at: customer.lastLoginAt,
          disabled: customer.disabled,
          roles: JSON.stringify(customer.roles),
          password_reset_token_id: customer.passwordResetTokenId,
          password_reset_token_hash: customer.passwordResetTokenHash,
          password_reset_requested_at: customer.passwordResetRequestedAt,
          password_reset_expires_at: customer.passwordResetExpiresAt,
          password_reset_request_ip: customer.passwordResetRequestIp,
          metadata: JSON.stringify(customer.metadata),
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            first_name: customer.firstName,
            last_name: customer.lastName,
            email: customer.email,
            active_cart_id: customer.activeCartId,
            password_hash: customer.passwordHash,
            registered_at: customer.registeredAt,
            phone: customer.phone,
            addresses: JSON.stringify(customer.addresses),
            security_stamp: customer.securityStamp,
            password_updated_at: customer.passwordUpdatedAt,
            failed: customer.failed,
            last_failed_at: customer.lastFailedAt,
            lock_until: customer.lockUntil,
            last_login_at: customer.lastLoginAt,
            disabled: customer.disabled,
            roles: JSON.stringify(customer.roles),
            password_reset_token_id: customer.passwordResetTokenId,
            password_reset_token_hash: customer.passwordResetTokenHash,
            password_reset_requested_at: customer.passwordResetRequestedAt,
            password_reset_expires_at: customer.passwordResetExpiresAt,
            password_reset_request_ip: customer.passwordResetRequestIp,
            metadata: JSON.stringify(customer.metadata),
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async updateAuthenticationMetadata(
    customerId: string,
    updates: CustomerAuthenticationMetadata,
  ): Promise<void> {
    try {
      const db = this.context.getDb();

      await db
        .updateTable("customer")
        .set({
          ...(updates.failedAttempts !== undefined
            ? { failed: updates.failedAttempts }
            : {}),
          ...(updates.lastFailedAt !== undefined
            ? { last_failed_at: updates.lastFailedAt }
            : {}),
          ...(updates.lockUntil !== undefined
            ? { lock_until: updates.lockUntil }
            : {}),
          ...(updates.lastLoginAt !== undefined
            ? { last_login_at: updates.lastLoginAt }
            : {}),
          ...(updates.passwordHash !== undefined
            ? { password_hash: updates.passwordHash }
            : {}),
          ...(updates.passwordUpdatedAt !== undefined
            ? { password_updated_at: updates.passwordUpdatedAt }
            : {}),
          ...(updates.passwordResetTokenId !== undefined
            ? { password_reset_token_id: updates.passwordResetTokenId }
            : {}),
          ...(updates.passwordResetTokenHash !== undefined
            ? { password_reset_token_hash: updates.passwordResetTokenHash }
            : {}),
          ...(updates.passwordResetRequestedAt !== undefined
            ? { password_reset_requested_at: updates.passwordResetRequestedAt }
            : {}),
          ...(updates.passwordResetExpiresAt !== undefined
            ? { password_reset_expires_at: updates.passwordResetExpiresAt }
            : {}),
          ...(updates.passwordResetRequestIp !== undefined
            ? { password_reset_request_ip: updates.passwordResetRequestIp }
            : {}),
          ...(updates.securityStamp !== undefined
            ? { security_stamp: updates.securityStamp }
            : {}),
          ...(updates.email !== undefined && updates.email !== null
            ? { email: updates.email }
            : {}),
          ...(updates.firstName !== undefined && updates.firstName !== null
            ? { first_name: updates.firstName }
            : {}),
          ...(updates.lastName !== undefined && updates.lastName !== null
            ? { last_name: updates.lastName }
            : {}),
          ...(updates.phone !== undefined ? { phone: updates.phone } : {}),
          ...(updates.addresses !== undefined
            ? { addresses: JSON.stringify(updates.addresses) }
            : {}),
          ...(updates.metadata !== undefined
            ? { metadata: JSON.stringify(updates.metadata) }
            : {}),
        })
        .where("id", "=", customerId)
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
