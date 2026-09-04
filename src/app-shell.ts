import './app-shell.css';

export type AppBreadcrumb = { label: string; href?: string };
type NavigationItem = { label: string; icon: string; path?: string; children?: AppBreadcrumb[] };

export function appIcon(name: string): string {
  const paths: Record<string, string> = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    campaign: '<path d="M4 14V7l12-3v13L4 14Z"/><path d="M16 8h2.5a1.5 1.5 0 0 1 0 3H16M6.5 14.6l.8 3.1"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.6-3.1 2.5-4.8 5.5-4.8s4.9 1.7 5.5 4.8M16 5.5a3 3 0 0 1 0 5.7M17 14.5c2.1.4 3.3 1.8 3.6 4"/>',
    link: '<path d="M10 13.8a4.2 4.2 0 0 0 5.9.1l2-2a4.2 4.2 0 0 0-5.9-5.9l-1.1 1.1M14 10.2a4.2 4.2 0 0 0-5.9-.1l-2 2A4.2 4.2 0 0 0 12 18l1.1-1.1"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20V8"/>',
    report: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h5M9 13h6M9 17h6"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v2M22 12h-2M12 22v-2M2 12h2"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m5 18 5-5 3 3 2-2 4 4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m16 16 4.5 4.5"/>',
    bell: '<path d="M18 10a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 22h4"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.6 2.6 0 1 1 4.3 2c-1.3 1-1.8 1.5-1.8 3M12 17.5h.01"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    edit: '<path d="m14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15 4 20Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 6 8 6 8-6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/>',
    shield: '<path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    filter: '<path d="M4 5h16l-6 7v5l-4 2v-7z"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.grid}</svg>`;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const navigation: NavigationItem[] = [
  { label: 'Dashboard', icon: 'grid' },
  { label: 'Campaigns', icon: 'campaign', path: '/campaigns', children: [{ label: 'Manage Campaigns', href: '/campaigns' }, { label: 'Create Campaign', href: '/campaigns/create' }] },
  { label: 'Advertisers', icon: 'users' },
  { label: 'Publishers', icon: 'users', path: '/publishers', children: [{ label: 'Manage Publishers', href: '/publishers' }, { label: 'Create Publisher', href: '/publishers/create' }, { label: 'PostBack / Pixels', href: '/publishers/postbacks' }] },
  { label: 'Tracking', icon: 'link', children: [{ label: 'Tracking Links' }, { label: 'Tracking Domains' }, { label: 'Click Logs' }] },
  { label: 'Conversions', icon: 'chart', children: [{ label: 'Conversions' }, { label: 'Postbacks' }] },
  { label: 'Reports', icon: 'report', children: [{ label: 'Campaign Report' }, { label: 'Publisher Report' }, { label: 'Conversion Report' }, { label: 'Click Report' }, { label: 'Daily Report' }] },
  { label: 'Analytics', icon: 'chart' },
  { label: 'Targeting', icon: 'target' },
  { label: 'Creatives', icon: 'image' },
  { label: 'Tools', icon: 'settings', children: [{ label: 'Macros' }, { label: 'Bulk Targeting' }] },
  { label: 'Settings', icon: 'settings' },
];

export function renderAppSidebar(activePath: string): string {
  const path = activePath.replace(/\/+$/, '');
  return `<aside class="app-sidebar shared-sidebar" id="app-sidebar" aria-label="Main navigation" tabindex="-1">
    <a class="sidebar-brand" href="/" aria-label="AdstrackIO home"><span class="brand-mark"><i></i><i></i><i></i></span><strong>Adstrack<span>IO</span></strong></a>
    <button class="sidebar-close" type="button" aria-label="Close menu">${appIcon('close')}</button>
    <nav aria-label="Workspace"><p class="sidebar-section-label">WORKSPACE</p>${navigation.map((item, index) => {
      const active = !!item.path && (path === item.path || path.startsWith(`${item.path}/`));
      const content = `<span class="nav-icon">${appIcon(item.icon)}</span><span>${item.label}</span>`;
      const control = item.children
        ? `<button class="nav-group-trigger" type="button" aria-expanded="${active}" aria-controls="nav-children-${index}">${content}<i class="nav-chevron">${appIcon('chevron')}</i></button>`
        : `<button class="nav-group-trigger nav-unavailable" type="button" disabled title="${item.label} is not available in this preview">${content}</button>`;
      const children = item.children ? `<div class="nav-children" id="nav-children-${index}" ${active ? '' : 'hidden'}>${item.children.map(child => {
        const current = !!child.href && (path === child.href || (child.href === item.path && active && !item.children!.some(other => other.href !== item.path && other.href === path)));
        return child.href ? `<a href="${child.href}" class="${current ? 'current' : ''}" ${current ? 'aria-current="page"' : ''}>${child.label}</a>` : `<button class="nav-unavailable" type="button" disabled title="Not available in this preview">${child.label}</button>`;
      }).join('')}</div>` : '';
      return `<div class="nav-group ${active ? 'active expanded' : ''}">${control}${children}</div>`;
    }).join('')}</nav>
    <div class="sidebar-bottom"><span class="avatar">AS</span><div><strong>Alex Singh</strong><small>Demo administrator</small></div><span class="sidebar-online" aria-label="Demo workspace"></span></div>
  </aside><button class="sidebar-scrim" type="button" aria-label="Close navigation" tabindex="-1" hidden></button>`;
}

const quickLinks = [
  { label: 'Manage Campaigns', href: '/campaigns', group: 'Campaigns' },
  { label: 'Create Campaign', href: '/campaigns/create', group: 'Campaigns' },
  { label: 'Manage Publishers', href: '/publishers', group: 'Publishers' },
  { label: 'Create Publisher', href: '/publishers/create', group: 'Publishers' },
  { label: 'PostBack / Pixels', href: '/publishers/postbacks', group: 'Publishers' },
];

export function renderAppHeader(breadcrumbs: AppBreadcrumb[]): string {
  return `<header class="topbar shared-topbar">
    <div class="topbar-left"><button class="menu-button" type="button" aria-label="Open menu" aria-controls="app-sidebar" aria-expanded="false">${appIcon('menu')}</button>
    <nav class="crumb" aria-label="Breadcrumb">${breadcrumbs.map((item, index) => `${index ? '<span aria-hidden="true">/</span>' : ''}${item.href && index !== breadcrumbs.length - 1 ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>` : `<strong ${index === breadcrumbs.length - 1 ? 'aria-current="page"' : ''}>${escapeHtml(item.label)}</strong>`}`).join('')}</nav></div>
    <div class="topbar-actions"><span class="shell-demo-badge">Demo workspace</span>
    <button type="button" class="shell-icon-button" data-shell-panel="shell-search" aria-label="Search pages" aria-expanded="false" aria-controls="shell-search">${appIcon('search')}</button>
    <button type="button" class="shell-icon-button" data-shell-panel="shell-notifications" aria-label="Notifications" aria-expanded="false" aria-controls="shell-notifications">${appIcon('bell')}</button>
    <button type="button" class="shell-icon-button shell-help-button" data-shell-panel="shell-help" aria-label="Help" aria-expanded="false" aria-controls="shell-help">${appIcon('help')}</button>
    <button class="profile-menu" type="button" data-shell-panel="shell-profile" aria-label="Profile menu for Alex Singh" aria-expanded="false" aria-controls="shell-profile"><span class="avatar">AS</span><span>Alex Singh</span>${appIcon('chevron')}</button></div>
    <section class="shell-popover shell-search-panel" id="shell-search" aria-label="Search pages" hidden><label for="shell-search-input">Find a page</label><div class="shell-search-field">${appIcon('search')}<input id="shell-search-input" type="search" placeholder="Search campaigns, publishers…" autocomplete="off"/></div><div class="shell-search-results">${quickLinks.map(link => `<a data-shell-search-link href="${link.href}"><span>${link.label}</span><small>${link.group}</small></a>`).join('')}</div><p id="shell-search-empty" hidden>No matching pages.</p></section>
    <section class="shell-popover" id="shell-notifications" aria-label="Notifications" hidden><h2>Notifications</h2><div class="shell-popover-empty">${appIcon('bell')}<strong>You're all caught up</strong><p>No notifications in this demo workspace.</p></div></section>
    <section class="shell-popover" id="shell-help" aria-label="Workspace help" hidden><h2>Workspace help</h2><p>Manage your campaigns and publishers from the sidebar. This preview uses demo data.</p><a href="/publishers">Browse publishers ${appIcon('arrow')}</a><a href="/campaigns">Browse campaigns ${appIcon('arrow')}</a></section>
    <section class="shell-popover" id="shell-profile" aria-label="Profile" hidden><div class="shell-profile-summary"><span class="avatar">AS</span><div><strong>Alex Singh</strong><small>Demo administrator</small></div></div><p>Account preferences and sign-out are unavailable in this demo workspace.</p></section>
  </header>`;
}

