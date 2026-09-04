import './styles.css';
import { mountCampaignPage } from './campaign';
import { mountManageCampaignsPage } from './manage-campaigns';
import { mountCampaignDetailsPage } from './campaign-details';

document.addEventListener('click', event => {
  const editLink = (event.target as HTMLElement).closest<HTMLAnchorElement>('.details-title a.btn-primary, .detail-actions a.icon-action');
  const match = window.location.pathname.match(/^\/campaigns\/(\d+)$/);
  if (editLink && match) {
    event.preventDefault();
    window.location.assign(`/campaigns/${match[1]}/edit`);
    return;
  }
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('.nav-group > a');
  const group = link?.parentElement;
  if (group?.querySelector(':scope > .nav-children')) {
    event.preventDefault();
    group.classList.toggle('expanded');
  }
});

const route = window.location.pathname.replace(/\/+$/, '');
if (route === '/campaigns/create') {
  mountCampaignPage();
} else if (route === '/campaigns') {
  mountManageCampaignsPage();
} else if (/^\/campaigns\/\d+$/.test(route)) {
  mountCampaignDetailsPage(Number(route.split('/').pop()));
} else if (/^\/campaigns\/\d+\/edit$/.test(route)) {
  mountCampaignPage(Number(route.split('/')[2]));
} else {

const icons = {
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h17v11h-17z"/><path d="m4 7 8 6 8-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5 9.5-5 9.5 5 9.5 5-3.4 5-9.5 5-9.5-5-9.5-5Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.6 6.2A11.8 11.8 0 0 1 12 6c6.1 0 9.5 6 9.5 6a17.7 17.7 0 0 1-3 3.5M6.1 6.1A17.2 17.2 0 0 0 2.5 12S5.9 18 12 18c1.3 0 2.5-.3 3.5-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c.8-3.6 3.3-5.5 7.5-5.5s6.7 1.9 7.5 5.5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 7l5 5-5 5"/></svg>',
};

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <section class="login-shell" aria-labelledby="login-title">
    <div class="auth-card login-card">
      <aside class="brand-panel" aria-labelledby="brand-heading">
        <div class="brand-orb orb-one"></div><div class="brand-orb orb-two"></div>
        <a class="wordmark" href="/" aria-label="AdstrackIO home">
          <span class="mark"><i></i><i></i><i></i></span><span>Adstrack<span>IO</span></span>
        </a>
        <div class="brand-copy">
          <p class="eyebrow">PERFORMANCE MARKETING, SIMPLIFIED.</p>
          <h1 id="brand-heading">Access your<br />AdstrackIO Dashboard</h1>
          <p>Manage your campaigns, tracking, conversions and performance from one powerful platform.</p>
        </div>
        <div class="dashboard-art" aria-label="Abstract performance analytics illustration" role="img">
          <div class="art-topbar"><span></span><span></span><span></span><b></b></div>
          <div class="art-body">
            <nav><em></em><em></em><em></em><em></em></nav>
            <div class="art-content">
              <div class="art-head"><b>Campaign performance</b><small>Last 30 days</small></div>
              <div class="metrics"><div><small>Revenue</small><strong>$48.2k</strong><span class="positive">↗ 18.4%</span></div><div><small>Conversions</small><strong>12,487</strong><span class="positive">↗ 12.8%</span></div></div>
              <div class="chart"><span style="height: 23%"></span><span style="height: 40%"></span><span style="height: 32%"></span><span style="height: 66%"></span><span style="height: 53%"></span><span style="height: 78%"></span><span style="height: 94%"></span></div>
            </div>
          </div>
          <div class="art-float"><span class="float-dot"></span><div><small>Live conversions</small><strong>+ 124 today</strong></div></div>
        </div>
        <p class="panel-tagline">Track clicks. Measure conversions. Optimize every campaign.</p>
      </aside>
      <section class="form-panel">
        <div class="form-content">
          <div class="form-heading"><p class="eyebrow">WELCOME BACK</p><h2 id="login-title">Login</h2><p>Sign in to continue to your AdstrackIO dashboard.</p></div>
          <form id="login-form" class="theme-form" novalidate>
            <div class="field-group">
              <label for="email">Email <span aria-hidden="true">*</span></label>
              <div class="input-wrap"><span class="input-icon">${icons.mail}</span><input class="form-control" id="email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="you@company.com" required aria-describedby="email-error" /></div>
              <p class="field-error" id="email-error" role="alert"></p>
            </div>
            <div class="field-group">
              <label for="password">Password <span aria-hidden="true">*</span></label>
              <div class="input-wrap"><span class="input-icon">${icons.lock}</span><input class="form-control" id="password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required aria-describedby="password-error" /><button class="toggle-password" type="button" aria-label="Show password" aria-pressed="false">${icons.eye}</button></div>
              <p class="field-error" id="password-error" role="alert"></p>
            </div>
            <div class="form-options"><label class="checkbox-label"><input type="checkbox" name="remember" /><span class="checkbox-ui" aria-hidden="true"></span>Remember me <small>(30 days)</small></label><a href="#forgot-password">Forgot your password?</a></div>
            <p class="form-status" aria-live="polite"></p>
            <button class="login-button btn btn-primary" type="submit"><span class="button-label">Log In</span><span class="spinner" aria-hidden="true"></span><span class="button-arrow">${icons.arrow}</span></button>
          </form>
          <div class="signup-section"><div class="divider"><span>New to AdstrackIO?</span></div><p>Don't have an account? <strong>Create one now:</strong></p><div class="signup-actions"><a class="outline-button btn btn-outline-primary" href="#publisher-signup"><span>${icons.user}</span>Sign up as Publisher</a><a class="outline-button btn btn-outline-primary" href="#advertiser-signup"><span>${icons.user}</span>Sign up as Advertiser</a></div></div>
        </div>
        <footer><span>© 2026 AdstrackIO</span><span class="footer-links"><a href="#privacy">Privacy Policy</a><a href="#terms">Terms &amp; Conditions</a></span></footer>
      </section>
    </div>
  </section>`;

const form = document.querySelector<HTMLFormElement>('#login-form')!;
const email = document.querySelector<HTMLInputElement>('#email')!;
const password = document.querySelector<HTMLInputElement>('#password')!;
const passwordToggle = document.querySelector<HTMLButtonElement>('.toggle-password')!;
const status = document.querySelector<HTMLParagraphElement>('.form-status')!;

function setError(input: HTMLInputElement, message: string): boolean {
  const error = document.querySelector<HTMLParagraphElement>(`#${input.id}-error`)!;
  error.textContent = message;
  input.setAttribute('aria-invalid', String(Boolean(message)));
  input.closest('.input-wrap')?.classList.toggle('has-error', Boolean(message));
  return !message;
}

function validate(): boolean {
  const emailValid = setError(email, !email.value.trim() ? 'Enter your email address.' : !email.validity.valid ? 'Enter a valid email address.' : '');
  const passwordValid = setError(password, password.value ? '' : 'Enter your password.');
  return emailValid && passwordValid;
}

email.addEventListener('blur', () => validate());
password.addEventListener('blur', () => validate());
passwordToggle.addEventListener('click', () => {
  const isHidden = password.type === 'password';
  password.type = isHidden ? 'text' : 'password';
  passwordToggle.innerHTML = isHidden ? icons.eyeOff : icons.eye;
  passwordToggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  passwordToggle.setAttribute('aria-pressed', String(isHidden));
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  status.textContent = '';
  validate();
});
}
