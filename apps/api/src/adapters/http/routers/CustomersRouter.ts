// apps/api/src/adapters/http/routers/CustomersRouter.ts

// HTTP adapter for the customer profile / address book / B2B / erasure
// endpoints (mounted at /store):
//   POST  /store/customers                          -> RegisterCustomerAccountUseCase
//   GET   /store/customers/me                       -> GetCustomerProfileUseCase
//   GET   /store/customers/me/addresses             -> GetCustomerAddressesUseCase
//   POST  /store/customers/password-reset/initiate  -> InitiatePasswordResetUseCase
//   POST  /store/customers/password-reset/complete  -> CompletePasswordResetUseCase
//   POST  /store/customers/me/addresses             -> ManageAddressBookUseCase (add)
//   PUT   /store/customers/me/addresses/{address_id}-> ManageAddressBookUseCase (update)
//   DELETE /store/customers/me/addresses/{address_id}-> ManageAddressBookUseCase (delete)
//   POST  /store/customers/me/business-units        -> ManageB2BBusinessUnitUseCase
//   POST  /store/customers/me/quotes                -> RequestQuoteUseCase
//   POST  /store/quotes/{id}/approve                -> ApproveB2BQuoteUseCase
//   GET   /store/customers/me/orders                -> RetrieveOrderHistoryUseCase
//   POST  /store/customers/me/erasure               -> ProcessCustomerDataErasureUseCase
//
// These routes are the TRANSPORT BOUNDARY ONLY. They perform, in order:
//   HTTP request
//     -> validate/map input (path params + strict body contract)
//     -> resolve the authenticated actor from the bearer JWT (required on every
//        /store/customers/me + /store/quotes route; registration and the
//        password-reset flows are public)
//     -> the use case (source of truth) -> map the application result to the
//        provider-neutral response contract
// No password hashing, email dispatch, address validation, or erasure logic
// exists here.
//
// Identity rules:
//   - customerId is NEVER read from a request body on the /me routes; the JWT
//     is the only identity source. RequestQuote carries a body customerId that
//     MUST equal the token identity (PERMISSION_DENIED otherwise).
//
// Response contract:
//   POST /store/customers              201  Customer (public projection)
//   GET  /store/customers/me           200  Customer (public projection)
//   GET  /store/customers/me/addresses 200  Address[]
//   POST business-units                201  BusinessUnit
//   GET  /store/customers/me/orders    200  { items: Order[], total }
//   all other mutations                204
//   400  VALIDATION_ERROR / INVALID_INPUT (malformed body / unknown fields)
//   401  UNAUTHORIZED_ACCESS (missing/invalid/expired bearer token)
//   403  PERMISSION_DENIED (body identity differs from the token)
//   404  RESOURCE_NOT_FOUND
//   409  CUSTOMER_ALREADY_EXISTS / INVALID_STATE / BUSINESS_UNIT_ALREADY_EXISTS
//   500  INTERNAL_ERROR
//
// Security: bearer tokens, password material, and reset tokens are never
// logged and never echoed into responses.

import express from "express";
import type { Request, Response } from "express";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { RegisterCustomerAccountUseCase } from "@api/use-cases/customers/RegisterCustomerAccountUseCase";
import type { GetCustomerAddressesUseCase } from "@api/use-cases/customers/GetCustomerAddressesUseCase";
import type { GetCustomerProfileUseCase } from "@api/use-cases/customers/GetCustomerProfileUseCase";
import type { InitiatePasswordResetUseCase } from "@api/use-cases/customers/InitiatePasswordResetUseCase";
import type { CompletePasswordResetUseCase } from "@api/use-cases/customers/CompletePasswordResetUseCase";
import type { ManageAddressBookUseCase } from "@api/use-cases/customers/ManageAddressBookUseCase";
import type { ManageB2BBusinessUnitUseCase } from "@api/use-cases/customers/ManageB2BBusinessUnitUseCase";
import type { RequestQuoteUseCase } from "@api/use-cases/customers/RequestQuoteUseCase";
import type { ApproveB2BQuoteUseCase } from "@api/use-cases/customers/ApproveB2BQuoteUseCase";
import type { RetrieveOrderHistoryUseCase } from "@api/use-cases/customers/RetrieveOrderHistoryUseCase";
import type { ProcessCustomerDataErasureUseCase } from "@api/use-cases/customers/ProcessCustomerDataErasureUseCase";
import { resolveActorFromBearerToken } from "../middleware/auth";
import {
  parseStrictBodyObject,
  readQueryInt,
  readRequiredPathId,
} from "../middleware/body";
import {
  createBodyParseErrorHandler,
  mapDomainErrorToHttp,
  sendErrorResponse,
} from "../errors";
import {
  toBusinessUnitResponse,
  toCustomerResponse,
  toOrderResponse,
} from "../projections";

