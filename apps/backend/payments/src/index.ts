/**
 * @delegolabs/payments — Entry point
 * #68 Dispute Resolution Arbiter Multi-Sig
 * #374 Enterprise Disbursement Multi-Sig Quorum
 */
import { createLogger } from "@delegolabs/utils";
import { startHttpServer, corsMiddleware, securityHeadersMiddleware } from "@delegolabs/utils";
import { registerRoutes } from "./routes.js";
import { startReconciliationScheduler } from "./reconciliation/settlementReconciler.js";
import { startSlaEscalationScheduler } from "./disputes/slaEscalation.js";
import { startSubscriptionBillingScheduler } from "./subscriptions/billingScheduler.js";
import { startAutoReleaseWorker, stopAutoReleaseWorker } from "./workers/autoRelease.js";
import { enablePostgresDisputeStore } from "./disputes/disputeStore.js";
import { startTimeoutRefundScheduler } from "./workers/timeoutRefund.js";
import { startShippingExceptionScheduler } from "./shipping/exceptionDetector.js";
import { startCarrierTrackingWorker } from "./webhooks/carrierWorker.js";
import { startCarrierPollingScheduler } from "./workers/carrierPolling.js";

export { escrowCoordinator } from "./escrowCoordinator/index.js";
export { reconcileSettlements, startReconciliationScheduler } from "./reconciliation/settlementReconciler.js";
export type { SettlementDiscrepancy } from "./reconciliation/settlementReconciler.js";
export { estimateTransactionFee, type FeeEstimate } from "../escrow/feeEstimator.js";
export type {
  DisputeEscrowParams,
  DisputeResult,
  EscrowCoordinator,
  EscrowStatusResult,
  FundEscrowParams,
  FundEscrowResult,
  PartialReleaseEscrowParams,
  PartialReleaseResult,
  PartialRefundEscrowParams,
  PartialRefundResult,
  RefundEscrowParams,
  RefundResult,
  ReleaseEscrowParams,
  ReleaseResult,
  RemainingBalance,
} from "./escrowCoordinator/index.js";
export { InsufficientEscrowBalanceError } from "./escrowCoordinator/index.js";

// ─── #46 Partial Refunds & Dispute Mediation ───────────────────────────────

export {
  assignMediator,
  autoAssignMediator,
  executeDecision,
  openDispute,
  submitEvidence,
  submitMediationDecision,
} from "./disputes/mediation.js";
export { executePartialRefund } from "./disputes/partialRefund.js";
export { submitMerchantResponse } from "./disputes/index.js";
export { startSlaEscalationScheduler, findAndEscalateBreachedDisputes } from "./disputes/slaEscalation.js";
export type {
  Dispute,
  DisputeEvidenceEntry,
  DisputeStatus,
  MediationDecision,
  PartialRefundRequest,
  ResolutionType,
} from "./disputes/types.js";
export {
  DisputeNotFoundError,
  DisputeAlreadyResolvedError,
  InvalidStateTransitionError,
} from "./disputes/types.js";

// ─── #47 Recurring Payment Subscriptions with Escrow ───────────────────────

export {
  cancelSubscription,
  changeSubscriptionPlan,
  createSubscription,
  createSubscriptionPlan,
  getSubscription,
  getSubscriptionPlan,
  pauseSubscription,
  renewSubscription,
  resumeSubscription,
} from "./subscriptions/service.js";
export { chargeSubscriptionPeriod } from "./subscriptions/billing.js";
export { runBillingCycle, startSubscriptionBillingScheduler } from "./subscriptions/billingScheduler.js";
export type {
  BillingInterval,
  Subscription,
  SubscriptionEvent,
  SubscriptionPlan,
  SubscriptionStatus,
} from "./subscriptions/types.js";
export {
  SubscriptionNotActiveError,
  SubscriptionNotFoundError,
  SubscriptionPlanNotFoundError,
  UnsupportedPaymentMethodError,
} from "./subscriptions/types.js";

// ─── #45 Escrow Auto-Release on Delivery Confirmation ──────────────────────

export { adminOverrideRelease, executeAutoRelease, handleDeliveryConfirmation } from "./autoRelease/service.js";

// ─── #369 Automated Oracle Delivery Receipt Signing ────────────────────────

export { signDeliveryReceipt, verifyDeliveryReceipt } from "./oracle/service.js";
export { getOracleSigner, getOracleSignerConfig, resetOracleSigner } from "./oracle/config.js";
export { registerOracleRoutes } from "./oracle/routes.js";
export type { OracleDeliveryReceiptInput, OracleSignedDeliveryReceipt, OracleSubmitReceiptResult } from "./oracle/types.js";
export { getAutoReleaseConfig, setAutoReleaseConfig } from "./autoRelease/configStore.js";
export { verifyWebhookSignature } from "./autoRelease/hmac.js";
export type {
  AdminOverrideReleaseParams,
  AutoReleaseOutcome,
  ScheduledReleaseAck,
} from "./autoRelease/service.js";
export type {
  AutoReleaseConfig,
  DeliveryConfirmation,
  DeliveryProof,
  ReleaseResult as AutoReleaseResult,
} from "./autoRelease/types.js";
export { EscrowDisputedError, EscrowNotReleasableError } from "./autoRelease/types.js";

