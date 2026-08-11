// apps/api/src/infrastructure/composition/useCases/types.ts

// Shared dependency and report types for the use-case factories.
//
// UseCaseDependencies carries every dependency the application's use cases
// need, typed by DOMAIN INTERFACES (never concrete infrastructure). The
// factories construct a use case only when every dependency it requires is
// present; a use case whose dependency has no implementation yet is recorded
// in the report instead of being constructed with a fake.

import type { Repositories } from "../repositories";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import type { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import type { IAuthorizationService } from "@api/domain/interfaces/services/IAuthenticationService";
import type { ICryptographyService } from "@api/domain/interfaces/services/ICryptographyService";
import type { IDatabaseManagementService } from "@api/domain/interfaces/services/IDatabaseManagementService";
import type { IHashingService } from "@api/domain/interfaces/services/IHashingService";
import type { IInsuranceService } from "@api/domain/interfaces/services/IInsuranceService";
import type { IInventoryLocationService } from "@api/domain/interfaces/services/IInventoryLocationService";
import type { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import type { INotificationService } from "@api/domain/interfaces/services/INotificationService";
import type { IPaymentService } from "@api/domain/interfaces/services/IPaymentService";
import type { IPricingService } from "@api/domain/interfaces/services/IPricingService";
import type { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import type { IRecommendationEngine } from "@api/domain/interfaces/services/IRecommendationEngine";
import type { IRiskAssessmentService } from "@api/domain/interfaces/services/IRiskAssessmentService";
import type { ISearchService } from "@api/domain/interfaces/services/ISearchService";
import type { ISessionRevocationService } from "@api/domain/interfaces/services/ISessionRevocationService";
import type { ITaxCalculationService } from "@api/domain/interfaces/services/ITaxCalculationService";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";

export interface UseCaseDependencies extends Repositories {
  logger: ILogger;
  idGenerator: IIdGenerator;
  auditLogService: IAuditLogService;
  transactionManager: ITransactionManager;
  queueService: IQueueService;
  hashingService: IHashingService;
  tokenService: ITokenService;
  sessionRevocationService: ISessionRevocationService;
  cryptographyService: ICryptographyService;
  /**
   * External service adapters that are NOT implemented yet. When an adapter is
   * supplied here, the use cases that depend on it are constructed; otherwise
   * they are reported as unwired. Never provide a fake implementation.
   */
  externalServices?: ExternalServiceDependencies;
}

export interface ExternalServiceDependencies {
  authorizationService?: IAuthorizationService;
  pricingService?: IPricingService;
  paymentService?: IPaymentService;
  logisticsService?: ILogisticsService;
  notificationService?: INotificationService;
  searchService?: ISearchService;
  recommendationEngine?: IRecommendationEngine;
  riskAssessmentService?: IRiskAssessmentService;
  insuranceService?: IInsuranceService;
  taxCalculationService?: ITaxCalculationService;
  databaseManagementService?: IDatabaseManagementService;
  inventoryLocationService?: IInventoryLocationService;
}

export interface UnwiredUseCase {
  useCase: string;
  missingDependency: string;
}

export interface UseCaseReport {
  wired: string[];
  unwired: UnwiredUseCase[];
}

/**
 * Collects which use cases were constructed (wired) and which were skipped
 * because a dependency has no implementation yet (unwired).
 */
export class UseCaseReportBuilder {
  private readonly wired: string[] = [];
  private readonly unwired: UnwiredUseCase[] = [];

  wiredUseCases(...names: string[]): void {
    this.wired.push(...names);
  }

  unwiredUseCase(name: string, missingDependency: string): void {
    this.unwired.push({ useCase: name, missingDependency });
  }

  toReport(): UseCaseReport {
    return { wired: [...this.wired], unwired: [...this.unwired] };
  }
}
