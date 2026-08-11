// apps/api/src/infrastructure/composition/useCases/index.ts

// Combined use-case factory: wires every use case whose dependencies are all
// implemented, and reports the ones whose dependencies are not.

import { buildAdminUseCases, AdminUseCases } from "./admin";
import { buildCartUseCases, CartUseCases } from "./cart";
import { buildCatalogUseCases, CatalogUseCases } from "./catalog";
import { buildCheckoutUseCases, CheckoutUseCases } from "./checkout";
import { buildCustomersUseCases, CustomersUseCases } from "./customers";
import { buildLogisticsUseCases, LogisticsUseCases } from "./logistics";
import {
  UseCaseDependencies,
  UseCaseReport,
  UseCaseReportBuilder,
} from "./types";

export interface AllUseCases {
  admin: AdminUseCases;
  cart: CartUseCases;
  catalog: CatalogUseCases;
  checkout: CheckoutUseCases;
  customers: CustomersUseCases;
  logistics: LogisticsUseCases;
}

export interface UseCaseComposition {
  useCases: AllUseCases;
  report: UseCaseReport;
}

export function buildUseCases(
  deps: UseCaseDependencies,
): UseCaseComposition {
  const report = new UseCaseReportBuilder();

  const admin = buildAdminUseCases(deps, report);
  const cart = buildCartUseCases(deps, report);
  const catalog = buildCatalogUseCases(deps, report);
  const checkout = buildCheckoutUseCases(deps, report);
  const customers = buildCustomersUseCases(deps, report);
  const logistics = buildLogisticsUseCases(deps, report);

  return {
    useCases: { admin, cart, catalog, checkout, customers, logistics },
    report: report.toReport(),
  };
}
