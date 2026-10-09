import { describe, it, expect } from 'vitest';
import { redact, redactItem } from '../redact.mjs';

const types = (r) => r.findings.map((f) => f.type).sort();

describe('redact — credentials', () => {
  it('redacts common API keys and tokens', () => {
    const text = [
      'aws AKIAIOSFODNN7EXAMPLE',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'anthropic sk-ant-api03-abcdefghijklmnopqrstuv',
      'google AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'slack xoxb-1234567890-abcdefghij',
    ].join('\n');
    const r = redact(text);
    expect(r.text).not.toMatch(/AKIAIOSFODNN7EXAMPLE|ghp_abc|sk-ant-api03|AIzaSy|xoxb-/);
    expect(types(r)).toEqual(['anthropic-key', 'aws-access-key', 'github-token', 'google-api-key', 'slack-token']);
  });

  it('redacts private key blocks entirely', () => {
    const r = redact('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\ny');
    expect(r.text).toBe('x\n[REDACTED:private-key]\ny');
  });

  it('redacts only the value of password-style assignments', () => {
    const r = redact('db_password = "hunter2hunter2" and api_key: sk_live_abcdefghijklmnop1234');
    expect(r.text).toContain('db_password = "[REDACTED:secret]');
    expect(r.text).not.toContain('hunter2hunter2');
    expect(r.text).not.toContain('sk_live_abcdefghijklmnop1234');
  });

  it('catches env-var style names (the most common way secrets get pasted)', () => {
    const env = [
      'DB_PASSWORD=correcthorsebattery',
      'export OPENAI_API_KEY="abcd1234efgh5678"',
      'GITHUB_TOKEN: zxcvbnm12345678',
      'SECRET_KEY=a1b2c3d4e5f6',
    ].join('\n');
    const r = redact(env);
    for (const leaked of ['correcthorsebattery', 'abcd1234efgh5678', 'zxcvbnm12345678', 'a1b2c3d4e5f6']) {
      expect(r.text).not.toContain(leaked);
    }
    // names stay visible so the note still makes sense
    expect(r.text).toContain('DB_PASSWORD=[REDACTED:secret]');
    expect(r.text).toContain('SECRET_KEY=[REDACTED:secret]');
  });

  it('does not redact short or non-secret values next to similar words', () => {
    const t = 'the token: ok and password=abc and passphrase is long';
    expect(redact(t).text).toBe(t);
  });

  it('leaves placeholders and prose alone', () => {
    const t = 'set password=YOUR_PASSWORD_HERE and the token: is explained below';
    expect(redact(t).text).toBe(t);
  });

  it('redacts credentials embedded in URLs but keeps the user', () => {
    const r = redact('postgres://admin:s3cretpass@db.local:5432/app');
    expect(r.text).toBe('postgres://admin:[REDACTED:password]@db.local:5432/app');
  });

  it('redacts bearer tokens and JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    const r = redact(`Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 and ${jwt}`);
    expect(r.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(r.text).not.toContain(jwt);
  });
});

describe('redact — Indian IDs and cards (checksum-validated)', () => {
  it('redacts a PAN', () => {
    expect(redact('my PAN is ABCDE1234F ok').text).toBe('my PAN is [REDACTED:pan] ok');
  });

  it('redacts a Verhoeff-valid Aadhaar number, with or without spaces', () => {
    // 2345 6789 0124 is Verhoeff-valid; 2345 6789 0123 is not (checked below).
    expect(redact('Aadhaar 234567890124').findings[0].type).toBe('aadhaar');
    expect(redact('Aadhaar 2345 6789 0124').findings[0].type).toBe('aadhaar');
  });

  it('does not touch a 12-digit number that fails Verhoeff', () => {
    const t = 'ref 234567890123';
    expect(redact(t).text).toBe(t);
  });

  it('redacts a valid card number (Luhn + issuer prefix)', () => {
    const r = redact('card 4111 1111 1111 1111 exp 12/29');
    expect(r.text).toBe('card [REDACTED:card-number] exp 12/29');
  });

  it('does not mangle long trade/order IDs or prices', () => {
    const t = 'Order 1100000012345678 filled at 22,450.35 qty 1,500 NIFTY 24500 CE';
    expect(redact(t).text).toBe(t);
  });

  it('does not redact a Luhn-valid number without a real issuer prefix', () => {
    // 0000000000000000 passes Luhn but is not a card
    const t = 'id 0000000000000000';
    expect(redact(t).text).toBe(t);
  });
});

