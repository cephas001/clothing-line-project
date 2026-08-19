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
import type { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import type { INotificationService } from "@api/domain/shared/notifications";
import type { IPaymentService } from "@api/domain/interfaces/services/IPaymentService";
import type { IPricingService } from "@api/domain/interfaces/services/IPricingService";
import type { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import type { IRecommendationEngine } from "@api/domain/interfaces/services/IRecommendationEngine";
import type { IRiskAssessmentService } from "@api/domain/interfaces/services/IRiskAssessmentService";
import type { ISearchService } from "@api/domain/interfaces/services/ISearchService";
import type { ISessionRevocationService } from "@api/domain/interfaces/services/ISessionRevocationService";
import type { ITaxCalculationService } from "@api/domain/interfaces/services/ITaxCalculationService";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type { RuntimeKind, UseCaseAvailability } from "./capabilities";
import { EXTERNAL_SERVICE_CAPABILITIES, classifyUnwired } from "./capabilities";

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
}

export interface UnwiredUseCase {
  useCase: string;
  missingDependency: string;
  /** Availability classification derived from the actual composition graph. */
  status: UseCaseAvailability;
  /** Human-readable reason; the diagnostics render this as-is. */
  detail: string;
  /**
   * Optional caller-supplied note that documents a domain constraint
   * (e.g. the L4/L5 invariant that the worker must never create shipments).
   */
  note?: string;
}

export interface UseCaseReport {
  wired: string[];
  unwired: UnwiredUseCase[];
  /** Per-status counts for startup telemetry + the describe() summary line. */
  summary: {
    wired: number;
    unavailableMissingInfrastructure: number;
    unavailableMissingConfiguration: number;
    deferredByDesign: number;
  };
}

export interface UseCaseReportOptions {
  /** The runtime this composition serves. Default: "api". */
  runtime?: RuntimeKind;
}

/**
 * Collects which use cases were constructed (wired) and which were skipped
 * because a dependency has no implementation yet (unwired). Each unwired entry
 * is classified against the runtime the composition serves, so the diagnostics
 * distinguish missing infrastructure capability (no adapter exists), missing
 * configuration (adapter exists but its config is absent), and deferred by
 * design (the use case belongs to the other runtime's responsibility).
 */
export class UseCaseReportBuilder {
  private readonly runtime: RuntimeKind;
  private readonly wired: string[] = [];
  private readonly unwired: UnwiredUseCase[] = [];

  constructor(options: UseCaseReportOptions = {}) {
    this.runtime = options.runtime ?? "api";
  }

  wiredUseCases(...names: string[]): void {
    this.wired.push(...names);
  }

  unwiredUseCase(name: string, missingDependency: string, note?: string): void {
    const classification = classifyUnwired(missingDependency, this.runtime);
    this.unwired.push({
      useCase: name,
      missingDependency,
      status: classification.status,
      detail: classification.detail,
      ...(note ? { note } : {}),
    });
  }

  toReport(): UseCaseReport {
    const count = (status: UseCaseAvailability): number =>
      this.unwired.filter((u) => u.status === status).length;
    return {
      wired: [...this.wired],
      unwired: [...this.unwired],
      summary: {
        wired: this.wired.length,
        unavailableMissingInfrastructure: count(
          "unavailable-missing-infrastructure",
        ),
        unavailableMissingConfiguration: count(
          "unavailable-missing-configuration",
        ),
        deferredByDesign: count("deferred-by-design"),
      },
    };
  }
}

/**
 * Render one unwired use case as a compact, scannable line:
 *
 *   SearchProductsUseCase -> ISearchService
 *   InitializePaymentSessionUseCase -> IPaymentService (set PAYSTACK_SECRET_KEY)
 *   DispatchOrderFulfillmentUseCase -> ILogisticsService (L4/L5 invariant: ...)
 *
 * Missing-configuration entries append the env var that would wire the
 * adapter; deferred entries append the caller-supplied note when present.
 *
 * ASCII-safe by design: the bootstrap diagnostics render in terminals that may
 * mis-decode non-ASCII punctuation (e.g. Windows PowerShell code pages), so the
 * separator is the two-character arrow "->" and headings use plain "-".
 */
function unwiredEntryLine(u: UnwiredUseCase): string {
  let hint = "";
  if (u.status === "unavailable-missing-configuration") {
    const configEnv = EXTERNAL_SERVICE_CAPABILITIES[u.missingDependency]
      ?.configEnv;
    if (configEnv) {
      hint = ` (set ${configEnv})`;
    }
  } else if (u.note) {
    hint = ` (${u.note})`;
  }
  return `  ${u.useCase} -> ${u.missingDependency}${hint}`;
}

/**
 * Render the use-case composition report as a compact startup diagnostic tree,
 * grouped by availability status with blank-line separation. Shared by the API
 * and worker composition roots so the boot summaries stay consistent. Lines
 * carry RELATIVE indentation (base 0); each runtime's describe() applies its
 * own uniform body indent.
 */
export function useCaseReportLines(report: UseCaseReport): string[] {
  const lines: string[] = [];
  const { summary } = report;
  lines.push(
    "Use cases",
    `  Wired: ${summary.wired}`,
    `  Unwired: ${report.unwired.length}`,
    `    Missing infrastructure: ${summary.unavailableMissingInfrastructure}`,
    `    Missing configuration: ${summary.unavailableMissingConfiguration}`,
    `    Deferred by design: ${summary.deferredByDesign}`,
  );

  const groups: Array<{
    label: string;
    status: UseCaseAvailability;
  }> = [
    {
      label: "Unavailable - missing infrastructure capability:",
      status: "unavailable-missing-infrastructure",
    },
    {
      label: "Unavailable - missing configuration:",
      status: "unavailable-missing-configuration",
    },
    {
      label: "Deferred by design:",
      status: "deferred-by-design",
    },
  ];
  for (const group of groups) {
    const entries = report.unwired.filter((u) => u.status === group.status);
    if (entries.length === 0) {
      continue;
    }
    lines.push("", group.label);
    for (const u of entries) {
      lines.push(unwiredEntryLine(u));
    }
  }
  return lines;
}
