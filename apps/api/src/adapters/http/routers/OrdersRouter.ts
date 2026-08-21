// apps/api/src/adapters/http/routers/OrdersRouter.ts

// HTTP adapter for the order-level logistics endpoints (mounted at /store):
//   GET   /store/orders/{id}            -> GetOrderUseCase
//   POST  /store/orders/{id}/returns    -> InitiateReturnAuthorizationUseCase
//   POST  /store/orders/{id}/edits      -> ProposeOrderEditUseCase
//   POST  /store/order-edits/{id}/confirm -> ConfirmOrderEditUseCase
//   POST  /store/orders/{id}/fulfillments -> DispatchOrderFulfillmentUseCase
//
// These routes are the TRANSPORT BOUNDARY ONLY. They perform, in order:
//   HTTP request
//     -> validate/map input (path params + strict body contract)
//     -> resolve the authenticated actor from the bearer JWT when presented
//        (never from the request body)
//     -> the use case (source of truth) -> map the application result to the
//        provider-neutral response contract
// No refund math, order-edit computation, dispatch state-machine logic, or
// logistics-provider calls exist here.
//
// Request/response contract (matches the OpenAPI spec):
//   GET returns             200  Order
//   POST returns            201  { rmaId, refundAmountMinor, returnLabelUrl }
//   POST edits              201  { orderEditId, differenceDueMinor, status }
//   POST confirm            200  { orderId, orderEditId, status }
//   POST fulfillments       204  (no body)
//   400  VALIDATION_ERROR / INVALID_INPUT (malformed body / unknown fields)
//   403  PERMISSION_DENIED (authenticated actor does not own the order)
//   404  RESOURCE_NOT_FOUND
//   409  INVALID_STATE / INVALID_OPERATION / INVALID_RETURN_ITEM /
//        INVALID_RETURN_QUANTITY / DUPLICATE_RMA
//   500  INTERNAL_ERROR / EXTERNAL_SERVICE_*
//
// Contract notes (documented in the Phase F3 report):
//   - The HTTP ReturnRequest carries `requireReturnLabel` (default true in the
//     spec) and, when a label IS requested, the `returnSelection` (return
//     courier + service rate) the domain genuinely requires to create a label.
//     The router validates `returnSelection` strictly (courierId, serviceCode,
//     amountMinor required; no other keys) and forwards it to the use case. The
//     refund amount is NEVER client-supplied — it is prorated server-side from
//     order pricing, and `returnSelection.amountMinor` is only the return-label
//     courier rate.
//   - DispatchOrderFulfillmentUseCase is snapshot-authoritative: it accepts
//     ONLY the order id. The `preferredCourier` / `serviceLevel` hints once
//     documented are NOT supported by the domain (dispatch reads the frozen
//     snapshot) and have been REMOVED from the OpenAPI contract — any body
//     field is now rejected (strict, additionalProperties: false).
//   - These operations are public in the spec (security: []); the actor is
//     resolved from the bearer JWT only when a valid token is presented.
//
// Security: bearer tokens, secret keys, and provider shipment identities are
// never logged and never echoed into responses.

import express from "express";
import type { Request, Response } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type { InitiateReturnAuthorizationUseCase } from "@api/use-cases/logistics/InitiateReturnAuthorizationUseCase";
import type { ProposeOrderEditUseCase } from "@api/use-cases/logistics/ProposeOrderEditUseCase";
import type { ConfirmOrderEditUseCase } from "@api/use-cases/logistics/ConfirmOrderEditUseCase";
import type { DispatchOrderFulfillmentUseCase } from "@api/use-cases/logistics/DispatchOrderFulfillmentUseCase";
import type { GetOrderUseCase } from "@api/use-cases/logistics/GetOrderUseCase";
import { resolveActorFromBearerToken } from "../middleware/auth";
import { parseStrictBodyObject } from "../middleware/body";
import {
  createBodyParseErrorHandler,
  mapDomainErrorToHttp,
  sendErrorResponse,
} from "../errors";
import { toOrderResponse } from "../projections";
import { toNonNegativeInteger } from "@api/utils/moneyUtils";