describe('redact — national IDs and codes from around the world', () => {
  it('masks a US SSN, but not dates or look-alike numbers', () => {
    expect(redact('SSN 123-45-6789 on file').text).toBe('SSN [REDACTED:us-ssn] on file');
    for (const ok of ['2024-01-15', '123-45-678', '000-12-3456', '666-12-3456', '900-12-3456', '123-00-6789', '123-45-0000']) {
      expect(redact(`ref ${ok}`).text).toBe(`ref ${ok}`);
    }
  });

  it('masks a valid IBAN (mod-97), with or without spaces, and ignores invalid ones', () => {
    expect(redact('pay to GB82 WEST 1234 5698 7654 32 today').text).toBe('pay to [REDACTED:iban] today');
    expect(redact('DE89370400440532013000').text).toBe('[REDACTED:iban]');
    const bad = 'GB82 WEST 1234 5698 7654 33'; // checksum wrong
    expect(redact(bad).text).toBe(bad);
    expect(redact('Order AB12 3456 7890 ABCD').text).toBe('Order AB12 3456 7890 ABCD');
  });

  it('masks a UK National Insurance number and respects the invalid prefixes', () => {
    expect(redact('NI: AB 12 34 56 C').text).toBe('NI: [REDACTED:uk-nino]');
    expect(redact('ref GB 12 34 56 C').text).toBe('ref GB 12 34 56 C'); // GB is never issued
  });

  it('masks a Canadian SIN only when it passes Luhn and has separators', () => {
    expect(redact('SIN 046 454 286').text).toBe('SIN [REDACTED:ca-sin]');
    expect(redact('SIN 046 454 287').text).toBe('SIN 046 454 287');
    expect(redact('number 046454286').text).toBe('number 046454286');
  });

  it('masks one-time codes in context and keeps the sentence', () => {
    expect(redact('Your OTP is 482913. Do not share.').text).toBe('Your OTP is [REDACTED:one-time-code]. Do not share.');
    expect(redact('verification code: 7391').text).toBe('verification code: [REDACTED:one-time-code]');
    expect(redact('Use security code 1234 to continue').text).toBe('Use security code [REDACTED:one-time-code] to continue');
    for (const ok of ['the OTP flow is documented', 'code 12', 'error code is ABCDE', 'otp 12']) expect(redact(ok).text).toBe(ok);
  });

  it('masks bank account and passport numbers only when the words say what they are', () => {
    expect(redact('Account number: 123456789012').text).toBe('Account number: [REDACTED:account-number]');
    expect(redact('a/c no 00112233445').text).toBe('a/c no [REDACTED:account-number]');
    expect(redact('Passport no. K1234567').text).toBe('Passport no. [REDACTED:passport-number]');
    for (const ok of ['account 5', 'my account is overdrawn', '123456789012', 'passport photo ready', 'passport number ABCDEFGH']) {
      expect(redact(ok).text).toBe(ok);
    }
  });

  it('works inside non-English sentences', () => {
    expect(redact('Mi número es 123-45-6789, gracias').text).toBe('Mi número es [REDACTED:us-ssn], gracias');
    expect(redact('私のOTPは 482913 です').text).toBe('私のOTPは [REDACTED:one-time-code] です');
  });
});

