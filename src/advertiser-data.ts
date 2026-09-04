import { publisherCountries, publisherStatuses } from './publisher-data'

/** Shared option vocabulary only. Advertiser previews never read or write publisher storage. */
export const advertiserStatuses = publisherStatuses
export type AdvertiserStatus = typeof advertiserStatuses[number]
export const advertiserCountries = publisherCountries.map(country => ({ ...country }))
export const advertiserCurrencies: Array<{ code: string; name: string }> = [
  { code: 'INR', name: 'Indian Rupee' }, { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' }, { code: 'GBP', name: 'British Pound' },
  { code: 'AED', name: 'UAE Dirham' }, { code: 'AUD', name: 'Australian Dollar' },
  { code: 'BRL', name: 'Brazilian Real' }, { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'CHF', name: 'Swiss Franc' }, { code: 'CNY', name: 'Chinese Yuan' },
  { code: 'DKK', name: 'Danish Krone' }, { code: 'HKD', name: 'Hong Kong Dollar' },
  { code: 'IDR', name: 'Indonesian Rupiah' }, { code: 'ILS', name: 'Israeli New Shekel' },
  { code: 'JPY', name: 'Japanese Yen' }, { code: 'KRW', name: 'South Korean Won' },
  { code: 'MXN', name: 'Mexican Peso' }, { code: 'MYR', name: 'Malaysian Ringgit' },
  { code: 'NOK', name: 'Norwegian Krone' }, { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'PHP', name: 'Philippine Peso' }, { code: 'PLN', name: 'Polish Zloty' },
  { code: 'SAR', name: 'Saudi Riyal' }, { code: 'SEK', name: 'Swedish Krona' },
  { code: 'SGD', name: 'Singapore Dollar' }, { code: 'THB', name: 'Thai Baht' },
  { code: 'TRY', name: 'Turkish Lira' }, { code: 'ZAR', name: 'South African Rand' },
]

export interface Advertiser {
  id: number | null
  name: string
  email: string
  phone: string
  company: string
  address: string
  state: string
  city: string
  zipcode: string
  taxId: string
  country: string
  status: AdvertiserStatus
  referenceId: string
  notes: string
  advertiserManager: string
  hashId: string
  currency: string
  billingEmail: string
  billingAddress: string
  billingCountry: string
  paymentTerms: string
  postbackUrl: string
  securityToken: string
  postbackValidation: string
  createdAt: string
  updatedAt: string
  advancedSetup: boolean
  postbackEnabled: boolean
  notifyByEmail: boolean
  access: { panel: boolean; api: boolean }
  tracking: {
    conversionTracking: boolean
    redirectType: 'Default' | '301' | '302'
    locale: string
    pixelType: 'image' | 'iframe'
  }
  notifications: { email: boolean; conversion: boolean }
  activity: Array<{ title: string; date: string }>
}

export function createEmptyAdvertiser(): Advertiser {
  return {
    id: null, name: '', email: '', phone: '', company: '', address: '', state: '', city: '', zipcode: '',
    taxId: '', country: 'IN', status: 'Active', referenceId: '', notes: '', advertiserManager: '', hashId: '',
    currency: 'INR', billingEmail: '', billingAddress: '', billingCountry: '', paymentTerms: '',
    postbackUrl: '', securityToken: '', postbackValidation: '', createdAt: '', updatedAt: '',
    advancedSetup: false, postbackEnabled: false, notifyByEmail: false,
    access: { panel: true, api: false },
    tracking: { conversionTracking: false, redirectType: 'Default', locale: '', pixelType: 'image' },
    notifications: { email: false, conversion: false }, activity: [],
  }
}

function previewToken(id: number): string {
  return `DEMO_ONLY_ADVERTISER_${id}_NOT_A_SECRET`
}
function previewPostbackUrl(id: number, token: string): string {
  // Deliberately non-operational examples; these functions do not provision endpoints or credentials.
  return `https://tracking.example.invalid/postback?advertiser_id=${id}&click_id={click_id}&security_token=${encodeURIComponent(token)}`
}

const demoAdvertisers: Advertiser[] = [
  {
    ...createEmptyAdvertiser(), id: 25, name: 'Morgan Taylor', email: 'morgan@advertiser.example',
    phone: '+91 98765 02468', company: 'Summit Commerce · Demo', address: '25 Example Avenue',
    state: 'Maharashtra', city: 'Mumbai', zipcode: '400001', taxId: 'DEMO-TAX-25',
    referenceId: 'ADV-DEMO-25', notes: 'Fictional advertiser account for reviewing this interface.',
    advertiserManager: 'Alex Singh · Demo', hashId: 'DEMO-ADV-25', billingEmail: 'billing@advertiser.example',
    billingAddress: '25 Example Avenue, Mumbai', billingCountry: 'IN', paymentTerms: 'Net 30',
    postbackEnabled: true, postbackUrl: previewPostbackUrl(25, previewToken(25)),
    securityToken: previewToken(25), postbackValidation: 'Security Token',
    createdAt: '2026-08-27T09:30:00.000Z', updatedAt: '2026-09-04T14:15:00.000Z',
    tracking: { conversionTracking: true, redirectType: '302', locale: 'en-IN', pixelType: 'image' },
    activity: [
      { title: 'Postback configuration updated', date: '2026-09-04T14:15:00.000Z' },
      { title: 'Profile updated', date: '2026-09-03T11:00:00.000Z' },
      { title: 'Security token regenerated', date: '2026-09-02T09:30:00.000Z' },
      { title: 'Status changed to Active', date: '2026-08-28T10:00:00.000Z' },
      { title: 'Advertiser created', date: '2026-08-27T09:30:00.000Z' },
    ],
  },
  {
    ...createEmptyAdvertiser(), id: 26, name: 'Riley Chen', email: 'riley@advertiser.example',
    company: 'Cedar Brands · Demo', country: 'US', currency: 'USD', city: 'Seattle', zipcode: '98101',
    status: 'Pending', referenceId: 'ADV-DEMO-26', hashId: 'DEMO-ADV-26',
    securityToken: previewToken(26), postbackUrl: previewPostbackUrl(26, previewToken(26)),
    createdAt: '2026-09-02T12:00:00.000Z', updatedAt: '2026-09-02T12:00:00.000Z',
    activity: [{ title: 'Advertiser created', date: '2026-09-02T12:00:00.000Z' }],
  },
]

const validCountries = new Set(advertiserCountries.map(country => country.code))
const validCurrencies = new Set(advertiserCurrencies.map(currency => currency.code))
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateAdvertiser(advertiser: Advertiser): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!advertiser.name.trim()) errors.name = 'Enter the advertiser name.'
  const email = advertiser.email.trim()
  if (!email) errors.email = 'Enter an email address.'
  else if (!emailPattern.test(email)) errors.email = 'Enter a valid email address.'
  if (!validCountries.has(advertiser.country.trim())) errors.country = 'Choose a country.'
  if (!advertiserStatuses.includes(advertiser.status)) errors.status = 'Choose an account status.'
  const currency = advertiser.currency.trim()
  if (currency && !validCurrencies.has(currency)) errors.currency = 'Choose a currency from the list.'
  const billingEmail = advertiser.billingEmail.trim()
  if (billingEmail && !emailPattern.test(billingEmail)) errors.billingEmail = 'Enter a valid billing email address.'
  const billingCountry = advertiser.billingCountry.trim()
  if (billingCountry && !validCountries.has(billingCountry)) errors.billingCountry = 'Choose a billing country from the list.'
  const phone = advertiser.phone.trim()
  const digits = phone.replace(/\D/g, '').length
  if (phone && (!/^[+\d\s().-]+$/.test(phone) || digits < 7 || digits > 15)) errors.phone = 'Enter a phone number with 7–15 digits.'
  const zipcode = advertiser.zipcode.trim()
  if (zipcode && !/^[\p{L}\p{N}][\p{L}\p{N} -]{2,11}$/u.test(zipcode)) errors.zipcode = 'Use 3–12 letters, numbers, spaces or hyphens.'

  // The PostBack card has its own enable switch, independent of the Advanced Setup disclosure.
  if (advertiser.postbackEnabled) {
    const value = advertiser.postbackUrl.trim()
    if (!value) errors.postbackUrl = 'Enter a postback URL.'
    else {
      try {
        const url = new URL(value)
        if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /\s/.test(value)) {
          errors.postbackUrl = 'Enter an HTTP or HTTPS URL without spaces or embedded credentials.'
        }
      } catch {
        errors.postbackUrl = 'Enter a valid URL starting with https:// or http://.'
      }
    }
    if (!advertiser.postbackValidation.trim()) errors.postbackValidation = 'Choose a postback validation method.'
  }
  return errors
}
