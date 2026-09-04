import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createEmptyPublisher, getPublisherPreview, listPublisherPreviews, publisherCountries, storePublisherPreview, validatePublisher } from '../src/publisher-data.ts'
import type { Publisher } from '../src/publisher-data.ts'

let storage: Map<string, string>
beforeEach(() => {
  storage = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } },
  })
})
function validPublisher(): Publisher {
  return { ...createEmptyPublisher(), name: ' Preview Publisher ', email: ' hello@publisher.example ' }
}

test('defaults and country options match the form requirements', () => {
  const publisher = createEmptyPublisher()
  assert.equal(publisher.country, 'IN')
  assert.equal(publisher.status, 'Active')
  assert.equal(publisher.advancedSetup, false)
  assert.equal(publisher.notifyByEmail, false)
  assert.equal(publisherCountries.length, 249)
  assert.deepEqual(publisherCountries.find(item => item.code === 'IN'), { code: 'IN', name: 'India' })
})

test('requires trimmed name, valid email, and known country/status values', () => {
  const publisher = { ...createEmptyPublisher(), name: '   ', email: 'wrong@address', country: 'XX', status: 'Unknown' } as Publisher
  assert.deepEqual(Object.keys(validatePublisher(publisher)).sort(), ['country', 'email', 'name', 'status'])
  assert.deepEqual(validatePublisher(validPublisher()), {})
})

test('accepts international phone and postal formats but rejects invalid supplied values', () => {
  for (const [phone, zipcode] of [['+91 98765 01234', '560001'], ['+44 (0)20 7946 0123', 'SW1A 1AA'], ['1-514-555-0100', 'H2Y 1C6'], ['', '']]) {
    assert.deepEqual(validatePublisher({ ...validPublisher(), phone, zipcode }), {})
  }
  assert.deepEqual(Object.keys(validatePublisher({ ...validPublisher(), phone: '123-call-me', zipcode: '<script>' })).sort(), ['phone', 'zipcode'])
})

test('ignores hidden tracking fields; validates custom referral only when enabled', () => {
  const publisher = validPublisher()
  publisher.tracking = { enabled: true, subIdParameter: 'has space', referralHandling: 'custom', referralUrl: 'not a url' }
  assert.deepEqual(validatePublisher(publisher), {})
  publisher.advancedSetup = true
  assert.deepEqual(Object.keys(validatePublisher(publisher)).sort(), ['tracking.referralUrl', 'tracking.subIdParameter'])
  publisher.tracking.enabled = false
  assert.deepEqual(validatePublisher(publisher), {})
  publisher.tracking.enabled = true
  publisher.tracking.subIdParameter = ''
  for (const referralUrl of ['', 'javascript:alert(1)', 'https://user:password@destination.example/']) {
    publisher.tracking.referralUrl = referralUrl
    assert.ok(validatePublisher(publisher)['tracking.referralUrl'])
  }
  publisher.tracking.referralUrl = 'https://destination.example/path?source=publisher'
  assert.deepEqual(validatePublisher(publisher), {})
})

test('demo fixtures are isolated and returned as independent copies', () => {
  const preview = getPublisherPreview(101)!
  preview.access.api = true
  preview.activity[0].title = 'Modified'
  assert.equal(getPublisherPreview(101)!.access.api, false)
  assert.notEqual(getPublisherPreview(101)!.activity[0].title, 'Modified')
  assert.equal(getPublisherPreview(999), undefined)
})

test('creates and edits session previews without mutating fixtures or storing extra credential fields', async () => {
  const publisher = Object.assign(validPublisher(), { password: 'must-not-be-stored' })
  await storePublisherPreview(publisher)
  assert.equal(publisher.id, 103)
  assert.equal(getPublisherPreview(103)!.name, 'Preview Publisher')
  assert.equal(getPublisherPreview(103)!.email, 'hello@publisher.example')
  assert.ok(publisher.createdAt)
  assert.ok(![...storage.values()].join('').includes('password'))
  publisher.status = 'Paused'
  await storePublisherPreview(publisher)
  assert.equal(getPublisherPreview(103)!.status, 'Paused')
  assert.equal(listPublisherPreviews().length, 3)
  assert.equal(getPublisherPreview(101)!.status, 'Active')
  const nextPublisher = validPublisher()
  await storePublisherPreview(nextPublisher)
  assert.equal(nextPublisher.id, 104)
})

test('ignores malformed or unsupported stored records without breaking fixture previews', () => {
  storage.set('adstrackio:publisher-preview:v1', '{broken json')
  assert.equal(listPublisherPreviews().length, 2)
  storage.set('adstrackio:publisher-preview:v1', JSON.stringify({ version: 1, publishers: [null, { id: 101 }, { ...getPublisherPreview(101), tracking: null }] }))
  assert.equal(listPublisherPreviews().length, 2)
})

test('rejects failed saves without assigning an ID or showing a saved record', async () => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new Error('Quota exceeded') } } })
  const publisher = validPublisher()
  await assert.rejects(storePublisherPreview(publisher), /could not be saved/)
  assert.equal(publisher.id, null)
  assert.equal(publisher.updatedAt, '')
  assert.equal(listPublisherPreviews().length, 2)
})
