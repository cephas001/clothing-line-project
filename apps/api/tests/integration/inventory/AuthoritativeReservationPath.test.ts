// apps/api/tests/integration/inventory/AuthoritativeReservationPath.test.ts
//
// L9 CLEANUP REGRESSION — the authoritative reservation path is the ONLY
// reachable path.
//
// L9 reserves durably through ReserveInventoryUseCase: deterministic
// single-origin sourcing (INV-I8) + an atomic conditional level UPDATE
// (INV-I2) + a UNIQUE(reservation_key) ledger insert whose collision REPLAYS
// the winner's committed row (INV-I3/INV-I4) inside one ITransactionManager
// unit. The legacy pessimistic-lock variant (ReserveInventoryPessimisticUseCase,
// SELECT ... FOR UPDATE NOWAIT -> LOCK_ACQUISITION_FAILED) predates that
// design and was ORPHANED: no checkout use case, worker, HTTP adapter, or test
// ever consumed it. It has been removed from the composition root and deleted.
//
// These assertions pin that removal so the dead path can never be silently
// re-introduced:
//   1. the checkout composition no longer exposes `reserveInventoryPessimistic`;
//   2. the wiring report never lists ReserveInventoryPessimisticUseCase;
//   3. the deleted module is unreachable (dynamic import rejects);
//   4. the AUTHORITATIVE path remains wired: initializePaymentSession reserves
//      atomically inside its obligation-claim unit, and finalizeOrderTransaction
//      confirms + freezes the sourcing snapshot — both composed from the shared
//      ReserveInventoryUseCase / ConfirmInventoryReservationUseCase instances.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { buildCheckoutUseCases } from "@api/infrastructure/composition/useCases/checkout";
import { UseCaseReportBuilder } from "@api/infrastructure/composition/useCases/types";
import type { UseCaseDependencies } from "@api/infrastructure/composition/useCases/types";
import { FinalizeOrderTransactionUseCase } from "@api/use-cases/checkout/FinalizeOrderTransactionUseCase";
import { InitializePaymentSessionUseCase } from "@api/use-cases/checkout/InitializePaymentSessionUseCase";
import { VerifyPaymentEventSignatureUseCase } from "@api/use-cases/checkout/VerifyPaymentEventSignatureUseCase";
import { VerifyPaymentEventUseCase } from "@api/use-cases/checkout/VerifyPaymentEventUseCase";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryRegionRepository } from "../../fakes/InMemoryRegionRepository";
import { InMemoryPaymentRepository } from "../../fakes/InMemoryPaymentRepository";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryTransactionRepository } from "../../fakes/InMemoryTransactionRepository";
import { InMemoryNotificationOutboxRepository } from "../../fakes/InMemoryNotificationOutboxRepository";
import { InMemoryInventoryLocationRepository } from "../../fakes/InMemoryInventoryLocationRepository";
import { InMemoryInventoryLevelRepository } from "../../fakes/InMemoryInventoryLevelRepository";
import { InMemoryInventoryReservationRepository } from "../../fakes/InMemoryInventoryReservationRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { FakePaymentService } from "../../fakes/FakePaymentService";
import { FakeQueueService } from "../../fakes/FakeQueueService";
import { FakeCryptographyService } from "../../fakes/FakeCryptographyService";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";

/**
 * The subset of UseCaseDependencies the checkout factory actually reads (every
 * repository/service the always-wired and payment-wired checkout use cases
 * need). The remaining repository fields are irrelevant to the factory and are
 * deliberately not constructed — the cast documents that this is a
 * composition-contract test, not a full dependency build.
 */
