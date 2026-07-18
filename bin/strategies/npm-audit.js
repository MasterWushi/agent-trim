'use strict';

module.exports = {
  name: 'npm-audit',
  minBytes: 500,
  apply(text, ctx) {
    const commandMatch = /npm\s+audit/i.test((ctx && ctx.command) || '');
    if (!commandMatch && !text.includes('"vulnerabilities"')) return null;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    const plainObject = (item) =>
      !!item && typeof item === 'object' && !Array.isArray(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item));
    if (!value || typeof value !== 'object' || !plainObject(value.vulnerabilities)) return null;
    const metadata = value.metadata && value.metadata.vulnerabilities;
    if (!commandMatch && !plainObject(metadata)) return null;
    const counts = plainObject(metadata) ? metadata : {};
    const order = ['critical', 'high', 'moderate', 'low', 'info'];
    const out = [`npm audit: ${order.map((key) => `${key} ${counts[key] || 0}`).join(', ')}`];
    for (const [name, item] of Object.entries(value.vulnerabilities).sort(([a], [b]) => a.localeCompare(b))) {
      if (!item || typeof item !== 'object') continue;
      const via = Array.isArray(item.via)
        ? item.via.map((v) => (typeof v === 'string' ? v : v && (v.title || v.source))).filter(Boolean).slice(0, 3).join('; ')
        : '';
      out.push(`${item.severity || 'unknown'} ${name}${item.range ? ` ${item.range}` : ''}${via ? ` — ${via}` : ''}`);
    }
    if (value.metadata && value.metadata.totalDependencies !== undefined) out.push(`dependencies: ${value.metadata.totalDependencies}`);
    return { out: out.join('\n'), lossy: true, reason: 'npm audit vulnerabilities summarized by package and severity' };
  },
};
