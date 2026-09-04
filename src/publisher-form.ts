import { appIcon } from './app-shell';
import { accountCombo, accountField, accountFieldId, accountSwitch, escapeHtml } from './account-form-controls';
import { publisherCountries, publisherStatuses, storePublisherPreview, validatePublisher, type Publisher, type PublisherStatus } from './publisher-data';
import './publisher-form.css';

type FormMode = 'create' | 'edit';
type TextField = 'email' | 'name' | 'phone' | 'company' | 'skype' | 'address' | 'state' | 'city' | 'zipcode' | 'taxId' | 'referenceId';
const fieldId = (field: string) => accountFieldId('pub', field);
const formatDate = (date: string) => date && !Number.isNaN(Date.parse(date)) ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(date)) : 'Not saved yet';
const countryLabel = (code: string) => publisherCountries.find(country => country.code === code)?.name ?? code;
const badge = (status: string) => `<span class="pub-badge pub-badge-${escapeHtml(status.toLowerCase())}"><i aria-hidden="true"></i>${escapeHtml(status)}</span>`;

function textField(publisher: Publisher, key: TextField, label: string, placeholder = '', required = false, type = 'text', help = '', full = false): string {
  return accountField('pub', key, label, publisher[key], {
    placeholder, required, type, help, full, multiline: key === 'address',
    autocomplete: key === 'phone' ? 'tel' : key === 'email' ? 'email' : key === 'name' ? 'name' : undefined,
  });
}

function combo(field: 'country' | 'status', label: string, value: string, options: Array<{value: string; label: string}>): string {
  return accountCombo('pub', field, label, value, options);
}

function switchControl(key: string, label: string, checked: boolean, help = ''): string {
  return accountSwitch('pub', key, label, checked, help);
}

export function PublisherBasicInfo(publisher: Publisher): string {
  return `<fieldset class="pub-field-group"><legend><span class="pub-section-icon">${appIcon('users')}</span>Contact information</legend><div class="pub-form-grid">${textField(publisher, 'email', 'Email', 'Enter Email', true, 'email', 'Used for publisher communication and account access.')}${textField(publisher, 'name', 'Name', 'Enter Name', true)}${textField(publisher, 'phone', 'Phone', 'Enter Phone (Optional)', false, 'tel')}${textField(publisher, 'company', 'Company', 'Enter Company (Optional)')}${textField(publisher, 'skype', 'Skype', 'Enter Skype (Optional)')}${textField(publisher, 'taxId', 'Tax ID', 'Enter Tax ID (Optional)')}</div></fieldset>`;
}

export function PublisherAddress(publisher: Publisher): string {
  return `<fieldset class="pub-field-group"><legend><span class="pub-section-icon">${appIcon('globe')}</span>Location & address</legend><div class="pub-form-grid">${textField(publisher, 'address', 'Address', 'Enter Address (Optional)', false, 'text', '', true)}${textField(publisher, 'state', 'State', 'Enter State (Optional)')}${textField(publisher, 'city', 'City', 'Enter City (Optional)')}${combo('country', 'Country', publisher.country, publisherCountries.map(country => ({ value: country.code, label: country.name })))}${textField(publisher, 'zipcode', 'Zipcode', 'Enter Zipcode (Optional)')}</div></fieldset>`;
}

export function PublisherAccount(publisher: Publisher): string {
  return `<fieldset class="pub-field-group pub-field-group-last"><legend><span class="pub-section-icon">${appIcon('shield')}</span>Account configuration</legend><div class="pub-form-grid">${combo('status', 'Account Status', publisher.status, publisherStatuses.map(status => ({ value: status, label: status })))}${textField(publisher, 'referenceId', 'Reference ID', 'Enter Reference ID (Optional)', false, 'text', 'Optional external reference identifier.')}</div></fieldset>`;
}