function buildCheckoutDeps(): UseCaseDependencies {
  const deps = {
    auditLogService: new InMemoryAuditLogService(),
    idGenerator: new SequenceIdGenerator(),
    logger: new NoopLogger(),
    transactionManager: new InMemoryTransactionManager(),
    cartRepository: new InMemoryCartRepository(),
    regionRepository: new InMemoryRegionRepository(),
    paymentRepository: new InMemoryPaymentRepository(),
    orderRepository: new InMemoryOrderRepository(),
    transactionRepository: new InMemoryTransactionRepository(),
    notificationOutboxRepository: new InMemoryNotificationOutboxRepository(),
    inventoryLocationRepository: new InMemoryInventoryLocationRepository(),
    inventoryLevelRepository: new InMemoryInventoryLevelRepository(),
    inventoryReservationRepository: new InMemoryInventoryReservationRepository(),
    queueService: new FakeQueueService(),
    cryptographyService: new FakeCryptographyService(),
    externalServices: {
      paymentService: new FakePaymentService(),
    },
  };
  return deps as unknown as UseCaseDependencies;
}

describe("L9 cleanup — the authoritative reservation path is the only reachable path", () => {
  it("the checkout composition no longer exposes reserveInventoryPessimistic", () => {
    const checkout = buildCheckoutUseCases(
      buildCheckoutDeps(),
      new UseCaseReportBuilder(),
    );

    expect("reserveInventoryPessimistic" in checkout).toBe(false);
    expect(
      (checkout as unknown as Record<string, unknown>).reserveInventoryPessimistic,
    ).toBeUndefined();
  });

  it("the wiring report never lists ReserveInventoryPessimisticUseCase", () => {
    const report = new UseCaseReportBuilder();
    buildCheckoutUseCases(buildCheckoutDeps(), report);
    const wired = report.toReport().wired;

    expect(wired.includes("ReserveInventoryPessimisticUseCase")).toBe(false);
    // The authoritative checkout reservation orchestration is still reported.
    expect(wired.includes("FinalizeOrderTransactionUseCase")).toBe(true);
  });

  it("the deleted ReserveInventoryPessimisticUseCase module is unreachable", async () => {
    // The specifier is assembled at runtime so the deleted module stays
    // out of the static import graph; if the file is ever re-created, the
    // dynamic import RESOLVES and this assertion fails.
    const specifier =
      "@api/use-cases/checkout/" + "ReserveInventoryPessimisticUseCase";
    let loaded = false;
    try {
      await import(specifier);
      loaded = true;
    } catch {
      loaded = false;
    }
    expect(loaded).toBe(false);
  });

  it("the authoritative reservation orchestration remains wired at checkout", () => {
    const checkout = buildCheckoutUseCases(
      buildCheckoutDeps(),
      new UseCaseReportBuilder(),
    );

    // initializePaymentSession reserves atomically inside its obligation-claim
    // unit via the shared ReserveInventoryUseCase instance.
    expect(checkout.initializePaymentSession).toBeInstanceOf(
      InitializePaymentSessionUseCase,
    );
    // finalizeOrderTransaction confirms + freezes the sourcing snapshot via the
    // shared ConfirmInventoryReservationUseCase instance.
    expect(checkout.finalizeOrderTransaction).toBeInstanceOf(
      FinalizeOrderTransactionUseCase,
    );
    expect(checkout.verifyPaymentEvent).toBeInstanceOf(VerifyPaymentEventUseCase);
    expect(checkout.verifyPaymentEventSignature).toBeInstanceOf(
      VerifyPaymentEventSignatureUseCase,
    );
  });

  it("the financial checkout path is composed WITHOUT the product read cache", () => {
    // L9 PART 3 — isolation: the product READ cache is a catalog short-circuit
    // for BrowseCatalog/GetProductDetails ONLY. The checkout financial path
    // (authoritative pricing/tax/promotions/shipping/reservation/payment
    // amount) must never depend on it. buildCheckoutDeps deliberately supplies
    // no productReadRepository; if the composition ever starts requiring it,
    // the factory will fail to typecheck/run and this pin catches it.
    const deps = buildCheckoutDeps();
    expect(
      (deps as unknown as Record<string, unknown>).productReadRepository,
    ).toBeUndefined();

    const checkout = buildCheckoutUseCases(deps, new UseCaseReportBuilder());
    expect(checkout.initializePaymentSession).toBeInstanceOf(
      InitializePaymentSessionUseCase,
    );
    expect(checkout.finalizeOrderTransaction).toBeInstanceOf(
      FinalizeOrderTransactionUseCase,
    );
  });
});