const ORDER_BODY_LIMIT = "100kb";
const MAX_RETURN_ITEMS = 100;
const MAX_EDIT_CHANGES = 200;

const RETURN_BODY_KEYS = [
  "orderId",
  "items",
  "requireReturnLabel",
  "returnSelection",
] as const;
const EDIT_BODY_KEYS = ["changes", "reason"] as const;
const CONFIRM_BODY_KEYS = [
  "paymentConfirmed",
  "paymentReference",
] as const;
// Dispatch is snapshot-authoritative (frozen shipping + sourcing snapshots).
// The request body is EMPTY: no courier/service-level/financial hints are
// accepted, so no body key is allowed.
const DISPATCH_BODY_KEYS: readonly string[] = [];

export interface OrdersRouterDeps {
  /** Read-only order retrieval; always wired (depends only on core deps). */
  getOrder: GetOrderUseCase;
  /** Present only when a logistics service is configured (gated route). */
  initiateReturnAuthorization?: InitiateReturnAuthorizationUseCase;
  proposeOrderEdit: ProposeOrderEditUseCase;
  confirmOrderEdit: ConfirmOrderEditUseCase;
  /** Present only when a logistics service is configured (gated route). */
  dispatchOrderFulfillment?: DispatchOrderFulfillmentUseCase;
  /** Verifies the OPTIONAL bearer JWT into the actor identity. */
  tokenService: ITokenService;
  logger: ILogger;
}