export function PublisherAdvancedSetup(publisher: Publisher): string {
  return `<section class="pub-card pub-advanced-card" aria-labelledby="pub-advanced-heading"><div class="pub-card-heading"><div><h2 id="pub-advanced-heading"><span class="pub-heading-icon">${appIcon('settings')}</span>Advanced Setup</h2><p>Configure additional publisher-level tracking and access settings.</p></div><label class="pub-switch" for="pub-advancedSetup"><span class="pub-sr-only">Advanced Setup</span><input id="pub-advancedSetup" data-pub-field="advancedSetup" type="checkbox" role="switch" aria-controls="pub-advanced-content" aria-expanded="${publisher.advancedSetup}" ${publisher.advancedSetup ? 'checked' : ''}/><i aria-hidden="true"></i></label></div>
    <div id="pub-advanced-content" ${publisher.advancedSetup ? '' : 'hidden'}><fieldset id="pub-advanced-fields" class="pub-advanced-fields" ${publisher.advancedSetup ? '' : 'disabled'}><legend class="pub-sr-only">Advanced publisher configuration</legend><div class="pub-config-disclaimer">Configuration preview only. These preferences do not change live tracking, payouts or account permissions.</div><div class="pub-advanced-grid">
      <section class="pub-config-group"><h3>${appIcon('link')} Tracking</h3>${switchControl('tracking.enabled', 'Publisher tracking', publisher.tracking.enabled, 'Prepare publisher-level tracking preferences.')}<fieldset class="pub-tracking-fields" id="pub-tracking-fields" ${publisher.tracking.enabled ? '' : 'disabled'}><legend class="pub-sr-only">Tracking preferences</legend><div class="pub-field"><label for="pub-tracking-subIdParameter">Sub-ID parameter</label><input id="pub-tracking-subIdParameter" data-pub-field="tracking.subIdParameter" value="${escapeHtml(publisher.tracking.subIdParameter)}" placeholder="e.g. sub_id" aria-describedby="pub-tracking-subIdParameter-error"/><span class="pub-field-error" id="pub-tracking-subIdParameter-error" hidden></span></div><div class="pub-field"><label for="pub-tracking-referralHandling">Referral handling</label><select id="pub-tracking-referralHandling" data-pub-field="tracking.referralHandling"><option value="hide" ${publisher.tracking.referralHandling === 'hide' ? 'selected' : ''}>Hide Referral</option><option value="custom" ${publisher.tracking.referralHandling === 'custom' ? 'selected' : ''}>Use Custom Referral URL</option></select></div><div class="pub-field" id="pub-custom-referral-field" ${publisher.tracking.referralHandling === 'custom' ? '' : 'hidden'}><label for="pub-tracking-referralUrl">Custom Referral URL<span class="pub-required"> *</span></label><input id="pub-tracking-referralUrl" type="url" data-pub-field="tracking.referralUrl" value="${escapeHtml(publisher.tracking.referralUrl)}" placeholder="https://example.com" aria-describedby="pub-tracking-referralUrl-help pub-tracking-referralUrl-error"/><small id="pub-tracking-referralUrl-help">Proposed referrer value; applying it requires future tracking integration.</small><span class="pub-field-error" id="pub-tracking-referralUrl-error" hidden></span></div></fieldset></section>
      <section class="pub-config-group"><h3>${appIcon('shield')} Access</h3>${switchControl('access.panel', 'Publisher panel access', publisher.access.panel, 'Allow publisher panel access when integrated.')}${switchControl('access.api', 'API access', publisher.access.api, 'Save an API access preference; no key is issued.')}<div class="pub-config-muted">No live access permissions are changed.</div></section>
      <section class="pub-config-group"><h3>${appIcon('report')} Payout</h3><dl class="pub-placeholder-rows"><div><dt>Payout configuration</dt><dd>Not connected</dd></div><div><dt>Payout status</dt><dd>Not configured</dd></div></dl><p class="pub-config-muted">Payout methods, terms and balances will be available after the payout integration is connected.</p></section>
      <section class="pub-config-group"><h3>${appIcon('bell')} Notifications</h3>${switchControl('notifications.campaignUpdates', 'Campaign updates', publisher.notifications.campaignUpdates)}${switchControl('notifications.conversionUpdates', 'Conversion updates', publisher.notifications.conversionUpdates)}<div class="pub-config-muted">Saved as preferences only. Delivery requires SMTP and backend integration.</div></section>
    </div></fieldset></div>
  </section>`;
}

