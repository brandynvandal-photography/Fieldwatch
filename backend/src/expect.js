// A JSON body against a shape, before anything is stored: strings trimmed and capped, numbers finite, choices from a list,
// unknown fields dropped. One line per rule: 'string:120' (required, at most 120 characters), 'string?:2000' (optional),
// 'number', 'number?', 'boolean?', or an array of the values allowed (with null in it when the field may be left out).
// Returns { value } clean, or { error } naming the field, so a route answers 400 with the reason.
export function expect(body, shape) {
  const src = body && typeof body === 'object' ? body : {}, value = {};
  for (const [field, rule] of Object.entries(shape)) {
    const v = src[field], missing = v === undefined || v === null || v === '';
    if (Array.isArray(rule)) {
      const optional = rule.includes(null);
      if (missing) { if (optional) continue; return { error: `${field} must be one of ${rule.filter(x => x != null).join(', ')}` }; }
      if (!rule.includes(v)) return { error: `${field} must be one of ${rule.filter(x => x != null).join(', ')}` };
      value[field] = v; continue;
    }
    const m = /^(string|number|boolean)(\?)?(?::(\d+))?$/.exec(String(rule));
    if (!m) throw new Error(`bad rule for ${field}: ${rule}`);
    const [, type, opt, max] = m, optional = Boolean(opt);
    if (missing) { if (optional) continue; return { error: `${field} required` }; }
    if (type === 'string') {
      if (typeof v !== 'string') return { error: `${field} must be text` };
      const t = v.replace(/\s+/g, ' ').trim();
      if (!t) { if (optional) continue; return { error: `${field} required` }; }
      if (max && t.length > Number(max)) return { error: `${field} is too long (${Number(max)} characters at most)` };
      value[field] = t;
    } else if (type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return { error: `${field} must be a number` };
      value[field] = n;
    } else if (type === 'boolean') {
      if (typeof v !== 'boolean') return { error: `${field} must be true or false` };
      value[field] = v;
    }
  }
  return { value };
}
