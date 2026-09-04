import './publisher-form.css';
import { publisherCountries, publisherStatuses, storePublisherPreview, validatePublisher, type Publisher, type PublisherStatus } from './publisher-data';

type PublisherMode = 'create' | 'edit';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const symbol = (name: string) => {
  const paths: Record<string, string> = {
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    link: '<path d="m10 13 4-4M8 15l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M16 9l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
    wallet: '<path d="M20 8V5H5a2 2 0 0 0 0 4h16v12H5a2 2 0 0 1-2-2V7"/><path d="M21 12h-5v5h5"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    arrow: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.settings}</svg>`;
};
const countryName = (code: string) => publisherCountries.find(country => country.code === code)?.name ?? 'Not selected';
const statusBadge = (status: string, extra = '') => `<span class="publisher-status publisher-status-${escape(status.toLowerCase())}" ${extra}><i></i>${escape(status || 'Not selected')}</span>`;
const formatDate = (value: string) => {
  if (!value) return 'Not saved yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
};
const field = (key: string, label: string, value: string, options: { required?: boolean; placeholder?: string; type?: string; help?: string; autocomplete?: string; full?: boolean } = {}) => `<div class="publisher-field field${options.full ? ' full' : ''}"><label for="publisher-${key}" class="form-label">${label}${options.required ? ' <b aria-hidden="true">*</b>' : ''}</label><input class="form-control" id="publisher-${key}" name="${key}" data-publisher-field="${key}" value="${escape(value)}" type="${options.type ?? 'text'}" placeholder="${escape(options.placeholder ?? `${label} (Optional)`)}" ${options.required ? 'required' : ''} autocomplete="${options.autocomplete ?? 'off'}" aria-describedby="publisher-${key}-error${options.help ? ` publisher-${key}-help` : ''}"/>${options.help ? `<small id="publisher-${key}-help">${options.help}</small>` : ''}<span class="publisher-field-error" id="publisher-${key}-error" data-publisher-error="${key}"></span></div>`;
const sectionTitle = (name: string, title: string, caption?: string) => `<div class="publisher-section-title"><span class="publisher-section-icon">${symbol(name)}</span><div><h3>${title}</h3>${caption ? `<p>${caption}</p>` : ''}</div></div>`;
const toggle = (key: string, label: string, checked: boolean, options: { help?: string; suffix?: string; disabled?: boolean } = {}) => `<label class="publisher-toggle switch-row" for="publisher-${key}${options.suffix ?? ''}"><span>${label}${options.help ? `<small>${options.help}</small>` : ''}</span><span class="switch"><input type="checkbox" role="switch" id="publisher-${key}${options.suffix ?? ''}" data-publisher-field="${key}" ${checked ? 'checked' : ''} ${options.disabled ? 'disabled' : ''}/><i class="switch-state" aria-hidden="true"></i></span></label>`;
const searchableSelect = (key: 'country' | 'status', label: string, value: string, choices: { value: string; label: string }[]) => `<div class="publisher-field field"><label for="publisher-${key}" class="form-label">${label} <b aria-hidden="true">*</b></label><div class="publisher-combobox" data-publisher-combo="${key}"><div class="publisher-combobox-input"><input class="form-control" id="publisher-${key}" name="${key}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="publisher-${key}-options" aria-describedby="publisher-${key}-error" value="${escape(choices.find(choice => choice.value === value)?.label ?? '')}" placeholder="Search ${key === 'country' ? 'countries' : 'account status'}" autocomplete="off" required/><span>${symbol('chevron')}</span></div><div class="publisher-combobox-options" id="publisher-${key}-options" role="listbox" aria-label="${label}" hidden>${choices.map((choice, index) => `<div id="publisher-${key}-option-${index}" role="option" aria-selected="${choice.value === value}" data-value="${escape(choice.value)}" data-label="${escape(choice.label)}">${escape(choice.label)}<span>${symbol('check')}</span></div>`).join('')}<p class="publisher-combo-empty" hidden>No matching ${key === 'country' ? 'countries' : 'statuses'}.</p></div></div><span class="publisher-field-error" id="publisher-${key}-error" data-publisher-error="${key}"></span></div>`;

export function PublisherBasicInfo(publisher: Publisher): string {
  return `<section class="publisher-form-section">${sectionTitle('user', 'Basic information', 'Contact and business details for this publisher.')}<div class="form-grid">${field('email', 'Email', publisher.email, { required: true, type: 'email', placeholder: 'Enter Email', autocomplete: 'email', help: 'Used for publisher communication and account access.' })}${field('name', 'Name', publisher.name, { required: true, placeholder: 'Enter Name', autocomplete: 'name' })}${field('phone', 'Phone', publisher.phone, { type: 'tel', placeholder: 'Enter Phone (Optional)', autocomplete: 'tel' })}${field('company', 'Company', publisher.company, { placeholder: 'Enter Company (Optional)', autocomplete: 'organization' })}${field('skype', 'Skype', publisher.skype, { placeholder: 'Enter Skype (Optional)' })}${field('taxId', 'Tax ID', publisher.taxId)}</div></section>`;
}

export function PublisherAccount(publisher: Publisher): string {
  return `<section class="publisher-form-section">${sectionTitle('shield', 'Account details', 'Set the country, account status and external reference.')}<div class="form-grid">${searchableSelect('country', 'Country', publisher.country, publisherCountries.map(country => ({ value: country.code, label: country.name })))}${searchableSelect('status', 'Account Status', publisher.status, publisherStatuses.map(status => ({ value: status, label: status })))}${field('referenceId', 'Reference ID', publisher.referenceId, { help: 'Optional external reference identifier.' })}${field('zipcode', 'Zipcode', publisher.zipcode, { autocomplete: 'postal-code' })}</div></section>`;
}

export function PublisherAddress(publisher: Publisher): string {
  return `<section class="publisher-form-section">${sectionTitle('pin', 'Address', 'Optional billing and location information.')}<div class="form-grid">${field('address', 'Address', publisher.address, { full: true, autocomplete: 'street-address', placeholder: 'Street address, building or suite (Optional)' })}${field('state', 'State', publisher.state, { autocomplete: 'address-level1' })}${field('city', 'City', publisher.city, { autocomplete: 'address-level2' })}</div></section>`;
}

export function PublisherNotificationSettings(publisher: Publisher): string {
  return `<section class="publisher-form-section publisher-notification-section">${sectionTitle('mail', 'Email notification')}<div class="publisher-email-row"><div><label class="publisher-checkbox publisher-checkbox-disabled"><input type="checkbox" id="publisher-notifyByEmail" data-publisher-field="notifyByEmail" disabled ${publisher.notifyByEmail ? 'checked' : ''}/>Notify this user by email</label><p>Email notification requires SMTP configuration.</p></div><button type="button" class="publisher-text-button" data-publisher-help="smtp">Configure SMTP ${symbol('chevron')}</button></div></section>`;
}

export function PublisherAdvancedSetup(publisher: Publisher): string {
  return `<section class="campaign-card publisher-advanced-card"><div class="publisher-advanced-heading"><div class="publisher-section-title"><span class="publisher-section-icon">${symbol('settings')}</span><div><h2>Advanced Setup</h2><p>Configure additional publisher-level tracking and access settings.</p></div></div><label class="publisher-advanced-switch" for="publisher-advancedSetup"><span data-advanced-state>${publisher.advancedSetup ? 'On' : 'Off'}</span><span class="switch"><input type="checkbox" role="switch" id="publisher-advancedSetup" data-publisher-field="advancedSetup" aria-controls="publisher-advanced-content" aria-expanded="${publisher.advancedSetup}" ${publisher.advancedSetup ? 'checked' : ''}/><i class="switch-state" aria-hidden="true"></i></span></label></div><div id="publisher-advanced-content" ${publisher.advancedSetup ? '' : 'hidden'}><button type="button" class="publisher-advanced-collapse" aria-expanded="true" aria-controls="publisher-advanced-groups">Configuration groups ${symbol('chevron')}</button><fieldset id="publisher-advanced-groups" class="publisher-advanced-groups" ${publisher.advancedSetup ? '' : 'disabled'}><section class="publisher-config-group">${sectionTitle('link', 'Tracking', 'Publisher tracking preferences')}${toggle('tracking.enabled', 'Publisher tracking configuration', publisher.tracking.enabled, { help: 'Enable additional publisher tracking options.' })}<div class="publisher-tracking-fields" ${publisher.tracking.enabled ? '' : 'hidden'}>${field('tracking.subIdParameter', 'Sub-ID parameter name', publisher.tracking.subIdParameter, { placeholder: 'e.g. sub_id', help: 'Optional parameter used for publisher sub-IDs.' })}<fieldset class="publisher-referral-options"><legend>Referral configuration</legend><label><input type="radio" name="publisher-referral" data-publisher-field="tracking.referralHandling" value="hide" ${publisher.tracking.referralHandling === 'hide' ? 'checked' : ''}/>Hide Referral</label><label><input type="radio" name="publisher-referral" data-publisher-field="tracking.referralHandling" value="custom" ${publisher.tracking.referralHandling === 'custom' ? 'checked' : ''}/>Use Custom Referral URL</label></fieldset><div class="publisher-referral-url" ${publisher.tracking.referralHandling === 'custom' ? '' : 'hidden'}>${field('tracking.referralUrl', 'Custom Referral URL', publisher.tracking.referralUrl, { required: true, type: 'url', placeholder: 'https://example.com', help: 'Use this URL as the referral/referrer value.' })}</div><p class="publisher-small-note" data-referral-help>Hide the referring URL/value from the destination.</p></div></section><section class="publisher-config-group">${sectionTitle('shield', 'Access', 'Account access preferences')}${toggle('access.panel', 'Publisher panel access', publisher.access.panel, { help: 'Allow access to the publisher panel.' })}${toggle('access.api', 'API access', publisher.access.api, { help: 'Allow access to publisher API features.' })}<p class="publisher-small-note">Preferences are stored with this local preview.</p></section><section class="publisher-config-group">${sectionTitle('wallet', 'Payout', 'Publisher payment preferences')}<dl class="publisher-placeholder-rows"><div><dt>Payout configuration</dt><dd><span class="publisher-muted-badge">Not configured</span></dd></div><div><dt>Payout status / settings</dt><dd><span class="publisher-muted-badge">Unavailable</span></dd></div></dl><p class="publisher-small-note">Payout settings will be available when payment configuration is connected.</p></section><section class="publisher-config-group">${sectionTitle('mail', 'Notifications', 'Publisher notification preferences')}${toggle('notifications.campaignUpdates', 'Campaign updates', publisher.notifications.campaignUpdates)}${toggle('notifications.conversionUpdates', 'Conversion updates', publisher.notifications.conversionUpdates)}<p class="publisher-small-note">Email delivery requires SMTP configuration.</p></section></fieldset></div></section>`;
}

export function PublisherSummary(publisher: Publisher): string {
  return `<section class="campaign-card publisher-summary"><div class="publisher-summary-identity"><span class="publisher-large-avatar" data-summary-initials>${escape(publisher.name.split(' ').filter(Boolean).slice(0, 2).map(part => part[0]).join('') || 'P')}</span><div><div class="publisher-summary-heading"><h2 data-summary-name>${escape(publisher.name || 'Unnamed publisher')}</h2><span data-summary-status>${statusBadge(publisher.status)}</span></div><p data-summary-email>${escape(publisher.email)}</p><span class="publisher-summary-id">Publisher ID: <strong data-summary-id>${publisher.id ?? '—'}</strong></span></div></div><dl class="publisher-summary-meta"><div><dt>Country</dt><dd data-summary-country>${escape(countryName(publisher.country))}</dd></div><div><dt>Created Date</dt><dd data-summary-created>${formatDate(publisher.createdAt)}</dd></div><div><dt>Last Updated</dt><dd data-summary-updated>${formatDate(publisher.updatedAt)}</dd></div></dl></section>`;
}

export function PublisherActivity(publisher: Publisher): string {
  return `<section class="campaign-card publisher-activity-card"><div class="publisher-card-heading"><h2>Activity</h2><span class="publisher-muted-badge">Demo timeline</span></div><div class="publisher-card-body"><ol class="publisher-timeline">${publisher.activity.length ? publisher.activity.map((item, index) => `<li><span class="publisher-timeline-dot${index === 0 ? ' current' : ''}">${symbol(index === 0 ? 'clock' : 'check')}</span><div><strong>${escape(item.title)}</strong><time>${formatDate(item.date)}</time></div></li>`).join('') : '<li><p>No demo activity available.</p></li>'}</ol><p class="publisher-small-note">Sample activity for this preview.</p></div></section>`;
}

export function PublisherSettings(publisher: Publisher): string {
  return `<section class="campaign-card publisher-settings-card"><div class="publisher-card-heading"><h2>Settings</h2><span class="publisher-muted-badge">Current form</span></div><div class="publisher-card-body"><div class="publisher-setting-status"><span>Account Status</span><button type="button" class="publisher-status-link" data-publisher-focus="status" aria-label="Change account status"><span data-settings-status>${statusBadge(publisher.status)}</span>${symbol('chevron')}</button></div>${toggle('access.panel', 'Panel Access', publisher.access.panel, { suffix: '-settings', disabled: !publisher.advancedSetup })}${toggle('access.api', 'API Access', publisher.access.api, { suffix: '-settings', disabled: !publisher.advancedSetup })}<div class="publisher-setting-status"><span>Email Notifications</span><span class="publisher-muted-badge">SMTP required</span></div><div class="publisher-setting-status"><span>Tracking Configuration</span><button type="button" class="publisher-text-button" data-publisher-focus="tracking"><span data-settings-tracking>${publisher.advancedSetup && publisher.tracking.enabled ? 'Configured' : 'Default'}</span>${symbol('chevron')}</button></div><p class="publisher-small-note" data-settings-help>${publisher.advancedSetup ? 'These controls stay in sync with Advanced Setup.' : 'Enable Advanced Setup to configure access and tracking.'}</p></div></section>`;
}

export function PublisherForm(publisher: Publisher, mode: PublisherMode): string {
  return `<form id="publisher-form" class="theme-form" novalidate><div class="publisher-editor-layout${mode === 'edit' ? ' publisher-editor-layout-edit' : ''}"><div class="publisher-main-column"><section class="campaign-card publisher-information-card"><div class="publisher-card-heading"><div><h2>Publisher Information</h2><p>To know more, <button type="button" class="publisher-inline-link" data-publisher-help="information">click here.</button></p></div><span class="publisher-required-hint"><b>*</b> Required fields</span></div><div class="publisher-card-body">${PublisherBasicInfo(publisher)}${PublisherAccount(publisher)}${PublisherAddress(publisher)}${PublisherNotificationSettings(publisher)}</div></section></div>${mode === 'edit' ? `<aside class="publisher-side-column" aria-label="Publisher account overview">${PublisherSettings(publisher)}${PublisherActivity(publisher)}</aside>` : ''}<div class="publisher-full-column">${PublisherAdvancedSetup(publisher)}</div></div><div id="publisher-form-message" class="publisher-form-message" role="status" aria-live="polite" tabindex="-1" hidden></div></form>`;
}

export function renderPublisherFormPage(publisher: Publisher, mode: PublisherMode): string {
  return `<div class="campaign-content publisher-page"><div class="page-intro publisher-page-intro"><div><p class="eyebrow">PUBLISHER MANAGEMENT</p><h1>${mode === 'edit' ? 'Edit Publisher' : 'Create Publisher'}</h1><p>${mode === 'edit' ? `Publisher ID: ${publisher.id} · Manage publisher information, access and preferences.` : 'Add a publisher and configure their account details and preferences.'}</p></div><div class="publisher-intro-actions"><span class="draft-badge" data-publisher-save-state>${mode === 'edit' ? 'Demo publisher' : 'Draft · Not saved'}</span>${mode === 'edit' ? `<div class="publisher-actions-dropdown"><button type="button" class="btn btn-outline" id="publisher-actions-button" aria-expanded="false" aria-controls="publisher-actions-menu">Actions ${symbol('chevron')}</button><div class="publisher-actions-menu" id="publisher-actions-menu" hidden><button type="button" data-publisher-focus="status">Change Status</button><button type="button" data-publisher-help="password">Reset Password<span>Unavailable</span></button><button type="button" data-publisher-help="invite">Send Invite<span>Unavailable</span></button><button type="button" class="publisher-danger-action" data-publisher-help="delete">Delete Publisher<span>Unavailable</span></button></div></div>` : ''}</div></div>${mode === 'edit' ? PublisherSummary(publisher) : ''}${PublisherForm(publisher, mode)}<dialog class="publisher-dialog" aria-labelledby="publisher-dialog-title"><div class="publisher-dialog-icon">${symbol('info')}</div><h2 id="publisher-dialog-title"></h2><p id="publisher-dialog-description"></p><button type="button" class="btn btn-primary" data-publisher-dialog-close>Got it</button></dialog></div><div class="publisher-action-bar"><p><span class="publisher-footer-dot"></span><span data-publisher-footer-state>Local preview · Changes stay in this browser session</span></p><div><a href="/publishers" class="btn btn-outline">Cancel</a><button type="submit" form="publisher-form" class="btn btn-primary" id="publisher-save"><span class="publisher-save-icon">${symbol('check')}</span><span data-publisher-save-label>${mode === 'edit' ? 'Save Changes' : 'SAVE'}</span></button></div></div>`;
}

export function bindPublisherFormPage(publisher: Publisher, mode: PublisherMode): void {
  const page = document.querySelector<HTMLElement>('.publisher-page')!;
  const form = page.querySelector<HTMLFormElement>('#publisher-form')!;
  const state: Publisher = structuredClone(publisher);
  const saveButton = document.querySelector<HTMLButtonElement>('#publisher-save')!;
  const message = page.querySelector<HTMLElement>('#publisher-form-message')!;
  let submitted = false;
  let saving = false;

  const setText = (selector: string, value: string) => page.querySelectorAll<HTMLElement>(selector).forEach(element => { element.textContent = value; });
  const readState = (key: string): string | boolean => {
    const [group, nested] = key.split('.');
    if (nested && (group === 'tracking' || group === 'access' || group === 'notifications')) return (state[group] as unknown as Record<string, string | boolean>)[nested];
    return (state as unknown as Record<string, string | boolean>)[key];
  };
  const writeState = (key: string, value: string | boolean) => {
    const [group, nested] = key.split('.');
    if (nested && (group === 'tracking' || group === 'access' || group === 'notifications')) (state[group] as unknown as Record<string, string | boolean>)[nested] = value;
    else if (key in state) (state as unknown as Record<string, string | boolean>)[key] = value;
  };
  const showMessage = (text: string, kind: 'error' | 'success') => {
    message.textContent = text;
    message.hidden = false;
    message.classList.toggle('is-error', kind === 'error');
  };
  const getErrors = (): Record<string, string> => validatePublisher(state) as Record<string, string>;
  const paintErrors = () => {
    const errors = submitted ? getErrors() : {};
    page.querySelectorAll<HTMLElement>('[data-publisher-error]').forEach(element => {
      const key = element.dataset.publisherError!;
      const error = errors[key] ?? errors[key.replace('tracking.', '')] ?? '';
      element.textContent = error;
      document.getElementById(`publisher-${key}`)?.setAttribute('aria-invalid', String(Boolean(error)));
    });
    return errors;
  };
  const sync = () => {
    page.querySelectorAll<HTMLInputElement>('[data-publisher-field]').forEach(input => {
      const value = readState(input.dataset.publisherField!);
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else if (input.type === 'radio') input.checked = input.value === value;
    });
    const advanced = page.querySelector<HTMLElement>('#publisher-advanced-content')!;
    advanced.hidden = !state.advancedSetup;
    page.querySelector<HTMLFieldSetElement>('#publisher-advanced-groups')!.disabled = !state.advancedSetup;
    page.querySelector<HTMLInputElement>('#publisher-advancedSetup')!.setAttribute('aria-expanded', String(state.advancedSetup));
    setText('[data-advanced-state]', state.advancedSetup ? 'On' : 'Off');
    const tracking = page.querySelector<HTMLElement>('.publisher-tracking-fields')!;
    tracking.hidden = !state.tracking.enabled;
    tracking.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = !state.advancedSetup || !state.tracking.enabled; });
    const custom = page.querySelector<HTMLElement>('.publisher-referral-url')!;
    custom.hidden = state.tracking.referralHandling !== 'custom';
    const referralInput = custom.querySelector<HTMLInputElement>('input')!;
    referralInput.disabled = !state.advancedSetup || !state.tracking.enabled || state.tracking.referralHandling !== 'custom';
    referralInput.required = !referralInput.disabled;
    setText('[data-referral-help]', state.tracking.referralHandling === 'hide' ? 'Hide the referring URL/value from the destination.' : 'A custom referral URL is required for this configuration.');
    page.querySelectorAll<HTMLInputElement>('.publisher-settings-card [data-publisher-field]').forEach(input => { input.disabled = !state.advancedSetup; });
    setText('[data-settings-tracking]', state.advancedSetup && state.tracking.enabled ? 'Configured' : 'Default');
    setText('[data-settings-help]', state.advancedSetup ? 'These controls stay in sync with Advanced Setup.' : 'Enable Advanced Setup to configure access and tracking.');
    setText('[data-summary-name]', state.name || 'Unnamed publisher');
    setText('[data-summary-email]', state.email || 'Email not entered');
    setText('[data-summary-initials]', state.name.split(' ').filter(Boolean).slice(0, 2).map(part => part[0]).join('') || 'P');
    setText('[data-summary-country]', countryName(state.country));
    page.querySelectorAll<HTMLElement>('[data-summary-status], [data-settings-status]').forEach(element => { element.innerHTML = statusBadge(state.status); });
    paintErrors();
  };
  const markDirty = () => {
    setText('[data-publisher-save-state]', 'Unsaved changes');
    const footerState = document.querySelector<HTMLElement>('[data-publisher-footer-state]');
    if (footerState) footerState.textContent = 'Unsaved changes · Local preview';
    if (!message.classList.contains('is-error')) message.hidden = true;
  };
  page.querySelectorAll<HTMLInputElement>('[data-publisher-field]').forEach(input => {
    const eventType = ['checkbox', 'radio'].includes(input.type) ? 'change' : 'input';
    input.addEventListener(eventType, () => {
      if (input.type === 'radio' && !input.checked) return;
      writeState(input.dataset.publisherField!, input.type === 'checkbox' ? input.checked : input.value);
      markDirty();
      sync();
    });
  });

  page.querySelectorAll<HTMLElement>('[data-publisher-combo]').forEach(combo => {
    const key = combo.dataset.publisherCombo as 'country' | 'status';
    const input = combo.querySelector<HTMLInputElement>('input')!;
    const listbox = combo.querySelector<HTMLElement>('[role="listbox"]')!;
    const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
    let active = -1;
    const visibleOptions = () => options.filter(option => !option.hidden);
    const close = () => { listbox.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    const highlight = (index: number) => {
      const visible = visibleOptions();
      active = Math.max(0, Math.min(index, visible.length - 1));
      options.forEach(option => option.classList.remove('is-highlighted'));
      if (visible[active]) {
        visible[active].classList.add('is-highlighted');
        input.setAttribute('aria-activedescendant', visible[active].id);
        visible[active].scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    };
    const open = (filter = false) => {
      const query = filter ? input.value.trim().toLowerCase() : '';
      options.forEach(option => {
        option.hidden = !option.dataset.label!.toLowerCase().includes(query);
        option.setAttribute('aria-selected', String(option.dataset.value === state[key]));
      });
      listbox.querySelector<HTMLElement>('.publisher-combo-empty')!.hidden = visibleOptions().length > 0;
      listbox.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      active = -1;
      options.forEach(option => option.classList.remove('is-highlighted'));
    };
    const selectOption = (option: HTMLElement) => {
      input.value = option.dataset.label!;
      if (key === 'country') state.country = option.dataset.value!;
      else state.status = option.dataset.value as PublisherStatus;
      markDirty(); sync(); close();
    };
    input.addEventListener('focus', () => { open(); input.select(); });
    input.addEventListener('click', () => { if (listbox.hidden) open(); });
    input.addEventListener('input', () => {
      const exact = options.find(option => option.dataset.label!.toLowerCase() === input.value.trim().toLowerCase());
      if (key === 'country') state.country = exact?.dataset.value ?? '';
      else state.status = (exact?.dataset.value ?? '') as PublisherStatus;
      open(true); markDirty(); sync();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key === 'Tab') { close(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (listbox.hidden) open();
        highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (!listbox.hidden && event.key === 'Enter') {
        event.preventDefault(); const selected = visibleOptions()[active]; if (selected) selectOption(selected);
      } else if (!listbox.hidden && (event.key === 'Home' || event.key === 'End') && active >= 0) {
        event.preventDefault(); highlight(event.key === 'Home' ? 0 : visibleOptions().length - 1);
      }
    });
    options.forEach(option => {
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => selectOption(option));
    });
    input.addEventListener('blur', close);
  });

  page.querySelector('.publisher-advanced-collapse')?.addEventListener('click', event => {
    const trigger = event.currentTarget as HTMLButtonElement;
    const groups = page.querySelector<HTMLElement>('#publisher-advanced-groups')!;
    groups.hidden = !groups.hidden;
    trigger.setAttribute('aria-expanded', String(!groups.hidden));
  });
  const actionButton = page.querySelector<HTMLButtonElement>('#publisher-actions-button');
  const actionMenu = page.querySelector<HTMLElement>('#publisher-actions-menu');
  const closeActions = () => { if (actionMenu && actionButton) { actionMenu.hidden = true; actionButton.setAttribute('aria-expanded', 'false'); } };
  actionButton?.addEventListener('click', () => { actionMenu!.hidden = !actionMenu!.hidden; actionButton.setAttribute('aria-expanded', String(!actionMenu!.hidden)); });
  page.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('.publisher-actions-dropdown')) closeActions(); });
  page.addEventListener('keydown', event => { if (event.key === 'Escape' && actionMenu && !actionMenu.hidden) { closeActions(); actionButton?.focus(); } });
  page.querySelectorAll<HTMLButtonElement>('[data-publisher-focus]').forEach(button => button.addEventListener('click', () => {
    closeActions();
    if (button.dataset.publisherFocus === 'status') page.querySelector<HTMLInputElement>('#publisher-status')?.focus();
    else {
      page.querySelector<HTMLInputElement>('#publisher-advancedSetup')?.focus();
      page.querySelector<HTMLElement>('.publisher-advanced-card')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }));

  const help: Record<string, { title: string; description: string }> = {
    smtp: { title: 'Configure SMTP', description: 'SMTP is not configured in this preview. Email notifications and invitations will be available after an administrator connects an email delivery service.' },
    information: { title: 'Publisher information', description: 'Enter the publisher’s contact and account details. Email, name, country and account status are required. Advanced Setup contains optional tracking, access and notification preferences.' },
    password: { title: 'Reset Password unavailable', description: 'Password reset requires a connected account service. No password was changed and no email was sent.' },
    invite: { title: 'Send Invite unavailable', description: 'Invitations require a connected account service and SMTP configuration. No invitation was sent.' },
    delete: { title: 'Delete Publisher unavailable', description: 'Deleting a publisher requires a connected publisher service. This preview has not deleted or changed the publisher.' },
  };
  const dialog = page.querySelector<HTMLDialogElement>('.publisher-dialog')!;
  page.querySelectorAll<HTMLButtonElement>('[data-publisher-help]').forEach(button => button.addEventListener('click', () => {
    closeActions();
    const content = help[button.dataset.publisherHelp!]!;
    setText('#publisher-dialog-title', content.title);
    setText('#publisher-dialog-description', content.description);
    dialog.showModal();
  }));
  dialog.querySelector('[data-publisher-dialog-close]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    submitted = true;
    const errors = paintErrors();
    if (Object.keys(errors).length) {
      showMessage('Please review the highlighted fields before saving.', 'error');
      const groups = page.querySelector<HTMLElement>('#publisher-advanced-groups')!;
      if (Object.keys(errors).some(key => key.startsWith('tracking.') || key === 'referralUrl' || key === 'subIdParameter')) {
        groups.hidden = false;
        page.querySelector('.publisher-advanced-collapse')?.setAttribute('aria-expanded', 'true');
      }
      form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    saving = true;
    saveButton.disabled = true;
    saveButton.classList.add('is-loading');
    form.setAttribute('aria-busy', 'true');
    saveButton.querySelector<HTMLElement>('[data-publisher-save-label]')!.textContent = 'Saving…';
    try {
      await storePublisherPreview(state);
      showMessage('Publisher saved locally for this browser session. No account was provisioned or email sent.', 'success');
      setText('[data-publisher-save-state]', 'Saved locally');
      setText('[data-summary-id]', String(state.id ?? '—'));
      setText('[data-summary-created]', formatDate(state.createdAt));
      setText('[data-summary-updated]', formatDate(state.updatedAt));
      const footerState = document.querySelector<HTMLElement>('[data-publisher-footer-state]');
      if (footerState) footerState.textContent = 'Saved locally · This browser session';
    } catch {
      showMessage('The local preview could not be saved. Your changes are still in the form; please try again.', 'error');
    } finally {
      saving = false;
      saveButton.disabled = false;
      saveButton.classList.remove('is-loading');
      form.removeAttribute('aria-busy');
      saveButton.querySelector<HTMLElement>('[data-publisher-save-label]')!.textContent = mode === 'edit' ? 'Save Changes' : 'SAVE';
    }
  });
  sync();
}
