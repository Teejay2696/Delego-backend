/**
 * Payment Method Vault Types
 * PCI DSS SAQ A-EP Compliant Payment Method Tokenization
 */

export type PaymentMethodType = "card" | "bank_account" | "wallet" | "stellar_account";

export type PaymentMethodVerificationMethod = "none" | "3ds" | "microdeposit" | "instant";

export type PaymentMethodStatus = "active" | "expired" | "removed";

export type NetworkTokenType = "visanet" | "mastercard-cvs" | "amex-epn" | "discover-dps";

export interface PaymentMethod {
  id: string;
  customerId: string;
  type: PaymentMethodType;
  token: string; // vault token (PAN substitute)
  brand?: string; // visa, mastercard, amex, discover, etc.
  last4?: string;
  expiryMonth?: number;
  expiryYear?: number;
  fingerprint: string; // unique identifier for the payment method
  networkToken?: {
    token: string;
    type: NetworkTokenType;
    expiryMonth?: number;
    expiryYear?: number;
    cryptogram?: string;
  };
  verified: boolean;
  verificationMethod: PaymentMethodVerificationMethod;
  metadata: Record<string, unknown>;
  status: PaymentMethodStatus;
  createdAt: string;
  lastUsedAt?: string;
  removedAt?: string;
  threeDSecure?: {
    enabled: boolean;
    challenged: boolean;
    version?: string;
    cryptogram?: string;
    eciFlag?: string;
  };
}

export interface PaymentMethodCreate {
  customerId: string;
  type: "card" | "bank_account" | "wallet";
  details: {
    number?: string;
    expMonth?: number;
    expYear?: number;
    cvc?: string;
    accountNumber?: string;
    routingNumber?: string;
    accountType?: "checking" | "savings";
    walletType?: "apple_pay" | "google_pay" | "paypal" | "stellar";
    walletAddress?: string;
  };
  verification?: {
    method: "3ds" | "microdeposit";
    returnUrl: string;
  };
  metadata?: Record<string, unknown>;
  threeDSecure?: {
    enabled: boolean;
    challengeRequested?: boolean;
  };
}

export interface TokenizationRequest {
  type: "card" | "bank_account";
  details: {
    number?: string;
    expMonth?: number;
    expYear?: number;
    cvc?: string;
    accountNumber?: string;
    routingNumber?: string;
    accountType?: "checking" | "savings";
  };
  customerId: string;
  verification?: {
    method: "3ds" | "microdeposit";
    returnUrl: string;
  };
}

export interface TokenizationResponse {
  paymentMethodId: string;
  token: string;
  fingerprint: string;
  last4?: string;
  expiryMonth?: number;
  expiryYear?: number;
  brand?: string;
  verified: boolean;
  verificationRequired: boolean;
  verificationMethod?: PaymentMethodVerificationMethod;
  networkToken?: {
    token: string;
    type: NetworkTokenType;
  };
}

export interface VerificationRequest {
  paymentMethodId: string;
  method: "3ds" | "microdeposit" | "instant";
  amount1?: number; // for microdeposit verification
  amount2?: number; // for microdeposit verification
  returnUrl?: string;
}

export interface VerificationResult {
  paymentMethodId: string;
  status: "verified" | "failed" | "pending" | "expired";
  verificationDetails: Record<string, unknown>;
  completedAt?: string;
  verifiedBy?: string; // user ID or system
}

export interface VaultTokenizeCardRequest {
  cardNumber: string;
  expiryMonth: number;
  expiryYear: number;
  cvc: string;
  customerId: string;
  verify?: boolean;
  verificationMethod?: "3ds" | "microdeposit";
  returnUrl?: string;
}

export interface VaultTokenizeBankRequest {
  accountNumber: string;
  routingNumber: string;
  accountType: "checking" | "savings";
  customerId: string;
  verify?: boolean;
}

export interface VaultTokenizeWalletRequest {
  walletType: "apple_pay" | "google_pay" | "paypal" | "stellar";
  walletToken: string;
  customerId: string;
}

export interface VaultListMethodsRequest {
  customerId: string;
  status?: PaymentMethodStatus;
  type?: PaymentMethodType;
  page?: number;
  limit?: number;
}

export interface VaultListMethodsResponse {
  paymentMethods: PaymentMethod[];
  totalCount: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface VaultUpdateMethodRequest {
  paymentMethodId: string;
  metadata?: Record<string, unknown>;
  status?: PaymentMethodStatus;
  threeDSecure?: {
    enabled: boolean;
  };
}

export interface VaultRemoveMethodRequest {
  paymentMethodId: string;
  reason: "customer_request" | "fraud" | "expired" | "duplicated";
}

export interface PaymentAuditLogEntry {
  id: string;
  eventId: string;
  timestamp: string;
  eventType: 
    | "payment_method_created"
    | "payment_method_updated"
    | "payment_method_verified"
    | "payment_method_removed"
    | "payment_method_tokenized"
    | "payment_method_network_tokenized"
    | "payment_method_3ds_verified"
    | "payment_method_imported";
  actorId: string;
  actorType: "user" | "system" | "api_key";
  resourceId: string;
  resourceType: "payment_method";
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  signature?: string;
}

// ---------------------------------------------------------------------------
// Issue #384 — Carrier Tracking Polling Fallback for Non-Webhook Carriers
// ---------------------------------------------------------------------------

/**
 * Tracks the exponential backoff polling schedule for a single payment's
 * carrier tracking endpoint.  Persisted in the `payment_records` table so
 * a restart never loses the backoff state.
 */
export interface PollingSchedule {
  /** ISO-8601 timestamp of the next poll attempt. */
  nextPollAt: Date;
  /** Base interval in minutes, doubled on each unchanged check (exponential backoff). */
  pollIntervalMinutes: number;
  /** How many consecutive polls found no change in tracking status. */
  consecutiveUnchangedCount: number;
}

export interface PCIComplianceSnapshot {
  saqType: "SAQ A-EP";
  complianceStatus: "compliant" | "non_compliant" | "in_progress";
  lastAssessmentDate: string;
  nextAssessmentDate: string;
  vaultTokenizationEnabled: boolean;
  networkTokenizationEnabled: boolean;
  threeDSecureEnabled: boolean;
  cardholderDataExposed: boolean;
  encryptionAtRestEnabled: boolean;
  encryptionInTransitEnabled: boolean;
}

export interface ThreeDSecureRequest {
  paymentMethodId: string;
  amount: number;
  currency: string;
  merchantName: string;
  merchantCategoryCode: string;
  customerEmail: string;
  customerPhoneNumber?: string;
  billingAddress?: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  returnUrl: string;
}

export interface ThreeDSecureResult {
  paymentMethodId: string;
  status: "authenticated" | "attempted" | "failed" | "skipped";
  threeDSecureVersion: string;
  eciFlag: string;
  cryptogram: string;
  xid: string;
  completedAt: string;
  challenged: boolean;
}

export interface NetworkTokenizationRequest {
  paymentMethodId: string;
  network: NetworkTokenType;
}

export interface NetworkTokenizationResponse {
  paymentMethodId: string;
  networkToken: string;
  networkTokenType: NetworkTokenType;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  cryptogram?: string;
  deviceDescriptor?: string;
}
