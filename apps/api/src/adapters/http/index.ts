// apps/api/src/adapters/http/index.ts

// Public barrel for the HTTP adapter directory. Groups the transport-boundary
// surface so composition roots and tests can import the whole adapter from a
// single path: routers/ (route-definition modules), middleware/ (request
// parsing + bearer-auth helpers), errors.ts (canonical error pipeline) and
// projections.ts (public response DTOs). Consumers that need a single symbol
// may keep importing the specific file directly.

export { createAuthRouter, type AuthRouterDeps } from "./routers/AuthRouter";
export {
  createCatalogRouter,
  type CatalogRouterDeps,
} from "./routers/CatalogRouter";
export {
  createCheckoutShippingRouter,
  type CheckoutShippingRouterDeps,
} from "./routers/CheckoutShippingRouter";
export {
  createPaymentInitializationRouter,
  type PaymentInitializationRouterDeps,
} from "./routers/PaymentInitializationRouter";
export {
  createPaymentWebhookRouter,
  type PaymentWebhookRouterDeps,
} from "./routers/PaymentWebhookRouter";
export {
  createShipbubbleWebhookRouter,
  type ShipbubbleWebhookRouterDeps,
} from "./routers/ShipbubbleWebhookRouter";
export { createSwapRouter, type SwapRouterDeps } from "./routers/SwapRouter";

export {
  resolveActorAndTokenFromBearerToken,
  resolveActorFromBearerToken,
  type ResolvedActor,
} from "./middleware/auth";
export {
  assertEmptyRequestBody,
  parseStrictBodyObject,
  readOptionalHeader,
  readQueryBoolean,
  readQueryInt,
  readQueryString,
  readRequiredPathId,
  readRequiredQueryString,
  splitCsv,
} from "./middleware/body";

export {
  createBodyParseErrorHandler,
  createNotFoundHandler,
  createTerminalErrorHandler,
  mapDomainErrorToHttp,
  sendErrorResponse,
  type HttpErrorMapping,
} from "./errors";

export {
  toProductListResponse,
  toProductResponse,
  toProductVariantResponse,
  type ProductResponse,
  type ProductVariantResponse,
} from "./projections";