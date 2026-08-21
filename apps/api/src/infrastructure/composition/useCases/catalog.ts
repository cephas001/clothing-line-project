// apps/api/src/infrastructure/composition/useCases/catalog.ts

// Factory for the catalog use cases. Each use case is constructed ONLY when
// all of its dependencies are present; missing dependencies are reported
// rather than faked.

import { BrowseCatalogUseCase } from "@api/use-cases/catalog/BrowseCatalogUseCase";
import { GetProductDetailsUseCase } from "@api/use-cases/catalog/GetProductDetailsUseCase";
import { GetVariantAvailabilityUseCase } from "@api/use-cases/catalog/GetVariantAvailabilityUseCase";
import { ResolveCrossSellingProductsUseCase } from "@api/use-cases/catalog/ResolveCrossSellingProductsUseCase";
import { RetrieveCategoryTreeUseCase } from "@api/use-cases/catalog/RetrieveCategoryTreeUseCase";
import { SearchProductsUseCase } from "@api/use-cases/catalog/SearchProductsUseCase";
import { SubmitProductReviewUseCase } from "@api/use-cases/catalog/SubmitProductReviewUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface CatalogUseCases {
  /** Present only when the regional pricing service is wired. */
  browseCatalog?: BrowseCatalogUseCase;
  /** Present only when the regional pricing service is wired. */
  getProductDetails?: GetProductDetailsUseCase;
  getVariantAvailability?: GetVariantAvailabilityUseCase;
  resolveCrossSellingProducts?: ResolveCrossSellingProductsUseCase;
  retrieveCategoryTree: RetrieveCategoryTreeUseCase;
  searchProducts?: SearchProductsUseCase;
  submitProductReview: SubmitProductReviewUseCase;
}

export function buildCatalogUseCases(
  deps: UseCaseDependencies,
  report: UseCaseReportBuilder,
): CatalogUseCases {
  const { auditLogService, idGenerator, logger, transactionManager } = deps;

  const retrieveCategoryTree = new RetrieveCategoryTreeUseCase(
    deps.categoryReadRepository,
    auditLogService,
    idGenerator,
    logger,
  );
  const submitProductReview = new SubmitProductReviewUseCase(
    deps.reviewRepository,
    deps.orderRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

  const pricingService = deps.externalServices?.pricingService;

  // Browse and product details resolve the AUTHORITATIVE regional price per
  // variant (via the pricing service), so they are wired ONLY when pricing is
  // present. In the API runtime the DB-backed RegionalPricingService is always
  // constructed; in the worker runtime these synchronous storefront flows are
  // deferred by design.
  let browseCatalog: BrowseCatalogUseCase | undefined;
  if (pricingService) {
    browseCatalog = new BrowseCatalogUseCase(
      deps.productReadRepository,
      auditLogService,
      idGenerator,
      logger,
      pricingService,
    );
  } else {
    report.unwiredUseCase("BrowseCatalogUseCase", "IPricingService");
  }

  let getProductDetails: GetProductDetailsUseCase | undefined;
  if (pricingService) {
    getProductDetails = new GetProductDetailsUseCase(
      deps.productReadRepository,
      auditLogService,
      idGenerator,
      logger,
      pricingService,
    );
  } else {
    report.unwiredUseCase("GetProductDetailsUseCase", "IPricingService");
  }

  let getVariantAvailability: GetVariantAvailabilityUseCase | undefined;
  if (pricingService) {
    getVariantAvailability = new GetVariantAvailabilityUseCase(
      deps.variantReadRepository,
      pricingService,
      auditLogService,
      idGenerator,
      logger,
    );
  } else {
    report.unwiredUseCase("GetVariantAvailabilityUseCase", "IPricingService");
  }

  const recommendationEngine = deps.externalServices?.recommendationEngine;
  let resolveCrossSellingProducts: ResolveCrossSellingProductsUseCase | undefined;
  if (recommendationEngine) {
    resolveCrossSellingProducts = new ResolveCrossSellingProductsUseCase(
      recommendationEngine,
      auditLogService,
      idGenerator,
      logger,
    );
  } else {
    report.unwiredUseCase(
      "ResolveCrossSellingProductsUseCase",
      "IRecommendationEngine",
    );
  }

  const searchService = deps.externalServices?.searchService;
  let searchProducts: SearchProductsUseCase | undefined;
  if (searchService) {
    searchProducts = new SearchProductsUseCase(
      searchService,
      auditLogService,
      idGenerator,
      logger,
    );
  } else {
    report.unwiredUseCase("SearchProductsUseCase", "ISearchService");
  }

  report.wiredUseCases(
    "RetrieveCategoryTreeUseCase",
    "SubmitProductReviewUseCase",
  );
  if (browseCatalog) {
    report.wiredUseCases("BrowseCatalogUseCase");
  }
  if (getProductDetails) {
    report.wiredUseCases("GetProductDetailsUseCase");
  }

  return {
    browseCatalog,
    getProductDetails,
    getVariantAvailability,
    resolveCrossSellingProducts,
    retrieveCategoryTree,
    searchProducts,
    submitProductReview,
  };
}
