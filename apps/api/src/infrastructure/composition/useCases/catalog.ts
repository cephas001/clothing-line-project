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
  browseCatalog: BrowseCatalogUseCase;
  getProductDetails: GetProductDetailsUseCase;
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

  const browseCatalog = new BrowseCatalogUseCase(
    deps.productReadRepository,
    auditLogService,
    idGenerator,
    logger,
  );
  const getProductDetails = new GetProductDetailsUseCase(
    deps.productReadRepository,
    auditLogService,
    idGenerator,
    logger,
  );
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
    "BrowseCatalogUseCase",
    "GetProductDetailsUseCase",
    "RetrieveCategoryTreeUseCase",
    "SubmitProductReviewUseCase",
  );

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