describe('redact — behaviour', () => {
  it('can disable individual detectors', () => {
    const r = redact('PAN ABCDE1234F', { disable: ['pan'] });
    expect(r.text).toBe('PAN ABCDE1234F');
  });

  it('is idempotent', () => {
    const once = redact('token=abcdefghijkl1234').text;
    expect(redact(once).text).toBe(once);
  });

  it('redacts title/content/tags of an item and reports findings', () => {
    const { item, findings } = redactItem({
      title: 'key ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      content: 'PAN ABCDE1234F',
      tags: 'a,b',
      type: 'diary',
    });
    expect(item.title).toContain('[REDACTED:github-token]');
    expect(item.content).toContain('[REDACTED:pan]');
    expect(item.type).toBe('diary');
    expect(findings.map((f) => f.type).sort()).toEqual(['github-token', 'pan']);
  });

  it('passes through empty and non-string values', () => {
    expect(redact('').text).toBe('');
    expect(redact(undefined).text).toBe('');
  });
});

describe('redact — speed on hostile or unusual text', () => {
  const ms = (text) => { const t = performance.now(); redact(text); return performance.now() - t; };
  const LIMIT = 1500; // generous for slow CI; the old patterns needed 30+ seconds for the dotted case

  it.each([
    ['dotted identifiers', () => 'a.bc.def.node.value.x1.'.repeat(9000)],
    ['repeated keyword', () => 'pass'.repeat(50000)],
    ['hyphenated keyword', () => 'pass-'.repeat(40000)],
    ['jwt-like prefixes', () => 'eyJ-'.repeat(50000)],
    ['unterminated private-key headers', () => '-----BEGIN PRIVATE KEY-----\n'.repeat(8000)],
    ['hyphen-joined ids', () => Array.from({ length: 5000 }, (_, i) => `id${i}-4f2a-9c1b-77de`).join('-')],
    ['url-like prefixes', () => 'a://b:'.repeat(30000)],
  ])('stays fast on %s (200 KB)', (_name, make) => {
    expect(ms(make().slice(0, 200_000))).toBeLessThan(LIMIT);
  });

  it('still finds secrets in the middle of a long document', () => {
    const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(2000);
    const r = redact(`${filler}\nDB_PASSWORD=correcthorsebattery\n${filler}\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n${filler}`);
    expect(r.text).not.toMatch(/correcthorsebattery|ghp_abc/);
    expect(types(r)).toEqual(['github-token', 'secret-assignment']);
  });

  it('still masks a private key even when other BEGIN lines come first', () => {
    const r = redact('-----BEGIN PRIVATE KEY-----\nlost header\nkeep going\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nafter');
    expect(r.text).toContain('[REDACTED:private-key]');
    expect(r.text).not.toContain('MIIabc');
    expect(r.text.endsWith('after')).toBe(true);
  });

  it('masks the whole of a very long secret value', () => {
    const r = redact(`API_KEY=${'a1b2c3d4'.repeat(400)} next`);
    expect(r.text).toBe('API_KEY=[REDACTED:secret] next');
  });

  it('masks a key that is also a long token inside a bigger identifier', () => {
    expect(redact('MY_SERVICE_API_KEY_PROD=abcd1234efgh5678').text).toBe('MY_SERVICE_API_KEY_PROD=[REDACTED:secret]');
    expect(redact('a.b.c.password: "hunter2hunter2"').text).not.toContain('hunter2hunter2');
  });
});

