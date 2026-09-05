import { appIcon } from './app-shell';
import { accountField, accountCombo, accountSwitch, accountFieldId, escapeHtml, type AccountFieldOptions } from './account-form-controls';
import { advertiserCountries, advertiserCurrencies, advertiserStatuses, storeAdvertiserPreview, validateAdvertiser, type Advertiser, type AdvertiserStatus } from './advertiser-data';
import './publisher-form.css';
import './advertiser-form.css';

type Mode = 'create' | 'edit';
type StringKey = { [K in keyof Advertiser]: Advertiser[K] extends string ? K : never }[keyof Advertiser];
const id = (key: string) => accountFieldId('adv', key);
const countries = advertiserCountries.map(country => ({ value: country.code, label: country.name }));
const statuses = advertiserStatuses.map(status => ({ value: status, label: status }));
const countryName = (code: string) => advertiserCountries.find(country => country.code === code)?.name ?? code;
const dateLabel = (value: string) => value && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value)) : 'Not saved yet';
const badge = (status: string) => `<span class="pub-badge pub-badge-${escapeHtml(status.toLowerCase())}"><i aria-hidden="true"></i>${escapeHtml(status || 'Not selected')}</span>`;
const field = (advertiser: Advertiser, key: StringKey, label: string, options: AccountFieldOptions = {}) => accountField('adv', key, label, advertiser[key], { placeholder: `Enter ${label} (Optional)`, ...options });
const toggle = (key: string, label: string, checked: boolean, help = '') => accountSwitch('adv', key, label, checked, help);
const cardHeading = (title: string, icon: string, subtitle = '', accessory = '') => `<div class="pub-card-heading"><div><h2><span class="pub-heading-icon">${appIcon(icon)}</span>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${accessory}</div>`;
const selectField = (key: string, label: string, value: string, values: Array<{ value: string; label: string }>, help = '') => `<div class="pub-field"><label for="${id(key)}">${label}</label><select id="${id(key)}" data-adv-field="${key}" aria-describedby="${id(key)}-help ${id(key)}-error">${values.map(option => `<option value="${escapeHtml(option.value)}" ${value === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select><small id="${id(key)}-help" ${help ? '' : 'hidden'}>${help}</small><span class="pub-field-error" id="${id(key)}-error" hidden></span></div>`;

export function AdvertiserBasicInfo(advertiser: Advertiser): string {
  return `<section class="pub-card" aria-label="Advertiser Information">${cardHeading('Advertiser Information', 'users', 'Contact information and advertiser account details.', '<span class="pub-required-note"><span>*</span> Required fields</span>')}<div class="pub-card-body">
    <fieldset class="pub-field-group"><legend>Contact information</legend><div class="pub-form-grid">${field(advertiser, 'name', 'Name', { required: true, placeholder: 'Enter Name', autocomplete: 'name' })}${field(advertiser, 'email', 'Email', { required: true, type: 'email', placeholder: 'Enter Email', autocomplete: 'email', help: 'Used for advertiser communication and account access.' })}${field(advertiser, 'phone', 'Phone', { type: 'tel', autocomplete: 'tel' })}${field(advertiser, 'advertiserManager', 'Advertiser Manager', { help: 'Optional manager reference; this does not assign live access.' })}</div></fieldset>
    <fieldset class="pub-field-group"><legend>Location & address</legend><div class="pub-form-grid">${field(advertiser, 'address', 'Address', { multiline: true, full: true })}${field(advertiser, 'state', 'State')}${field(advertiser, 'city', 'City')}${accountCombo('adv', 'country', 'Country', advertiser.country, countries)}${field(advertiser, 'zipcode', 'Zipcode', { autocomplete: 'postal-code' })}</div></fieldset>
    <fieldset class="pub-field-group pub-field-group-last"><legend>Account configuration</legend><div class="pub-form-grid">${accountCombo('adv', 'status', 'Account Status', advertiser.status, statuses)}${field(advertiser, 'referenceId', 'Reference ID', { help: 'Optional external reference identifier.' })}${field(advertiser, 'notes', 'Notes', { multiline: true, full: true, placeholder: 'Enter note message (Optional)', help: 'Internal notes saved with this advertiser preview.' })}</div></fieldset>
  </div></section>`;
}

export function AdvertiserBusinessInfo(advertiser: Advertiser): string {
  return `<fieldset class="pub-field-group"><legend>Business information</legend><div class="pub-form-grid">${field(advertiser, 'company', 'Business/Company Name')}${field(advertiser, 'taxId', 'Tax ID')}</div></fieldset>`;
}

export function AdvertiserBillingInfo(advertiser: Advertiser): string {
  return `<fieldset class="pub-field-group pub-field-group-last"><legend>Billing preferences</legend><div class="pub-form-grid">${field(advertiser, 'billingEmail', 'Billing Email', { type: 'email' })}${selectField('currency', 'Currency', advertiser.currency, [{ value: '', label: 'Not set' }, ...advertiserCurrencies.map(currency => ({ value: currency.code, label: `${currency.code} — ${currency.name}` }))])}${field(advertiser, 'billingAddress', 'Billing Address', { multiline: true, full: true })}${accountCombo('adv', 'billingCountry', 'Billing Country', advertiser.billingCountry, countries, false)}${field(advertiser, 'paymentTerms', 'Payment Terms', { placeholder: 'e.g. Net 30 (Optional)', help: 'A stored preference only; no billing agreement is applied.' })}</div></fieldset>`;
}

export function AdvertiserPostback(advertiser: Advertiser): string {
  return `<section class="pub-card adv-postback-card" id="advertiser-postback" aria-label="Advertiser PostBack">${cardHeading('Advertiser PostBack', 'link', 'Use this postback endpoint to send conversion events to AdstrackIO.', '<span class="adv-demo-token-badge">Demo configuration</span>')}<div class="pub-card-body">
    <div class="adv-postback-notice">${appIcon('shield')}<span>This preview does not provision endpoints or receive conversions. <strong>DEMO_ONLY</strong> tokens and <strong>example.invalid</strong> URLs are non-operational placeholders.</span></div>
    ${toggle('postbackEnabled', 'Postback Enabled', advertiser.postbackEnabled, 'Store an enabled preference for future integration; no delivery occurs.')}
    <div class="pub-field"><label for="adv-securityToken">Security Token</label><div class="adv-copy-row"><input id="adv-securityToken" readonly value="${escapeHtml(advertiser.securityToken)}" placeholder="Demo token appears after a local save" aria-describedby="adv-token-help"/><button type="button" class="btn btn-outline" data-adv-copy="securityToken" ${advertiser.securityToken ? '' : 'disabled'} aria-label="Copy security token">Copy</button></div><small id="adv-token-help">Read-only preview token. No real security credentials are created or regenerated.</small></div>
    <div class="adv-postback-field">${field(advertiser, 'postbackUrl', 'Postback URL', { multiline: true, placeholder: 'https://tracking.example.invalid/postback?click_id={click_id}', help: 'Editable configuration draft. Required only when Postback Enabled is on.' })}<button type="button" class="btn btn-outline adv-url-copy" data-adv-copy="postbackUrl" aria-label="Copy postback URL" ${advertiser.postbackUrl ? '' : 'disabled'}>Copy URL</button></div>
    ${field(advertiser, 'postbackValidation', 'Validation', { multiline: true, placeholder: 'e.g. Security Token (Optional when disabled)', help: 'Required when enabled. Stored as plain text; validation rules are not executed.' })}
    <div id="adv-postback-feedback" class="adv-postback-feedback" role="status" aria-live="polite" hidden></div>
    <div class="adv-postback-actions"><button type="button" class="btn btn-outline" id="adv-debug-postback">${appIcon('search')} Debug Postback</button><button type="submit" class="btn btn-primary" data-adv-submit>Save</button></div><p class="adv-postback-save-note">Save stores the complete advertiser form in this browser tab only.</p>
  </div></section>`;
}

export function AdvertiserAdvancedSetup(advertiser: Advertiser): string {
  return `<section class="pub-card pub-advanced-card" aria-label="Advanced Setup">${cardHeading('Advanced Setup', 'settings', 'Additional advertiser tracking, access, notifications and security preferences.', `<label class="pub-switch" for="adv-advancedSetup"><span class="pub-sr-only">Advanced Setup</span><input type="checkbox" role="switch" id="adv-advancedSetup" data-adv-field="advancedSetup" aria-controls="adv-advanced-content" aria-expanded="${advertiser.advancedSetup}" ${advertiser.advancedSetup ? 'checked' : ''}/><i aria-hidden="true"></i></label>`)}
    <div id="adv-advanced-content" ${advertiser.advancedSetup ? '' : 'hidden'}><fieldset id="adv-advanced-fields" class="pub-advanced-fields" ${advertiser.advancedSetup ? '' : 'disabled'}><legend class="pub-sr-only">Advanced advertiser preferences</legend><div class="pub-config-disclaimer">Preferences only. These controls do not change live tracking, access, email delivery or security.</div><div class="pub-advanced-grid">
      <section class="pub-config-group"><h3>${appIcon('link')} Tracking Settings</h3>${toggle('tracking.conversionTracking', 'Conversion tracking', advertiser.tracking.conversionTracking)}<a href="#advertiser-postback" class="pub-inline-link">Configure Advertiser PostBack ↑</a><div class="adv-config-selects">${selectField('tracking.redirectType', 'Redirect Type', advertiser.tracking.redirectType, ['Default', '301', '302'].map(value => ({ value, label: value })))}${accountField('adv', 'tracking.locale', 'Locale', advertiser.tracking.locale, { placeholder: 'e.g. en-IN (Optional)' })}</div></section>
      <section class="pub-config-group"><h3>${appIcon('shield')} Access Settings</h3>${toggle('access.panel', 'Advertiser panel access', advertiser.access.panel, 'A preference only; no permissions are granted.')}${toggle('access.api', 'API access', advertiser.access.api, 'No API key is generated.')}<button class="btn btn-outline" type="button" disabled title="Requires API integration">Generate API Key</button></section>
      <section class="pub-config-group"><h3>${appIcon('bell')} Notification Settings</h3>${toggle('notifications.email', 'Email notifications', advertiser.notifications.email)}${toggle('notifications.conversion', 'Conversion notifications', advertiser.notifications.conversion)}<p class="pub-config-muted">Preferences are stored locally. Email delivery requires SMTP and backend integration.</p></section>
      <section class="pub-config-group"><h3>${appIcon('shield')} Security</h3><dl class="pub-placeholder-rows"><div><dt>Security configuration</dt><dd>Not connected</dd></div><div><dt>Token management</dt><dd>Backend required</dd></div></dl><p class="pub-config-muted">Password resets, token regeneration and security policy enforcement are unavailable in this preview.</p></section>
      <section class="pub-config-group adv-global-pixel"><h3>${appIcon('image')} Global Pixel</h3><fieldset class="adv-pixel-options"><legend>Pixel format</legend><label><input type="radio" name="adv-pixel-type" data-adv-field="tracking.pixelType" value="image" ${advertiser.tracking.pixelType === 'image' ? 'checked' : ''}/> Image</label><label><input type="radio" name="adv-pixel-type" data-adv-field="tracking.pixelType" value="iframe" ${advertiser.tracking.pixelType === 'iframe' ? 'checked' : ''}/> Iframe</label></fieldset><label class="adv-pixel-code-label" for="adv-pixel-code">Code</label><textarea id="adv-pixel-code" readonly placeholder="Pixel code requires tracking integration." aria-describedby="adv-pixel-help"></textarea><p class="pub-config-muted" id="adv-pixel-help">Format preference only. No pixel or iframe is loaded, generated or executed.</p></section>
    </div></fieldset></div>
  </section>`;
}

export function AdvertiserNotificationSettings(): string {
  return `<section class="pub-card pub-notification-card" aria-label="Email notification"><div class="pub-notification-symbol">${appIcon('mail')}</div><div><h2>Email notification</h2><label class="pub-disabled-check"><input type="checkbox" disabled aria-describedby="adv-smtp-help"/>Notify this user by email <span class="pub-label-muted">SMTP unavailable</span></label><p id="adv-smtp-help">Email notification requires SMTP configuration.</p></div><button type="button" class="pub-text-button" id="adv-smtp-help-button">Configure SMTP ${appIcon('arrow')}</button></section>`;
}

export function AdvertiserSummary(advertiser: Advertiser): string {
  return `<section class="pub-card pub-summary-card" aria-label="Advertiser summary"><div class="pub-summary-identity"><span class="pub-summary-avatar" id="adv-summary-avatar" aria-hidden="true">${escapeHtml(advertiser.name.split(/\s+/).slice(0, 2).map(part => part[0]).join(''))}</span><div><div class="pub-summary-name-row"><h2 id="adv-summary-name">${escapeHtml(advertiser.name)}</h2><span id="adv-summary-status">${badge(advertiser.status)}</span></div><p id="adv-summary-email">${escapeHtml(advertiser.email)}</p><span class="pub-summary-id">Advertiser ID: ${advertiser.id} · Hash ID: ${escapeHtml(advertiser.hashId || 'Not assigned')}</span></div></div><dl><div><dt>Country</dt><dd id="adv-summary-country">${escapeHtml(countryName(advertiser.country))}</dd></div><div><dt>Currency</dt><dd id="adv-summary-currency">${escapeHtml(advertiser.currency || 'Not set')}</dd></div><div><dt>Created</dt><dd>${dateLabel(advertiser.createdAt)}</dd></div><div><dt>Last Updated</dt><dd id="adv-summary-updated">${dateLabel(advertiser.updatedAt)}</dd></div></dl></section>`;
}

export function AdvertiserActivity(advertiser: Advertiser): string {
  return `<section class="pub-card" aria-label="Activity">${cardHeading('Activity', 'clock', '', '<span class="pub-static-badge">Demo timeline</span>')}<ol class="pub-timeline">${advertiser.activity.length ? advertiser.activity.map((item, index) => `<li><span class="pub-timeline-dot ${index === 0 ? 'pub-timeline-dot-current' : ''}" aria-hidden="true"></span><strong>${escapeHtml(item.title)}</strong><time datetime="${escapeHtml(item.date)}">${dateLabel(item.date)}</time></li>`).join('') : '<li><span class="pub-timeline-dot" aria-hidden="true"></span><strong>No demo activity available</strong></li>'}</ol><p class="pub-rail-note">Static demo events, not a live audit log.</p></section>`;
}

export function AdvertiserSettings(advertiser: Advertiser): string {
  return `<section class="pub-card" aria-label="Advertiser Settings">${cardHeading('Advertiser Settings', 'settings')}<div class="pub-settings-body"><label class="pub-setting-status" for="adv-settings-status"><span>Account Status</span><select id="adv-settings-status">${advertiserStatuses.map(status => `<option ${status === advertiser.status ? 'selected' : ''}>${status}</option>`).join('')}</select></label><dl>${['Panel Access', 'API Access', 'Email Notifications', 'Postback Enabled', 'Conversion Notifications'].map((label, index) => `<div><dt>${label}</dt><dd id="adv-setting-${index}"></dd></div>`).join('')}</dl></div><p class="pub-rail-note">Reflects current form preferences only. Save Changes stores the local preview.</p></section>`;
}

export function AdvertiserForm(advertiser: Advertiser): string {
  return `${AdvertiserBasicInfo(advertiser)}<section class="pub-card" aria-label="Billing & Business">${cardHeading('Billing & Business', 'report', 'Optional business details and billing preferences.', '<span class="pub-required-note">Optional fields</span>')}<div class="pub-card-body">${AdvertiserBusinessInfo(advertiser)}${AdvertiserBillingInfo(advertiser)}</div></section>${AdvertiserPostback(advertiser)}${AdvertiserAdvancedSetup(advertiser)}${AdvertiserNotificationSettings()}`;
}

export function renderAdvertiserFormPage(advertiser: Advertiser, mode: Mode): string {
  const editing = mode === 'edit';
  return `<div class="publisher-page advertiser-page ${editing ? 'publisher-edit-page' : 'publisher-create-page'}"><div class="pub-page-intro"><div><p class="eyebrow">PARTNER MANAGEMENT</p><h1>${editing ? 'Edit Advertiser' : 'Create Advertiser'}</h1><p>${editing ? `Advertiser ID: ${advertiser.id} · Manage profile, billing and PostBack preferences.` : 'Add an advertiser profile and prepare their account configuration.'}</p></div>${editing ? `<div class="pub-actions"><button class="btn btn-outline" type="button" id="adv-actions-trigger" aria-expanded="false" aria-controls="adv-actions-menu">Actions ${appIcon('chevron')}</button><div class="pub-actions-menu" id="adv-actions-menu" hidden><button type="button" id="adv-change-status">${appIcon('settings')} Change Status</button><button type="button" disabled title="Requires account API integration">${appIcon('shield')} Reset Password</button><button type="button" disabled title="Requires SMTP and invitation integration">${appIcon('mail')} Send Invite</button><div class="pub-danger-action"><button type="button" disabled title="Requires account API integration">${appIcon('shield')} Suspend Advertiser</button><button type="button" disabled title="Requires account API integration">${appIcon('trash')} Delete Advertiser</button></div><small>Change Status edits this preview only. Live account actions are unavailable.</small></div></div>` : '<span class="pub-preview-pill">New advertiser</span>'}</div>
    <div class="pub-preview-notice">${appIcon('shield')}<div><strong>Frontend preview</strong><span>Saved in this browser tab only. No live account, billing, tracking or security settings are changed.</span></div></div>${editing ? AdvertiserSummary(advertiser) : ''}
    <div class="pub-form-feedback" id="adv-form-feedback" role="status" aria-live="polite" tabindex="-1" hidden></div>
    <form id="advertiser-form" novalidate><div class="pub-page-grid"><div class="pub-primary-column">${AdvertiserForm(advertiser)}</div>${editing ? `<aside class="pub-side-column" aria-label="Advertiser insights">${AdvertiserSettings(advertiser)}${AdvertiserActivity(advertiser)}</aside>` : ''}</div></form>
    <footer class="publisher-action-bar"><div class="pub-save-context"><span class="pub-save-icon">${appIcon('shield')}</span><span><strong id="adv-draft-state">${editing ? 'Advertiser preview' : 'Unsaved advertiser'}</strong><small>Local preview only · no events or email sent</small></span></div><div class="pub-footer-buttons"><a class="btn btn-outline" href="/advertisers">Cancel</a><button class="btn btn-primary pub-save-button" id="adv-save" data-adv-submit type="submit" form="advertiser-form">${appIcon('check')}<span>${editing ? 'Save Changes' : 'SAVE'}</span></button></div></footer>
    <dialog class="pub-help-dialog" id="adv-help-dialog" aria-labelledby="adv-help-title"><div class="pub-dialog-heading"><span class="pub-heading-icon">${appIcon('help')}</span><button type="button" class="pub-icon-button" id="adv-help-close" aria-label="Close help">${appIcon('close')}</button></div><h2 id="adv-help-title"></h2><p id="adv-help-description"></p><button type="button" class="btn btn-primary" id="adv-help-done">Got it</button></dialog>
  </div>`;
}

export function bindAdvertiserFormPage(advertiser: Advertiser, mode: Mode): void {
  const root = document.querySelector<HTMLElement>('.advertiser-page')!;
  const form = document.querySelector<HTMLFormElement>('#advertiser-form')!;
  const draft: Advertiser = JSON.parse(JSON.stringify(advertiser));
  draft.notifyByEmail = false;
  const feedback = document.querySelector<HTMLElement>('#adv-form-feedback')!;
  const postbackFeedback = document.querySelector<HTMLElement>('#adv-postback-feedback')!;
  let submitted = false;
  let saving = false;
  let dirty = false;
  function message(text: string, error = false) {
    feedback.textContent = text;
    feedback.hidden = false;
    feedback.classList.toggle('pub-feedback-error', error);
  }
  function showErrors() {
    const errors = validateAdvertiser(draft);
    root.querySelectorAll<HTMLElement>('.pub-field-error').forEach(element => { element.textContent = ''; element.hidden = true; });
    root.querySelectorAll('[aria-invalid]').forEach(element => element.removeAttribute('aria-invalid'));
    for (const [key, error] of Object.entries(errors)) {
      document.getElementById(id(key))?.setAttribute('aria-invalid', 'true');
      const target = document.getElementById(`${id(key)}-error`);
      if (target) { target.textContent = error; target.hidden = false; }
    }
    return errors;
  }
  function sync() {
    document.querySelector<HTMLElement>('#adv-advanced-content')!.hidden = !draft.advancedSetup;
    document.querySelector<HTMLFieldSetElement>('#adv-advanced-fields')!.disabled = !draft.advancedSetup;
    document.querySelector('#adv-advancedSetup')!.setAttribute('aria-expanded', String(draft.advancedSetup));
    for (const key of ['postbackUrl', 'postbackValidation']) {
      const input = document.getElementById(id(key)) as HTMLTextAreaElement;
      input.required = draft.postbackEnabled;
      const label = root.querySelector(`label[for="${id(key)}"]`)!;
      label.innerHTML = `${key === 'postbackUrl' ? 'Postback URL' : 'Validation'}${draft.postbackEnabled ? '<span class="pub-required"> *</span>' : ''}`;
    }
    root.querySelectorAll<HTMLButtonElement>('[data-adv-copy]').forEach(button => button.disabled = !draft[button.dataset.advCopy as 'postbackUrl' | 'securityToken'].trim());
    document.querySelector<HTMLInputElement>('#adv-securityToken')!.value = draft.securityToken;
    if (mode === 'edit') {
      document.querySelector('#adv-summary-name')!.textContent = draft.name.trim() || 'Unnamed advertiser';
      document.querySelector('#adv-summary-avatar')!.textContent = draft.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('') || 'A';
      document.querySelector('#adv-summary-email')!.textContent = draft.email || 'No email entered';
      document.querySelector('#adv-summary-country')!.textContent = countryName(draft.country) || 'Not selected';
      document.querySelector('#adv-summary-currency')!.textContent = draft.currency || 'Not set';
      document.querySelector('#adv-summary-status')!.innerHTML = badge(draft.status);
      document.querySelector<HTMLSelectElement>('#adv-settings-status')!.value = draft.status;
      const values = [draft.advancedSetup ? (draft.access.panel ? 'Enabled preference' : 'Disabled') : 'Default', draft.advancedSetup ? (draft.access.api ? 'Enabled preference' : 'Disabled') : 'Default', draft.advancedSetup && draft.notifications.email ? 'SMTP required' : 'Off', draft.postbackEnabled ? 'Preview enabled' : 'Off', draft.advancedSetup && draft.notifications.conversion ? 'Preference on' : 'Off'];
      values.forEach((value, index) => document.querySelector(`#adv-setting-${index}`)!.innerHTML = `<span class="pub-neutral-pill">${value}</span>`);
    }
    document.querySelector('#adv-draft-state')!.textContent = dirty ? 'Unsaved changes' : mode === 'edit' ? 'Advertiser preview' : 'Unsaved advertiser';
  }
  function changed() { dirty = true; feedback.hidden = true; postbackFeedback.hidden = true; sync(); if (submitted) showErrors(); }
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-adv-field]').forEach(control => {
    const changeEvent = control instanceof HTMLSelectElement || control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type) ? 'change' : 'input';
    control.addEventListener(changeEvent, () => {
      const key = control.dataset.advField!;
      if (control instanceof HTMLInputElement && control.type === 'radio' && !control.checked) return;
      const value = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value;
      const [group, subkey] = key.split('.');
      if (subkey && ['access', 'tracking', 'notifications'].includes(group)) (draft[group as 'access' | 'tracking' | 'notifications'] as unknown as Record<string, string | boolean>)[subkey] = value;
      else (draft as unknown as Record<string, string | boolean>)[key] = value;
      changed();
    });
  });
  const choices = { country: countries, status: statuses, billingCountry: countries };
  root.querySelectorAll<HTMLInputElement>('[data-adv-combo]').forEach(input => {
    const key = input.dataset.advCombo as keyof typeof choices;
    const list = input.closest('.pub-combo')!.querySelector<HTMLElement>('[role="listbox"]')!;
    let filtered = choices[key];
    let active = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    const render = (search: string) => {
      filtered = choices[key].filter(option => option.label.toLowerCase().includes(search.toLowerCase()) || option.value.toLowerCase() === search.toLowerCase());
      list.innerHTML = filtered.length ? filtered.map((option, index) => `<div role="option" id="${input.id}-option-${index}" data-adv-option="${escapeHtml(option.value)}" aria-selected="${draft[key] === option.value}">${escapeHtml(option.label)}${draft[key] === option.value ? appIcon('check') : ''}</div>`).join('') : '<div class="pub-combo-empty">No matching options</div>';
      list.hidden = false; input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant'); active = -1;
    };
    const choose = (value: string) => {
      const option = choices[key].find(item => item.value === value);
      if (!option) return;
      (draft as unknown as Record<string, string>)[key] = value; input.value = option.label; close(); changed();
    };
    input.addEventListener('focus', () => render(''));
    input.addEventListener('click', () => { if (list.hidden) render(''); });
    input.addEventListener('input', () => {
      const text = input.value.trim();
      const choice = choices[key].find(option => option.label.toLowerCase() === text.toLowerCase());
      (draft as unknown as Record<string, string>)[key] = choice?.value ?? (key === 'billingCountry' ? text : ''); changed(); render(text);
    });
    list.addEventListener('mousedown', event => event.preventDefault());
    list.addEventListener('click', event => { const option = (event.target as HTMLElement).closest<HTMLElement>('[data-adv-option]'); if (option) choose(option.dataset.advOption!); });
    input.addEventListener('blur', close);
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (list.hidden) render('');
        active = filtered.length ? (active < 0 ? (event.key === 'ArrowDown' ? 0 : filtered.length - 1) : (active + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length) : -1;
        list.querySelectorAll<HTMLElement>('[role="option"]').forEach((option, index) => option.classList.toggle('pub-option-focused', index === active));
        if (active >= 0) { const option = list.children[active] as HTMLElement; input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
      } else if (event.key === 'Enter' && !list.hidden) { event.preventDefault(); if (active >= 0) choose(filtered[active].value); else if (filtered.length === 1) choose(filtered[0].value); else close(); }
    });
  });
  document.querySelector<HTMLSelectElement>('#adv-settings-status')?.addEventListener('change', event => { draft.status = (event.target as HTMLSelectElement).value as AdvertiserStatus; document.querySelector<HTMLInputElement>('#adv-status')!.value = draft.status; changed(); });
  const actions = document.querySelector<HTMLElement>('#adv-actions-menu');
  const trigger = document.querySelector<HTMLButtonElement>('#adv-actions-trigger');
  const closeActions = () => { if (actions) actions.hidden = true; trigger?.setAttribute('aria-expanded', 'false'); };
  trigger?.addEventListener('click', () => { actions!.hidden = !actions!.hidden; trigger.setAttribute('aria-expanded', String(!actions!.hidden)); });
  document.querySelector('#adv-change-status')?.addEventListener('click', () => { closeActions(); document.querySelector<HTMLInputElement>('#adv-status')!.focus(); });
  root.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('.pub-actions')) closeActions(); });
  root.addEventListener('focusout', event => { if ((event.target as HTMLElement).closest('.pub-actions') && !(event.relatedTarget as HTMLElement | null)?.closest('.pub-actions')) closeActions(); });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && actions && !actions.hidden) { closeActions(); trigger?.focus(); } });

  const dialog = document.querySelector<HTMLDialogElement>('#adv-help-dialog')!;
  const openDialog = (title: string, description: string) => { document.querySelector('#adv-help-title')!.textContent = title; document.querySelector('#adv-help-description')!.textContent = description; dialog.showModal(); };
  document.querySelector('#adv-smtp-help-button')!.addEventListener('click', () => openDialog('SMTP configuration unavailable', 'This preview has no connected SMTP service. Notifications and invitations require backend email configuration. No email is sent from this form.'));
  document.querySelector('#adv-debug-postback')!.addEventListener('click', () => {
    const candidate = { ...draft, postbackEnabled: true };
    const errors = validateAdvertiser(candidate);
    const issues = [errors.postbackUrl, errors.postbackValidation].filter(Boolean);
    openDialog('Debug Postback · local check', issues.length ? `${issues.join(' ')} No request was sent. This check only inspects the URL format and whether Validation is filled; it cannot verify an endpoint, token, delivery or conversion.` : 'URL format and required configuration are valid locally. No request was sent. Token authenticity, Validation rules, endpoint availability, delivery and conversion processing have not been checked.');
  });
  document.querySelector('#adv-help-close')!.addEventListener('click', () => dialog.close());
  document.querySelector('#adv-help-done')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  root.querySelectorAll<HTMLButtonElement>('[data-adv-copy]').forEach(button => button.addEventListener('click', async () => {
    const key = button.dataset.advCopy as 'postbackUrl' | 'securityToken';
    if (!draft[key]) return;
    try { await navigator.clipboard.writeText(draft[key]); postbackFeedback.textContent = `${key === 'securityToken' ? 'Demo security token' : 'Postback URL'} copied. No request was sent.`; }
    catch { const input = document.getElementById(id(key)) as HTMLInputElement | HTMLTextAreaElement; input.focus(); input.select(); postbackFeedback.textContent = 'Clipboard is unavailable. The value is selected; use your keyboard to copy it.'; }
    postbackFeedback.hidden = false;
  }));
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return; submitted = true;
    const errors = showErrors();
    if (Object.keys(errors).length) { message('Please check the highlighted fields before saving.', true); root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); return; }
    saving = true;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-adv-submit]')];
    const labels = buttons.map(button => button.innerHTML);
    buttons.forEach(button => { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Saving…'; });
    try {
      await storeAdvertiserPreview(draft); dirty = false;
      if (mode === 'create') { window.location.assign(`/advertisers/${draft.id}/edit?preview=created`); return; }
      document.querySelector<HTMLTextAreaElement>('#adv-postbackUrl')!.value = draft.postbackUrl;
      sync(); document.querySelector('#adv-summary-updated')!.textContent = dateLabel(draft.updatedAt);
      document.querySelector('#adv-draft-state')!.textContent = 'Preview saved';
      message(`Advertiser #${draft.id} updated in this browser tab only. No live account was changed, and no email or conversion event was sent.`); feedback.focus();
    } catch (error) { message(error instanceof Error ? error.message : 'The local preview could not be saved.', true); feedback.focus(); }
    finally { saving = false; buttons.forEach((button, index) => { button.disabled = mode === 'create' && draft.id !== null; button.removeAttribute('aria-busy'); button.innerHTML = labels[index]; }); }
  });
  sync();
  if (mode === 'edit' && new URLSearchParams(location.search).get('preview') === 'created') { message(`Advertiser #${draft.id} was saved as a local preview. The token and example.invalid endpoint are demo placeholders only.`); history.replaceState(null, '', location.pathname + location.hash); }
  if (location.hash === '#advertiser-postback') document.getElementById('advertiser-postback')?.scrollIntoView({ block: 'start' });
}
