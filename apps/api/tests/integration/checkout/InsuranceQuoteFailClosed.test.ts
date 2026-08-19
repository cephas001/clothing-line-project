// apps/api/tests/integration/checkout/InsuranceQuoteFailClosed.test.ts
//
// The insurance premium is a COMPONENT of the authoritative checkout total.
// A malformed premium from the provider must FAIL CLOSED (EXTERNAL_SERVICE_ERROR)
// — it must never be silently normalized to 0, which would zero a component of
// the charge the payment obligation freezes.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { FetchEmbeddedInsuranceQuoteUseCase } from "@api/use-cases/checkout/FetchEmbeddedInsuranceQuoteUseCase";
import type { IInsuranceService } from "@api/domain/interfaces/services/IInsuranceService";

class StubInsuranceService implements IInsuranceService {
  constructor(private readonly premium: number) {}

  async getQuote(_cartTotalMinor: number): Promise<number> {
    return this.premium;
  }
}

function buildUseCase(
  cartRepository: InMemoryCartRepository,
  premium: number,
): FetchEmbeddedInsuranceQuoteUseCase {
  return new FetchEmbeddedInsuranceQuoteUseCase(
    cartRepository,
    new StubInsuranceService(premium),
    new InMemoryAuditLogService(),
    new SequenceIdGenerator(),
    new NoopLogger(),
    new InMemoryTransactionManager(),
  );
}

describe("FetchEmbeddedInsuranceQuoteUseCase — fail-closed premium", () => {
  it("rejects a non-integer premium with EXTERNAL_SERVICE_ERROR and leaves the cart untouched", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));

    await expect(
      buildUseCase(cartRepository, 1.5).execute({ cartId: "cart-1" }),
    ).rejectsWithCode("EXTERNAL_SERVICE_ERROR");

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.insuranceAmountMinor).toBeNull();
  });

  it("rejects a negative premium with EXTERNAL_SERVICE_ERROR and leaves the cart untouched", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));

    await expect(
      buildUseCase(cartRepository, -500).execute({ cartId: "cart-1" }),
    ).rejectsWithCode("EXTERNAL_SERVICE_ERROR");

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.insuranceAmountMinor).toBeNull();
  });

  it("accepts a valid integer premium and persists it as the authoritative insurance component", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));

    const premium = await buildUseCase(cartRepository, 500).execute({
      cartId: "cart-1",
    });
    expect(premium).toBe(500);

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.insuranceAmountMinor).toBe(500);
    expect(cart!.computeAuthoritativeCheckoutBreakdown().insuranceMinor).toBe(500);
  });
});