export function PublisherNotificationSettings(): string {
  return `<section class="pub-card pub-notification-card" aria-labelledby="pub-notification-heading"><div class="pub-notification-symbol">${appIcon('mail')}</div><div><h2 id="pub-notification-heading">Email notification</h2><label class="pub-disabled-check"><input type="checkbox" disabled aria-describedby="pub-smtp-help"/>Notify this user by email <span class="pub-label-muted">SMTP unavailable</span></label><p id="pub-smtp-help">Email notification requires SMTP configuration.</p></div><button type="button" class="pub-text-button" data-pub-help="smtp">Configure SMTP ${appIcon('arrow')}</button></section>`;
}

export function PublisherSummary(publisher: Publisher): string {
  const initials = publisher.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('') || 'P';
  return `<section class="pub-card pub-summary-card" aria-label="Publisher summary"><div class="pub-summary-identity"><span class="pub-summary-avatar" id="pub-summary-avatar" aria-hidden="true">${escapeHtml(initials)}</span><div><div class="pub-summary-name-row"><h2 id="pub-summary-name">${escapeHtml(publisher.name)}</h2><span id="pub-summary-status">${badge(publisher.status)}</span></div><p id="pub-summary-email">${escapeHtml(publisher.email)}</p><span class="pub-summary-id">Publisher ID: ${publisher.id}</span></div></div><dl><div><dt>Country</dt><dd id="pub-summary-country">${escapeHtml(countryLabel(publisher.country))}</dd></div><div><dt>Created Date</dt><dd>${formatDate(publisher.createdAt)}</dd></div><div><dt>Last Updated</dt><dd id="pub-summary-updated">${formatDate(publisher.updatedAt)}</dd></div></dl></section>`;
}

export function PublisherActivity(publisher: Publisher): string {
  return `<section class="pub-card pub-activity-card" aria-labelledby="pub-activity-heading"><div class="pub-card-heading"><h2 id="pub-activity-heading"><span class="pub-heading-icon">${appIcon('clock')}</span>Activity</h2><span class="pub-static-badge">Demo timeline</span></div><ol class="pub-timeline">${publisher.activity.length ? publisher.activity.map((item, index) => `<li><span class="pub-timeline-dot ${index === 0 ? 'pub-timeline-dot-current' : ''}" aria-hidden="true"></span><strong>${escapeHtml(item.title)}</strong><time datetime="${escapeHtml(item.date)}">${formatDate(item.date)}</time></li>`).join('') : '<li><span class="pub-timeline-dot" aria-hidden="true"></span><strong>No demo activity available</strong></li>'}</ol><p class="pub-rail-note">Static demo events, not a live audit log.</p></section>`;
}

