// apps/api/src/infrastructure/composition/useCases/cart.ts

// Factory for the cart use cases. Each use case is constructed ONLY when all
// of its dependencies are present; missing dependencies are reported rather
// than faked.

import { AddCartLineItemUseCase } from "@api/use-cases/cart/AddCartLineItemUseCase";
import { AddCustomLineItemUseCase } from "@api/use-cases/cart/AddCustomLineItemUseCase";
import { ApplyDiscountCodeUseCase } from "@api/use-cases/cart/ApplyDiscountCodeUseCase";
import { GetCartUseCase } from "@api/use-cases/cart/GetCartUseCase";
import { InitializeCartSessionUseCase } from "@api/use-cases/cart/InitializeCartSessionUseCase";
import { MergeGuestCartToCustomerUseCase } from "@api/use-cases/cart/MergeGuestCartToCustomerUseCase";
import { PruneAbandonedCartsUseCase } from "@api/use-cases/cart/PruneAbandonedCartsUseCase";
import { RemoveCartLineItemUseCase } from "@api/use-cases/cart/RemoveCartLineItemUseCase";
import { UpdateLineItemQuantityUseCase } from "@api/use-cases/cart/UpdateLineItemQuantityUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface CartUseCases {
  addCartLineItem?: AddCartLineItemUseCase;
  addCustomLineItem: AddCustomLineItemUseCase;
  applyDiscountCode: ApplyDiscountCodeUseCase;
  getCart: GetCartUseCase;
  initializeCartSession: InitializeCartSessionUseCase;
  mergeGuestCartToCustomer: MergeGuestCartToCustomerUseCase;
  pruneAbandonedCarts: PruneAbandonedCartsUseCase;
  removeCartLineItem: RemoveCartLineItemUseCase;
  updateLineItemQuantity: UpdateLineItemQuantityUseCase;
}

export function buildCartUseCases(
  deps: UseCaseDependencies,
  report: UseCaseReportBuilder,
): CartUseCases {
  const { auditLogService, idGenerator, logger, transactionManager } = deps;

  const addCustomLineItem = new AddCustomLineItemUseCase(
    deps.cartRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const applyDiscountCode = new ApplyDiscountCodeUseCase(
    deps.cartRepository,
    deps.promotionRepository,
    auditLogService,
    logger,
    transactionManager,
  );
  const getCart = new GetCartUseCase(
    deps.cartRepository,
    auditLogService,
    idGenerator,
    logger,
  );
  const initializeCartSession = new InitializeCartSessionUseCase(
    deps.cartRepository,
    deps.regionRepository,
    deps.salesChannelRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const mergeGuestCartToCustomer = new MergeGuestCartToCustomerUseCase(
    deps.cartRepository,
    deps.customerRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const pruneAbandonedCarts = new PruneAbandonedCartsUseCase(
    deps.cartRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const removeCartLineItem = new RemoveCartLineItemUseCase(
    deps.cartRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const updateLineItemQuantity = new UpdateLineItemQuantityUseCase(
    deps.cartRepository,
    deps.variantRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

  const pricingService = deps.externalServices?.pricingService;
  let addCartLineItem: AddCartLineItemUseCase | undefined;
  if (pricingService) {
    addCartLineItem = new AddCartLineItemUseCase(
      deps.cartRepository,
      deps.variantRepository,
      pricingService,
      auditLogService,
      idGenerator,
      logger,
      transactionManager,
    );
  } else {
    report.unwiredUseCase("AddCartLineItemUseCase", "IPricingService");
  }

  report.wiredUseCases(
    "AddCustomLineItemUseCase",
    "ApplyDiscountCodeUseCase",
    "GetCartUseCase",
    "InitializeCartSessionUseCase",
    "MergeGuestCartToCustomerUseCase",
    "PruneAbandonedCartsUseCase",
    "RemoveCartLineItemUseCase",
    "UpdateLineItemQuantityUseCase",
  );

  return {
    addCartLineItem,
    addCustomLineItem,
    applyDiscountCode,
    getCart,
    initializeCartSession,
    mergeGuestCartToCustomer,
    pruneAbandonedCarts,
    removeCartLineItem,
    updateLineItemQuantity,
  };
}
