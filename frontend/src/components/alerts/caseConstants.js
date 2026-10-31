export const REASON_LABEL = {
  customer_confirmed_legitimate: 'Customer confirmed it was legitimate',
  customer_confirmed_fraud: 'Customer confirmed it was fraud',
  card_testing: 'Card testing',
  account_takeover: 'Account takeover',
  stolen_card: 'Stolen card',
  merchant_error: 'Merchant error',
  duplicate_alert: 'Duplicate alert',
  rule_too_sensitive: 'Rule too sensitive',
  insufficient_evidence: 'Insufficient evidence',
  other: 'Other',
};
export const STATUS_LABEL = { open: 'Open', in_review: 'In review', escalated: 'Escalated', pending_info: 'Waiting for info', resolved: 'Resolved' };
export const SEVERITY_STYLE = {
  critical: 'bg-red-600 text-white', high: 'bg-orange-500 text-white', medium: 'bg-yellow-500 text-black', low: 'bg-gray-500 text-white',
};
export const lockedByOther = (alert, userId) => !!alert?.claim && alert.claim.user_id !== userId;
export const errorCode = (err) => err?.response?.data?.details?.code;