describe('redact — formats seen in real notes (found by the review)', () => {
  // [text, the part that must NOT survive]
  const secrets = [
    ['{"password": "hunter2hunter2"}', 'hunter2hunter2'],
    ['{"apiKey":"abcdef1234567890"}', 'abcdef1234567890'],
    ['DB_PASSWORD="my secret pass phrase here"', 'pass phrase here'],
    ["API_SECRET='abcd efgh ijkl'", 'abcd efgh ijkl'],
    ['  password: \'p@ss w0rd\'', 'p@ss w0rd'],
    ['{"client_secret": "vQ3~abc"}', 'vQ3~abc'],
    ['PASSWORD=hunter2', 'hunter2'],
    ['password: abc123', 'abc123'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=', 'dXNlcjpwYXNzd29yZDEyMzQ='],
    ['Authorization: Token 0123456789abcdef', '0123456789abcdef'],
    ['curl -u admin:SuperSecret99 https://x.example', 'SuperSecret99'],
    ['mysql -u root -pMyS3cretPw', 'MyS3cretPw'],
    ['postgres://admin:p@ssw0rd123@host/db', 'p@ssw0rd123'],
    ['redis://:mypassword123@host:6379', 'mypassword123'],
    ['npm_aBc' + 'DeFgHiJkLmNoPqRsTuVwXyZ0123456789', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ'],
    ['SG.abc' + 'defghijklmnopqrstuv.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghi', 'abcdefghijklmnopqrstuv'],
    ['glpat-abc' + 'defghij0123456789', 'abcdefghij0123456789'],
    ['hf_abc' + 'defghijklmnopqrstuvwxyzABCDEFGH', 'abcdefghijklmnopqrstuvwxyz'],
    ['whsec_abc' + 'defghijklmnopqrstuvwxyz012345', 'abcdefghijklmnopqrstuvwxyz'],
    ['123456789:AAHdq' + 'TcvCH1vGWJxfSeofSAs0K5PALDsaw', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'],
    ['https://hooks.slack.com/services/T01' + '234567/B01234567/abcdEFGHijklMNOPqrstUVWX', 'abcdEFGHijklMNOPqrstUVWX'],
    ['https://discord.com/api/webhooks/123' + '456789012345678/abcDEF-ghiJKL_mnoPQR0123456789abcdefghijklmnop', 'abcDEF-ghiJKL_mnoPQR0123456789abcdefghijklmnop'],
    ['AccountKey=Xk3' + 'J9aLmQ0pZr7vTnB2cYdE5fGhI8jKl1MoPqRsTuVwXyZ0123456789abcdefghijklmnopQRSTUV==', 'Xk3J9aLmQ0pZr7vTnB2cYdE5fGhI8jKl1MoPqRsTuVwXyZ'],
    ['1//0gAbC' + 'dEfGhIjKlMnOpQrStUvWxYz-abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBFabc\n-----END PGP PRIVATE KEY BLOCK-----', 'lQOYBFabc'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz', 'MIIEowIBAAKCAQEAxyz'], // pasted without the end line
  ];
  it.each(secrets)('masks %j', (text, leak) => {
    expect(redact(text).text).not.toContain(leak);
    expect(redact(text).findings.length).toBeGreaterThan(0);
  });

  it('keeps the names so the note still makes sense', () => {
    expect(redact('{"password": "hunter2hunter2"}').text).toBe('{"password": "[REDACTED:secret]"}');
    expect(redact('Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=').text).toBe('Authorization: Basic [REDACTED:authorization]');
    expect(redact('postgres://admin:p@ssw0rd123@host/db').text).toBe('postgres://admin:[REDACTED:password]@host/db');
  });

  const harmless = [
    'The password policy requires rotation', 'Authorization: Bearer <token>', 'See token: the docs',
    "password: the user's secret question", 'Our api key rotation: weekly', 'https://example.com/a/b?x=1',
    'const tokenizer = new Tok()', 'Password: required', 'the password: changed yesterday',
    'mailto:someone@example.com', 'https://example.com:8080/path@x', 'sig=short', 'Authorization: Bearer YOUR_TOKEN_HERE',
    'git commit 0123456789abcdef0123456789abcdef01234567', 'hf_ is' + ' a prefix', 'key-value pairs',
  ];
  it.each(harmless)('leaves ordinary text alone: %j', (text) => {
    expect(redact(text).text).toBe(text);
  });

  it('stays quick on long quoted text with no closing quote', () => {
    const t0 = performance.now();
    redact('password="' + 'a '.repeat(100000));
    redact('-----BEGIN PGP PRIVATE KEY BLOCK-----\n'.repeat(5000));
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('is still idempotent on the new patterns', () => {
    const once = redact('{"password": "hunter2hunter2"} Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ= npm_aBc' + 'DeFgHiJkLmNoPqRsTuVwXyZ0123456789').text;
    expect(redact(once).text).toBe(once);
  });
});
