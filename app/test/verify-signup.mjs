import { fileURLToPath } from 'node:url';
// Portable base: this file lives in app/test/, so app/ is one level up.
const APP = new URL('../', import.meta.url).href;            // file:///.../app/
const APP_DIR = fileURLToPath(APP);                          // native path

import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
import fs from 'fs';
const html = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const vc = new VirtualConsole(); const errs = [];
vc.on('jsdomError', e => errs.push(String(e && e.message || e)));
const dom = new JSDOM(html, { url: 'https://melthahonda.com/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window;
w.fetch = async () => new Response(JSON.stringify({ products: [], total: 0 }), { headers: { 'content-type': 'application/json' } });
w.matchMedia = w.matchMedia || (() => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }));
w.scrollTo = () => {};
w.addEventListener('error', e => errs.push('win:' + (e.error && e.error.message || e.message)));
await new Promise(r => w.addEventListener('load', r, { once: true }));
await new Promise(r => setTimeout(r, 800));
const d = w.document;
const cta = d.getElementById('heroSignupCta');
console.log('heroSignupCta present:', !!cta);
console.log('  text:', cta && JSON.stringify(cta.textContent.trim()));
console.log('  visible (not display:none):', cta && cta.style.display !== 'none');
console.log('window._foxdOpenSignup is fn:', typeof w._foxdOpenSignup);
console.log('window._foxdOpenSignin is fn:', typeof w._foxdOpenSignin);
// click it -> modal opens on the signup tab
const before = d.getElementById('signinOverlay') && d.getElementById('signinOverlay').style.display;
if (cta) cta.click();
await new Promise(r => setTimeout(r, 100));
const ov = d.getElementById('signinOverlay');
const activeTab = ov && ov.querySelector('#signinTabs button.active');
console.log('modal display before click:', before, '-> after:', ov && ov.style.display);
console.log('active tab after click:', activeTab && activeTab.dataset.tab, '(expect signup)');
console.log('name field shown:', d.getElementById('suNameWrap').style.display !== 'none');
console.log('submit btn label:', JSON.stringify(d.getElementById('signinSubmit').textContent));
// logged-in state hides the CTA
w.localStorage.setItem('mh_user', JSON.stringify({ email: 'x@y.com', name: 'X' }));
w._foxdRefreshUI();
console.log('CTA hidden when signed in:', d.getElementById('heroSignupCta').style.display === 'none');
const ne = errs.filter(e => !/Could not parse CSS|Not implemented|getContext/i.test(e));
console.log('uncaught JS errors:', ne.length, ne.slice(0, 3));
console.log('"Staff Portal" still absent:', !/staff\s*portal/i.test(html));
