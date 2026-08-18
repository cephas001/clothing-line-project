// apps/api/src/infrastructure/composition/useCases/admin.ts

// Factory for the admin use cases. Each use case is constructed ONLY when all
// of its dependencies are present; missing dependencies are reported rather
// than faked.

import { ConfigureRegionalPricingUseCase } from "@api/use-cases/admin/ConfigureRegionalPricingUseCase";
import { CreateProductUseCase } from "@api/use-cases/admin/CreateProductUseCase";
import { CreateProductVariantUseCase } from "@api/use-cases/admin/CreateProductVariantUseCase";
import { CreatePromotionRuleUseCase } from "@api/use-cases/admin/CreatePromotionRuleUseCase";
import { CreateSalesChannelUseCase } from "@api/use-cases/admin/CreateSalesChannelUseCase";
import { ImportBulkCatalogDataUseCase } from "@api/use-cases/admin/ImportBulkCatalogDataUseCase";
import { ListDeadLetterJobsUseCase } from "@api/use-cases/admin/ListDeadLetterJobsUseCase";
import { ManageAdminRolePermissionsUseCase } from "@api/use-cases/admin/ManageAdminRolePermissionsUseCase";
import { ManageCategoriesUseCase } from "@api/use-cases/admin/ManageCategoriesUseCase";
import { RetryDeadLetterJobUseCase } from "@api/use-cases/admin/RetryDeadLetterJobUseCase";
import { AdjustInventoryLevelUseCase } from "@api/use-cases/admin/AdjustInventoryLevelUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface AdminUseCases {
  configureRegionalPricing: ConfigureRegionalPricingUseCase;
  createProduct: CreateProductUseCase;
  createProductVariant: CreateProductVariantUseCase;
  createPromotionRule: CreatePromotionRuleUseCase;
  createSalesChannel: CreateSalesChannelUseCase;
  importBulkCatalogData: ImportBulkCatalogDataUseCase;
  listDeadLetterJobs: ListDeadLetterJobsUseCase;
  manageAdminRolePermissions: ManageAdminRolePermissionsUseCase;
  manageCategories: ManageCategoriesUseCase;
  retryDeadLetterJob: RetryDeadLetterJobUseCase;
  adjustInventoryLevel?: AdjustInventoryLevelUseCase;
}

export function buildAdminUseCases(
  deps: UseCaseDependencies,
  report: UseCaseReportBuilder,
): AdminUseCases {
  const { auditLogService, idGenerator, logger, transactionManager } = deps;

  const configureRegionalPricing = new ConfigureRegionalPricingUseCase(
    deps.variantRepository,
    deps.regionRepository,
    deps.moneyAmountRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const createProduct = new CreateProductUseCase(
    deps.productRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const createProductVariant = new CreateProductVariantUseCase(
    deps.variantRepository,
    deps.productRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const createPromotionRule = new CreatePromotionRuleUseCase(
    deps.promotionRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const createSalesChannel = new CreateSalesChannelUseCase(
    deps.salesChannelRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const importBulkCatalogData = new ImportBulkCatalogDataUseCase(
    deps.queueService,
    auditLogService,
    idGenerator,
    logger,
  );
  const listDeadLetterJobs = new ListDeadLetterJobsUseCase(
    deps.queueService,
    auditLogService,
    logger,
  );
  const manageAdminRolePermissions = new ManageAdminRolePermissionsUseCase(
    deps.roleRepository,
    auditLogService,
    logger,
    transactionManager,
  );
  const manageCategories = new ManageCategoriesUseCase(
    deps.categoryRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const retryDeadLetterJob = new RetryDeadLetterJobUseCase(
    deps.queueService,
    auditLogService,
    logger,
  );

  const authorizationService = deps.externalServices?.authorizationService;
  let adjustInventoryLevel: AdjustInventoryLevelUseCase | undefined;
  if (authorizationService) {
    adjustInventoryLevel = new AdjustInventoryLevelUseCase(
      deps.variantRepository,
      auditLogService,
      authorizationService,
      logger,
      transactionManager,
    );
  } else {
    report.unwiredUseCase(
      "AdjustInventoryLevelUseCase",
      "IAuthorizationService",
    );
  }

  report.wiredUseCases(
    "ConfigureRegionalPricingUseCase",
    "CreateProductUseCase",
    "CreateProductVariantUseCase",
    "CreatePromotionRuleUseCase",
    "CreateSalesChannelUseCase",
    "ImportBulkCatalogDataUseCase",
    "ListDeadLetterJobsUseCase",
    "ManageAdminRolePermissionsUseCase",
    "ManageCategoriesUseCase",
    "RetryDeadLetterJobUseCase",
  );

  return {
    configureRegionalPricing,
    createProduct,
    createProductVariant,
    createPromotionRule,
    createSalesChannel,
    importBulkCatalogData,
    listDeadLetterJobs,
    manageAdminRolePermissions,
    manageCategories,
    retryDeadLetterJob,
    adjustInventoryLevel,
  };
}
