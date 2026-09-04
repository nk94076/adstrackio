import './campaign.css';
import { renderAppSidebar, renderAppHeader, bindAppShell, appIcon } from './app-shell';
import { createEmptyPublisher, getPublisherPreview, listPublisherPreviews, publisherCountries, publisherStatuses, type Publisher } from './publisher-data';
import { renderPublisherFormPage, bindPublisherFormPage } from './publisher-form';
import './publisher-pages.css';

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const countryName = (code: string) => publisherCountries.find(country => country.code === code)?.name ?? code;
const dateLabel = (value: string) => value && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value)) : '—';
const statusBadge = (status: string) => `<span class="publisher-status publisher-status-${escapeHtml(status.toLowerCase())}"><i aria-hidden="true"></i>${escapeHtml(status)}</span>`;
const demoNotice = '<div class="publisher-demo-note"><span class="publisher-demo-dot" aria-hidden="true"></span><strong>Preview workspace</strong><span>Demo records and edits are stored in this browser tab only. No live publisher accounts are changed.</span></div>';

function mountShell(route: string, title: string, body: string, breadcrumbs: Array<{ label: string; href?: string }>) {
  document.title = `${title} | AdstrackIO`;
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `<div class="campaign-app publisher-app">${renderAppSidebar(route)}<main class="campaign-main">${renderAppHeader(breadcrumbs)}${body}</main></div>`;
  bindAppShell();
}

function publisherRows(publishers: Publisher[]): string {
  return publishers.length ? publishers.map(publisher => `<tr>
    <td class="publisher-id">#${publisher.id}</td>
    <td><a class="publisher-name-link" href="/publishers/${publisher.id}"><span class="publisher-list-avatar" aria-hidden="true">${escapeHtml(publisher.name.split(/\s+/).slice(0, 2).map(part => part[0]).join(''))}</span><span><strong>${escapeHtml(publisher.name)}</strong><small>${escapeHtml(publisher.email)}</small></span></a></td>
    <td>${statusBadge(publisher.status)}</td><td>${escapeHtml(publisher.company || '—')}</td><td>${escapeHtml(countryName(publisher.country))}</td><td>${dateLabel(publisher.updatedAt)}</td>
    <td class="publisher-row-action"><a class="btn btn-outline" href="/publishers/${publisher.id}/edit" aria-label="Edit ${escapeHtml(publisher.name)}">Edit <span aria-hidden="true">↗</span></a></td>
  </tr>`).join('') : '<tr><td colspan="7"><div class="publisher-no-results"><strong>No publishers match your filters</strong><p>Try a different name, email, ID or account status.</p><button class="btn btn-outline" type="button" id="publisher-clear-filters">Clear filters</button></div></td></tr>';
}

function mountManagePublishers(route: string) {
  const publishers = listPublisherPreviews();
  const body = `<div class="publisher-directory">
    <section class="publisher-directory-intro"><div><p class="eyebrow">PARTNER MANAGEMENT</p><h1>Manage Publishers</h1><p>Manage publisher profiles, account access and configuration.</p></div><a class="btn btn-primary" href="/publishers/create"><span aria-hidden="true">＋</span> Create Publisher</a></section>
    ${demoNotice}
    <section class="publisher-directory-card" aria-labelledby="publisher-list-heading">
      <div class="publisher-directory-toolbar"><div><h2 id="publisher-list-heading">Publisher directory <span>${publishers.length}</span></h2><p>Your demo publisher accounts, in one place.</p></div><div class="publisher-directory-filters"><label class="publisher-list-search"><span class="sr-only">Search publishers</span>${appIcon('search')}<input id="publisher-search" type="search" placeholder="Search name, email or ID" /></label><label><span class="sr-only">Filter by account status</span><select id="publisher-status-filter"><option value="">All statuses</option>${publisherStatuses.map(status => `<option>${status}</option>`).join('')}</select></label></div></div>
      <div class="publisher-table-scroll" role="region" aria-label="Publishers table" tabindex="0"><table><thead><tr><th scope="col">ID</th><th scope="col">Publisher</th><th scope="col">Account Status</th><th scope="col">Company</th><th scope="col">Country</th><th scope="col">Last Updated</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody id="publisher-table-body">${publisherRows(publishers)}</tbody></table></div>
      <div class="publisher-directory-footer"><span id="publisher-result-count" role="status">${publishers.length} publishers</span><span>Session-only preview data</span></div>
    </section>
  </div>`;
  mountShell(route, 'Manage Publishers', body, [{ label: 'Publishers' }, { label: 'Manage Publishers' }]);
  const search = document.querySelector<HTMLInputElement>('#publisher-search')!;
  const status = document.querySelector<HTMLSelectElement>('#publisher-status-filter')!;
  const filter = () => {
    const term = search.value.trim().toLowerCase();
    const filtered = publishers.filter(publisher => (!status.value || publisher.status === status.value) && `${publisher.id} ${publisher.name} ${publisher.email} ${publisher.company}`.toLowerCase().includes(term));
    document.querySelector('#publisher-table-body')!.innerHTML = publisherRows(filtered);
    document.querySelector('#publisher-result-count')!.textContent = `${filtered.length} of ${publishers.length} publishers`;
  };
  search.addEventListener('input', filter);
  status.addEventListener('change', filter);
  document.querySelector('#publisher-table-body')!.addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('#publisher-clear-filters')) {
      search.value = '';
      status.value = '';
      filter();
      search.focus();
    }
  });
}