const CUSTOMER_BODY_LIMIT = "100kb";
const ORDER_HISTORY_DEFAULT_LIMIT = 10;
const ORDER_HISTORY_MAX_LIMIT = 100;

const REGISTER_BODY_KEYS = ["firstName", "lastName", "email", "password"] as const;
const INITIATE_RESET_BODY_KEYS = ["email"] as const;
const COMPLETE_RESET_BODY_KEYS = ["resetToken", "newPassword"] as const;
const BUSINESS_UNIT_BODY_KEYS = [
  "unitName",
  "adminCustomerId",
  "companyRegistrationNumber",
  "salesChannelId",
] as const;
const REQUEST_QUOTE_BODY_KEYS = [
  "cartId",
  "customerId",
  "businessUnitId",
  "customerNotes",
  "freezeCart",
] as const;
const APPROVE_QUOTE_BODY_KEYS = ["approvedTotalMinor", "approvalNote"] as const;
const ERASURE_BODY_KEYS = ["reason"] as const;

export interface CustomersRouterDeps {
  registerCustomerAccount: RegisterCustomerAccountUseCase;
  /** Read-only profile retrieval; always wired (depends only on core deps). */
  getCustomerProfile: GetCustomerProfileUseCase;
  /** Read-only address-book listing; always wired (depends only on core deps). */
  getCustomerAddresses: GetCustomerAddressesUseCase;
  /**
   * Present only when the notification service is configured. When absent the
   * password-reset/initiate route is not registered (requests receive a 404);
   * it is never faked.
   */
  initiatePasswordReset?: InitiatePasswordResetUseCase;
  completePasswordReset: CompletePasswordResetUseCase;
  manageAddressBook: ManageAddressBookUseCase;
  manageB2BBusinessUnit: ManageB2BBusinessUnitUseCase;
  requestQuote: RequestQuoteUseCase;
  approveB2BQuote: ApproveB2BQuoteUseCase;
  retrieveOrderHistory: RetrieveOrderHistoryUseCase;
  processCustomerDataErasure: ProcessCustomerDataErasureUseCase;
  /** Verifies the bearer JWT (POST /store/auth) into the actor identity. */
  tokenService: ITokenService;
  logger: ILogger;
}