export function PublisherSettings(publisher: Publisher): string {
  return `<section class="pub-card pub-settings-card" aria-labelledby="pub-settings-heading"><div class="pub-card-heading"><h2 id="pub-settings-heading"><span class="pub-heading-icon">${appIcon('settings')}</span>Settings</h2></div><div class="pub-settings-body"><label class="pub-setting-status" for="pub-settings-status"><span>Account Status</span><select id="pub-settings-status">${publisherStatuses.map(status => `<option ${publisher.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></label><dl><div><dt>Panel Access</dt><dd id="pub-settings-panel"></dd></div><div><dt>API Access</dt><dd id="pub-settings-api"></dd></div><div><dt>Email Notifications</dt><dd><span class="pub-neutral-pill">SMTP required</span></dd></div><div><dt>Tracking Configuration</dt><dd id="pub-settings-tracking"></dd></div></dl></div><p class="pub-rail-note">Reflects the current form. Use Save Changes to save this preview.</p></section>`;
}

export function PublisherForm(publisher: Publisher): string {
  return `<section class="pub-card pub-information-card" aria-labelledby="pub-info-heading"><div class="pub-card-heading"><div><h2 id="pub-info-heading"><span class="pub-heading-icon">${appIcon('users')}</span>Publisher Information</h2><p>To know more, <button class="pub-inline-link" type="button" data-pub-help="information">click here.</button></p></div><span class="pub-required-note"><span>*</span> Required fields</span></div><div class="pub-card-body">${PublisherBasicInfo(publisher)}${PublisherAddress(publisher)}${PublisherAccount(publisher)}</div></section>${PublisherAdvancedSetup(publisher)}${PublisherNotificationSettings()}`;
}

export function renderPublisherFormPage(publisher: Publisher, mode: FormMode): string {
  const editing = mode === 'edit';
  return `<div class="publisher-page ${editing ? 'publisher-edit-page' : 'publisher-create-page'}"><div class="pub-page-intro"><div><p class="eyebrow">PARTNER MANAGEMENT</p><h1>${editing ? 'Edit Publisher' : 'Create Publisher'}</h1><p>${editing ? `Publisher ID: ${publisher.id} · Manage profile and account preferences.` : 'Add a publisher profile and configure their account preferences.'}</p></div>${editing ? `<div class="pub-actions"><button class="btn btn-outline" type="button" id="pub-actions-trigger" aria-expanded="false" aria-controls="pub-actions-menu">Actions ${appIcon('chevron')}</button><div class="pub-actions-menu" id="pub-actions-menu" hidden><button type="button" id="pub-change-status">${appIcon('settings')} Change Status</button><button type="button" disabled title="Requires account API integration">${appIcon('shield')} Reset Password</button><button type="button" disabled title="Requires SMTP and invitation API integration">${appIcon('mail')} Send Invite</button><div class="pub-danger-action"><button type="button" disabled title="Requires account API integration">${appIcon('trash')} Delete Publisher</button></div><small>Account actions require backend integration.</small></div></div>` : '<span class="pub-preview-pill">New publisher</span>'}</div>
    <div class="pub-preview-notice">${appIcon('shield')}<div><strong>Frontend preview</strong><span>Changes are saved in this browser tab only. No live publisher account is created or updated.</span></div></div>
    ${editing ? PublisherSummary(publisher) : ''}
    <div id="pub-form-feedback" class="pub-form-feedback" role="status" aria-live="polite" tabindex="-1" hidden></div>
    <form id="publisher-form" novalidate><div class="pub-page-grid"><div class="pub-primary-column">${PublisherForm(publisher)}</div>${editing ? `<aside class="pub-side-column" aria-label="Publisher insights">${PublisherSettings(publisher)}${PublisherActivity(publisher)}</aside>` : ''}</div></form>
    <footer class="publisher-action-bar"><div class="pub-save-context"><span class="pub-save-icon">${appIcon('shield')}</span><span><strong id="pub-draft-state">${editing ? 'Publisher preview' : 'Unsaved publisher'}</strong><small>Local preview only · no email will be sent</small></span></div><div class="pub-footer-buttons"><a id="pub-cancel" class="btn btn-outline" href="/publishers">Cancel</a><button class="btn btn-primary pub-save-button" id="pub-save" type="submit" form="publisher-form">${appIcon('check')}<span>${editing ? 'Save Changes' : 'SAVE'}</span></button></div></footer>
    <dialog class="pub-help-dialog" id="pub-help-dialog" aria-labelledby="pub-help-title"><div class="pub-dialog-heading"><span class="pub-heading-icon">${appIcon('help')}</span><button type="button" class="pub-icon-button" id="pub-help-close" aria-label="Close help">${appIcon('close')}</button></div><h2 id="pub-help-title"></h2><p id="pub-help-description"></p><button type="button" class="btn btn-primary" id="pub-help-done">Got it</button></dialog>
  </div>`;
}

export function bindPublisherFormPage(publisher: Publisher, mode: FormMode): void {
  const form = document.querySelector<HTMLFormElement>('#publisher-form')!;
  const root = document.querySelector<HTMLElement>('.publisher-page')!;
  const draft: Publisher = JSON.parse(JSON.stringify(publisher));
  draft.notifyByEmail = false;
  let submitted = false;
  let dirty = false;
  let saving = false;
  const options = {
    country: publisherCountries.map(country => ({ value: country.code, label: country.name })),
    status: publisherStatuses.map(status => ({ value: status, label: status })),
  };
  const feedback = document.querySelector<HTMLElement>('#pub-form-feedback')!;
  const saveButton = document.querySelector<HTMLButtonElement>('#pub-save')!;

  function showFeedback(text: string, error = false) {
    feedback.textContent = text;
    feedback.classList.toggle('pub-feedback-error', error);
    feedback.hidden = false;
  }

  function showErrors() {
    const errors = validatePublisher(draft);
    root.querySelectorAll<HTMLElement>('.pub-field-error').forEach(element => { element.textContent = ''; element.hidden = true; });
    root.querySelectorAll('[aria-invalid]').forEach(element => element.removeAttribute('aria-invalid'));
    Object.entries(errors).forEach(([key, message]) => {
      const control = document.getElementById(fieldId(key));
      const error = document.getElementById(`${fieldId(key)}-error`);
      control?.setAttribute('aria-invalid', 'true');
      if (error) { error.textContent = message; error.hidden = false; }
    });
    return errors;
  }

  function updateState() {
    const advanced = document.querySelector<HTMLElement>('#pub-advanced-content')!;
    advanced.hidden = !draft.advancedSetup;
    document.querySelector<HTMLFieldSetElement>('#pub-advanced-fields')!.disabled = !draft.advancedSetup;
    document.querySelector('#pub-advancedSetup')!.setAttribute('aria-expanded', String(draft.advancedSetup));
    document.querySelector<HTMLFieldSetElement>('#pub-tracking-fields')!.disabled = !draft.tracking.enabled;
    const custom = draft.advancedSetup && draft.tracking.enabled && draft.tracking.referralHandling === 'custom';
    document.querySelector<HTMLElement>('#pub-custom-referral-field')!.hidden = !custom;
    const referral = document.querySelector<HTMLInputElement>('#pub-tracking-referralUrl')!;
    referral.disabled = !custom;
    referral.required = custom;
    if (mode === 'edit') {
      document.querySelector('#pub-summary-name')!.textContent = draft.name.trim() || 'Unnamed publisher';
      document.querySelector('#pub-summary-avatar')!.textContent = draft.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('') || 'P';
      document.querySelector('#pub-summary-email')!.textContent = draft.email || 'No email entered';
      document.querySelector('#pub-summary-country')!.textContent = countryLabel(draft.country) || 'Not selected';
      document.querySelector('#pub-summary-status')!.innerHTML = badge(draft.status || 'Not selected');
      document.querySelector<HTMLSelectElement>('#pub-settings-status')!.value = draft.status;
      const pill = (enabled: boolean) => `<span class="pub-neutral-pill ${enabled ? 'pub-preference-on' : ''}">${enabled ? 'Enabled' : 'Disabled'}</span>`;
      document.querySelector('#pub-settings-panel')!.innerHTML = draft.advancedSetup ? pill(draft.access.panel) : '<span class="pub-neutral-pill">Default</span>';
      document.querySelector('#pub-settings-api')!.innerHTML = draft.advancedSetup ? pill(draft.access.api) : '<span class="pub-neutral-pill">Default</span>';
      document.querySelector('#pub-settings-tracking')!.innerHTML = `<span class="pub-neutral-pill">${draft.advancedSetup && draft.tracking.enabled ? 'Custom preferences' : 'Default'}</span>`;
    }
    document.querySelector('#pub-draft-state')!.textContent = dirty ? 'Unsaved changes' : mode === 'edit' ? 'Publisher preview' : 'Unsaved publisher';
  }

  function changed() {
    dirty = true;
    feedback.hidden = true;
    updateState();
    if (submitted) showErrors();
  }

  function updateField(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
    const key = control.dataset.pubField!;
    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      if (key === 'advancedSetup') draft.advancedSetup = control.checked;
      else if (key === 'tracking.enabled') draft.tracking.enabled = control.checked;
      else if (key === 'access.panel') draft.access.panel = control.checked;
      else if (key === 'access.api') draft.access.api = control.checked;
      else if (key === 'notifications.campaignUpdates') draft.notifications.campaignUpdates = control.checked;
      else if (key === 'notifications.conversionUpdates') draft.notifications.conversionUpdates = control.checked;
    } else if (key === 'tracking.subIdParameter') draft.tracking.subIdParameter = control.value;
    else if (key === 'tracking.referralUrl') draft.tracking.referralUrl = control.value;
    else if (key === 'tracking.referralHandling') draft.tracking.referralHandling = control.value as 'hide' | 'custom';
    else draft[key as TextField] = control.value;
    changed();
  }

  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-pub-field]').forEach(control => {
    control.addEventListener(control instanceof HTMLInputElement && control.type === 'checkbox' || control instanceof HTMLSelectElement ? 'change' : 'input', () => updateField(control));
  });

  root.querySelectorAll<HTMLInputElement>('[data-pub-combo]').forEach(input => {
    const field = input.dataset.pubCombo as 'country' | 'status';
    const wrapper = input.closest<HTMLElement>('.pub-combo')!;
    const list = wrapper.querySelector<HTMLElement>('[role="listbox"]')!;
    let filtered = options[field];
    let active = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    const render = (search: string) => {
      filtered = options[field].filter(option => option.label.toLowerCase().includes(search.toLowerCase()) || option.value.toLowerCase() === search.toLowerCase());
      list.innerHTML = filtered.length ? filtered.map((option, index) => `<div role="option" id="${input.id}-option-${index}" data-pub-option="${escapeHtml(option.value)}" aria-selected="${draft[field] === option.value}">${escapeHtml(option.label)}${draft[field] === option.value ? appIcon('check') : ''}</div>`).join('') : '<div class="pub-combo-empty">No matching options</div>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };
    const choose = (value: string) => {
      const option = options[field].find(item => item.value === value);
      if (!option) return;
      if (field === 'country') draft.country = option.value;
      else draft.status = option.value as PublisherStatus;
      input.value = option.label;
      close();
      changed();
    };
    input.addEventListener('focus', () => render(''));
    input.addEventListener('click', () => { if (list.hidden) render(''); });
    input.addEventListener('input', () => {
      const option = options[field].find(item => item.label.toLowerCase() === input.value.trim().toLowerCase());
      if (field === 'country') draft.country = option?.value ?? '';
      else draft.status = (option?.value ?? '') as PublisherStatus;
      changed();
      render(input.value.trim());
    });
    list.addEventListener('mousedown', event => event.preventDefault());
    list.addEventListener('click', event => {
      const option = (event.target as HTMLElement).closest<HTMLElement>('[data-pub-option]');
      if (option) choose(option.dataset.pubOption!);
    });
    input.addEventListener('blur', close);
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.hidden) render('');
        active = filtered.length ? (active < 0 ? (event.key === 'ArrowDown' ? 0 : filtered.length - 1) : (active + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length) : -1;
        list.querySelectorAll<HTMLElement>('[role="option"]').forEach((option, index) => option.classList.toggle('pub-option-focused', index === active));
        if (active >= 0) {
          const option = list.children[active] as HTMLElement;
          input.setAttribute('aria-activedescendant', option.id);
          option.scrollIntoView({ block: 'nearest' });
        }
      } else if (event.key === 'Enter' && !list.hidden) {
        event.preventDefault();
        if (active >= 0 && filtered[active]) choose(filtered[active].value);
        else if (filtered.length === 1) choose(filtered[0].value);
        else close();
      }
    });
  });

  document.querySelector<HTMLSelectElement>('#pub-settings-status')?.addEventListener('change', event => {
    draft.status = (event.target as HTMLSelectElement).value as PublisherStatus;
    document.querySelector<HTMLInputElement>('#pub-status')!.value = draft.status;
    changed();
  });

  const actions = document.querySelector<HTMLElement>('#pub-actions-menu');
  const actionsTrigger = document.querySelector<HTMLButtonElement>('#pub-actions-trigger');
  const closeActions = () => { if (actions) actions.hidden = true; actionsTrigger?.setAttribute('aria-expanded', 'false'); };
  actionsTrigger?.addEventListener('click', () => { actions!.hidden = !actions!.hidden; actionsTrigger.setAttribute('aria-expanded', String(!actions!.hidden)); });
  document.querySelector('#pub-change-status')?.addEventListener('click', () => { closeActions(); document.querySelector<HTMLInputElement>('#pub-status')!.focus(); });
  root.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('.pub-actions')) closeActions(); });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && actions && !actions.hidden) { closeActions(); actionsTrigger?.focus(); } });
  root.addEventListener('focusout', event => { if ((event.target as HTMLElement).closest('.pub-actions') && !(event.relatedTarget as HTMLElement | null)?.closest('.pub-actions')) closeActions(); });

  const dialog = document.querySelector<HTMLDialogElement>('#pub-help-dialog')!;
  root.querySelectorAll<HTMLElement>('[data-pub-help]').forEach(button => button.addEventListener('click', () => {
    const smtp = button.dataset.pubHelp === 'smtp';
    document.querySelector('#pub-help-title')!.textContent = smtp ? 'SMTP configuration unavailable' : 'Publisher Information';
    document.querySelector('#pub-help-description')!.textContent = smtp ? 'This frontend preview is not connected to an SMTP service. An administrator will need to configure email delivery in the backend before notifications or invitations can be sent. No email is sent from this form.' : 'Enter the publisher’s contact and account information. Email, Name, Country and Account Status are required. Advanced Setup is optional. Saves are local to this browser tab and do not create a live account.';
    dialog.showModal();
  }));
  document.querySelector('#pub-help-close')!.addEventListener('click', () => dialog.close());
  document.querySelector('#pub-help-done')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    submitted = true;
    const errors = showErrors();
    if (Object.keys(errors).length) {
      showFeedback('Please check the highlighted fields before saving.', true);
      root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    saving = true;
    saveButton.disabled = true;
    saveButton.classList.add('pub-is-saving');
    saveButton.setAttribute('aria-busy', 'true');
    saveButton.querySelector('span')!.textContent = 'Saving…';
    try {
      await storePublisherPreview(draft);
      dirty = false;
      if (mode === 'create') {
        window.location.assign(`/publishers/${draft.id}/edit?preview=created`);
        return;
      }
      updateState();
      document.querySelector('#pub-summary-updated')?.replaceChildren(formatDate(draft.updatedAt));
      document.querySelector('#pub-draft-state')!.textContent = 'Preview saved';
      showFeedback(`Publisher #${draft.id} updated in this browser tab only. No live account was changed and no email was sent.`);
      feedback.focus();
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : 'The local preview could not be saved. Please try again.', true);
      feedback.focus();
    } finally {
      saving = false;
      saveButton.classList.remove('pub-is-saving');
      saveButton.removeAttribute('aria-busy');
      saveButton.disabled = mode === 'create' && draft.id !== null;
      if (!saveButton.disabled) saveButton.querySelector('span')!.textContent = mode === 'edit' ? 'Save Changes' : 'SAVE';
    }
  });
  updateState();
  if (mode === 'edit' && new URLSearchParams(window.location.search).get('preview') === 'created') {
    showFeedback(`Publisher #${publisher.id} is ready to edit in this browser tab. This is a local preview only; no live account was created or email sent.`);
    window.history.replaceState(null, '', window.location.pathname);
  }
}
