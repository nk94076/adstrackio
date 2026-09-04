/** Isolated, session-only publisher previews. Replace this module with an API adapter when available. */
export const publisherStatuses = ['Active', 'Pending', 'Paused', 'Suspended', 'Rejected'] as const
export type PublisherStatus = typeof publisherStatuses[number]

export interface Publisher {
  id: number | null
  name: string
  email: string
  phone: string
  company: string
  skype: string
  address: string
  state: string
  city: string
  zipcode: string
  taxId: string
  country: string
  status: PublisherStatus
  referenceId: string
  advancedSetup: boolean
  notifyByEmail: boolean
  createdAt: string
  updatedAt: string
  tracking: {
    enabled: boolean
    subIdParameter: string
    referralHandling: 'hide' | 'custom'
    referralUrl: string
  }
  access: { panel: boolean; api: boolean }
  notifications: { campaignUpdates: boolean; conversionUpdates: boolean }
  activity: Array<{ title: string; date: string }>
}

// ISO 3166-1 country codes; names come from the browser's bundled English locale data.
const countryCodes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ')
type DisplayNamesConstructor = new (locales: string[], options: { type: 'region' }) => { of(code: string): string | undefined }
const RegionNames = (Intl as unknown as { DisplayNames: DisplayNamesConstructor }).DisplayNames
const regionNames = new RegionNames(['en'], { type: 'region' })
export const publisherCountries: Array<{ code: string; name: string }> = countryCodes
  .map(code => ({ code, name: regionNames.of(code) || code }))
  .sort((left, right) => left.name.localeCompare(right.name))
const validCountryCodes = new Set(countryCodes)

export function createEmptyPublisher(): Publisher {
  return {
    id: null, name: '', email: '', phone: '', company: '', skype: '', address: '', state: '', city: '',
    zipcode: '', taxId: '', country: 'IN', status: 'Active', referenceId: '', advancedSetup: false,
    notifyByEmail: false, createdAt: '', updatedAt: '',
    tracking: { enabled: false, subIdParameter: '', referralHandling: 'hide', referralUrl: '' },
    access: { panel: true, api: false },
    notifications: { campaignUpdates: false, conversionUpdates: false },
    activity: [],
  }
}

const demoPublishers: Publisher[] = [
  {
    ...createEmptyPublisher(), id: 101, name: 'Avery Patel', email: 'avery@publisher.example',
    phone: '+91 98765 01234', company: 'Northstar Media · Demo', skype: 'avery.publisher.demo',
    address: '12 Example Avenue', state: 'Karnataka', city: 'Bengaluru', zipcode: '560001',
    taxId: 'DEMO-TAX-101', referenceId: 'PUB-DEMO-101',
    createdAt: '2026-08-28T09:30:00.000Z', updatedAt: '2026-09-04T12:15:00.000Z',
    activity: [
      { title: 'Notification preference updated', date: '2026-09-04T12:15:00.000Z' },
      { title: 'Profile updated', date: '2026-09-03T10:00:00.000Z' },
      { title: 'Status changed to Active', date: '2026-08-29T08:00:00.000Z' },
      { title: 'Publisher created', date: '2026-08-28T09:30:00.000Z' },
    ],
  },
  {
    ...createEmptyPublisher(), id: 102, name: 'Jordan Lee', email: 'jordan@publisher.example',
    company: 'Harbor Partners · Demo', country: 'GB', city: 'London', zipcode: 'SW1A 1AA',
    status: 'Pending', referenceId: 'PUB-DEMO-102',
    createdAt: '2026-09-02T14:00:00.000Z', updatedAt: '2026-09-02T14:00:00.000Z',
    activity: [{ title: 'Publisher created', date: '2026-09-02T14:00:00.000Z' }],
  },
]

export function validatePublisher(publisher: Publisher): Record<string, string> {
  const errors: Record<string, string> = {}
  const email = publisher.email.trim()
  if (!email) errors.email = 'Enter an email address.'
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.'
  if (!publisher.name.trim()) errors.name = 'Enter the publisher name.'
  if (!validCountryCodes.has(publisher.country.trim())) errors.country = 'Choose a country.'
  if (!publisherStatuses.includes(publisher.status)) errors.status = 'Choose an account status.'

  const phone = publisher.phone.trim()
  const phoneDigits = phone.replace(/\D/g, '').length
  if (phone && (!/^[+\d\s().-]+$/.test(phone) || phoneDigits < 7 || phoneDigits > 15)) {
    errors.phone = 'Enter a phone number with 7–15 digits.'
  }
  const zipcode = publisher.zipcode.trim()
  if (zipcode && !/^[\p{L}\p{N}][\p{L}\p{N} -]{2,11}$/u.test(zipcode)) {
    errors.zipcode = 'Use 3–12 letters, numbers, spaces or hyphens.'
  }

  if (publisher.advancedSetup && publisher.tracking.enabled) {
    const parameter = publisher.tracking.subIdParameter.trim()
    if (parameter && !/^[a-zA-Z0-9_.~-]{1,64}$/.test(parameter)) {
      errors['tracking.subIdParameter'] = 'Use up to 64 letters, numbers, dots, hyphens, underscores or tildes.'
    }
    if (publisher.tracking.referralHandling === 'custom') {
      const referralUrl = publisher.tracking.referralUrl.trim()
      if (!referralUrl) errors['tracking.referralUrl'] = 'Enter a custom referral URL.'
      else {
        try {
          const parsed = new URL(referralUrl)
          if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
            errors['tracking.referralUrl'] = 'Enter an HTTP or HTTPS URL without embedded credentials.'
          }
        } catch {
          errors['tracking.referralUrl'] = 'Enter a valid URL starting with https:// or http://.'
        }
      }
    }
  }
  return errors
}

