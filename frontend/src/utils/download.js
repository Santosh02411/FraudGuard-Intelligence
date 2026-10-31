/**
 * Triggers a browser download for an axios response fetched with
 * `responseType: 'blob'` (feature: CSV export). Shared by every export
 * button (Transactions, Alerts, Admin audit log) so the "create an
 * object URL, click a throwaway <a>, revoke the URL" dance — needed
 * because a Blob response has no natural URL of its own — lives in one
 * place instead of being copy-pasted per page.
 */
export function downloadBlobResponse(response, fallbackFilename) {
  const disposition = response.headers['content-disposition'] || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : fallbackFilename;

  const url = window.URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

/**
 * Same idea as downloadBlobResponse, for a plain JSON object that
 * wasn't fetched as a blob in the first place (feature: self-service
 * data export — GET /auth/me/export returns normal JSON, not a file
 * response with a Content-Disposition header, so there's no filename to
 * read off it).
 */
export function downloadJson(data, filename) {
  const url = window.URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