let shellController: AbortController | undefined;

export function bindAppShell(): void {
  shellController?.abort();
  shellController = new AbortController();
  const { signal } = shellController;
  const sidebar = document.querySelector<HTMLElement>('.shared-sidebar');
  const main = document.querySelector<HTMLElement>('.campaign-main');
  const menuButton = document.querySelector<HTMLButtonElement>('.shared-topbar .menu-button');
  const scrim = document.querySelector<HTMLButtonElement>('.sidebar-scrim');
  if (!sidebar || !main || !menuButton || !scrim) return;
  const compact = window.matchMedia('(max-width: 1050px)');
  let drawerOpen = false;
  let activePanel: HTMLElement | null = null;
  let panelTrigger: HTMLButtonElement | null = null;

  const closePanel = (restoreFocus = false) => {
    if (activePanel) activePanel.hidden = true;
    panelTrigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) panelTrigger?.focus();
    activePanel = null;
    panelTrigger = null;
  };
  const setDrawer = (open: boolean, restoreFocus = true) => {
    drawerOpen = compact.matches && open;
    document.body.classList.toggle('nav-open', drawerOpen);
    sidebar.inert = compact.matches && !drawerOpen;
    sidebar.setAttribute('aria-hidden', String(sidebar.inert));
    main.inert = drawerOpen;
    menuButton.setAttribute('aria-expanded', String(drawerOpen));
    scrim.hidden = !drawerOpen;
    if (drawerOpen) {
      closePanel();
      sidebar.querySelector<HTMLElement>('.sidebar-close')?.focus();
    } else if (restoreFocus && compact.matches) menuButton.focus();
  };
  setDrawer(false, false);
  menuButton.addEventListener('click', () => setDrawer(!drawerOpen), { signal });
  sidebar.querySelector('.sidebar-close')?.addEventListener('click', () => setDrawer(false), { signal });
  scrim.addEventListener('click', () => setDrawer(false), { signal });
  compact.addEventListener('change', () => setDrawer(false, false), { signal });

  sidebar.querySelectorAll<HTMLButtonElement>('.nav-group-trigger[aria-controls]').forEach(button => {
    button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(expanded));
      button.closest('.nav-group')?.classList.toggle('expanded', expanded);
      const children = document.getElementById(button.getAttribute('aria-controls')!);
      if (children) children.hidden = !expanded;
    }, { signal });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-shell-panel]').forEach(button => {
    button.addEventListener('click', () => {
      const wasOpen = button === panelTrigger;
      closePanel();
      if (wasOpen) return;
      activePanel = document.getElementById(button.dataset.shellPanel!);
      panelTrigger = button;
      if (!activePanel) return;
      activePanel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      activePanel.querySelector<HTMLInputElement>('input')?.focus();
    }, { signal });
  });
  document.querySelector<HTMLInputElement>('#shell-search-input')?.addEventListener('input', event => {
    const value = (event.target as HTMLInputElement).value.trim().toLowerCase();
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-shell-search-link]')];
    links.forEach(link => link.hidden = !link.textContent?.toLowerCase().includes(value));
    document.getElementById('shell-search-empty')!.hidden = links.some(link => !link.hidden);
  }, { signal });
  document.addEventListener('click', event => {
    if (activePanel && !activePanel.contains(event.target as Node) && !panelTrigger?.contains(event.target as Node)) closePanel();
  }, { signal });
  document.addEventListener('focusin', event => {
    if (activePanel && !activePanel.contains(event.target as Node) && !panelTrigger?.contains(event.target as Node)) closePanel();
  }, { signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (activePanel) { closePanel(true); event.preventDefault(); }
      if (drawerOpen) { setDrawer(false); event.preventDefault(); }
    }
    if (event.key !== 'Tab' || !drawerOpen) return;
    const focusable = [...sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]')].filter(element => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === sidebar)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }, { signal });
}
