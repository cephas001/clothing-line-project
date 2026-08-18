// apps/api/src/infrastructure/composition/repositories.ts

// Constructs every Postgres repository against the single shared
// TransactionContext. All repositories share the same constructor and the same
// context instance, so there is exactly ONE Kysely connection pool for the
// whole application (see database/connection/kysely.ts) and every repository
// participates in ITransactionManager units of work automatically.
//
// Use-case factories depend on this record typed by its domain INTERFACES, not
// on the concrete Postgres classes.

import { TransactionContext } from "../database/transaction/TransactionContext";
import { PostgresBusinessUnitRepository } from "../database/repositories/PostgresBusinessUnitRepository";
import { PostgresCartRepository } from "../database/repositories/PostgresCartRepository";
import { PostgresCategoryReadRepository } from "../database/repositories/PostgresCategoryReadRepository";
import { PostgresCategoryRepository } from "../database/repositories/PostgresCategoryRepository";
import { PostgresCustomerRepository } from "../database/repositories/PostgresCustomerRepository";
import { PostgresDraftOrderRepository } from "../database/repositories/PostgresDraftOrderRepository";
import { PostgresFulfillmentRepository } from "../database/repositories/PostgresFulfillmentRepository";
import { PostgresInventoryLevelRepository } from "../database/repositories/PostgresInventoryLevelRepository";
import { PostgresInventoryLocationRepository } from "../database/repositories/PostgresInventoryLocationRepository";
import { PostgresInventoryReservationRepository } from "../database/repositories/PostgresInventoryReservationRepository";
import { PostgresMoneyAmountRepository } from "../database/repositories/PostgresMoneyAmountRepository";
import { PostgresNotificationOutboxRepository } from "../database/repositories/PostgresNotificationOutboxRepository";
import { PostgresOrderEditRepository } from "../database/repositories/PostgresOrderEditRepository";
import { PostgresOrderReadRepository } from "../database/repositories/PostgresOrderReadRepository";
import { PostgresOrderRepository } from "../database/repositories/PostgresOrderRepository";
import { PostgresProductReadRepository } from "../database/repositories/PostgresProductReadRepository";
import { PostgresProductRepository } from "../database/repositories/PostgresProductRepository";
import { PostgresPromotionRepository } from "../database/repositories/PostgresPromotionRepository";
import { PostgresPaymentRepository } from "../database/repositories/PostgresPaymentRepository";
import { PostgresQuoteRepository } from "../database/repositories/PostgresQuoteRepository";
import { PostgresRefundRepository } from "../database/repositories/PostgresRefundRepository";
import { PostgresRegionRepository } from "../database/repositories/PostgresRegionRepository";
import { PostgresReturnRepository } from "../database/repositories/PostgresReturnRepository";
import { PostgresReviewRepository } from "../database/repositories/PostgresReviewRepository";
import { PostgresRoleRepository } from "../database/repositories/PostgresRoleRepository";
import { PostgresSalesChannelRepository } from "../database/repositories/PostgresSalesChannelRepository";
import { PostgresSwapRepository } from "../database/repositories/PostgresSwapRepository";
import { PostgresTransactionRepository } from "../database/repositories/PostgresTransactionRepository";
import { PostgresVariantReadRepository } from "../database/repositories/PostgresVariantReadRepository";
import { PostgresVariantRepository } from "../database/repositories/PostgresVariantRepository";
import type { IBusinessUnitRepository } from "@api/domain/interfaces/repositories/IBusinessUnitRepository";
import type { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import type { ICategoryReadRepository } from "@api/domain/interfaces/repositories/ICategoryReadRepository";
import type { ICategoryRepository } from "@api/domain/interfaces/repositories/ICategoryRepository";
import type { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import type { IDraftOrderRepository } from "@api/domain/interfaces/repositories/IDraftOrderRepository";
import type { IFulfillmentRepository } from "@api/domain/interfaces/repositories/IFulfillmentRepository";
import type { IInventoryLevelRepository } from "@api/domain/interfaces/repositories/IInventoryLevelRepository";
import type { IInventoryLocationRepository } from "@api/domain/interfaces/repositories/IInventoryLocationRepository";
import type { IInventoryReservationRepository } from "@api/domain/interfaces/repositories/IInventoryReservationRepository";
import type { IMoneyAmountRepository } from "@api/domain/interfaces/repositories/IMoneyAmountRepository";
import type { INotificationOutboxRepository } from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import type { IOrderEditRepository } from "@api/domain/interfaces/repositories/IOrderEditRepository";
import type { IOrderReadRepository } from "@api/domain/interfaces/repositories/IOrderReadRepository";
import type { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import type { IProductReadRepository } from "@api/domain/interfaces/repositories/IProductReadRepository";
import type { IProductRepository } from "@api/domain/interfaces/repositories/IProductRepository";
import type { IPromotionRepository } from "@api/domain/interfaces/repositories/IPromotionRepository";
import type { IPaymentRepository } from "@api/domain/interfaces/repositories/IPaymentRepository";
import type { IQuoteRepository } from "@api/domain/interfaces/repositories/IQuoteRepository";
import type { IRefundRepository } from "@api/domain/interfaces/repositories/IRefundRepository";
import type { IRegionRepository } from "@api/domain/interfaces/repositories/IRegionRepository";
import type { IReturnRepository } from "@api/domain/interfaces/repositories/IReturnRepository";
import type { IReviewRepository } from "@api/domain/interfaces/repositories/IReviewRepository";
import type { IRoleRepository } from "@api/domain/interfaces/repositories/IRoleRepository";
import type { ISalesChannelRepository } from "@api/domain/interfaces/repositories/ISalesChannelRepository";
import type { ISwapRepository } from "@api/domain/interfaces/repositories/ISwapRepository";
import type { ITransactionRepository } from "@api/domain/interfaces/repositories/ITransactionRepository";
import type { IVariantReadRepository } from "@api/domain/interfaces/repositories/IVariantReadRepository";
import type { IVariantRepository } from "@api/domain/interfaces/repositories/IVariantRepository";

export interface Repositories {
  businessUnitRepository: IBusinessUnitRepository;
  cartRepository: ICartRepository;
  categoryReadRepository: ICategoryReadRepository;
  categoryRepository: ICategoryRepository;
  customerRepository: ICustomerRepository;
  draftOrderRepository: IDraftOrderRepository;
  fulfillmentRepository: IFulfillmentRepository;
  inventoryLevelRepository: IInventoryLevelRepository;
  inventoryLocationRepository: IInventoryLocationRepository;
  inventoryReservationRepository: IInventoryReservationRepository;
  moneyAmountRepository: IMoneyAmountRepository;
  notificationOutboxRepository: INotificationOutboxRepository;
  orderEditRepository: IOrderEditRepository;
  orderReadRepository: IOrderReadRepository;
  orderRepository: IOrderRepository;
  productReadRepository: IProductReadRepository;
  productRepository: IProductRepository;
  promotionRepository: IPromotionRepository;
  paymentRepository: IPaymentRepository;
  quoteRepository: IQuoteRepository;
  refundRepository: IRefundRepository;
  regionRepository: IRegionRepository;
  returnRepository: IReturnRepository;
  reviewRepository: IReviewRepository;
  roleRepository: IRoleRepository;
  salesChannelRepository: ISalesChannelRepository;
  swapRepository: ISwapRepository;
  transactionRepository: ITransactionRepository;
  variantReadRepository: IVariantReadRepository;
  variantRepository: IVariantRepository;
}

export function buildRepositories(context: TransactionContext): Repositories {
  return {
    businessUnitRepository: new PostgresBusinessUnitRepository(context),
    cartRepository: new PostgresCartRepository(context),
    categoryReadRepository: new PostgresCategoryReadRepository(context),
    categoryRepository: new PostgresCategoryRepository(context),
    customerRepository: new PostgresCustomerRepository(context),
    draftOrderRepository: new PostgresDraftOrderRepository(context),
    fulfillmentRepository: new PostgresFulfillmentRepository(context),
    inventoryLevelRepository: new PostgresInventoryLevelRepository(context),
    inventoryLocationRepository: new PostgresInventoryLocationRepository(context),
    inventoryReservationRepository: new PostgresInventoryReservationRepository(context),
    moneyAmountRepository: new PostgresMoneyAmountRepository(context),
    notificationOutboxRepository: new PostgresNotificationOutboxRepository(context),
    orderEditRepository: new PostgresOrderEditRepository(context),
    orderReadRepository: new PostgresOrderReadRepository(context),
    orderRepository: new PostgresOrderRepository(context),
    productReadRepository: new PostgresProductReadRepository(context),
    productRepository: new PostgresProductRepository(context),
    promotionRepository: new PostgresPromotionRepository(context),
    paymentRepository: new PostgresPaymentRepository(context),
    quoteRepository: new PostgresQuoteRepository(context),
    refundRepository: new PostgresRefundRepository(context),
    regionRepository: new PostgresRegionRepository(context),
    returnRepository: new PostgresReturnRepository(context),
    reviewRepository: new PostgresReviewRepository(context),
    roleRepository: new PostgresRoleRepository(context),
    salesChannelRepository: new PostgresSalesChannelRepository(context),
    swapRepository: new PostgresSwapRepository(context),
    transactionRepository: new PostgresTransactionRepository(context),
    variantReadRepository: new PostgresVariantReadRepository(context),
    variantRepository: new PostgresVariantRepository(context),
  };
}