export function createOrdersRouter(deps: OrdersRouterDeps): express.Router {
  const router = express.Router();

  // GET /store/orders/:orderId — retrieve an immutable order (public read; the
  // use case enforces customer ownership when a bearer identity is presented).
  router.get(
    "/orders/:orderId",
    async (req: Request, res: Response) => {
      try {
        const orderId = readPathId(req.params.orderId, "orderId");
        const actorId = await resolveActorFromBearerToken(
          req,
          deps.tokenService,
        );
        const order = await deps.getOrder.execute({
          orderId,
          actorId: actorId ?? undefined,
        });
        res.status(200).json(toOrderResponse(order));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Get order");
      }
    },
  );

  // POST /store/orders/:orderId/returns — initiate a return authorization.
  if (deps.initiateReturnAuthorization) {
    router.post(
      "/orders/:orderId/returns",
      express.json({ limit: ORDER_BODY_LIMIT }),
      async (req: Request, res: Response) => {
        try {
          const orderId = readPathId(req.params.orderId, "orderId");
          const body = parseStrictBodyObject(
            req.body,
            RETURN_BODY_KEYS,
            ["orderId", "items"],
          );
          // The body orderId MUST equal the path resource.
          if ((body.orderId as string) !== orderId) {
            throw new DomainError(
              "VALIDATION_ERROR",
              "The orderId in the request body does not match the path.",
            );
          }
          const items = readReturnItems(body.items);
          // A label is only created when explicitly requested; the domain then
          // requires the RETURN courier selection (see the file header).
          const requireReturnLabel = body.requireReturnLabel === true;
          const returnSelection = requireReturnLabel
            ? readReturnSelection(body.returnSelection)
            : undefined;
          const actorId = await resolveActorFromBearerToken(
            req,
            deps.tokenService,
          );
          const result = await deps.initiateReturnAuthorization!.execute({
            orderId,
            items,
            actorId,
            requestedByCustomerId: actorId ?? undefined,
            requireReturnLabel,
            returnSelection,
          });
          res.status(201).json({
            rmaId: result.rmaId,
            refundAmountMinor: result.refundAmountMinor,
            returnLabelUrl: result.returnLabelUrl ?? null,
          });
        } catch (err: unknown) {
          handleError(err, res, deps.logger, "Initiate return authorization");
        }
      },
    );
  }

  // POST /store/orders/:orderId/edits — propose an order edit.
  router.post(
    "/orders/:orderId/edits",
    express.json({ limit: ORDER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const orderId = readPathId(req.params.orderId, "orderId");
        const body = parseStrictBodyObject(req.body, EDIT_BODY_KEYS, ["changes"]);
        const changes = readEditChanges(body.changes);
        const actorId = await resolveActorFromBearerToken(req, deps.tokenService);
        const result = await deps.proposeOrderEdit.execute({
          orderId,
          changes,
          reason:
            typeof body.reason === "string" ? (body.reason as string) : undefined,
          actorId,
        });
        res.status(201).json({
          orderEditId: result.orderEditId,
          differenceDueMinor: result.differenceDueMinor,
          status: result.status,
        });
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Propose order edit");
      }
    },
  );

  // POST /store/order-edits/:orderEditId/confirm — confirm a proposed edit.
  router.post(
    "/order-edits/:orderEditId/confirm",
    express.json({ limit: ORDER_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const orderEditId = readPathId(req.params.orderEditId, "orderEditId");
        const body = parseStrictBodyObject(
          req.body,
          CONFIRM_BODY_KEYS,
          ["paymentConfirmed"],
        );
        const actorId = await resolveActorFromBearerToken(req, deps.tokenService);
        const result = await deps.confirmOrderEdit.execute({
          orderEditId,
          paymentConfirmed: body.paymentConfirmed as boolean,
          paymentReference:
            typeof body.paymentReference === "string"
              ? (body.paymentReference as string)
              : null,
          actorId,
        });
        res.status(200).json({
          orderId: result.orderId,
          orderEditId: result.orderEditId,
          status: result.status,
        });
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Confirm order edit");
      }
    },
  );

  // POST /store/orders/:orderId/fulfillments — dispatch an order. The body is
  // OPTIONAL per the spec, and when present it must be EMPTY: dispatch is
  // snapshot-authoritative and accepts no courier/service-level/financial hints
  // (the contract removed preferredCourier/serviceLevel — see the file header).
  if (deps.dispatchOrderFulfillment) {
    router.post(
      "/orders/:orderId/fulfillments",
      express.json({ limit: ORDER_BODY_LIMIT }),
      async (req: Request, res: Response) => {
        try {
          const orderId = readPathId(req.params.orderId, "orderId");
          // requestBody is not required; validate strictly ONLY when present.
          if (req.body !== undefined && req.body !== null) {
            parseStrictBodyObject(req.body, DISPATCH_BODY_KEYS, []);
          }
          const actorId = await resolveActorFromBearerToken(
            req,
            deps.tokenService,
          );
          await deps.dispatchOrderFulfillment!.execute({ orderId, actorId });
          res.status(204).end();
        } catch (err: unknown) {
          handleError(err, res, deps.logger, "Dispatch order fulfillment");
        }
      },
    );
  }

  // express.json errors (malformed body, oversized payload) never reach the
  // route handler; map them to the standard envelope.
  router.use(createBodyParseErrorHandler(deps.logger, "Orders"));

  return router;
}

/** Read and validate the return items array against the OpenAPI contract. */
function readReturnItems(
  value: unknown,
): Array<{ lineItemId: string; quantity: number; reasonCode: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "items must be a non-empty array.",
    );
  }
  if (value.length > MAX_RETURN_ITEMS) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Too many items. Maximum allowed is ${MAX_RETURN_ITEMS}.`,
    );
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Item at index ${index} must be an object.`,
      );
    }
    const item = raw as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!["lineItemId", "quantity", "reasonCode"].includes(key)) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Unexpected field "${key}" in return item at index ${index}.`,
        );
      }
    }
    const lineItemId = typeof item.lineItemId === "string" ? item.lineItemId : "";
    const quantity = Number(item.quantity);
    const reasonCode =
      typeof item.reasonCode === "string" ? item.reasonCode : "";
    if (!lineItemId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Item at index ${index} must include a lineItemId.`,
      );
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Item at index ${index} quantity must be a positive integer.`,
      );
    }
    if (!reasonCode) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Item at index ${index} must include a reasonCode.`,
      );
    }
    return { lineItemId, quantity, reasonCode };
  });
}

