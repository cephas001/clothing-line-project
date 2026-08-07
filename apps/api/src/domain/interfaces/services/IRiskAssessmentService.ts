import { Order } from "@api-domain-entities/Order";
import { StructuredMeta } from "@api/domain/shared/contracts";

export interface IRiskAssessmentService {
  assessOrderRisk(order: Order): Promise<"high" | "medium" | "low">;
  evaluateRisk({
    orderId,
    customerId,
    totalMinor,
    paymentMetadata,
  }: {
    orderId: string;
    customerId: string;
    totalMinor: number;
    paymentMetadata: StructuredMeta;
  }): Promise<number>;
}
