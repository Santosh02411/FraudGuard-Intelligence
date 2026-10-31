export const CASE_STATUS_LABEL = { open: 'Open', investigating: 'Investigating', pending_info: 'Pending info', closed: 'Closed' };
export const CASE_STATUS_STYLE = { open: 'bg-blue-500/15 text-blue-300', investigating: 'bg-purple-500/15 text-purple-300', pending_info: 'bg-yellow-500/15 text-yellow-300', closed: 'bg-gray-500/20 text-gray-300' };
export const PRIORITY_STYLE = { critical: 'bg-red-600 text-white', high: 'bg-orange-500 text-white', medium: 'bg-yellow-500 text-black', low: 'bg-gray-500 text-white' };
export const OUTCOME_LABEL = { confirmed_fraud: 'Confirmed fraud', legitimate: 'Legitimate activity', inconclusive: 'Inconclusive' };
export const TIMELINE_STYLE = { case: 'text-cyan-300', alert: 'text-purple-300', transaction: 'text-gray-300', dispute: 'text-orange-300' };
export const apiCode = (err) => err?.response?.data?.details?.code;
export const apiMessage = (err, fallback) => err?.response?.data?.error || fallback;