export function createCustomersRouter(deps: CustomersRouterDeps): express.Router {
  const router = express.Router();

  // POST /store/customers — register a new customer account (public).
  router.post(
    "/customers",
    express.json({ limit: CUSTOMER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const body = parseStrictBodyObject(
          req.body,
          REGISTER_BODY_KEYS,
          ["firstName", "lastName", "email", "password"],
        );
        const customer = await deps.registerCustomerAccount.execute({
          firstName: body.firstName as string,
          lastName: body.lastName as string,
          email: body.email as string,
          passwordRaw: body.password as string,
        });
        res.status(201).json(toCustomerResponse(customer));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Register customer");
      }
    },
  );

  // POST /store/customers/password-reset/initiate (public; notification-gated).
  if (deps.initiatePasswordReset) {
    router.post(
      "/customers/password-reset/initiate",
      express.json({ limit: CUSTOMER_BODY_LIMIT }),
      async (req: Request, res: Response) => {
        try {
          const body = parseStrictBodyObject(
            req.body,
            INITIATE_RESET_BODY_KEYS,
            ["email"],
          );
          await deps.initiatePasswordReset!.execute({
            email: body.email as string,
            ipAddress: req.ip,
            userAgent: req.get("user-agent") ?? undefined,
          });
          res.status(204).end();
        } catch (err: unknown) {
          handleError(err, res, deps.logger, "Initiate password reset");
        }
      },
    );
  }

  // POST /store/customers/password-reset/complete (public).
  router.post(
    "/customers/password-reset/complete",
    express.json({ limit: CUSTOMER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const body = parseStrictBodyObject(
          req.body,
          COMPLETE_RESET_BODY_KEYS,
          ["resetToken", "newPassword"],
        );
        await deps.completePasswordReset.execute({
          resetToken: body.resetToken as string,
          newPasswordRaw: body.newPassword as string,
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? undefined,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Complete password reset");
      }
    },
  );

  // GET /store/customers/me — retrieve the authenticated customer's public
  // profile (auth required; identity always from the bearer JWT).
  router.get(
    "/customers/me",
    async (req: Request, res: Response) => {
      try {
        const customerId = await requireActor(req, deps.tokenService);
        const customer = await deps.getCustomerProfile.execute({
          customerId,
          actorId: customerId,
        });
        res.status(200).json(toCustomerResponse(customer));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Get customer profile");
      }
    },
  );

  // GET /store/customers/me/addresses — list the authenticated customer's
  // address book (auth required; identity always from the bearer JWT).
  router.get(
    "/customers/me/addresses",
    async (req: Request, res: Response) => {
      try {
        const customerId = await requireActor(req, deps.tokenService);
        const addresses = await deps.getCustomerAddresses.execute({
          customerId,
          actorId: customerId,
        });
        res.status(200).json(addresses.map((entry) => ({ ...entry })));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Get customer addresses");
      }
    },
  );

  // POST /store/customers/me/addresses — add an address (auth required).
  router.post(
    "/customers/me/addresses",
    express.json({ limit: CUSTOMER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const customerId = await requireActor(req, deps.tokenService);
        const addressData = readAddressBody(req.body);
        await deps.manageAddressBook.execute({
          customerId,
          action: "add",
          addressData,
          actorId: customerId,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Add customer address");
      }
    },
  );

  // PUT /store/customers/me/addresses/{address_id} — update an address.
  router.put(
    "/customers/me/addresses/:address_id",
    express.json({ limit: CUSTOMER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const customerId = await requireActor(req, deps.tokenService);
        const addressId = readRequiredPathId(req.params.address_id, "addressId");
        const addressData = readAddressBody(req.body);
        await deps.manageAddressBook.execute({
          customerId,
          action: "update",
          addressId,
          addressData,
          actorId: customerId,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Update customer address");
      }
    },
  );

  // DELETE /store/customers/me/addresses/{address_id} — delete an address.
  router.delete(
    "/customers/me/addresses/:address_id",
    express.json({ limit: CUSTOMER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const customerId = await requireActor(req, deps.tokenService);
        const addressId = readRequiredPathId(req.params.address_id, "addressId");
        await deps.manageAddressBook.execute({
          customerId,
          action: "delete",
          addressId,
          addressData: {},
          actorId: customerId,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Delete customer address");
      }
    },
  );

  // POST /store/customers/me/business-units — create a B2B business unit.
  router.post(
    "/customers/me/business-units",
    express.json({ limit: CUSTOMER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const actorId = await requireActor(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          BUSINESS_UNIT_BODY_KEYS,
          ["unitName", "adminCustomerId", "companyRegistrationNumber", "salesChannelId"],
        );
        const record = await deps.manageB2BBusinessUnit.execute({
          unitName: body.unitName as string,
          adminCustomerId: body.adminCustomerId as string,
          companyRegistrationNumber: body.companyRegistrationNumber as string,
          salesChannelId: body.salesChannelId as string,
          actorId,
        });
        res.status(201).json(toBusinessUnitResponse(record));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Create business unit");
      }
    },
  );

  // POST /store/customers/me/quotes — request a B2B quote for a cart.
  router.post(
    "/customers/me/quotes",
    express.json({ limit: CUSTOMER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const actorId = await requireActor(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          REQUEST_QUOTE_BODY_KEYS,
          ["cartId", "customerId", "businessUnitId"],
        );
        // The body customerId MUST equal the authenticated identity.
        if (actorId !== (body.customerId as string)) {
          throw new DomainError(
            "PERMISSION_DENIED",
            "The customerId does not match the authenticated customer.",
          );
        }
        await deps.requestQuote.execute({
          cartId: body.cartId as string,
          customerId: body.customerId as string,
          businessUnitId: body.businessUnitId as string,
          customerNotes:
            typeof body.customerNotes === "string"
              ? (body.customerNotes as string)
              : undefined,
          freezeCart:
            typeof body.freezeCart === "boolean"
              ? (body.freezeCart as boolean)
              : undefined,
          actorId,
        });
        res.status(202).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Request quote");
      }
    },
  );

  // POST /store/quotes/{id}/approve — approve a pending B2B quote.
  router.post(
    "/quotes/:id/approve",
    express.json({ limit: CUSTOMER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const actorId = await requireActor(req, deps.tokenService);
        const quoteId = readRequiredPathId(req.params.id, "quoteId");
        const body = parseStrictBodyObject(
          req.body,
          APPROVE_QUOTE_BODY_KEYS,
          ["approvedTotalMinor"],
        );
        // The only identity the transport can resolve is the bearer JWT's
        // customer identity; the use case records it as the approving actor.
        await deps.approveB2BQuote.execute({
          quoteId,
          adminId: actorId,
          approvedTotalMinor: body.approvedTotalMinor as number,
          approvalNote:
            typeof body.approvalNote === "string"
              ? (body.approvalNote as string)
              : undefined,
          actorId,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Approve quote");
      }
    },
  );

  // GET /store/customers/me/orders — paginated order history.
  router.get(
    "/customers/me/orders",
    async (req: Request, res: Response) => {
      try {
        const customerId = await requireActor(req, deps.tokenService);
        const limit = readQueryInt(
          req.query.limit,
          "limit",
          1,
          ORDER_HISTORY_MAX_LIMIT,
          ORDER_HISTORY_DEFAULT_LIMIT,
        );
        const offset = readQueryInt(
          req.query.offset,
          "offset",
          0,
          1_000_000_000,
          0,
        );
        const result = await deps.retrieveOrderHistory.execute({
          customerId,
          limit,
          offset,
          actorId: customerId,
        });
        res.status(200).json({
          items: result.items.map(toOrderResponse),
          total: result.total,
        });
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Retrieve order history");
      }
    },
  );

  // POST /store/customers/me/erasure — GDPR/CCPA data erasure (auth required).
  router.post(
    "/customers/me/erasure",
    express.json({ limit: CUSTOMER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const customerId = await requireActor(req, deps.tokenService);
        const body = req.body;
        let reason: string | undefined;
        if (body !== undefined && body !== null) {
          if (typeof body !== "object" || Array.isArray(body)) {
            throw new DomainError(
              "VALIDATION_ERROR",
              "Request body must be a JSON object.",
            );
          }
          const record = body as Record<string, unknown>;
          for (const key of Object.keys(record)) {
            if (!(ERASURE_BODY_KEYS as readonly string[]).includes(key)) {
              throw new DomainError(
                "VALIDATION_ERROR",
                `Unexpected field "${key}" in request body.`,
              );
            }
          }
          if (typeof record.reason === "string") {
            reason = record.reason as string;
          } else if (record.reason !== undefined) {
            throw new DomainError(
              "VALIDATION_ERROR",
              "reason must be a string.",
            );
          }
        }
        await deps.processCustomerDataErasure.execute({
          customerId,
          reason,
          actorId: customerId,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Customer data erasure");
      }
    },
  );

  // express.json errors (malformed body, oversized payload) never reach the
  // route handler; map them to the standard envelope.
  router.use(createBodyParseErrorHandler(deps.logger, "Customers"));

  return router;
}

/**
 * Resolve the authenticated customer from the bearer JWT. The /me routes
 * inherit bearerAuth, so a missing/invalid token is a 401 — never a silent
 * guest flow.
 */
async function requireActor(
  req: Request,
  tokenService: ITokenService,
): Promise<string> {
  const actorId = await resolveActorFromBearerToken(req, tokenService);
  if (!actorId) {
    throw new DomainError("UNAUTHORIZED_ACCESS", "Authentication required.");
  }
  return actorId;
}

/**
 * Read the address body. The OpenAPI `AddressInput` schema allows unknown keys
 * (additionalProperties: true), so the whole object is forwarded verbatim —
 * address shape validation is owned by the use case / repository.
 */
function readAddressBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Request body must be a JSON object.",
    );
  }
  return body as Record<string, unknown>;
}

/** Map a thrown error to the canonical envelope + log the rejection. */
function handleError(
  err: unknown,
  res: Response,
  logger: ILogger,
  context: string,
): void {
  const mapped = mapDomainErrorToHttp(err);
  logger.warn(`${context} request rejected`, {
    status: mapped.status,
    code: mapped.code,
  });
  sendErrorResponse(res, mapped);
}