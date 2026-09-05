import './campaign.css';
import { appIcon, bindAppShell, renderAppHeader, renderAppSidebar, type AppBreadcrumb } from './app-shell';
import { advertiserCountries, advertiserStatuses, createEmptyAdvertiser, getAdvertiserPreview, listAdvertiserPreviews, type Advertiser } from './advertiser-data';
import { bindAdvertiserFormPage, renderAdvertiserFormPage } from './advertiser-form';
import './publisher-pages.css';

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const countryName = (code: string) => advertiserCountries.find(country => country.code === code)?.name ?? code;
const dateLabel = (value: string) => value && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value)) : '—';
const statusBadge = (status: string) => `<span class="publisher-status publisher-status-${escapeHtml(status.toLowerCase())}"><i aria-hidden="true"></i>${escapeHtml(status)}</span>`;
const demoNotice = '<div class="publisher-demo-note"><span class="publisher-demo-dot" aria-hidden="true"></span><strong>Preview workspace</strong><span>Demo records and edits are stored in this browser tab only. No live advertiser accounts are changed.</span></div>';

function mountShell(route: string, title: string, body: string, breadcrumbs: AppBreadcrumb[]): void {
  document.title = `${title} | AdstrackIO`;
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `<div class="campaign-app advertiser-app">${renderAppSidebar(route)}<main class="campaign-main">${renderAppHeader(breadcrumbs)}${body}</main></div>`;
  bindAppShell();
}

function advertiserRows(advertisers: Advertiser[]): string {
  return advertisers.length ? advertisers.map(advertiser => `<tr>
    <td class="publisher-id">#${advertiser.id}</td>
    <td><a class="publisher-name-link" href="/advertisers/${advertiser.id}"><span class="publisher-list-avatar" aria-hidden="true">${escapeHtml(advertiser.name.split(/\s+/).slice(0, 2).map(part => part[0]).join(''))}</span><span><strong>${escapeHtml(advertiser.name)}</strong><small>${escapeHtml(advertiser.email)}</small></span></a></td>
    <td>${statusBadge(advertiser.status)}</td><td>${escapeHtml(advertiser.company || '—')}</td><td>${escapeHtml(countryName(advertiser.country))}</td><td>${dateLabel(advertiser.updatedAt)}</td>
    <td class="publisher-row-action"><a class="btn btn-outline" href="/advertisers/${advertiser.id}/edit" aria-label="Edit ${escapeHtml(advertiser.name)}">Edit <span aria-hidden="true">↗</span></a></td>
  </tr>`).join('') : '<tr><td colspan="7"><div class="publisher-no-results"><strong>No advertisers match your filters</strong><p>Try a different name, email, ID or account status.</p><button class="btn btn-outline" type="button" id="advertiser-clear-filters">Clear filters</button></div></td></tr>';
}

function mountManageAdvertisers(route: string): void {
  const advertisers = listAdvertiserPreviews();
  mountShell(route, 'Manage Advertisers', `<div class="publisher-directory">
    <section class="publisher-directory-intro"><div><p class="eyebrow">ADVERTISER MANAGEMENT</p><h1>Manage Advertisers</h1><p>Manage advertiser profiles, billing details and account configuration.</p></div><a class="btn btn-primary" href="/advertisers/create">${appIcon('plus')} Create Advertiser</a></section>
    ${demoNotice}
    <section class="publisher-directory-card" aria-labelledby="advertiser-list-heading">
      <div class="publisher-directory-toolbar"><div><h2 id="advertiser-list-heading">Advertiser directory <span>${advertisers.length}</span></h2><p>Your demo advertiser accounts, in one place.</p></div><div class="publisher-directory-filters"><label class="publisher-list-search"><span class="sr-only">Search advertisers</span>${appIcon('search')}<input id="advertiser-search" type="search" placeholder="Search name, email or ID" /></label><label><span class="sr-only">Filter by account status</span><select id="advertiser-status-filter"><option value="">All statuses</option>${advertiserStatuses.map(status => `<option>${escapeHtml(status)}</option>`).join('')}</select></label></div></div>
      <div class="publisher-table-scroll" role="region" aria-label="Advertisers table" tabindex="0"><table><thead><tr><th scope="col">ID</th><th scope="col">Advertiser</th><th scope="col">Account Status</th><th scope="col">Company</th><th scope="col">Country</th><th scope="col">Last Updated</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody id="advertiser-table-body">${advertiserRows(advertisers)}</tbody></table></div>
      <div class="publisher-directory-footer"><span id="advertiser-result-count" role="status">${advertisers.length} advertisers</span><span>Session-only preview data</span></div>
    </section>
  </div>`, [{ label: 'Advertisers', href: '/advertisers' }, { label: 'Manage Advertisers' }]);

  const search = document.querySelector<HTMLInputElement>('#advertiser-search')!;
  const status = document.querySelector<HTMLSelectElement>('#advertiser-status-filter')!;
  const filter = () => {
    const term = search.value.trim().toLowerCase();
    const filtered = advertisers.filter(advertiser => (!status.value || advertiser.status === status.value) && `${advertiser.id} ${advertiser.name} ${advertiser.email} ${advertiser.company}`.toLowerCase().includes(term));
    document.querySelector('#advertiser-table-body')!.innerHTML = advertiserRows(filtered);
    document.querySelector('#advertiser-result-count')!.textContent = `${filtered.length} of ${advertisers.length} advertisers`;
  };
  search.addEventListener('input', filter);
  status.addEventListener('change', filter);
  document.querySelector('#advertiser-table-body')!.addEventListener('click', event => {
    if (!(event.target as HTMLElement).closest('#advertiser-clear-filters')) return;
    search.value = '';
    status.value = '';
    filter();
    search.focus();
  });
}

