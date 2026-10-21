// Shared by tools/record_rsc.js (when saving) and serve-mirror.js (when looking up),
// so a recorded RSC payload is always found under the same key.
// `_rsc` is only a cache-busting hash, so it is dropped; what identifies a payload
// is the route plus which segment (or the full tree) was asked for.
function rscKey(url, headers) {
  const params = new URLSearchParams(url.search);
  params.delete('_rsc');
  const query = params.toString();
  const route = url.pathname + (query ? `?${query}` : '');
  const segment = headers['next-router-segment-prefetch'];
  const kind = segment ? `segment:${segment}` : headers['next-router-prefetch'] ? 'prefetch' : 'full';
  return `${route}|${kind}`;
}

module.exports = { rscKey };
