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

export type RoutingRuleStatus = "ACTIVE" | "INACTIVE";
export type RoutingRuleAction = "TARGET" | "SAFE_PAGE" | "BLOCK";
export type RoutingConditionField =
  | "BOT_CLASSIFICATION"
  | "COUNTRY"
  | "DEVICE_TYPE"
  | "BROWSER"
  | "OS"
  | "REFERRER_HOST";
export type RoutingConditionOperator = "EQUALS" | "NOT_EQUALS" | "IN" | "NOT_IN";

export interface RoutingCondition {
  field: RoutingConditionField;
  operator: RoutingConditionOperator;
  value: string | string[];
}

/** Campaign-scoped routing rule (Phase 8: Rules & Routing Engine) — see
 * docs/architecture/rules-routing.md. */
export interface RoutingRule {
  id: string;
  campaignId: string;
  name: string;
  status: RoutingRuleStatus;
  priority: number;
  conditions: RoutingCondition[];
  action: RoutingRuleAction;
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
  /** The single affiliate partner this link's clicks attribute to (Phase
   * 9), or null for an ordinary non-affiliate link. Must already be on the
   * link's own campaign's roster — see affiliate-partners.md. */
  affiliatePartnerId: string | null;
  createdAt: string;
}

export type AffiliatePartnerStatus = "PENDING" | "ACTIVE" | "PAUSED" | "ARCHIVED";

/** Phase 9: Affiliate/Partner System — see
 * docs/architecture/affiliate-partners.md. */
export interface AffiliatePartner {
  id: string;
  name: string;
  externalId: string | null;
  email: string | null;
  status: AffiliatePartnerStatus;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** A partner's roster membership on one campaign — the join table that
 * authorizes (but does not by itself attribute) clicks; see
 * TrackingLink.affiliatePartnerId for the actual attribution point. */
export interface CampaignAffiliatePartnerAssignment {
  id: string;
  campaignId: string;
  affiliatePartnerId: string;
  createdAt: string;
  affiliatePartner: AffiliatePartner;
}

export interface AffiliatePartnerPerformanceRow {
  affiliatePartnerId: string;
  name: string;
  status: AffiliatePartnerStatus;
  clicks: number;
  humanClicks: number;
  conversions: number;
  approvedConversions: number;
  conversionRate: number;
  approvedConversionRate: number;
  totalConversionValue: number;
  approvedConversionValue: number;
  epc: number;
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

export type TimeseriesBucket = "hour" | "day" | "week" | "month";

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

export type ConversionStatus = "PENDING" | "APPROVED" | "REJECTED" | "REVERSED";

export interface Conversion {
  id: string;
  clickId: string;
  campaignId: string;
  trackingLinkId: string;
  eventName: string;
  status: ConversionStatus;
  /** Decimal(12,2), serialized as a string by Prisma — null when the
   * event carries no monetary value (e.g. a signup). */
  value: string | null;
  currency: string | null;
  externalConversionId: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface ConversionSummary {
  totalConversions: number;
  pendingConversions: number;
  approvedConversions: number;
  rejectedConversions: number;
  reversedConversions: number;
  totalConversionValue: number;
  approvedConversionValue: number;
  humanClicksInRange: number;
  conversionRate: number;
  /** Phase 10: identical value to conversionRate — see
   * docs/architecture/attribution-reporting.md#metric-formulas. */
  approvedConversionRate: number;
  /** Phase 10: EPC ("earnings per click") = approvedConversionValue /
   * humanClicksInRange. A currency-per-click figure, not a percentage. */
  epc: number;
}

// ---------------------------------------------------------------------------
// Phase 10: Attribution & Advanced Reporting — see
// docs/architecture/attribution-reporting.md.
// ---------------------------------------------------------------------------

export interface ReportOverview {
  clicks: ClickSummary;
  conversions: ConversionSummary;
}

export interface ReportTimeseriesPoint {
  bucket: string;
  clicks: number;
  humanClicks: number;
  botClicks: number;
  uniqueClicksInBucket: number;
  conversions: number;
  approvedConversions: number;
  totalConversionValue: number;
  approvedConversionValue: number;
}

export interface CampaignPerformanceRow {
  campaignId: string;
  name: string;
  status: CampaignStatus;
  clicks: number;
  humanClicks: number;
  botClicks: number;
  uniqueClicksInRange: number;
  conversions: number;
  approvedConversions: number;
  totalConversionValue: number;
  approvedConversionValue: number;
  conversionRate: number;
  approvedConversionRate: number;
  epc: number;
}

export interface TrackingLinkPerformanceRow {
  trackingLinkId: string;
  slug: string;
  campaignId: string;
  affiliatePartnerId: string | null;
  status: TrackingLinkStatus;
  clicks: number;
  humanClicks: number;
  uniqueClicksInRange: number;
  conversions: number;
  approvedConversions: number;
  totalConversionValue: number;
  approvedConversionValue: number;
  conversionRate: number;
  approvedConversionRate: number;
  epc: number;
}

export type ReportDimension = "country" | "deviceType" | "browser" | "os" | "botClassification";

export interface DimensionBreakdownRow {
  key: string;
  clicks: number;
  humanClicks: number;
  uniqueClicksInRange: number;
  conversions: number;
  approvedConversions: number;
  conversionRate: number;
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