const previewStorageKey = 'adstrackio:publisher-preview:v1'
const stringFields = ['name', 'email', 'phone', 'company', 'skype', 'address', 'state', 'city', 'zipcode', 'taxId', 'country', 'referenceId', 'createdAt', 'updatedAt'] as const
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isPublisherRecord(value: unknown): value is Publisher {
  if (!isObject(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) return false
  if (!stringFields.every(field => typeof value[field] === 'string')) return false
  if (!validCountryCodes.has(value.country as string) || !publisherStatuses.includes(value.status as PublisherStatus)) return false
  if (typeof value.advancedSetup !== 'boolean' || typeof value.notifyByEmail !== 'boolean') return false
  const { tracking, access, notifications, activity } = value
  if (!isObject(tracking) || typeof tracking.enabled !== 'boolean' || typeof tracking.subIdParameter !== 'string' || typeof tracking.referralUrl !== 'string' || !['hide', 'custom'].includes(tracking.referralHandling as string)) return false
  if (!isObject(access) || typeof access.panel !== 'boolean' || typeof access.api !== 'boolean') return false
  if (!isObject(notifications) || typeof notifications.campaignUpdates !== 'boolean' || typeof notifications.conversionUpdates !== 'boolean') return false
  return Array.isArray(activity) && activity.every(item => isObject(item) && typeof item.title === 'string' && typeof item.date === 'string')
}

/** Copy known fields only, so storage never retains unrelated account or credential properties. */
function copyPublisher(publisher: Publisher): Publisher {
  return {
    id: publisher.id, name: publisher.name.trim(), email: publisher.email.trim(), phone: publisher.phone.trim(),
    company: publisher.company.trim(), skype: publisher.skype.trim(), address: publisher.address.trim(),
    state: publisher.state.trim(), city: publisher.city.trim(), zipcode: publisher.zipcode.trim(),
    taxId: publisher.taxId.trim(), country: publisher.country.trim(), status: publisher.status,
    referenceId: publisher.referenceId.trim(), advancedSetup: publisher.advancedSetup,
    notifyByEmail: publisher.notifyByEmail, createdAt: publisher.createdAt, updatedAt: publisher.updatedAt,
    tracking: {
      enabled: publisher.tracking.enabled, subIdParameter: publisher.tracking.subIdParameter.trim(),
      referralHandling: publisher.tracking.referralHandling, referralUrl: publisher.tracking.referralUrl.trim(),
    },
    access: { panel: publisher.access.panel, api: publisher.access.api },
    notifications: { campaignUpdates: publisher.notifications.campaignUpdates, conversionUpdates: publisher.notifications.conversionUpdates },
    activity: publisher.activity.map(item => ({ title: item.title, date: item.date })),
  }
}

function readStoredPublishers(): Publisher[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(previewStorageKey) || 'null')
    if (!isObject(value) || value.version !== 1 || !Array.isArray(value.publishers)) return []
    return value.publishers.filter(isPublisherRecord).map(copyPublisher)
  } catch {
    return []
  }
}

export function listPublisherPreviews(): Publisher[] {
  const publishers = new Map<number, Publisher>()
  for (const publisher of [...demoPublishers, ...readStoredPublishers()]) {
    publishers.set(publisher.id!, copyPublisher(publisher))
  }
  return [...publishers.values()].sort((left, right) => left.id! - right.id!)
}

export function getPublisherPreview(id: number): Publisher | undefined {
  return listPublisherPreviews().find(publisher => publisher.id === id)
}

/** Saves only to this browser tab. Resolves after storage succeeds; it sends no requests or email. */
export async function storePublisherPreview(publisher: Publisher): Promise<void> {
  if (Object.keys(validatePublisher(publisher)).length) throw new Error('Check the highlighted publisher fields before saving.')
  if (publisher.id !== null && (!Number.isSafeInteger(publisher.id) || publisher.id <= 0)) throw new Error('The publisher preview ID is invalid.')
  const saved = copyPublisher(publisher)
  saved.id ??= Math.max(102, ...listPublisherPreviews().map(item => item.id!)) + 1
  const now = new Date().toISOString()
  saved.createdAt ||= now
  saved.updatedAt = now
  const stored = readStoredPublishers().filter(item => item.id !== saved.id)
  stored.push(saved)
  try {
    sessionStorage.setItem(previewStorageKey, JSON.stringify({ version: 1, publishers: stored }))
  } catch {
    throw new Error('The local preview could not be saved. Browser session storage is unavailable or full.')
  }
  // Expose the newly assigned ID only after the browser has accepted the save.
  publisher.id = saved.id
  publisher.createdAt = saved.createdAt
  publisher.updatedAt = saved.updatedAt
}