function mountPublisherDetails(route: string, publisher: Publisher) {
  const rows: Array<[string, string]> = [['Publisher ID', `#${publisher.id}`], ['Email', publisher.email], ['Phone', publisher.phone], ['Company', publisher.company], ['Skype', publisher.skype], ['Country', countryName(publisher.country)], ['Address', publisher.address], ['State', publisher.state], ['City', publisher.city], ['Zipcode', publisher.zipcode], ['Tax ID', publisher.taxId], ['Reference ID', publisher.referenceId], ['Created Date', dateLabel(publisher.createdAt)], ['Last Updated', dateLabel(publisher.updatedAt)]];
  const body = `<div class="publisher-directory">
    <section class="publisher-directory-intro"><div><p class="eyebrow">PUBLISHER #${publisher.id}</p><h1>${escapeHtml(publisher.name)}</h1><p>Publisher profile and account overview.</p></div><a class="btn btn-primary" href="/publishers/${publisher.id}/edit">Edit Publisher</a></section>
    ${demoNotice}
    <section class="publisher-directory-card publisher-overview" aria-labelledby="publisher-overview-title"><div class="publisher-directory-toolbar"><h2 id="publisher-overview-title">Publisher Information</h2>${statusBadge(publisher.status)}</div><dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value || '—')}</dd></div>`).join('')}</dl></section>
    <a class="btn btn-outline" href="/publishers">← Manage Publishers</a>
  </div>`;
  mountShell(route, `${publisher.name} · Publisher`, body, [{ label: 'Publishers', href: '/publishers' }, { label: 'Manage Publishers', href: '/publishers' }, { label: `Publisher #${publisher.id}` }]);
}

export function mountPublisherPage(route: string) {
  if (route === '/publishers') return mountManagePublishers(route);
  if (route === '/publishers/create') {
    const publisher = createEmptyPublisher();
    mountShell(route, 'Create Publisher', renderPublisherFormPage(publisher, 'create'), [{ label: 'Publishers', href: '/publishers' }, { label: 'Create Publisher' }]);
    bindPublisherFormPage(publisher, 'create');
    return;
  }
  const match = route.match(/^\/publishers\/(\d+)(\/edit)?$/);
  const publisher = match ? getPublisherPreview(Number(match[1])) : undefined;
  if (publisher && match?.[2]) {
    mountShell(route, 'Edit Publisher', renderPublisherFormPage(publisher, 'edit'), [{ label: 'Publishers', href: '/publishers' }, { label: 'Manage Publishers', href: '/publishers' }, { label: `Publisher #${publisher.id}` }]);
    bindPublisherFormPage(publisher, 'edit');
    return;
  }
  if (publisher) return mountPublisherDetails(route, publisher);
  const isPostbacks = route === '/publishers/postbacks';
  const title = isPostbacks ? 'PostBack / Pixels' : 'Publisher not found';
  mountShell(route, title, `<div class="publisher-directory"><section class="publisher-directory-intro"><div><p class="eyebrow">PUBLISHERS</p><h1>${title}</h1></div></section><section class="publisher-directory-card publisher-unavailable"><span class="publisher-unavailable-icon" aria-hidden="true">${appIcon(isPostbacks ? 'link' : 'users')}</span><h2>${isPostbacks ? 'Postback configuration is not connected' : 'This publisher is unavailable'}</h2><p>${isPostbacks ? 'This preview includes publisher profiles only. Postback and pixel management require the future tracking integration; no tracking settings have been changed.' : 'The ID does not match a demo or locally saved publisher in this browser tab.'}</p><a href="/publishers" class="btn btn-primary">Manage Publishers</a></section></div>`, [{ label: 'Publishers', href: '/publishers' }, { label: title }]);
}
