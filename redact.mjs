/**
 * redact.mjs — strip secrets before they reach the shared memory
 * ═══════════════════════════════════════════════════════════════════════════════
 * Every agent can read the shared vault, so a pasted API key or a captured
 * clipboard would be readable by all of them. Everything entering the vault is
 * passed through here first. Detectors are deliberately high-precision:
 * a redaction you did not expect is worse than a missed one in a notes app, so
 * card numbers need a real issuer prefix + Luhn, and Aadhaar needs Verhoeff.
 * (Trade/order IDs are long digit strings; they must not be mangled.)
 *
 * This is a safety net, not a guarantee — see SECURITY.md.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── checksums ──────────────────────────────────────────────────────────────

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const V_D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
  [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
  [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0],
];
const V_P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];

function verhoeff(digits) {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = V_D[c][V_P[i % 8][Number(rev[i])]];
  return c === 0;
}

/** IBAN check: move the first 4 chars to the end, letters → numbers, remainder mod 97 must be 1. */
function ibanOk(raw) {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

// Card numbers must start with a real issuer range, not just pass Luhn.
const CARD_PREFIX = /^(?:4\d{12}(?:\d{3}(?:\d{3})?)?|5[1-5]\d{14}|2(?:2[2-9]\d|[3-6]\d\d|7[01]\d|720)\d{12}|3[47]\d{13}|6(?:011|5\d\d)\d{12}|(?:60|65|81|82)\d{14}|508\d{13})$/;

// ─── detectors ──────────────────────────────────────────────────────────────

const mask = (type) => `[REDACTED:${type}]`;

/**
 * Mask PEM private-key blocks. A linear scan, not a lazy regex: a regex retried from every
 * "BEGIN" line that has no "END" re-reads the rest of the text each time (quadratic).
 * Returns the new text and how many blocks were masked.
 */
function maskPrivateKeys(text) {
  const BEGIN = /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----/g;
  const END = /-----END [A-Z ]{0,30}PRIVATE KEY-----/g;
  let out = "";
  let from = 0;
  let count = 0;
  for (;;) {
    BEGIN.lastIndex = from;
    const b = BEGIN.exec(text);
    if (!b) break;
    END.lastIndex = b.index + b[0].length;
    const e = END.exec(text);
    if (!e) break; // no closing line anywhere after this point, so none of the later headers can close either
    out += text.slice(from, b.index) + mask("private-key");
    from = e.index + e[0].length;
    count++;
  }
  return { text: out + text.slice(from), count };
}

/** Each detector: { id, re, validate?(match), replace?(match, ...groups) } or { id, scan(text) → { text, count } } */
export const DETECTORS = [
  { id: "private-key", scan: maskPrivateKeys },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "stripe-key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: "jwt", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}(?![A-Za-z0-9_-])/g },
  { id: "bearer-token", re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, replace: (_m, pre) => `${pre}${mask("bearer-token")}` },
  { id: "url-credentials", re: /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{1,200}:)[^\s@/]{3,500}(@)/gi, replace: (_m, a, b) => `${a}${mask("password")}${b}` },
  {
    id: "secret-assignment",
    // password=..., DB_PASSWORD=..., export OPENAI_API_KEY="...", GITHUB_TOKEN: ...
    // → redact the value only. The name may carry any identifier prefix/suffix.
    re: /((?:pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|private[_-]?key)[A-Za-z0-9_]{0,40}\s{0,10}[:=]\s{0,10}["']?)([^\s"',;]{8,})/gi,
    validate: (_m, _pre, value) => !/^(?:your|xxx|\*{3,}|<|\$\{|\[REDACTED|example|changeme|placeholder)/i.test(value),
    replace: (_m, pre) => `${pre}${mask("secret")}`,
  },
  // ── national IDs and codes from around the world (each is checksum- or format-validated) ──
  { id: "us-ssn", re: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g },
  { id: "iban", re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, validate: (m) => ibanOk(m) },
  { id: "uk-nino", re: /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z][ ]?\d{2}[ ]?\d{2}[ ]?\d{2}[ ]?[A-D]\b/g },
  { id: "ca-sin", re: /(?<![\d-])\d{3}[ -]\d{3}[ -]\d{3}(?![\d-])/g, validate: (m) => luhn(m.replace(/\D/g, "")) },
  {
    // "Your OTP is 482913", "verification code: 7391" — the digits are masked, the sentence is kept
    id: "one-time-code",
    re: /\b((?:otp|one[- ]time[- ](?:password|passcode|code|pin)|verification[- ]code|security[- ]code|auth(?:entication)?[- ]code|login[- ]code|2fa[- ]code|passcode)\b[^\d\n]{0,25})(\d{4,8})\b/gi,
    replace: (_m, pre) => `${pre}${mask("one-time-code")}`,
  },
  {
    id: "account-number",
    re: /\b((?:bank\s+)?(?:account|acct|a\/c)[ ]?(?:no\.?|number|num|#)?[ ]?[:=]?[ ]?)(\d{8,18})\b/gi,
    replace: (_m, pre) => `${pre}${mask("account-number")}`,
  },
  {
    id: "passport-number",
    re: /\b(passport[ ]?(?:no\.?|number|num|#)?[ ]?[:=]?[ ]?)([A-Z0-9]{6,9})\b/gi,
    validate: (_m, _pre, v) => /\d/.test(v),
    replace: (_m, pre) => `${pre}${mask("passport-number")}`,
  },
  // India (Aadhaar is Verhoeff-checked; PAN has a fixed shape)
  { id: "pan", re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  {
    id: "aadhaar",
    re: /(?<![\d-])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g,
    validate: (m) => verhoeff(m.replace(/\D/g, "")),
  },
  {
    id: "card-number",
    re: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    validate: (m) => {
      const d = m.replace(/\D/g, "");
      return CARD_PREFIX.test(d) && luhn(d);
    },
  },
];

/**
 * Redact secrets from a string.
 * @param {string} text
 * @param {{ disable?: string[] }} [opts]
 * @returns {{ text: string, findings: Array<{ type: string, count: number }> }}
 */
export function redact(text, { disable = [] } = {}) {
  if (typeof text !== "string" || !text) return { text: text ?? "", findings: [] };
  const counts = new Map();
  let out = text;
  for (const d of DETECTORS) {
    if (disable.includes(d.id)) continue;
    if (d.scan) {
      const r = d.scan(out);
      if (r.count) { out = r.text; counts.set(d.id, (counts.get(d.id) || 0) + r.count); }
      continue;
    }
    out = out.replace(d.re, (...args) => {
      const m = args[0];
      const groups = args.slice(1, -2).filter((g) => typeof g === "string" || g === undefined);
      if (d.validate && !d.validate(m, ...groups)) return m;
      counts.set(d.id, (counts.get(d.id) || 0) + 1);
      return d.replace ? d.replace(m, ...groups) : mask(d.id);
    });
  }
  return { text: out, findings: [...counts].map(([type, count]) => ({ type, count })) };
}

/** Redact the text fields of an item in place-safe fashion; returns { item, findings }. */
export function redactItem(item, opts) {
  const findings = new Map();
  const out = { ...item };
  // `source` is free text too (an AI or importer can set it), so it is masked like the rest.
  for (const field of ["title", "content", "tags", "source"]) {
    if (typeof out[field] !== "string") continue;
    const r = redact(out[field], opts);
    out[field] = r.text;
    for (const f of r.findings) findings.set(f.type, (findings.get(f.type) || 0) + f.count);
  }
  return { item: out, findings: [...findings].map(([type, count]) => ({ type, count })) };
}

export function summarizeFindings(findings) {
  return findings.map((f) => `${f.count}× ${f.type}`).join(", ");
}
