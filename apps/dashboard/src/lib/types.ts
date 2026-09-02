export type OrganizationRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Membership {
  id: string;
  role: OrganizationRole;
  organization: Organization;
}

export interface OrganizationMember {
  id: string;
  role: OrganizationRole;
  user: User;
  createdAt: string;
}

export type DomainVerificationStatus = "PENDING" | "VERIFIED" | "FAILED";
export type DomainSslStatus = "NOT_CONFIGURED" | "PENDING" | "ACTIVE" | "FAILED";

export interface DomainVerificationInstructions {
  recordType: "TXT";
  recordName: string;
  recordValue: string;
}

export interface TrackingDomain {
  id: string;
  hostname: string;
  verificationStatus: DomainVerificationStatus;
  verificationRequestedAt: string | null;
  verifiedAt: string | null;
  sslStatus: DomainSslStatus;
  isActive: boolean;
  createdAt: string;
  verificationInstructions: DomainVerificationInstructions | null;
}

export interface Destination {
  id: string;
  name: string;
  url: string;
  isActive: boolean;
  createdAt: string;
}

export type CampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";

export type BotTrafficPolicyAction = "SAFE_PAGE" | "TARGET" | "BLOCK";

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  trackingDomainId: string | null;
  destinationId: string | null;
  /** Server-configured destination for BOT-classified traffic (Phase 3/5)
   * — never settable by request query parameters. Null means no Safe Page
   * is configured, in which case the tracker returns a controlled 404 for
   * BOT/BLOCKed traffic instead of guessing a destination. */
  safePageUrl: string | null;
  /** Routing policy for SUSPICIOUS/UNKNOWN-classified traffic (Phase 5) —
   * BOT/HUMAN are not configurable. See
   * docs/architecture/bot-detection.md. */
  suspiciousTrafficPolicy: BotTrafficPolicyAction;
  unknownTrafficPolicy: BotTrafficPolicyAction;
  createdAt: string;
}

export type TrackingLinkStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

export interface TrackingLink {
  id: string;
  campaignId: string;
  trackingDomainId: string;
  destinationId: string;
  slug: string;
  status: TrackingLinkStatus;
  createdAt: string;
}

export type ReferralConfigurationType = "NORMAL" | "HIDE" | "CUSTOM_PARTNER_ATTRIBUTION";
export type ReferralConfigurationStatus = "INACTIVE" | "ACTIVE";
export type ReferralProofReviewStatus = "PENDING" | "UNDER_REVIEW" | "APPROVED" | "REJECTED";

export interface ReferralProof {
  id: string;
  reviewStatus: ReferralProofReviewStatus;
  documentReference: string | null;
  evidenceUrl: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface ReferralConfiguration {
  id: string;
  type: ReferralConfigurationType;
  status: ReferralConfigurationStatus;
  customReferrerValue: string | null;
  campaignId: string | null;
  proofs: ReferralProof[];
  createdAt: string;
}

export type TimeseriesBucket = "hour" | "day" | "week";

export interface AnalyticsRange {
  from: string;
  to: string;
  timezone: string;
}

export interface ClickSummary {
  totalClicks: number;
  humanClicks: number;
  botClicks: number;
  suspiciousClicks: number;
  unknownClicks: number;
  /** Unique visitors estimated over the ENTIRE requested date range. Not
   * comparable to ClickTimeseriesPoint.uniqueClicksInBucket — see
   * docs/architecture/click-analytics.md#unique-click-methodology. */
  uniqueClicksInRange: number;
  botPercentage: number;
}

export interface ClickTimeseriesPoint {
  /** Local wall-clock start of this bucket in the requested timezone — see
   * docs/architecture/click-analytics.md for why this intentionally has no
   * "Z"/UTC marker. */
  bucket: string;
  clicks: number;
  humanClicks: number;
  botClicks: number;
  /** Unique visitors estimated WITHIN THIS BUCKET only — a visitor
   * appearing in two buckets counts once in each. Summing this field
   * across buckets does NOT equal ClickSummary.uniqueClicksInRange for
   * the same period. */
  uniqueClicksInBucket: number;
}

export interface ClickBreakdownRow {
  key: string;
  label: string;
  clicks: number;
  humanClicks: number;
  botClicks: number;
  /** Same range-wide window as ClickSummary.uniqueClicksInRange, scoped to
   * this row's group. */
  uniqueClicksInRange: number;
}

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  actor: { id: string; name: string; email: string } | null;
  metadata: Record<string, unknown> | null;
}
