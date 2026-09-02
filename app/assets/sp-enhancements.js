/* =====================================================================
   SPEED PLUS ENHANCEMENTS · auto parts + general merchandise
   ---------------------------------------------------------------------
   Drop-in script that adds shopper-facing features tuned for an auto
   parts shop. Self-installs on page load. Skips silently if a feature
   is already installed (so it's safe to include twice).
   ---------------------------------------------------------------------
   Features:
     1. Vehicle Fitment Finder      (year / make / model selector)
     2. Service Booking Widget      (install / fitting appointments)
     3. Loyalty Rewards             (points by phone, redeemable)
     4. Quick Reorder               (past inquiries, 1-click resend)
     5. Compare Products            (side-by-side, up to 3 items)
     6. Bundle / Multi-buy Pricing  (4-tire discount, etc.)
     7. Floating "Help me find a part" launcher
   ---------------------------------------------------------------------
   No external dependencies. Browser-only. localStorage backed.
   Multi-tenant safe — keys are namespaced under sp_*.
   ===================================================================== */
(function(){
'use strict';
if(window.__mortysautoEnhancements) return;
window.__mortysautoEnhancements = true;

/* ---------- helpers ---------- */
function r(k, fb){ try{const v=localStorage.getItem(k);return v?JSON.parse(v):fb}catch(_){return fb} }
function w(k, v){ try{localStorage.setItem(k, JSON.stringify(v))}catch(_){} }
function $(s, el){ return (el||document).querySelector(s) }
function $$(s, el){ return Array.from((el||document).querySelectorAll(s)) }
function el(tag, attrs, html){
  const e = document.createElement(tag);
  if(attrs) for(const [k,v] of Object.entries(attrs)) e.setAttribute(k, v);
  if(html != null) e.innerHTML = html;
  return e;
}
function money(n){ return 'J$' + Math.round(Number(n)||0).toLocaleString('en-JM') }
function toast(msg, kind){
  const t = el('div', { class:'sp-toast ' + (kind||'') });
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>{ t.classList.add('sp-toast-show') }, 10);
  setTimeout(()=>{ t.classList.remove('sp-toast-show'); setTimeout(()=>t.remove(), 320) }, 2400);
}

/* ---------- styles ---------- */
const STYLES = `
.sp-fab-stack{position:fixed;left:18px;bottom:18px;display:flex;flex-direction:column;gap:10px;z-index:9000;align-items:flex-start}
.sp-fab{background:linear-gradient(135deg,#ffcb05,#e8b800);color:#0a0a0c;border:none;border-radius:24px;padding:11px 16px;font-weight:800;font-family:Inter,sans-serif;font-size:13px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28);display:inline-flex;align-items:center;gap:8px;letter-spacing:.02em;transition:transform .15s}
.sp-fab:hover{transform:translateY(-2px)}
.sp-fab.red{background:linear-gradient(135deg,#d61f2b,#a31420);color:#fff}
.sp-fab.black{background:#0a0a0c;color:#ffcb05;border:1px solid #ffcb05}
.sp-fab .badge-pts{background:#0a0a0c;color:#ffcb05;border-radius:10px;padding:1px 7px;font-size:11px;margin-left:4px}

.sp-modal{position:fixed;inset:0;background:rgba(10,10,12,.72);z-index:10000;display:none;align-items:center;justify-content:center;padding:18px}
.sp-modal.open{display:flex}
.sp-modal-inner{background:#fff;border-radius:14px;max-width:640px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 30px 60px rgba(0,0,0,.4);position:relative}
.sp-modal-head{padding:18px 22px;border-bottom:1px solid #e2e5e8;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;background:linear-gradient(135deg,#0a0a0c,#1a1410);color:#fff;border-radius:14px 14px 0 0}
.sp-modal-head h3{font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:.04em;line-height:1.1}
.sp-modal-head p{font-size:13px;opacity:.7;margin-top:4px}
.sp-close{background:transparent;border:1px solid rgba(255,255,255,.3);color:#fff;width:34px;height:34px;border-radius:50%;font-size:18px;cursor:pointer;flex-shrink:0}
.sp-close:hover{background:rgba(255,255,255,.12)}
.sp-modal-body{padding:22px}
.sp-modal-foot{padding:14px 22px;border-top:1px solid #e2e5e8;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;background:#fafbfc;border-radius:0 0 14px 14px}

.sp-field{margin-bottom:14px}
.sp-field label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#5a6470;margin-bottom:5px}
.sp-field select,.sp-field input,.sp-field textarea{width:100%;border:1.5px solid #e2e5e8;border-radius:8px;padding:9px 11px;font-size:14px;font-family:inherit;background:#fff}
.sp-field select:focus,.sp-field input:focus,.sp-field textarea:focus{outline:none;border-color:#d61f2b;box-shadow:0 0 0 3px rgba(214,31,43,.12)}
.sp-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:520px){.sp-row{grid-template-columns:1fr}}

.sp-btn{padding:10px 18px;border-radius:8px;font-weight:800;font-family:Inter,sans-serif;font-size:13px;cursor:pointer;border:none;letter-spacing:.02em}
.sp-btn-primary{background:linear-gradient(135deg,#d61f2b,#a31420);color:#fff}
.sp-btn-primary:hover{box-shadow:0 4px 12px rgba(214,31,43,.3)}
.sp-btn-gold{background:linear-gradient(135deg,#ffcb05,#e8b800);color:#0a0a0c}
.sp-btn-ghost{background:#fff;color:#1a1d22;border:1.5px solid #e2e5e8}
.sp-btn-ghost:hover{border-color:#d61f2b;color:#d61f2b}

.sp-vehicle-pill{display:inline-flex;align-items:center;gap:6px;background:#fffbe6;border:1.5px solid #ffcb05;color:#5e3a18;padding:5px 11px;border-radius:18px;font-size:12px;font-weight:800;cursor:pointer;letter-spacing:.02em}
.sp-vehicle-pill:hover{background:#ffcb05;color:#0a0a0c}

.sp-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,30px);background:#0a0a0c;color:#fff;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:600;opacity:0;transition:.3s;z-index:10500;box-shadow:0 8px 24px rgba(0,0,0,.3)}
.sp-toast-show{opacity:1;transform:translate(-50%,0)}
.sp-toast.ok{background:#0a6a3a}.sp-toast.err{background:#a31420}

.sp-bundle-bar{background:linear-gradient(135deg,#fef3c7,#ffecb3);border:1.5px dashed #d4a017;color:#5e3a18;padding:10px 14px;border-radius:10px;margin:14px 0;font-size:13px;font-weight:700;display:flex;align-items:center;gap:10px}
.sp-bundle-bar .ic{font-size:22px}

.sp-cmp-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:6px}
.sp-cmp-item{border:1px solid #e2e5e8;border-radius:10px;padding:12px;background:#fafbfc;font-size:13px}
.sp-cmp-item h5{font-family:'Bebas Neue',sans-serif;font-size:1.05rem;margin-bottom:4px;letter-spacing:.04em;color:#1a1d22}
.sp-cmp-item .pr{font-size:1.1rem;font-weight:900;color:#d61f2b;margin:6px 0}

.sp-loyalty-row{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#fafbfc;border-radius:10px;margin-bottom:8px;font-size:13px}
.sp-loyalty-row .pts{font-family:'Bebas Neue',sans-serif;font-size:1.2rem;color:#d61f2b;letter-spacing:.04em}

.sp-svc-tile{border:1.5px solid #e2e5e8;border-radius:10px;padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:.15s}
.sp-svc-tile:hover{border-color:#d61f2b;background:#fffaf9}
.sp-svc-tile.on{border-color:#d61f2b;background:#fff1f2}
.sp-svc-tile .em{font-size:24px}
.sp-svc-tile .lbl{font-weight:700;font-size:14px}
.sp-svc-tile .pr{font-size:11px;color:#5a6470}

.sp-svc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
@media(max-width:520px){.sp-svc-grid{grid-template-columns:1fr}}

.sp-empty{text-align:center;padding:30px;color:#5a6470;font-size:13px}
.sp-empty .ic{font-size:36px;display:block;margin-bottom:8px;opacity:.5}
`;
document.head.appendChild(el('style', null, STYLES));

/* ---------- VEHICLE FITMENT FINDER ---------- */
// JM-common car list — could be expanded; we keep it broad and editable
const MAKES = {
  'Toyota':    ['Corolla','Camry','RAV4','Hilux','Probox','Yaris','Fortuner','Land Cruiser','Vitz','Mark X','Crown','Noah','Voxy'],
  'Nissan':    ['Tiida','Sunny','Almera','X-Trail','Navara','Note','Wingroad','Patrol','Skyline','March','Cube','Latio'],
  'Honda':     ['Civic','Accord','CR-V','Fit','City','HR-V','Stream','Stepwgn','Odyssey'],
  'Mazda':     ['3','6','CX-3','CX-5','CX-7','Demio','BT-50','Axela','Atenza','Premacy'],
  'Mitsubishi':['Lancer','Outlander','ASX','Galant','Pajero','L200','Colt','Mirage'],
  'Subaru':    ['Impreza','Forester','Outback','Legacy','XV','WRX'],
  'Suzuki':    ['Swift','Vitara','Jimny','Alto','Wagon R','SX4'],
  'Hyundai':   ['Tucson','Elantra','Accent','Santa Fe','i10','i20','Sonata','Creta'],
  'Kia':       ['Rio','Sportage','Picanto','Cerato','Sorento','Soul'],
  'Ford':      ['Ranger','Focus','Fiesta','Escape','Edge','F-150','Explorer'],
  'BMW':       ['1 Series','3 Series','5 Series','X1','X3','X5'],
  'Mercedes':  ['A-Class','C-Class','E-Class','GLA','GLC','GLE'],
  'Volkswagen':['Golf','Polo','Tiguan','Passat','Jetta'],
  'Lexus':     ['IS','ES','RX','NX','GX'],
  'Isuzu':     ['D-Max','MU-X','NPR'],
  'Chevrolet': ['Aveo','Cruze','Captiva','Spark','Tahoe','Silverado'],
  'Audi':      ['A3','A4','A6','Q3','Q5','Q7'],
  'Other':     ['—']
};
const YEARS = (() => {
  const y = new Date().getFullYear();
  const arr = [];
  for(let v = y+1; v >= 1995; v--) arr.push(v);
  return arr;
})();

function loadVehicle(){ return r('sp_vehicle', null) }
function saveVehicle(v){ w('sp_vehicle', v) }

function openFitment(){
  const v = loadVehicle();
  const mdl = $('#spFitmentModal') || makeFitmentModal();
  $('#spFitYear', mdl).value = v?.year || '';
  populateMake(mdl);
  $('#spFitMake', mdl).value = v?.make || '';
  populateModel(mdl);
  $('#spFitModel', mdl).value = v?.model || '';
  $('#spFitVin', mdl).value = v?.vin || '';
  mdl.classList.add('open');
}

function makeFitmentModal(){
  const m = el('div', { id:'spFitmentModal', class:'sp-modal' });
  m.innerHTML = `
    <div class="sp-modal-inner">
      <div class="sp-modal-head">
        <div><h3>🔧 Find Parts For My Vehicle</h3><p>Set your car once — every product page filters to your fitment automatically.</p></div>
        <button class="sp-close" data-act="close">×</button>
      </div>
      <div class="sp-modal-body">
        <div class="sp-row">
          <div class="sp-field"><label>Year</label><select id="spFitYear"><option value="">— Select —</option>${YEARS.map(y=>`<option>${y}</option>`).join('')}</select></div>
          <div class="sp-field"><label>Make</label><select id="spFitMake"><option value="">— Select —</option></select></div>
        </div>
        <div class="sp-row">
          <div class="sp-field"><label>Model</label><select id="spFitModel"><option value="">— Select —</option></select></div>
          <div class="sp-field"><label>Trim / Engine (optional)</label><input id="spFitTrim" placeholder="e.g. 1.5L Turbo, 4WD"></div>
        </div>
        <div class="sp-field">
          <label>VIN (optional — paste from your registration)</label>
          <input id="spFitVin" placeholder="17-character VIN" maxlength="17">
        </div>
        <div style="font-size:12px;color:#5a6470;background:#fafbfc;padding:10px;border-radius:8px">
          💡 Once saved, every product card shows compatibility. Tires &amp; rims size-match by make/model lookup, brake parts and filters match by VIN where available.
        </div>
      </div>
      <div class="sp-modal-foot">
        <button class="sp-btn sp-btn-ghost" data-act="clear">Clear vehicle</button>
        <button class="sp-btn sp-btn-ghost" data-act="close">Cancel</button>
        <button class="sp-btn sp-btn-primary" data-act="save">Save Vehicle</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  $('#spFitMake', m).onchange = () => populateModel(m);
  m.addEventListener('click', (e) => {
    const a = e.target.dataset && e.target.dataset.act;
    if(a === 'close' || e.target === m) m.classList.remove('open');
    if(a === 'clear'){ saveVehicle(null); renderVehiclePill(); toast('Vehicle cleared'); m.classList.remove('open'); }
    if(a === 'save'){
      const v = {
        year:  $('#spFitYear', m).value,
        make:  $('#spFitMake', m).value,
        model: $('#spFitModel', m).value,
        trim:  $('#spFitTrim', m).value,
        vin:   $('#spFitVin', m).value.trim().toUpperCase()
      };
      if(!v.year || !v.make){ toast('Pick year and make at minimum', 'err'); return; }
      saveVehicle(v);
      renderVehiclePill();
      toast('Vehicle saved · products will be filtered', 'ok');
      m.classList.remove('open');
      window.dispatchEvent(new CustomEvent('sp:vehicle-changed', { detail: v }));
    }
  });
  return m;
}
function populateMake(m){
  const sel = $('#spFitMake', m);
  sel.innerHTML = `<option value="">— Select —</option>` + Object.keys(MAKES).map(k=>`<option>${k}</option>`).join('');
}
function populateModel(m){
  const sel = $('#spFitModel', m);
  const make = $('#spFitMake', m).value;
  const models = MAKES[make] || [];
  sel.innerHTML = `<option value="">— Select —</option>` + models.map(k=>`<option>${k}</option>`).join('');
}

function renderVehiclePill(){
  const host = $('#spVehiclePillHost');
  if(!host) return;
  const v = loadVehicle();
  host.innerHTML = '';
  const pill = el('button', { class:'sp-vehicle-pill', title:'Click to change vehicle' });
  if(v && v.year && v.make){
    pill.innerHTML = `🚗 ${v.year} ${v.make} ${v.model||''} <span style="opacity:.7;margin-left:4px">change</span>`;
  } else {
    pill.innerHTML = `🔧 Set my vehicle for fitment`;
  }
  pill.onclick = openFitment;
  host.appendChild(pill);
}

/* ---------- SERVICE BOOKING ---------- */
const SERVICES = [
  { id:'tires',    em:'🛞', lbl:'Tire fitting',        from:'J$500/wheel' },
  { id:'rims',     em:'⚙️', lbl:'Rim swap',             from:'J$1,200/wheel' },
  { id:'brakes',   em:'🛑', lbl:'Brake service',        from:'J$3,500/axle' },
  { id:'audio',    em:'🔊', lbl:'Audio install',        from:'From J$3,000' },
  { id:'tint',     em:'🪟', lbl:'Window tint',          from:'2-4 hours' },
  { id:'battery',  em:'🔋', lbl:'Battery + install',    from:'Free w/ purchase' },
  { id:'lighting', em:'💡', lbl:'Lighting install',     from:'J$2,000+' },
  { id:'alarm',    em:'🛡️', lbl:'Alarm / remote start', from:'J$4,500+' },
  { id:'suspension',em:'🏎️', lbl:'Suspension work',     from:'Quote on site' },
  { id:'inspect',  em:'🔎', lbl:'Pre-purchase inspection', from:'J$5,000' }
];

function openBooking(preselectId){
  const v = loadVehicle();
  const mdl = $('#spBookingModal') || makeBookingModal();
  // reset state
  $('#spSvcGrid', mdl).querySelectorAll('.sp-svc-tile').forEach(t => t.classList.remove('on'));
  if(preselectId){
    const tile = $('#spSvcGrid', mdl).querySelector(`[data-svc="${preselectId}"]`);
    if(tile) tile.classList.add('on');
  }
  // prefill
  if(v && v.year){
    $('#spBkVehicle', mdl).value = `${v.year} ${v.make} ${v.model||''}`.trim();
  }
  // default date = tomorrow
  const tom = new Date(); tom.setDate(tom.getDate()+1);
  $('#spBkDate', mdl).value = tom.toISOString().slice(0,10);
  $('#spBkDate', mdl).min  = new Date().toISOString().slice(0,10);
  $('#spBkTime', mdl).value = '10:00';
  mdl.classList.add('open');
}

function makeBookingModal(){
  const m = el('div', { id:'spBookingModal', class:'sp-modal' });
  m.innerHTML = `
    <div class="sp-modal-inner">
      <div class="sp-modal-head">
        <div><h3>📅 Book a Service Appointment</h3><p>Pick the service, your car, and a slot. We'll WhatsApp confirm within an hour.</p></div>
        <button class="sp-close" data-act="close">×</button>
      </div>
      <div class="sp-modal-body">
        <label style="display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#5a6470;margin-bottom:6px">Service needed</label>
        <div class="sp-svc-grid" id="spSvcGrid">
          ${SERVICES.map(s => `
            <div class="sp-svc-tile" data-svc="${s.id}" onclick="this.parentElement.querySelectorAll('.sp-svc-tile').forEach(x=>x.classList.remove('on'));this.classList.add('on')">
              <div class="em">${s.em}</div>
              <div><div class="lbl">${s.lbl}</div><div class="pr">${s.from}</div></div>
            </div>
          `).join('')}
        </div>
        <div class="sp-row">
          <div class="sp-field"><label>Your name</label><input id="spBkName" placeholder="Full name"></div>
          <div class="sp-field"><label>WhatsApp / phone</label><input id="spBkPhone" placeholder="876-xxx-xxxx"></div>
        </div>
        <div class="sp-field"><label>Vehicle</label><input id="spBkVehicle" placeholder="Year Make Model"></div>
        <div class="sp-row">
          <div class="sp-field"><label>Preferred date</label><input id="spBkDate" type="date"></div>
          <div class="sp-field"><label>Preferred time</label><input id="spBkTime" type="time"></div>
        </div>
        <div class="sp-field"><label>Notes (optional)</label><textarea id="spBkNotes" rows="2" placeholder="Anything we should know"></textarea></div>
      </div>
      <div class="sp-modal-foot">
        <button class="sp-btn sp-btn-ghost" data-act="close">Cancel</button>
        <button class="sp-btn sp-btn-gold" data-act="wa">Send via WhatsApp</button>
        <button class="sp-btn sp-btn-primary" data-act="save">Book Appointment</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('click', (e) => {
    const a = e.target.dataset && e.target.dataset.act;
    if(a === 'close' || e.target === m) m.classList.remove('open');
    if(a === 'save' || a === 'wa'){
      const tile = $('#spSvcGrid', m).querySelector('.sp-svc-tile.on');
      if(!tile){ toast('Pick a service', 'err'); return; }
      const svc = SERVICES.find(s => s.id === tile.dataset.svc);
      const data = {
        id: 'BK-' + Date.now().toString(36).toUpperCase(),
        service: svc.lbl, serviceId: svc.id,
        name:  $('#spBkName', m).value.trim(),
        phone: $('#spBkPhone', m).value.trim(),
        vehicle: $('#spBkVehicle', m).value.trim(),
        date:  $('#spBkDate', m).value,
        time:  $('#spBkTime', m).value,
        notes: $('#spBkNotes', m).value.trim(),
        createdAt: new Date().toISOString()
      };
      if(!data.name || !data.phone || !data.date){ toast('Name, phone and date are required', 'err'); return; }
      const list = r('sp_bookings', []);
      list.push(data);
      w('sp_bookings', list);
      // Multi-tenant write so manager dashboards see this too
      const co = r('phi_co_speed-plus_bookings', []);
      co.push(data);
      w('phi_co_speed-plus_bookings', co);

      // Loyalty: +25 points for booking
      addPoints(data.phone, 25, 'Service booking: ' + svc.lbl);

      if(a === 'wa'){
        const msg = `Hi Morty's Auto, I'd like to book a ${svc.lbl}:\n\n• Name: ${data.name}\n• Phone: ${data.phone}\n• Vehicle: ${data.vehicle||'—'}\n• When: ${data.date} at ${data.time}\n${data.notes? '• Notes: '+data.notes+'\n':''}\nRef: ${data.id}`;
        window.open(`https://wa.me/18765550200?text=${encodeURIComponent(msg)}`, '_blank');
      }
      toast('Booking saved · ref ' + data.id, 'ok');
      m.classList.remove('open');
    }
  });
  return m;
}

/* ---------- LOYALTY REWARDS ---------- */
// keyed by phone number. Stores { phone, points, history:[{ts, delta, note}] }
function loyaltyGet(phone){
  const all = r('sp_loyalty', {});
  return all[phone] || { phone, points:0, history:[] };
}
function loyaltyAll(){ return r('sp_loyalty', {}) }
function loyaltySave(rec){
  const all = r('sp_loyalty', {});
  all[rec.phone] = rec;
  w('sp_loyalty', all);
}
function addPoints(phone, delta, note){
  if(!phone) return;
  const rec = loyaltyGet(phone);
  rec.points = Math.max(0, (rec.points||0) + delta);
  rec.history = rec.history || [];
  rec.history.push({ ts: Date.now(), delta, note: note||'' });
  loyaltySave(rec);
  // Remember active phone so the FAB badge can show current points
  if(delta > 0) w('sp_active_phone', phone);
  renderFabBadges();
}
window.spAddPoints = addPoints;

function activePhone(){ return r('sp_active_phone', null) }

function openRewards(){
  const mdl = $('#spRewardsModal') || makeRewardsModal();
  const ph = activePhone();
  const rec = ph ? loyaltyGet(ph) : null;
  $('#spLoyPhone', mdl).value = ph || '';
  renderLoyaltyInner(mdl, rec);
  mdl.classList.add('open');
}
function makeRewardsModal(){
  const m = el('div', { id:'spRewardsModal', class:'sp-modal' });
  m.innerHTML = `
    <div class="sp-modal-inner">
      <div class="sp-modal-head">
        <div><h3>⭐ Morty's Auto Rewards</h3><p>Earn points on purchases &amp; services. Redeem for discounts.</p></div>
        <button class="sp-close" data-act="close">×</button>
      </div>
      <div class="sp-modal-body">
        <div class="sp-field">
          <label>WhatsApp / phone</label>
          <input id="spLoyPhone" placeholder="876-xxx-xxxx">
        </div>
        <div id="spLoyInner"></div>
      </div>
      <div class="sp-modal-foot">
        <button class="sp-btn sp-btn-ghost" data-act="close">Close</button>
        <button class="sp-btn sp-btn-primary" data-act="lookup">Look up my points</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('click', (e) => {
    const a = e.target.dataset && e.target.dataset.act;
    if(a === 'close' || e.target === m) m.classList.remove('open');
    if(a === 'lookup'){
      const ph = $('#spLoyPhone', m).value.trim();
      if(!ph){ toast('Enter your phone number', 'err'); return; }
      w('sp_active_phone', ph);
      const rec = loyaltyGet(ph);
      renderLoyaltyInner(m, rec);
      renderFabBadges();
      toast('Points loaded', 'ok');
    }
  });
  return m;
}
function renderLoyaltyInner(m, rec){
  const inner = $('#spLoyInner', m);
  if(!rec){
    inner.innerHTML = `<div class="sp-empty"><span class="ic">🎟</span>Enter your phone to see your points balance.</div>
      <div style="font-size:12px;color:#5a6470;background:#fafbfc;padding:12px;border-radius:8px;margin-top:8px">
        <b>How to earn:</b><br>
        • +25 points per service booking<br>
        • +100 points per completed purchase (J$1 = 1 pt)<br>
        • +50 points for product reviews<br>
        <b>Redeem:</b> 500 pts = J$500 off · 2000 pts = J$2,500 off · 5000 pts = free install
      </div>`;
    return;
  }
  const tier = rec.points >= 5000 ? '🏆 Gold' : rec.points >= 2000 ? '🥈 Silver' : rec.points >= 500 ? '🥉 Bronze' : '🌱 Starter';
  const recent = (rec.history||[]).slice(-8).reverse();
  inner.innerHTML = `
    <div class="sp-loyalty-row">
      <div><div style="font-size:11px;color:#5a6470;text-transform:uppercase;letter-spacing:.08em;font-weight:700">Balance</div><div class="pts">${rec.points.toLocaleString('en-JM')} pts</div></div>
      <div style="text-align:right"><div style="font-size:11px;color:#5a6470;text-transform:uppercase;letter-spacing:.08em;font-weight:700">Tier</div><div style="font-weight:800">${tier}</div></div>
    </div>
    ${recent.length ? `
      <div style="font-size:11px;color:#5a6470;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin:14px 0 6px">Recent activity</div>
      ${recent.map(h => `
        <div class="sp-loyalty-row" style="font-size:12px">
          <div>
            <div style="font-weight:700">${h.note || '—'}</div>
            <div style="color:#5a6470;font-size:11px">${new Date(h.ts).toLocaleDateString('en-JM', { month:'short', day:'numeric', year:'numeric' })}</div>
          </div>
          <div style="font-weight:900;color:${h.delta>=0?'#0a6a3a':'#a31420'}">${h.delta>=0?'+':''}${h.delta} pts</div>
        </div>
      `).join('')}
    ` : ''}
    <div style="font-size:12px;color:#5a6470;background:#fafbfc;padding:10px;border-radius:8px;margin-top:10px">
      💡 Redeem at checkout — tell the cashier your phone number.
    </div>`;
}

/* ---------- BUNDLE / MULTI-BUY PRICING ---------- */
const BUNDLE_RULES = [
  { name:'4-tire deal',  match: items => items.filter(c => /tire|tyre/i.test(c.name||'')).reduce((s,c)=>s+c.qty,0) >= 4, discountPct: 8, label:'4+ tires — 8% off' },
  { name:'Brake combo',  match: items => items.some(c=>/brake.*pad/i.test(c.name||'')) && items.some(c=>/rotor|disc/i.test(c.name||'')), discountPct: 10, label:'Pads + rotors — 10% off' },
  { name:'Full audio',   match: items => items.some(c=>/head.?unit|amplifier/i.test(c.name||'')) && items.some(c=>/sub.?woofer|speaker/i.test(c.name||'')), discountPct: 12, label:'Audio bundle — 12% off' }
];
function computeBundle(cart){
  if(!cart || !cart.length) return null;
  for(const rule of BUNDLE_RULES){
    try { if(rule.match(cart)) return rule; } catch(_){}
  }
  return null;
}
// Drop-in helper that pages can call to apply bundle to a subtotal
window.spApplyBundle = function(cart, subtotal){
  const r = computeBundle(cart || []);
  if(!r) return { discount:0, label:null, rule:null };
  return { discount: Math.round(subtotal * r.discountPct/100), label: r.label, rule: r };
};

function injectBundleBar(){
  // If the page has a cart drawer, watch it and add the bundle bar
  const drawer = $('#cartDrawer');
  if(!drawer) return;
  const foot = $('.cart-foot', drawer);
  if(!foot) return;
  const watch = () => {
    let cart = [];
    try { cart = JSON.parse(localStorage.getItem('va_cart') || '[]'); } catch(_){}
    const bar = $('#spBundleBar', drawer);
    const rule = computeBundle(cart);
    if(rule){
      if(!bar){
        const b = el('div', { id:'spBundleBar', class:'sp-bundle-bar' }, `<span class="ic">🎁</span><div><b>Bundle bonus:</b> ${rule.label}</div>`);
        foot.parentElement.insertBefore(b, foot);
      } else {
        bar.innerHTML = `<span class="ic">🎁</span><div><b>Bundle bonus:</b> ${rule.label}</div>`;
      }
    } else if(bar){
      bar.remove();
    }
  };
  // Hook into addToCart events (the existing shop dispatches none, so we poll on storage events too)
  window.addEventListener('storage', e => { if(e.key === 'va_cart') watch(); });
  // Also re-check on a setInterval cheaply since updates inside same tab don't trigger storage event
  setInterval(watch, 1200);
  watch();
}

/* ---------- COMPARE PRODUCTS ---------- */
// Page can call window.spAddToCompare(p) to add a product
window.spAddToCompare = function(p){
  let list = r('va_compare', []);
  if(list.find(x => x.sku === p.sku)){ toast('Already in compare', 'err'); return; }
  if(list.length >= 3){ toast('Compare holds up to 3 items', 'err'); return; }
  list.push(p);
  w('va_compare', list);
  renderFabBadges();
  toast('Added to compare', 'ok');
};
function openCompare(){
  const list = r('va_compare', []);
  const mdl = $('#spCompareModal') || makeCompareModal();
  const body = $('.sp-modal-body', mdl);
  if(!list.length){
    body.innerHTML = `<div class="sp-empty"><span class="ic">⚖️</span>No products selected yet.<div style="margin-top:6px;font-size:12px">Use the ⚖️ button on product cards to add items.</div></div>`;
  } else {
    body.innerHTML = `<div class="sp-cmp-list">${list.map(p => `
      <div class="sp-cmp-item">
        <h5>${p.name||p.sku}</h5>
        <div style="font-size:11px;color:#5a6470">${p.brand||''} ${p.cat?' · '+p.cat:''}</div>
        <div class="pr">${money(p.price||0)}</div>
        ${p.rating?`<div style="font-size:12px">⭐ ${p.rating} ${p.reviews?'('+p.reviews+')':''}</div>`:''}
        ${p.stock!=null?`<div style="font-size:11px;color:${p.stock>0?'#0a6a3a':'#a31420'};font-weight:700">${p.stock>10?'In stock':p.stock>0?'Only '+p.stock+' left':'Out of stock'}</div>`:''}
        <button class="sp-btn sp-btn-ghost" style="margin-top:8px;width:100%" onclick="spRemoveCompare('${p.sku}')">Remove</button>
      </div>
    `).join('')}</div>
    <button class="sp-btn sp-btn-ghost" style="margin-top:12px" onclick="localStorage.removeItem('va_compare');document.getElementById('spCompareModal').classList.remove('open');spEnh.renderFabBadges();">Clear all</button>`;
  }
  mdl.classList.add('open');
}
window.spRemoveCompare = function(sku){
  let list = r('va_compare', []);
  list = list.filter(p => p.sku !== sku);
  w('va_compare', list);
  openCompare();
  renderFabBadges();
};
function makeCompareModal(){
  const m = el('div', { id:'spCompareModal', class:'sp-modal' });
  m.innerHTML = `
    <div class="sp-modal-inner">
      <div class="sp-modal-head">
        <div><h3>⚖️ Compare Products</h3><p>Up to 3 items side-by-side. Pick by clicking the ⚖️ on a product card.</p></div>
        <button class="sp-close" data-act="close">×</button>
      </div>
      <div class="sp-modal-body"></div>
      <div class="sp-modal-foot"><button class="sp-btn sp-btn-ghost" data-act="close">Close</button></div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('click', (e) => {
    const a = e.target.dataset && e.target.dataset.act;
    if(a === 'close' || e.target === m) m.classList.remove('open');
  });
  return m;
}

/* ---------- QUICK REORDER ---------- */
// Stored at sp_inquiries by the shop's existing checkout flow
function openHistory(){
  const inquiries = r('sp_inquiries', []);
  const mdl = $('#spHistoryModal') || makeHistoryModal();
  const body = $('.sp-modal-body', mdl);
  if(!inquiries.length){
    body.innerHTML = `<div class="sp-empty"><span class="ic">📋</span>No past inquiries on this device yet.<div style="margin-top:6px;font-size:12px">Submit an inquiry first — then you can re-send the same cart with one click.</div></div>`;
  } else {
    body.innerHTML = inquiries.slice(-15).reverse().map(inq => `
      <div class="sp-loyalty-row" style="align-items:flex-start;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
          <div>
            <div style="font-weight:800">${inq.items?.length || 0} items · ${money(inq.total||0)}</div>
            <div style="font-size:11px;color:#5a6470">${new Date(inq.createdAt||inq.ts||Date.now()).toLocaleString('en-JM', { dateStyle:'medium', timeStyle:'short' })}</div>
          </div>
          <button class="sp-btn sp-btn-gold" onclick="spReorder(${(inquiries.length-1) - inquiries.slice().reverse().indexOf(inq)})">Reorder</button>
        </div>
        <div style="font-size:12px;color:#5a6470;width:100%">${(inq.items||[]).slice(0,4).map(i=>i.name).join(' · ')}${(inq.items||[]).length>4?' · …':''}</div>
      </div>
    `).join('');
  }
  mdl.classList.add('open');
}
window.spReorder = function(idx){
  const inquiries = r('sp_inquiries', []);
  const inq = inquiries[idx];
  if(!inq){ toast('Inquiry not found', 'err'); return; }
  w('va_cart', inq.items || []);
  toast('Items added back to cart', 'ok');
  if($('#spHistoryModal')) $('#spHistoryModal').classList.remove('open');
  // open cart if the toggleCart function exists on the shop page
  if(typeof window.toggleCart === 'function') window.toggleCart();
};
function makeHistoryModal(){
  const m = el('div', { id:'spHistoryModal', class:'sp-modal' });
  m.innerHTML = `
    <div class="sp-modal-inner">
      <div class="sp-modal-head">
        <div><h3>🔁 Quick Reorder</h3><p>Re-send a previous inquiry with one tap.</p></div>
        <button class="sp-close" data-act="close">×</button>
      </div>
      <div class="sp-modal-body"></div>
      <div class="sp-modal-foot"><button class="sp-btn sp-btn-ghost" data-act="close">Close</button></div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('click', (e) => {
    const a = e.target.dataset && e.target.dataset.act;
    if(a === 'close' || e.target === m) m.classList.remove('open');
  });
  return m;
}

/* ---------- FLOATING ACTION STACK ---------- */
function makeFabStack(){
  if($('#spFabStack')) return;
  const stack = el('div', { id:'spFabStack', class:'sp-fab-stack' });
  stack.innerHTML = `
    <a class="sp-fab" id="spFabSpecial" href="special-order.html" style="text-decoration:none">📋 Special Order</a>
    <a class="sp-fab" id="spFabClearance" href="clearance.html" style="text-decoration:none;background:linear-gradient(135deg,#ea580c,#9a3412);color:#fff">🏷 Clearance</a>
    <a class="sp-fab" id="spFabDonate" href="donations.html" style="text-decoration:none;background:linear-gradient(135deg,#0d9488,#115e59);color:#fff">💝 Donations</a>
    <button class="sp-fab black" id="spFabRewards">⭐ Rewards <span class="badge-pts" id="spPtsBadge"></span></button>
    <button class="sp-fab red" id="spFabFit">🔧 Find My Parts</button>
  `;
  document.body.appendChild(stack);
  $('#spFabFit').onclick = openFitment;
  $('#spFabRewards').onclick = openRewards;
  renderFabBadges();
}

function renderFabBadges(){
  // Points badge
  const ph = activePhone();
  const badge = $('#spPtsBadge');
  if(badge){
    if(ph){
      const rec = loyaltyGet(ph);
      badge.textContent = rec.points ? rec.points.toLocaleString('en-JM') : '0';
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

/* ---------- INTEGRATION HOOKS FOR THE SHOP PAGE ---------- */
// Add a ⚖️ compare button to each product card when the shop renders the grid
function decorateProductCards(){
  const grid = $('#grid');
  if(!grid) return;
  // Watch for grid changes
  const mo = new MutationObserver(() => addCompareButtons());
  mo.observe(grid, { childList:true, subtree:true });
  addCompareButtons();
}
function addCompareButtons(){
  $$('#grid .product').forEach(card => {
    if(card.querySelector('.sp-cmp-btn')) return;
    const fav = card.querySelector('.fav');
    if(!fav) return;
    const sku = (fav.getAttribute('onclick')||'').match(/'([^']+)'/);
    if(!sku) return;
    const btn = el('button', { class:'sp-cmp-btn', title:'Compare', style:'position:absolute;top:10px;left:10px;background:rgba(255,255,255,.9);border:none;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.15);z-index:2' }, '⚖️');
    btn.onclick = (e) => {
      e.stopPropagation();
      // Find the product in the page's `products` array if exposed
      let p = null;
      if(window.products && Array.isArray(window.products)) p = window.products.find(x => x.sku === sku[1]);
      if(!p){
        // fallback: build a minimal record from the card
        p = {
          sku: sku[1],
          name: card.querySelector('h4')?.textContent || sku[1],
          brand: card.querySelector('.brand')?.textContent || '',
          price: Number((card.querySelector('.price')?.textContent||'').replace(/[^\d.]/g,'')) || 0
        };
      }
      window.spAddToCompare(p);
    };
    const img = card.querySelector('.img');
    if(img) img.appendChild(btn);
  });
}

// Award points on inquiry submission
function hookInquirySubmission(){
  // Wrap localStorage.setItem to detect new sp_inquiries entries
  const origCheckout = window.checkout;
  if(typeof origCheckout === 'function' && !origCheckout.__spWrapped){
    window.checkout = function(...args){
      const before = r('sp_inquiries', []).length;
      const result = origCheckout.apply(this, args);
      // After checkout, capture phone if it landed in inquiries
      setTimeout(() => {
        const after = r('sp_inquiries', []);
        if(after.length > before){
          const inq = after[after.length - 1];
          const phone = (inq.customer?.phone || inq.phone || '').trim();
          if(phone){
            w('sp_active_phone', phone);
            addPoints(phone, Math.max(50, Math.round((inq.total||0) / 100)), 'Purchase inquiry · ' + (inq.items?.length||0) + ' items');
          }
        }
      }, 200);
      return result;
    };
    window.checkout.__spWrapped = true;
  }
}

/* ---------- BOOTSTRAP ---------- */
function boot(){
  // Inject the vehicle pill host into the topbar / promobar if any
  if(!$('#spVehiclePillHost')){
    const host = el('span', { id:'spVehiclePillHost', style:'margin-left:8px' });
    const topbar = $('.topbar .container') || $('header .container') || document.body;
    topbar.appendChild(host);
  }
  renderVehiclePill();
  makeFabStack();
  injectBundleBar();
  decorateProductCards();
  hookInquirySubmission();

  window.addEventListener('storage', e => {
    if(e.key === 'sp_active_phone' || e.key === 'sp_loyalty' || e.key === 'va_compare') renderFabBadges();
  });
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* ---------- EXPORT ---------- */
window.spEnh = {
  openFitment, openBooking, openRewards, openCompare, openHistory,
  loadVehicle, saveVehicle,
  addPoints, loyaltyGet, loyaltyAll,
  computeBundle, renderFabBadges
};

})();
orage', e => {
    if(e.key === 'sp_active_phone' || e.key === 'sp_loyalty' || e.key === 'va_compare') renderFabBadges();
  });
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.spEnh = {
  openFitment, openBooking, openRewards, openCompare, openHistory,
  loadVehicle, saveVehicle,
  addPoints, loyaltyGet, loyaltyAll,
  computeBundle, renderFabBadges
};

})();
eBundle, renderFabBadges
};

})();
