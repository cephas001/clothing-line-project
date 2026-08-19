// apps/api/src/infrastructure/composition/useCases/index.ts

// Combined use-case factory: wires every use case whose dependencies are all
// implemented, and reports the ones whose dependencies are not.

import { buildAdminUseCases, AdminUseCases } from "./admin";
import { buildCartUseCases, CartUseCases } from "./cart";
import { buildCatalogUseCases, CatalogUseCases } from "./catalog";
import { buildCheckoutUseCases, CheckoutUseCases } from "./checkout";
import { buildCustomersUseCases, CustomersUseCases } from "./customers";
import { buildInventoryUseCases, InventoryUseCases } from "./inventory";
import { buildLogisticsUseCases, LogisticsUseCases } from "./logistics";
import { buildNotificationsUseCases, NotificationsUseCases } from "./notifications";
import {
  UseCaseDependencies,
  UseCaseReport,
  UseCaseReportBuilder,
} from "./types";
import type { RuntimeKind } from "./capabilities";

export interface AllUseCases {
  admin: AdminUseCases;
  cart: CartUseCases;
  catalog: CatalogUseCases;
  checkout: CheckoutUseCases;
  customers: CustomersUseCases;
  inventory: InventoryUseCases;
  logistics: LogisticsUseCases;
  notifications: NotificationsUseCases;
}

export interface UseCaseComposition {
  useCases: AllUseCases;
  report: UseCaseReport;
}

export interface BuildUseCasesOptions {
  /**
   * The runtime this composition serves. Defaults to "api". The worker
   * composition root passes "worker" so unwired entries that belong to the API
   * runtime are reported as deferred by design, never as configuration gaps.
   */
  runtime?: RuntimeKind;
}

export function buildUseCases(
  deps: UseCaseDependencies,
  options: BuildUseCasesOptions = {},
): UseCaseComposition {
  const report = new UseCaseReportBuilder({ runtime: options.runtime });

  const admin = buildAdminUseCases(deps, report);
  const cart = buildCartUseCases(deps, report);
  const catalog = buildCatalogUseCases(deps, report);
  const checkout = buildCheckoutUseCases(deps, report);
  const customers = buildCustomersUseCases(deps, report);
  const inventory = buildInventoryUseCases(deps, report);
  const logistics = buildLogisticsUseCases(deps, report);
  const notifications = buildNotificationsUseCases(deps, report);

  return {
    useCases: {
      admin,
      cart,
      catalog,
      checkout,
      customers,
      inventory,
      logistics,
      notifications,
    },
    report: report.toReport(),
  };
}
