import { appIcon } from './app-shell';

export type AccountFieldOptions = {
  placeholder?: string;
  required?: boolean;
  type?: string;
  help?: string;
  full?: boolean;
  multiline?: boolean;
  readonly?: boolean;
  autocomplete?: string;
};

export const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export const accountFieldId = (prefix: string, key: string): string => `${prefix}-${key.replace(/\./g, '-')}`;

export function accountField(prefix: string, key: string, label: string, value: string, options: AccountFieldOptions = {}): string {
  const id = escapeHtml(accountFieldId(prefix, key));
  const { placeholder = '', required = false, type = 'text', help = '', full = false, multiline = false, readonly = false, autocomplete } = options;
  const attributes = `id="${id}" name="${escapeHtml(key)}" data-${escapeHtml(prefix)}-field="${escapeHtml(key)}" ${required ? 'required' : ''} aria-describedby="${id}-help ${id}-error" ${autocomplete ? `autocomplete="${escapeHtml(autocomplete)}"` : ''}${readonly ? ' readonly' : ''}`;
  return `<div class="pub-field ${full ? 'pub-full' : ''}"><label for="${id}">${escapeHtml(label)}${required ? '<span class="pub-required"> *</span>' : ''}</label>${multiline ? `<textarea ${attributes} rows="2" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>` : `<input ${attributes} type="${escapeHtml(type)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${type === 'tel' ? 'inputmode="tel"' : ''}/>`}<small id="${id}-help" ${help ? '' : 'hidden'}>${escapeHtml(help)}</small><span class="pub-field-error" id="${id}-error" hidden></span></div>`;
}

export function accountCombo(prefix: string, key: string, label: string, value: string, options: Array<{ value: string; label: string }>, required = true): string {
  const id = escapeHtml(accountFieldId(prefix, key));
  const labelValue = options.find(option => option.value === value)?.label ?? '';
  return `<div class="pub-field"><label for="${id}">${escapeHtml(label)}${required ? '<span class="pub-required"> *</span>' : ''}</label><div class="pub-combo" data-combo="${escapeHtml(key)}"><input id="${id}" name="${escapeHtml(key)}" data-${escapeHtml(prefix)}-combo="${escapeHtml(key)}" type="text" role="combobox" aria-autocomplete="list" aria-controls="${id}-options" aria-expanded="false" aria-required="${required}" aria-describedby="${id}-help ${id}-error" ${required ? 'required' : ''} autocomplete="off" value="${escapeHtml(labelValue)}" placeholder="Search ${escapeHtml(label.toLowerCase())}"/><span class="pub-combo-chevron">${appIcon('chevron')}</span><div class="pub-combo-options" id="${id}-options" role="listbox" aria-label="${escapeHtml(label)}" hidden></div></div><small id="${id}-help">Type to search, or use the arrow keys to select.</small><span class="pub-field-error" id="${id}-error" hidden></span></div>`;
}

export function accountSwitch(prefix: string, key: string, label: string, checked: boolean, help = ''): string {
  const id = escapeHtml(accountFieldId(prefix, key));
  return `<label class="pub-switch-row" for="${id}"><span><strong>${escapeHtml(label)}</strong>${help ? `<small>${escapeHtml(help)}</small>` : ''}</span><span class="pub-switch"><input type="checkbox" role="switch" id="${id}" data-${escapeHtml(prefix)}-field="${escapeHtml(key)}" ${checked ? 'checked' : ''}/><i aria-hidden="true"></i></span></label>`;
}