function mountAdvertiserDetails(route: string, advertiser: Advertiser): void {
  const profileRows: Array<[string, string]> = [
    ['Advertiser ID', `#${advertiser.id}`], ['Email', advertiser.email], ['Phone', advertiser.phone],
    ['Company', advertiser.company], ['Country', countryName(advertiser.country)], ['Address', advertiser.address],
    ['State', advertiser.state], ['City', advertiser.city], ['Zipcode', advertiser.zipcode],
    ['Tax ID', advertiser.taxId], ['Reference ID', advertiser.referenceId],
    ['Advertiser Manager', advertiser.advertiserManager], ['Hash ID', advertiser.hashId], ['Notes', advertiser.notes],
    ['Created', dateLabel(advertiser.createdAt)], ['Last Updated', dateLabel(advertiser.updatedAt)],
  ];
  const billingRows: Array<[string, string]> = [
    ['Currency', advertiser.currency], ['Billing Email', advertiser.billingEmail], ['Billing Address', advertiser.billingAddress],
    ['Billing Country', countryName(advertiser.billingCountry)], ['Payment Terms', advertiser.paymentTerms],
    ['Postback Enabled', advertiser.postbackEnabled ? 'Enabled in preview' : 'Disabled in preview'],
  ];
  const rows = (entries: Array<[string, string]>) => `<dl>${entries.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value || '—')}</dd></div>`).join('')}</dl>`;
  mountShell(route, `${advertiser.name} · Advertiser`, `<div class="publisher-directory">
    <section class="publisher-directory-intro"><div><p class="eyebrow">ADVERTISER #${advertiser.id}</p><h1>${escapeHtml(advertiser.name)}</h1><p>Advertiser profile and account overview.</p></div><a class="btn btn-primary" href="/advertisers/${advertiser.id}/edit">${appIcon('edit')} Edit Advertiser</a></section>
    ${demoNotice}
    <section class="publisher-directory-card publisher-overview" aria-labelledby="advertiser-overview-title"><div class="publisher-directory-toolbar"><h2 id="advertiser-overview-title">Advertiser Information</h2>${statusBadge(advertiser.status)}</div>${rows(profileRows)}</section>
    <section class="publisher-directory-card publisher-overview" aria-labelledby="advertiser-billing-title"><div class="publisher-directory-toolbar"><h2 id="advertiser-billing-title">Billing &amp; Configuration</h2><a class="btn btn-outline" href="/advertisers/${advertiser.id}/edit#advertiser-postback">View PostBack setup</a></div>${rows(billingRows)}</section>
    <a class="btn btn-outline" href="/advertisers">← Manage Advertisers</a>
  </div>`, [{ label: 'Advertisers', href: '/advertisers' }, { label: 'Manage Advertisers', href: '/advertisers' }, { label: `Advertiser #${advertiser.id}` }]);
}

function mountUnavailable(route: string): void {
  const isPostbacks = route === '/advertisers/postbacks';
  const title = isPostbacks ? 'PostBack / Hits' : 'Advertiser not found';
  mountShell(route, title, `<div class="publisher-directory">
    <section class="publisher-directory-intro"><div><p class="eyebrow">ADVERTISERS</p><h1>${title}</h1></div></section>
    <section class="publisher-directory-card publisher-unavailable"><span class="publisher-unavailable-icon" aria-hidden="true">${appIcon(isPostbacks ? 'link' : 'users')}</span><h2>${isPostbacks ? 'Postback hits are not connected' : 'This advertiser is unavailable'}</h2>
    <p>${isPostbacks ? 'Live postback delivery, hit logs and debugging are unavailable in this preview. You can review and edit the demo advertiser’s PostBack configuration; no conversion events are sent.' : 'The ID does not match a demo or locally saved advertiser in this browser tab.'}</p>
    ${isPostbacks ? '<a href="/advertisers/25/edit#advertiser-postback" class="btn btn-primary">Open demo PostBack setup</a>' : '<a href="/advertisers" class="btn btn-primary">Manage Advertisers</a>'}
    </section>
    ${isPostbacks ? '<a class="btn btn-outline" href="/advertisers">← Manage Advertisers</a>' : ''}
  </div>`, [{ label: 'Advertisers', href: '/advertisers' }, { label: title }]);
}

export function mountAdvertiserPage(route: string): void {
  if (route === '/advertisers') return mountManageAdvertisers(route);
  if (route === '/advertisers/create') {
    const advertiser = createEmptyAdvertiser();
    mountShell(route, 'Create Advertiser', renderAdvertiserFormPage(advertiser, 'create'), [{ label: 'Advertisers', href: '/advertisers' }, { label: 'Create Advertiser' }]);
    bindAdvertiserFormPage(advertiser, 'create');
    return;
  }
  const match = route.match(/^\/advertisers\/(\d+)(\/edit)?$/);
  const advertiser = match ? getAdvertiserPreview(Number(match[1])) : undefined;
  if (advertiser && match?.[2]) {
    mountShell(route, 'Edit Advertiser', renderAdvertiserFormPage(advertiser, 'edit'), [{ label: 'Advertisers', href: '/advertisers' }, { label: 'Manage Advertisers', href: '/advertisers' }, { label: `Advertiser #${advertiser.id}` }]);
    bindAdvertiserFormPage(advertiser, 'edit');
    return;
  }
  if (advertiser) return mountAdvertiserDetails(route, advertiser);
  mountUnavailable(route);
}