// ─── #295 Shipping Exception & Lost Package Detector ───────────────────────

export {
  addBusinessDays,
  businessDaysBetween,
  classifyAnomaly,
  detectShippingExceptions,
  startShippingExceptionScheduler,
} from "./shipping/exceptionDetector.js";
export { notifyShippingAnomaly, SHIPPING_ANOMALY_EVENT } from "./shipping/notifications.js";
export type { ShippingAnomalyNotification } from "./shipping/notifications.js";
export {
  getShipmentStore,
  InMemoryShipmentStore,
  resetShipmentStore,
  setShipmentStore,
} from "./shipping/shipmentStore.js";
export type { ShipmentAnomalyFlag, ShipmentStore } from "./shipping/shipmentStore.js";
export type {
  InTransitShipment,
  ShipmentTrackingStatus,
  ShipmentTrackingUpdate,
  ShippingAnomalyReason,
  ShippingAnomalyRecord,
  ShippingDetectionConfig,
  ShippingScanResult,
} from "./shipping/types.js";

const SERVICE_NAME = "payments";
const DEFAULT_PORT = 3014;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);
const port = Number(process.env.PAYMENTS_PORT ?? DEFAULT_PORT);

if (process.env.DATABASE_URL) enablePostgresDisputeStore();
startAutoReleaseWorker();

log.info("Starting service", { port, nodeEnv });

const server = startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  middleware: [corsMiddleware(), securityHeadersMiddleware()],
  routes: registerRoutes(),
});

// ─── #358 Settlement Reconciliation ────────────────────────────────────────

// Start periodic settlement reconciliation if enabled
let stopScheduler: (() => void) | null = null;
if (process.env.ENABLE_SETTLEMENT_RECONCILIATION !== "false") {
  stopScheduler = startReconciliationScheduler();
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  log.info("Received shutdown signal", { signal });
  await stopAutoReleaseWorker();

  if (stopScheduler) {
    try {
      stopScheduler();
      log.info("Reconciliation scheduler stopped");
    } catch (err) {
      log.error("Error stopping reconciliation scheduler", { error: (err as Error).message });
    }
  }

  server.close(() => {
    log.info("HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    log.warn("Force-exiting after shutdown timeout");
    process.exit(0);
  }, 10_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void gracefulShutdown(signal);
  });
}

// ─── #46 Dispute SLA Escalation ─────────────────────────────────────────────

if (process.env.ENABLE_DISPUTE_SLA_ESCALATION !== "false") {
  const stopSlaScheduler = startSlaEscalationScheduler();

  process.on("SIGTERM", () => {
    log.info("SIGTERM received; stopping dispute SLA escalation scheduler");
    stopSlaScheduler();
  });
}

// ─── #47 Subscription Billing ───────────────────────────────────────────────

if (process.env.ENABLE_SUBSCRIPTION_BILLING !== "false") {
  const stopBillingScheduler = startSubscriptionBillingScheduler();

  process.on("SIGTERM", () => {
    log.info("SIGTERM received; stopping subscription billing scheduler");
    stopBillingScheduler();
  });
}

// ─── #291 Carrier Tracking Webhook Receiver ─────────────────────────────────

export {
  normalizeEasyPostEvent,
  validateEasyPostPayload,
  getCarrierWebhookSecret,
  extractCarrierSignature,
} from "./webhooks/carrierWebhook.js";
export type {
  CarrierTrackingStatus,
  EasyPostTrackingDetail,
  EasyPostTrackingWebhook,
  NormalizedCarrierEvent,
} from "./webhooks/carrierWebhook.js";
export {
  CARRIER_TRACKING_QUEUE_NAME,
  enqueueCarrierEvent,
  registerCarrierEventProcessor,
} from "./webhooks/carrierQueue.js";
export { processCarrierEvent, startCarrierTrackingWorker } from "./webhooks/carrierWorker.js";

if (process.env.ENABLE_CARRIER_TRACKING_WORKER !== "false") {
  const carrierWorker = startCarrierTrackingWorker();

  process.on("SIGTERM", () => {
    log.info("SIGTERM received; stopping carrier tracking worker");
    carrierWorker.stop();
  });
}

// ─── #297 Timeout Refund Worker for Stalled Escrows ─────────────────────────

if (process.env.ENABLE_TIMEOUT_REFUND_WORKER !== "false") {
  const timeoutRefundScheduler = startTimeoutRefundScheduler();

  process.on("SIGTERM", () => {
    log.info("SIGTERM received; stopping timeout refund scheduler");
    timeoutRefundScheduler.stop();
  });
}
// ─── #295 Shipping Exception & Lost Package Detector ───────────────────────

