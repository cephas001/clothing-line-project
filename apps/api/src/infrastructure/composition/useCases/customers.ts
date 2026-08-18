// apps/api/src/infrastructure/composition/useCases/customers.ts

// Factory for the customers use cases. Each use case is constructed ONLY when
// all of its dependencies are present; missing dependencies are reported
// rather than faked.

import { ApproveB2BQuoteUseCase } from "@api/use-cases/customers/ApproveB2BQuoteUseCase";
import { AuthenticateCustomerUseCase } from "@api/use-cases/customers/AuthenticateCustomerUseCase";
import { CompletePasswordResetUseCase } from "@api/use-cases/customers/CompletePasswordResetUseCase";
import { InitiatePasswordResetUseCase } from "@api/use-cases/customers/InitiatePasswordResetUseCase";
import { ManageAddressBookUseCase } from "@api/use-cases/customers/ManageAddressBookUseCase";
import { ManageB2BBusinessUnitUseCase } from "@api/use-cases/customers/ManageB2BBusinessUnitUseCase";
import { ProcessCustomerDataErasureUseCase } from "@api/use-cases/customers/ProcessCustomerDataErasureUseCase";
import { RegisterCustomerAccountUseCase } from "@api/use-cases/customers/RegisterCustomerAccountUseCase";
import { RequestQuoteUseCase } from "@api/use-cases/customers/RequestQuoteUseCase";
import { RetrieveOrderHistoryUseCase } from "@api/use-cases/customers/RetrieveOrderHistoryUseCase";
import { RevokeCustomerSessionUseCase } from "@api/use-cases/customers/RevokeCustomerSessionUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface CustomersUseCases {
  approveB2BQuote: ApproveB2BQuoteUseCase;
  authenticateCustomer: AuthenticateCustomerUseCase;
  completePasswordReset: CompletePasswordResetUseCase;
  initiatePasswordReset?: InitiatePasswordResetUseCase;
  manageAddressBook: ManageAddressBookUseCase;
  manageB2BBusinessUnit: ManageB2BBusinessUnitUseCase;
  processCustomerDataErasure: ProcessCustomerDataErasureUseCase;
  registerCustomerAccount: RegisterCustomerAccountUseCase;
  requestQuote: RequestQuoteUseCase;
  retrieveOrderHistory: RetrieveOrderHistoryUseCase;
  revokeCustomerSession: RevokeCustomerSessionUseCase;
}

export function buildCustomersUseCases(
  deps: UseCaseDependencies,
  report: UseCaseReportBuilder,
): CustomersUseCases {
  const {
    auditLogService,
    idGenerator,
    logger,
    sessionRevocationService,
    transactionManager,
  } = deps;

  const authenticateCustomer = new AuthenticateCustomerUseCase(
    deps.customerRepository,
    deps.hashingService,
    deps.tokenService,
    auditLogService,
    idGenerator,
    logger,
  );
  const completePasswordReset = new CompletePasswordResetUseCase(
    deps.customerRepository,
    deps.hashingService,
    deps.tokenService,
    sessionRevocationService,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const manageAddressBook = new ManageAddressBookUseCase(
    deps.customerRepository,
    auditLogService,
    idGenerator,
    logger,
  );
  const manageB2BBusinessUnit = new ManageB2BBusinessUnitUseCase(
    deps.businessUnitRepository,
    deps.customerRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const processCustomerDataErasure = new ProcessCustomerDataErasureUseCase(
    deps.customerRepository,
    auditLogService,
    idGenerator,
    sessionRevocationService,
    logger,
    transactionManager,
  );
  const registerCustomerAccount = new RegisterCustomerAccountUseCase(
    deps.customerRepository,
    deps.hashingService,
    auditLogService,
    idGenerator,
    logger,
  );
  const requestQuote = new RequestQuoteUseCase(
    deps.cartRepository,
    deps.quoteRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );
  const retrieveOrderHistory = new RetrieveOrderHistoryUseCase(
    deps.orderReadRepository,
    auditLogService,
    idGenerator,
    logger,
  );
  const revokeCustomerSession = new RevokeCustomerSessionUseCase(
    sessionRevocationService,
    auditLogService,
    idGenerator,
    logger,
  );

  // --- B2B quote approval (L8 PART 3: outbox-migrated) -----------------------
  // Always wired: the quote_approved intent is appended to the notification
  // outbox inside the same transaction as the quote save, then relayed to the
  // queue AFTER commit by EnqueuePendingNotificationsUseCase. It no longer
  // depends on a live INotificationService.
  const approveB2BQuote = new ApproveB2BQuoteUseCase(
    deps.quoteRepository,
    deps.customerRepository,
    transactionManager,
    deps.notificationOutboxRepository,
    auditLogService,
    idGenerator,
    logger,
  );

  // --- Password reset initiation (L8 PART 3: direct-sync RETAINED) ----------
  // Deliberately NOT outbox-migrated: the notification carries the RAW
  // single-use reset token, which the adapter needs to render the reset link
  // and which is not retrievable after hashing. Persisting it would store a
  // credential in the async pipeline — a security risk. Wired only when a live
  // INotificationService is present.
  const notificationService = deps.externalServices?.notificationService;
  let initiatePasswordReset: InitiatePasswordResetUseCase | undefined;
  if (notificationService) {
    initiatePasswordReset = new InitiatePasswordResetUseCase(
      deps.customerRepository,
      deps.tokenService,
      notificationService,
      auditLogService,
      idGenerator,
      logger,
    );
  } else {
    report.unwiredUseCase(
      "InitiatePasswordResetUseCase",
      "INotificationService",
    );
  }

  report.wiredUseCases(
    "AuthenticateCustomerUseCase",
    "CompletePasswordResetUseCase",
    "ManageAddressBookUseCase",
    "ManageB2BBusinessUnitUseCase",
    "ProcessCustomerDataErasureUseCase",
    "RegisterCustomerAccountUseCase",
    "RequestQuoteUseCase",
    "RetrieveOrderHistoryUseCase",
    "RevokeCustomerSessionUseCase",
    "ApproveB2BQuoteUseCase",
  );

  return {
    approveB2BQuote,
    authenticateCustomer,
    completePasswordReset,
    initiatePasswordReset,
    manageAddressBook,
    manageB2BBusinessUnit,
    processCustomerDataErasure,
    registerCustomerAccount,
    requestQuote,
    retrieveOrderHistory,
    revokeCustomerSession,
  };
}