/** Read and validate the return courier selection against the OpenAPI contract. */
function readReturnSelection(value: unknown): {
  quoteId: string;
  courierId: string;
  serviceCode: string;
  serviceLevel?: string;
  amountMinor: number;
  currency?: string;
  etaDays?: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "returnSelection must be an object when requireReturnLabel is true.",
    );
  }
  const selection = value as Record<string, unknown>;
  for (const key of Object.keys(selection)) {
    if (!["quoteId", "courierId", "serviceCode", "serviceLevel", "amountMinor", "currency", "etaDays"].includes(key)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Unexpected field "${key}" in returnSelection.`,
      );
    }
  }
  const courierId = readSelectionString(selection.courierId, "courierId");
  const serviceCode = readSelectionString(selection.serviceCode, "serviceCode");
  const amountMinor = toNonNegativeInteger(selection.amountMinor, "returnSelection amountMinor");
  const quoteId = readOptionalSelectionString(selection.quoteId, "quoteId") ?? "";
  const serviceLevel = readOptionalSelectionString(selection.serviceLevel, "serviceLevel");
  const currency = readOptionalSelectionString(selection.currency, "currency");
  const etaDays =
    selection.etaDays === undefined || selection.etaDays === null
      ? undefined
      : toNonNegativeInteger(selection.etaDays, "returnSelection etaDays");
  return {
    quoteId,
    courierId,
    serviceCode,
    amountMinor,
    ...(serviceLevel ? { serviceLevel } : {}),
    ...(currency ? { currency } : {}),
    ...(etaDays !== undefined ? { etaDays } : {}),
  };
}

function readSelectionString(value: unknown, name: string): string {
  const trimmed = readOptionalSelectionString(value, name);
  if (!trimmed) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `returnSelection ${name} is required and must be a non-empty string.`,
    );
  }
  return trimmed;
}

function readOptionalSelectionString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `returnSelection ${name} must be a non-empty string.`,
    );
  }
  return value.trim();
}

/** Read and validate the order-edit changes array against the OpenAPI contract. */
function readEditChanges(
  value: unknown,
): Array<{
  type: "add" | "remove" | "update";
  lineItemId?: string;
  newVariantId?: string;
  quantity: number;
}> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "changes must be a non-empty array.",
    );
  }
  if (value.length > MAX_EDIT_CHANGES) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Too many changes. Maximum allowed is ${MAX_EDIT_CHANGES}.`,
    );
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Change at index ${index} must be an object.`,
      );
    }
    const change = raw as Record<string, unknown>;
    for (const key of Object.keys(change)) {
      if (!["type", "lineItemId", "newVariantId", "quantity"].includes(key)) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Unexpected field "${key}" in change at index ${index}.`,
        );
      }
    }
    const type = change.type;
    if (!["add", "remove", "update"].includes(type as string)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Change at index ${index} must have a valid type (add|remove|update).`,
      );
    }
    const quantity = Number(change.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Change at index ${index} quantity must be a positive integer.`,
      );
    }
    const lineItemId =
      typeof change.lineItemId === "string" ? change.lineItemId : undefined;
    const newVariantId =
      typeof change.newVariantId === "string" ? change.newVariantId : undefined;
    return { type: type as "add" | "remove" | "update", lineItemId, newVariantId, quantity };
  });
}

/** Read and trim a required path id parameter. */
function readPathId(raw: unknown, name: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new DomainError("VALIDATION_ERROR", `${name} is required.`);
  }
  return value;
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