import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Match Vite's TypeScript extension resolution while testing with native Node.
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === './publisher-data' && context.parentURL?.endsWith('/advertiser-data.ts') ? './publisher-data.ts' : specifier, context);
} });
const { createEmptyAdvertiser, getAdvertiserPreview, listAdvertiserPreviews, storeAdvertiserPreview, validateAdvertiser, advertiserCountries } = await import('../src/advertiser-data.ts');

const records = new Map<string, string>();
beforeEach(() => {
  records.clear();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) } });
});
const valid = () => ({ ...createEmptyAdvertiser(), name: 'Test Advertiser', email: 'test@advertiser.example' });

test('defaults, countries and required profile validation', () => {
  const advertiser = createEmptyAdvertiser();
  assert.equal(advertiser.country, 'IN');
  assert.equal(advertiser.advancedSetup, false);
  assert.equal(advertiser.postbackEnabled, false);
  assert.ok(advertiserCountries.length > 240);
  assert.deepEqual(Object.keys(validateAdvertiser(advertiser)).sort(), ['email', 'name']);
  assert.deepEqual(validateAdvertiser(valid()), {});
  assert.ok(validateAdvertiser({ ...valid(), country: '' }).country);
  assert.ok(validateAdvertiser({ ...valid(), status: 'Unknown' as never }).status);
});

test('validates optional contact and billing fields only when supplied', () => {
  const advertiser = { ...valid(), phone: '+91 98765 43210', zipcode: 'SW1A 1AA', billingEmail: 'billing@example.com' };
  assert.deepEqual(validateAdvertiser(advertiser), {});
  const invalid = validateAdvertiser({ ...advertiser, phone: 'bad', zipcode: '@@', billingEmail: 'bad', billingCountry: 'ZZ', currency: 'FAKE' });
  for (const key of ['phone', 'zipcode', 'billingEmail', 'billingCountry', 'currency']) assert.ok(invalid[key]);
});

test('PostBack validation is conditional and rejects unsafe URLs', () => {
  const advertiser = { ...valid(), postbackUrl: 'bad' };
  assert.deepEqual(validateAdvertiser(advertiser), {});
  advertiser.postbackEnabled = true;
  assert.ok(validateAdvertiser(advertiser).postbackUrl);
  assert.ok(validateAdvertiser(advertiser).postbackValidation);
  advertiser.postbackValidation = 'Security Token';
  for (const url of ['javascript:alert(1)', 'https://user:pass@example.com', 'https://exa mple.com']) {
    advertiser.postbackUrl = url;
    assert.ok(validateAdvertiser(advertiser).postbackUrl);
  }
  advertiser.postbackUrl = 'https://tracking.example.invalid/postback?click_id={click_id}';
  assert.deepEqual(validateAdvertiser(advertiser), {});
});

test('fixtures are fictional, cloned and unknown IDs are not fabricated', () => {
  const advertiser = getAdvertiserPreview(25)!;
  assert.match(advertiser.securityToken, /^DEMO_ONLY_/);
  assert.equal(new URL(advertiser.postbackUrl).hostname, 'tracking.example.invalid');
  advertiser.name = 'Changed';
  advertiser.access.api = true;
  assert.notEqual(getAdvertiserPreview(25)!.name, 'Changed');
  assert.equal(getAdvertiserPreview(25)!.access.api, false);
  assert.equal(getAdvertiserPreview(999), undefined);
});

test('local create/edit persistence generates only explicitly fake endpoint placeholders', async () => {
  const advertiser = valid();
  await storeAdvertiserPreview(advertiser);
  assert.equal(advertiser.id, 27);
  assert.match(advertiser.securityToken, /^DEMO_ONLY_/);
  assert.equal(new URL(advertiser.postbackUrl).hostname, 'tracking.example.invalid');
  advertiser.name = 'Edited';
  await storeAdvertiserPreview(advertiser);
  assert.equal(getAdvertiserPreview(27)!.name, 'Edited');
  assert.equal(listAdvertiserPreviews().length, 3);
  assert.equal(records.has('adstrackio:publisher-preview:v1'), false);
});

test('storage failures reject without assigning an ID', async () => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new Error('full'); } } });
  const advertiser = valid();
  await assert.rejects(storeAdvertiserPreview(advertiser), /storage is unavailable or full/);
  assert.equal(advertiser.id, null);
  assert.equal(advertiser.securityToken, '');
});

test('malformed persisted records are ignored and unrelated fields are stripped', async () => {
  records.set('adstrackio:advertiser-preview:v1', '{bad');
  assert.equal(listAdvertiserPreviews().length, 2);
  records.set('adstrackio:advertiser-preview:v1', JSON.stringify({ version: 1, advertisers: [{ id: 44 }] }));
  assert.equal(listAdvertiserPreviews().length, 2);
  const advertiser = { ...valid(), unrelatedSecret: 'do-not-store' };
  await storeAdvertiserPreview(advertiser);
  assert.ok(!records.get('adstrackio:advertiser-preview:v1')!.includes('do-not-store'));
});