if (process.env.ENABLE_SHIPPING_EXCEPTION_SCAN !== "false") {
  const stopShippingExceptionScheduler = startShippingExceptionScheduler();

  process.on("SIGTERM", () => {
    log.info("SIGTERM received; stopping shipping exception scheduler");
    stopShippingExceptionScheduler();
  });
}

// ─── #384 Carrier Tracking Polling Fallback ──────────────────────────────────

if (process.env.ENABLE_CARRIER_POLLING !== "false") {
  const carrierPollingScheduler = startCarrierPollingScheduler();

  process.on("SIGTERM", () => {
    log.info("SIGTERM received; stopping carrier polling scheduler");
    carrierPollingScheduler.stop();
  });
}

// ─── #68 Dispute Resolution Arbiter Multi-Sig ────────────────────────────────

export interface ArbiterSignature {
  escrowId: string;
  arbiter: string;
  signature: string;
  signedPayloadHash: string;
  submittedAt: string;
}

export interface DisputeResolutionState {
  escrowId: string;
  threshold: number;
  signatures: ArbiterSignature[];
  status: "collecting" | "threshold_met" | "submitted" | "resolved";
}

// In-memory store keyed by escrowId.
// In production, persist to PostgreSQL (disputes table).
const disputes = new Map<string, DisputeResolutionState>();

/** Default quorum threshold (configurable via env). */
const DEFAULT_THRESHOLD = Number(process.env.ARBITER_THRESHOLD ?? 2);

/**
 * Registers an arbiter signature for a disputed escrow.
 * When the signature count reaches the threshold, the on-chain resolution is submitted.
 */
export async function collectArbiterSignature(
  escrowId: string,
  arbiter: string,
  signature: string
): Promise<DisputeResolutionState> {
  if (!escrowId || !arbiter || !signature) {
    throw new Error("escrowId, arbiter, and signature are required");
  }

  let state = disputes.get(escrowId);
  if (!state) {
    state = {
      escrowId,
      threshold: DEFAULT_THRESHOLD,
      signatures: [],
      status: "collecting",
    };
    disputes.set(escrowId, state);
  }

  // Reject duplicate signatures from the same arbiter
  if (state.signatures.some((s) => s.arbiter === arbiter)) {
    throw new Error(`Arbiter ${arbiter} has already submitted a signature for escrow ${escrowId}`);
  }

  // Prevent modifications once submitted/resolved
  if (state.status === "submitted" || state.status === "resolved") {
    throw new Error(`Dispute for escrow ${escrowId} is already ${state.status}`);
  }

  const sig: ArbiterSignature = {
    escrowId,
    arbiter,
    signature,
    signedPayloadHash: computePayloadHash(escrowId, arbiter, signature),
    submittedAt: new Date().toISOString(),
  };

  state.signatures.push(sig);

  log.info("Arbiter signature collected", {
    escrowId,
    arbiter,
    collected: state.signatures.length,
    threshold: state.threshold,
  });

  if (state.signatures.length >= state.threshold) {
    state.status = "threshold_met";
    await submitDisputeResolution(state);
  }

  return state;
}

/**
 * Returns the current dispute state for an escrow, or null if none exists.
 */
export function getDisputeState(escrowId: string): DisputeResolutionState | null {
  return disputes.get(escrowId) ?? null;
}

/** Submits the finalized multi-sig transaction to the escrow contract. */
async function submitDisputeResolution(state: DisputeResolutionState): Promise<void> {
  state.status = "submitted";
  log.info("Submitting dispute resolution transaction", {
    escrowId: state.escrowId,
    signers: state.signatures.map((s) => s.arbiter),
  });

  try {
    const walletUrl = process.env.WALLET_SERVICE_URL ?? "http://localhost:3012";
    const res = await fetch(`${walletUrl}/escrow/${encodeURIComponent(state.escrowId)}/dispute-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signatures: state.signatures,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Wallet service error: ${res.status} ${body}`);
    }

    state.status = "resolved";
    log.info("Dispute resolution submitted on-chain", { escrowId: state.escrowId });
  } catch (err) {
    // Revert to threshold_met so callers can retry
    state.status = "threshold_met";
    log.error("Dispute resolution submission failed", {
      escrowId: state.escrowId,
      error: (err as Error).message,
    });
    throw err;
  }
}

/** Deterministic payload hash from the signature inputs. */
function computePayloadHash(escrowId: string, arbiter: string, signature: string): string {
  // Simple stable hash — production should use crypto.createHash('sha256')
  const raw = `${escrowId}:${arbiter}:${signature}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ─── #374 Enterprise Disbursement Multi-Sig Quorum ────────────────────────────

export {
  createDisbursementApproval,
  collectOfficerSignature,
  getDisbursementState,
  submitDisbursementApproval,
  listDisbursements,
  expireStaleDisbursements,
  DisbursementNotFoundError,
  OfficerNotAuthorizedError,
  DuplicateSignatureError,
  InvalidSignatureError,
  DisbursementClosedError,
  type DisbursementState,
  type DisbursementStatus,
  type OfficerSignature,
  type CreateDisbursementApprovalInput,
  type SubmitOfficerSignatureInput,
} from "./disbursementApproval.js";
