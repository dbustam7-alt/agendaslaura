/* Agenda Laura — login, persistencia en Supabase, validación, facturación y export */

const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

const DEFAULT_CONFIG = {
  cesStart: "2026-10-01",
  bufferMin: 30,
  noctStart: "19:00",
  noctEnd: "07:00",
  aunaOrd: 85000,
  aunaNoc: 87000,
  noelPart: 0,
  noelPol: 0,
};

let CONFIG = {...DEFAULT_CONFIG};
let TURNOS = [];

// ---------- Conexión Supabase ----------
// La URL y la "anon key" son públicas por diseño (Supabase las espera en el
// cliente): por sí solas NO dan acceso a los datos. Row Level Security en el
// proyecto exige una sesión autenticada (haber iniciado sesión) para poder
// leer o escribir en turnos/configuracion. La "service role key" (que sí
// se salta esa protección) nunca debe ir aquí ni a ningún código de cliente.
const SUPABASE_URL = "https://gdntsqutspcxsaqecqgp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkbnRzcXV0c3BjeHNhcWVjcWdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNjEwNDgsImV4cCI6MjEwMzkzNzA0OH0.4m1QnFch6zJgKqLHdfDxW4kt9C65anNCEG3z5spJ6pM";
// Si la librería de Supabase no cargó (ej. sin conexión), `sb` queda en null
// y el arranque muestra un aviso en vez de romper toda la página en silencio.
const sb = (window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// ---------- Persistencia (Supabase) ----------
const TURNO_SELECT = "*, turno_eps_detalle(cantidad, remitente_id, noel_remitentes(nombre, tarifa))";

function rowToTurno(row){
  const epsDetalle = (row.turno_eps_detalle || [])
    .filter(d => d.cantidad > 0)
    .map(d => ({
      remitenteId: d.remitente_id,
      nombre: d.noel_remitentes ? d.noel_remitentes.nombre : "(remitente eliminado)",
      tarifa: d.noel_remitentes ? Number(d.noel_remitentes.tarifa) : 0,
      cantidad: d.cantidad,
    }));
  return {
    id: row.id,
    entidad: row.entidad,
    fecha: row.fecha,
    inicio: row.inicio.slice(0,5),
    fin: row.fin.slice(0,5),
    sede: row.sede || undefined,
    noelPart: row.noel_part,
    noelPol: row.noel_pol,
    epsDetalle,
  };
}
function turnoToRow(t){
  return {
    entidad: t.entidad,
    fecha: t.fecha,
    inicio: t.inicio,
    fin: t.fin,
    sede: t.entidad === "AUNA" ? (t.sede || "La 80") : null,
    noel_part: t.entidad === "NOEL" ? (t.noelPart || 0) : 0,
    noel_pol: t.entidad === "NOEL" ? (t.noelPol || 0) : 0,
  };
}
async function saveEpsDetalle(turnoId, epsDetalle){
  const rows = (epsDetalle || []).filter(d => d.cantidad > 0 && d.remitenteId).map(d => ({
    turno_id: turnoId, remitente_id: d.remitenteId, cantidad: d.cantidad,
  }));
  if (rows.length === 0) return;
  const { error } = await sb.from("turno_eps_detalle").insert(rows);
  if (error) throw error;
}
async function fetchTurnos(){
  const { data, error } = await sb.from("turnos").select(TURNO_SELECT).order("fecha").order("inicio");
  if (error){ showAlert("Error cargando turnos: " + error.message, "error"); return []; }
  return data.map(rowToTurno);
}
async function insertTurnoDB(t){
  const { data, error } = await sb.from("turnos").insert(turnoToRow(t)).select().single();
  if (error) throw error;
  if (t.entidad === "NOEL") await saveEpsDetalle(data.id, t.epsDetalle);
  const { data: full, error: err2 } = await sb.from("turnos").select(TURNO_SELECT).eq("id", data.id).single();
  if (err2) throw err2;
  return rowToTurno(full);
}
async function insertTurnosBulkDB(list){
  const { data, error } = await sb.from("turnos").insert(list.map(turnoToRow)).select();
  if (error) throw error;
  // Supabase devuelve las filas insertadas en el mismo orden que se enviaron.
  for (let i = 0; i < data.length; i++){
    if (list[i].entidad === "NOEL" && list[i].epsDetalle && list[i].epsDetalle.length){
      await saveEpsDetalle(data[i].id, list[i].epsDetalle);
    }
  }
  const ids = data.map(r => r.id);
  const { data: full, error: err2 } = await sb.from("turnos").select(TURNO_SELECT).in("id", ids);
  if (err2) throw err2;
  return full.map(rowToTurno);
}
async function deleteTurnoDB(id){
  const { error } = await sb.from("turnos").delete().eq("id", id);
  if (error) throw error;
}

// ---------- Maestro de remitentes NOEL (EPS/pólizas/prepagadas) ----------
let REMITENTES = [];

async function fetchRemitentes(){
  const { data, error } = await sb.from("noel_remitentes").select("*").eq("activo", true).order("orden");
  if (error){ showAlert("Error cargando remitentes: " + error.message, "error"); return []; }
  return data.map(r => ({ id: r.id, nombre: r.nombre, tarifa: Number(r.tarifa) }));
}
async function insertRemitenteDB(nombre, tarifa){
  const orden = REMITENTES.length;
  const { data, error } = await sb.from("noel_remitentes").insert({ nombre, tarifa, orden, activo:true }).select().single();
  if (error) throw error;
  return { id: data.id, nombre: data.nombre, tarifa: Number(data.tarifa) };
}
async function updateRemitenteDB(id, nombre, tarifa){
  const { error } = await sb.from("noel_remitentes").update({ nombre, tarifa }).eq("id", id);
  if (error) throw error;
}

function rowToConfig(row){
  return {
    cesStart: row.ces_start,
    bufferMin: Number(row.buffer_min),
    noctStart: row.noct_start.slice(0,5),
    noctEnd: row.noct_end.slice(0,5),
    aunaOrd: Number(row.auna_ord),
    aunaNoc: Number(row.auna_noc),
    noelPart: Number(row.noel_part),
    noelPol: Number(row.noel_pol),
  };
}
function configToRow(cfg){
  return {
    ces_start: cfg.cesStart,
    buffer_min: cfg.bufferMin,
    noct_start: cfg.noctStart,
    noct_end: cfg.noctEnd,
    auna_ord: cfg.aunaOrd,
    auna_noc: cfg.aunaNoc,
    noel_part: cfg.noelPart,
    noel_pol: cfg.noelPol,
  };
}
async function fetchConfig(){
  const { data, error } = await sb.from("configuracion").select("*").eq("id", 1).single();
  if (error){ showAlert("Error cargando configuración: " + error.message, "error"); return {...DEFAULT_CONFIG}; }
  return rowToConfig(data);
}
async function saveConfigDB(){
  const { error } = await sb.from("configuracion").update(configToRow(CONFIG)).eq("id", 1);
  if (error) throw error;
}

// ---------- Autenticación ----------
function showLoginAlert(msg, type){
  const box = document.getElementById("login-alert");
  box.hidden = false;
  box.className = "alert " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
}
function showLoginScreen(){
  document.getElementById("app-root").hidden = true;
  document.getElementById("login-screen").hidden = false;
  document.getElementById("login-password").value = "";
}
async function enterApp(){
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app-root").hidden = false;

  const { data: { user } } = await sb.auth.getUser();
  document.getElementById("user-email-label").textContent = user ? user.email : "";

  CONFIG = await fetchConfig();
  loadConfigIntoForm();
  REMITENTES = await fetchRemitentes();
  renderRemitentesMaestro();
  renderRemitentesFormOptions();
  TURNOS = await fetchTurnos();

  document.getElementById("f-fecha").value = new Date().toISOString().slice(0,10);
  document.getElementById("filter-month").value = new Date().toISOString().slice(0,7);
  toggleFormFields();

  renderAll();
}
async function handleLogin(e){
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const btn = document.getElementById("btn-login");
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  if (error){
    showLoginAlert("No se pudo iniciar sesión: correo o contraseña incorrectos.", "error");
  }
}
async function handleLogout(){
  await sb.auth.signOut();
}

// ---------- Helpers de fecha/hora ----------
function parseTimeParts(hhmm){
  const [h,m] = hhmm.split(":").map(Number);
  return [h,m,0,0];
}
function toDateTime(fechaISO, horaHHMM){
  const d = new Date(fechaISO + "T00:00:00");
  const [h,m] = parseTimeParts(horaHHMM);
  d.setHours(h,m,0,0);
  return d;
}
function turnoInterval(t){
  const start = toDateTime(t.fecha, t.inicio);
  let end = toDateTime(t.fecha, t.fin);
  if (end.getTime() <= start.getTime()) end.setDate(end.getDate()+1); // cruza medianoche
  return {start, end};
}
function overlaps(aStart, aEnd, bStart, bEnd){
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}
function isWeekendDate(d){
  const day = d.getDay(); // 0=Dom, 6=Sáb
  return day === 0 || day === 6;
}
function isMonThu(d){
  const day = d.getDay(); // 1=Lun ... 4=Jue
  return day >= 1 && day <= 4;
}
function fmtMoney(n){
  return "$" + Math.round(n).toLocaleString("es-CO");
}
function fmtHours(h){
  return (Math.round(h*100)/100).toString();
}

// ---------- Bloque CES ----------
function cesBlockForDate(fechaISO){
  const d = new Date(fechaISO + "T00:00:00");
  if (d < new Date(CONFIG.cesStart + "T00:00:00")) return null;
  if (!isMonThu(d)) return null;
  const start = toDateTime(fechaISO, "07:00");
  const end = toDateTime(fechaISO, "11:00");
  start.setMinutes(start.getMinutes() - Number(CONFIG.bufferMin || 0));
  end.setMinutes(end.getMinutes() + Number(CONFIG.bufferMin || 0));
  return {start, end};
}
function cesBlocksInRange(start, end){
  const blocks = [];
  let d = new Date(start); d.setHours(0,0,0,0);
  const last = new Date(end);
  while (d.getTime() <= last.getTime()){
    const iso = d.toISOString().slice(0,10);
    const b = cesBlockForDate(iso);
    if (b) blocks.push(b);
    d.setDate(d.getDate()+1);
  }
  return blocks;
}

// ---------- Validación de choques ----------
function validarTurno(nuevo, excludeId, extra){
  const {start, end} = turnoInterval(nuevo);
  const candidatos = extra && extra.length ? TURNOS.concat(extra) : TURNOS;

  // 1. Choque contra otros turnos ya registrados (incluyendo un lote de importación en curso)
  for (const t of candidatos){
    if (excludeId && t.id === excludeId) continue;
    const iv = turnoInterval(t);
    if (overlaps(start, end, iv.start, iv.end)){
      return {
        ok:false,
        motivo:`Choque con turno existente: ${t.entidad} el ${t.fecha} (${t.inicio}–${t.fin}).`
      };
    }
  }

  // 2. Choque contra el bloque fijo de CES (incluye buffer de traslado)
  const blocks = cesBlocksInRange(start, end);
  for (const b of blocks){
    if (overlaps(start, end, b.start, b.end)){
      if (nuevo.entidad === "CES"){
        // El propio turno CES debe caber dentro del bloque exacto (sin contar el buffer)
        const exactStart = toDateTime(nuevo.fecha, "07:00");
        const exactEnd = toDateTime(nuevo.fecha, "11:00");
        if (start.getTime() < exactStart.getTime() || end.getTime() > exactEnd.getTime()){
          return {
            ok:false,
            motivo:`El turno CES debe estar contenido en el bloque fijo 07:00–11:00 (Lunes a Jueves, desde ${CONFIG.cesStart}).`
          };
        }
        continue; // es el propio bloque CES, válido
      }
      return {
        ok:false,
        motivo:`Choque con el BLOQUE FIJO CES (07:00–11:00 ± ${CONFIG.bufferMin} min de traslado) el ${nuevo.fecha}.`
      };
    }
  }

  return {ok:true};
}

// ---------- Facturación AUNA ----------
function minutesOfDay(d){ return d.getHours()*60 + d.getMinutes(); }
function isInNocturno(d){
  const [sh,sm] = CONFIG.noctStart.split(":").map(Number);
  const [eh,em] = CONFIG.noctEnd.split(":").map(Number);
  const startMin = sh*60+sm, endMin = eh*60+em;
  const cur = minutesOfDay(d);
  if (startMin > endMin){ // cruza medianoche, ej 19:00 -> 07:00
    return cur >= startMin || cur < endMin;
  }
  return cur >= startMin && cur < endMin;
}
function tarifaEnInstante(d){
  if (isWeekendDate(d)) return CONFIG.aunaNoc;      // fin de semana completo
  if (isInNocturno(d)) return CONFIG.aunaNoc;       // nocturno entre semana
  return CONFIG.aunaOrd;                             // ordinario diurno
}
function computeAunaBilling(start, end){
  const pts = new Set([start.getTime(), end.getTime()]);
  let d = new Date(start); d.setHours(0,0,0,0);
  while (d.getTime() <= end.getTime()){
    pts.add(d.getTime()); // medianoche
    const [sh,sm] = CONFIG.noctStart.split(":").map(Number);
    const [eh,em] = CONFIG.noctEnd.split(":").map(Number);
    const ns = new Date(d); ns.setHours(sh,sm,0,0);
    const ne = new Date(d); ne.setHours(eh,em,0,0);
    pts.add(ns.getTime()); pts.add(ne.getTime());
    d.setDate(d.getDate()+1);
  }
  const sorted = [...pts].filter(t=>t>=start.getTime() && t<=end.getTime()).sort((a,b)=>a-b);
  let ordMin=0, nocMin=0, subtotal=0;
  for (let i=0;i<sorted.length-1;i++){
    const a=sorted[i], b=sorted[i+1];
    if (b<=a) continue;
    const mid = new Date((a+b)/2);
    const rate = tarifaEnInstante(mid);
    const minutes = (b-a)/60000;
    if (rate === CONFIG.aunaNoc) nocMin += minutes; else ordMin += minutes;
    subtotal += (minutes/60) * rate;
  }
  return { ordMin, nocMin, subtotal };
}

// ---------- Cálculo genérico por turno ----------
function calcularTurno(t){
  const {start, end} = turnoInterval(t);
  const horas = (end - start) / 3600000;
  if (t.entidad === "AUNA"){
    const b = computeAunaBilling(start, end);
    const detalle = `${t.sede || ""} · ord ${fmtHours(b.ordMin/60)}h / noc-finde ${fmtHours(b.nocMin/60)}h`;
    return { horas, subtotal: b.subtotal, detalle };
  }
  if (t.entidad === "NOEL"){
    const epsDetalle = t.epsDetalle || [];
    const epsTotal = epsDetalle.reduce((s,d)=> s + d.cantidad, 0);
    const epsSubtotal = epsDetalle.reduce((s,d)=> s + d.cantidad*d.tarifa, 0);
    const subtotal = (t.noelPart||0)*CONFIG.noelPart + (t.noelPol||0)*CONFIG.noelPol + epsSubtotal;
    const epsResumen = epsDetalle.length
      ? epsDetalle.map(d => `${d.nombre} (${d.cantidad})`).join(", ")
      : "0";
    const detalle = `Part ${t.noelPart||0} · Póliza ${t.noelPol||0} · EPS ${epsTotal}: ${epsResumen}`;
    return { horas, subtotal, detalle, epsDetalle, epsTotal };
  }
  // CES
  return { horas, subtotal: 0, detalle: "Registro horas contrato" };
}

// ---------- Render: alerta ----------
function showAlert(msg, type){
  const box = document.getElementById("alert-box");
  box.hidden = false;
  box.className = "alert " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
}
function hideAlertLater(){
  // se mantiene visible hasta el próximo evento; no auto-oculta para no perder contexto
}

// ---------- Render: tabla agenda ----------
function getFilteredTurnos(){
  const month = document.getElementById("filter-month").value; // "YYYY-MM"
  let list = [...TURNOS];
  if (month) list = list.filter(t => t.fecha.slice(0,7) === month);
  list.sort((a,b)=>{
    const ia = turnoInterval(a), ib = turnoInterval(b);
    return ia.start - ib.start;
  });
  return list;
}

function renderAgenda(){
  const tbody = document.querySelector("#tbl-agenda tbody");
  tbody.innerHTML = "";
  const list = getFilteredTurnos();
  for (const t of list){
    const d = new Date(t.fecha + "T00:00:00");
    const calc = calcularTurno(t);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.fecha}</td>
      <td>${DIAS[d.getDay()]}</td>
      <td><span class="badge ${t.entidad}">${t.entidad}</span></td>
      <td>${t.inicio}</td>
      <td>${t.fin}</td>
      <td>${fmtHours(calc.horas)}</td>
      <td>${calc.detalle}</td>
      <td>${calc.subtotal ? fmtMoney(calc.subtotal) : "—"}</td>
      <td><button class="btn danger-link" data-del="${t.id}">Eliminar</button></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-del]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      try{
        await deleteTurnoDB(btn.dataset.del);
        TURNOS = TURNOS.filter(t=>t.id !== btn.dataset.del);
        renderAll();
      }catch(e){
        showAlert("Error eliminando el turno: " + e.message, "error");
      }
    });
  });
}

// ---------- Render: resumen financiero ----------
function renderResumen(){
  const list = getFilteredTurnos();
  const acc = {
    CES:{horas:0, subtotal:0},
    AUNA:{horas:0, subtotal:0, ordMin:0, nocMin:0},
    NOEL:{horas:0, subtotal:0, part:0, pol:0, epsPorRemitente:{}},
  };
  for (const t of list){
    const calc = calcularTurno(t);
    acc[t.entidad].horas += calc.horas;
    acc[t.entidad].subtotal += calc.subtotal;
    if (t.entidad === "AUNA"){
      const {start,end} = turnoInterval(t);
      const b = computeAunaBilling(start,end);
      acc.AUNA.ordMin += b.ordMin; acc.AUNA.nocMin += b.nocMin;
    }
    if (t.entidad === "NOEL"){
      acc.NOEL.part += t.noelPart||0; acc.NOEL.pol += t.noelPol||0;
      for (const d of (t.epsDetalle||[])){
        const cur = acc.NOEL.epsPorRemitente[d.nombre] || {cantidad:0, subtotal:0};
        cur.cantidad += d.cantidad;
        cur.subtotal += d.cantidad * d.tarifa;
        acc.NOEL.epsPorRemitente[d.nombre] = cur;
      }
    }
  }
  const epsRows = Object.entries(acc.NOEL.epsPorRemitente)
    .sort((a,b)=> b[1].subtotal - a[1].subtotal)
    .map(([nombre, v]) => `<div class="row"><span>${nombre}</span><b>${v.cantidad} pac. · ${fmtMoney(v.subtotal)}</b></div>`)
    .join("");
  const epsTotalPac = Object.values(acc.NOEL.epsPorRemitente).reduce((s,v)=>s+v.cantidad,0);

  const el = document.getElementById("resumen-financiero");
  const total = acc.CES.subtotal + acc.AUNA.subtotal + acc.NOEL.subtotal;
  el.innerHTML = `
    <div class="resumen-item">
      <h3>🟣 CES</h3>
      <div class="row"><span>Horas registradas</span><span>${fmtHours(acc.CES.horas)} h</span></div>
      <div class="row"><span>Facturación</span><span>No aplica (cumplimiento contrato)</span></div>
    </div>
    <div class="resumen-item">
      <h3>🔵 AUNA</h3>
      <div class="row"><span>Horas ordinarias</span><span>${fmtHours(acc.AUNA.ordMin/60)} h</span></div>
      <div class="row"><span>Horas nocturno/fin de semana</span><span>${fmtHours(acc.AUNA.nocMin/60)} h</span></div>
      <div class="total">${fmtMoney(acc.AUNA.subtotal)}</div>
    </div>
    <div class="resumen-item">
      <h3>🟠 NOEL</h3>
      <div class="row"><span>Particular</span><span>${acc.NOEL.part} pac.</span></div>
      <div class="row"><span>Póliza</span><span>${acc.NOEL.pol} pac.</span></div>
      <div class="row"><span><strong>EPS (total)</strong></span><span>${epsTotalPac} pac.</span></div>
      ${epsRows}
      <div class="total">${fmtMoney(acc.NOEL.subtotal)}</div>
    </div>
    <div class="resumen-item">
      <h3>💵 Total periodo</h3>
      <div class="total">${fmtMoney(total)}</div>
    </div>
  `;
}

// ---------- Calendario mensual ----------
let calendarMonth = new Date().toISOString().slice(0,7); // "YYYY-MM"

function renderCalendar(){
  const [y, m] = calendarMonth.split("-").map(Number);
  const monthIndex0 = m - 1;
  document.getElementById("cal-label").textContent = `${MESES[monthIndex0]} ${y}`;

  const firstOfMonth = new Date(y, monthIndex0, 1);
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // 0=Lun ... 6=Dom
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - firstWeekday);

  const todayISO = new Date().toISOString().slice(0,10);
  const byDate = {};
  for (const t of TURNOS) (byDate[t.fecha] = byDate[t.fecha] || []).push(t);
  for (const arr of Object.values(byDate)) arr.sort((a,b)=> a.inicio.localeCompare(b.inicio));

  let html = "";
  const cursor = new Date(gridStart);
  for (let i = 0; i < 42; i++){
    const iso = cursor.toISOString().slice(0,10);
    const inMonth = cursor.getMonth() === monthIndex0;
    const isToday = iso === todayISO;
    const isCes = !!cesBlockForDate(iso);
    const dayTurnos = byDate[iso] || [];

    const classes = ["cal-cell"];
    if (!inMonth) classes.push("cal-cell-out");
    if (isToday) classes.push("cal-cell-today");
    if (isCes) classes.push("cal-cell-ces");

    const chips = dayTurnos.map(t=>{
      const calc = calcularTurno(t);
      const title = `${t.entidad} ${t.inicio}–${t.fin} · ${calc.detalle}${calc.subtotal ? " · " + fmtMoney(calc.subtotal) : ""}`;
      return `<button type="button" class="cal-chip ${t.entidad}" data-del="${t.id}" title="${title.replace(/"/g,"&quot;")} — clic para eliminar">${t.inicio}–${t.fin} ${t.entidad}</button>`;
    }).join("");

    html += `<div class="${classes.join(" ")}" ${isCes ? 'title="Bloqueo CES 07:00–11:00 (Lun–Jue)"' : ""}>
      <span class="cal-daynum">${cursor.getDate()}</span>
      <div class="cal-chips">${chips}</div>
    </div>`;

    cursor.setDate(cursor.getDate()+1);
  }

  const grid = document.getElementById("cal-grid");
  grid.innerHTML = html;
  grid.querySelectorAll("[data-del]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const t = TURNOS.find(x=>x.id === btn.dataset.del);
      if (!t) return;
      if (!confirm(`¿Eliminar turno ${t.entidad} del ${t.fecha} (${t.inicio}–${t.fin})?`)) return;
      try{
        await deleteTurnoDB(btn.dataset.del);
        TURNOS = TURNOS.filter(x=>x.id !== btn.dataset.del);
        renderAll();
      }catch(e){
        showAlert("Error eliminando el turno: " + e.message, "error");
      }
    });
  });
}

function shiftCalendarMonth(delta){
  const [y,m] = calendarMonth.split("-").map(Number);
  const d = new Date(y, m-1+delta, 1);
  calendarMonth = d.toISOString().slice(0,7);
  renderCalendar();
}

function renderAll(){
  renderAgenda();
  renderResumen();
  renderCalendar();
}

// ---------- Formulario ----------
function toggleFormFields(){
  const entidad = document.getElementById("f-entidad").value;
  document.getElementById("f-sede-wrap").hidden = entidad !== "AUNA";
  document.getElementById("noel-fields").hidden = entidad !== "NOEL";
  if (entidad === "NOEL" && document.getElementById("f-noel-eps-rows").children.length === 0){
    addEpsFormRow();
  }
}

// ---------- Remitentes EPS: filas dinámicas del formulario de turno ----------
function addEpsFormRow(){
  const wrap = document.getElementById("f-noel-eps-rows");
  const row = document.createElement("div");
  row.className = "eps-row";
  row.innerHTML = `
    <select class="f-noel-eps-remitente">${REMITENTES.map(r=>`<option value="${r.id}">${r.nombre}</option>`).join("")}</select>
    <input type="number" class="f-noel-eps-cantidad" min="0" value="0" placeholder="Cant.">
    <button type="button" class="btn ghost-icon eps-row-remove" aria-label="Quitar remitente">✕</button>
  `;
  row.querySelector(".eps-row-remove").addEventListener("click", ()=> row.remove());
  wrap.appendChild(row);
}
function resetEpsFormRows(){
  document.getElementById("f-noel-eps-rows").innerHTML = "";
  addEpsFormRow();
}
function collectEpsFormRows(){
  return Array.from(document.querySelectorAll("#f-noel-eps-rows .eps-row")).map(row=>{
    const remitenteId = row.querySelector(".f-noel-eps-remitente").value;
    const cantidad = Number(row.querySelector(".f-noel-eps-cantidad").value || 0);
    const rem = REMITENTES.find(r=>r.id === remitenteId);
    return { remitenteId, nombre: rem ? rem.nombre : "", tarifa: rem ? rem.tarifa : 0, cantidad };
  }).filter(d=>d.cantidad > 0);
}
function renderRemitentesFormOptions(){
  document.querySelectorAll(".f-noel-eps-remitente").forEach(sel=>{
    const cur = sel.value;
    sel.innerHTML = REMITENTES.map(r=>`<option value="${r.id}">${r.nombre}</option>`).join("");
    if (cur) sel.value = cur;
  });
}

// ---------- Maestro de remitentes EPS ----------
function renderRemitentesMaestro(){
  const wrap = document.getElementById("remitentes-rows");
  wrap.innerHTML = REMITENTES.map(r => `
    <tr data-id="${r.id}">
      <td><input type="text" class="rem-nombre" value="${String(r.nombre).replace(/"/g,"&quot;")}"></td>
      <td class="num"><input type="number" class="rem-tarifa" value="${r.tarifa}" step="1000"></td>
    </tr>
  `).join("");
}
function addRemitenteMaestroRow(){
  const wrap = document.getElementById("remitentes-rows");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input type="text" class="rem-nombre" placeholder="Nombre del remitente"></td>
    <td class="num"><input type="number" class="rem-tarifa" value="0" step="1000"></td>
  `;
  wrap.appendChild(tr);
}
async function saveRemitentesMaestro(){
  const rows = Array.from(document.querySelectorAll("#remitentes-rows tr"));
  try{
    for (const row of rows){
      const nombre = row.querySelector(".rem-nombre").value.trim();
      const tarifa = Number(row.querySelector(".rem-tarifa").value || 0);
      if (!nombre) continue;
      const id = row.dataset.id;
      if (id) await updateRemitenteDB(id, nombre, tarifa);
      else await insertRemitenteDB(nombre, tarifa);
    }
    REMITENTES = await fetchRemitentes();
    renderRemitentesMaestro();
    renderRemitentesFormOptions();
    showAlert("Remitentes EPS guardados.", "ok");
    renderAll();
  }catch(e){
    showAlert("Error guardando remitentes EPS: " + e.message, "error");
  }
}

async function handleAddTurno(){
  const entidad = document.getElementById("f-entidad").value;
  const fecha = document.getElementById("f-fecha").value;
  const inicio = document.getElementById("f-inicio").value;
  const fin = document.getElementById("f-fin").value;

  if (!fecha || !inicio || !fin){
    showAlert("Completa fecha, hora de inicio y hora de fin.", "error");
    return;
  }

  const nuevo = { entidad, fecha, inicio, fin };
  if (entidad === "AUNA"){
    nuevo.sede = document.getElementById("f-sede").value;
  }
  if (entidad === "NOEL"){
    nuevo.noelPart = Number(document.getElementById("f-noel-part").value || 0);
    nuevo.noelPol = Number(document.getElementById("f-noel-pol").value || 0);
    nuevo.epsDetalle = collectEpsFormRows();
  }

  const check = validarTurno(nuevo);
  if (!check.ok){
    showAlert(check.motivo, "error");
    return;
  }

  try{
    const saved = await insertTurnoDB(nuevo);
    TURNOS.push(saved);
    showAlert(`Turno ${entidad} registrado sin conflictos (${fecha} ${inicio}–${fin}).`, "ok");
    if (entidad === "NOEL"){
      document.getElementById("f-noel-part").value = "0";
      document.getElementById("f-noel-pol").value = "0";
      resetEpsFormRows();
    }
    renderAll();
  }catch(e){
    showAlert("Error guardando el turno: " + e.message, "error");
  }
}

// ---------- Importador masivo ----------
let importPreviewRows = [];

const IMPORT_FORMATS = {
  CES:  { cols:["Fecha","Inicio","Fin"], hint:"Columnas: Fecha (AAAA-MM-DD o DD/MM/AAAA), Hora inicio (HH:MM), Hora fin (HH:MM).",
          placeholder:"2026-10-05\t07:00\t11:00\n2026-10-06\t07:00\t10:30" },
  AUNA: { cols:["Fecha","Inicio","Fin","Sede"], hint:"Columnas: Fecha, Hora inicio, Hora fin, Sede (La 80 / Sur).",
          placeholder:"2026-09-05\t08:00\t16:00\tLa 80\n2026-09-08\t18:00\t22:00\tSur" },
  NOEL: { cols:["Fecha","Inicio","Fin","Particular","Póliza","Remitente EPS","Cant. EPS"],
          hint:"Columnas: Fecha, Hora inicio, Hora fin, N° Particular, N° Póliza, Nombre del remitente EPS (debe existir en el maestro de tarifas), N° pacientes de ese remitente. Si un turno tiene pacientes de varios remitentes EPS, repite la fila con la misma Fecha/Inicio/Fin y cambia solo el remitente y la cantidad.",
          placeholder:"2026-09-03\t08:00\t12:00\t2\t1\tSalud Total EPS\t3\n2026-09-03\t08:00\t12:00\t\t\tEntidad Promotora de Salud Sanitas\t2\n2026-09-15\t14:00\t18:00\t1\t0\tMedisanitas\t2" },
};

function normalizeImportDate(raw){
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, mo, d;
  if (m){ y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  const iso = `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const check = new Date(iso + "T00:00:00");
  if (check.getFullYear() !== y || check.getMonth()+1 !== mo || check.getDate() !== d) return null;
  return iso;
}
function normalizeImportTime(raw){
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${String(h).padStart(2,"0")}:${m[2]}`;
}
function parseImportText(text){
  return text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0).map(line=>{
    const sep = line.includes("\t") ? "\t" : ",";
    return line.split(sep).map(c=>c.trim().replace(/^"(.*)"$/,"$1"));
  });
}

function updateImportFormatHint(){
  const entidad = document.getElementById("imp-entidad").value;
  const fmt = IMPORT_FORMATS[entidad];
  document.getElementById("imp-format-hint").textContent = fmt.hint;
  document.getElementById("imp-textarea").placeholder = fmt.placeholder;
}

function downloadImportTemplate(){
  const entidad = document.getElementById("imp-entidad").value;
  const fmt = IMPORT_FORMATS[entidad];
  const exampleRows = fmt.placeholder.split("\n").map(line => line.split("\t"));
  const rows = [fmt.cols, ...exampleRows];
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  downloadFile(`plantilla-turnos-${entidad.toLowerCase()}.csv`, csv, "text/csv;charset=utf-8;");
}

function handleImportFile(file){
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")){
    if (typeof XLSX === "undefined"){
      showAlert("No se pudo leer el archivo: la librería de Excel no cargó (sin conexión). Pega los datos manualmente en el cuadro de texto.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e)=>{
      const wb = XLSX.read(e.target.result, {type:"array"});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:false, blankrows:false});
      document.getElementById("imp-textarea").value = rows.map(r=>r.join("\t")).join("\n");
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = (e)=>{ document.getElementById("imp-textarea").value = e.target.result; };
    reader.readAsText(file);
  }
}

function buildImportPreview(){
  const entidad = document.getElementById("imp-entidad").value;
  const raw = document.getElementById("imp-textarea").value;
  let rows = parseImportText(raw);

  if (rows.length === 0){
    showAlert("No hay filas para procesar. Pega o sube los datos primero.", "error");
    return;
  }
  if (normalizeImportDate(rows[0][0]) === null) rows = rows.slice(1); // descarta fila de encabezado si la hay

  importPreviewRows = entidad === "NOEL" ? buildNoelImportPreview(rows) : buildSimpleImportPreview(entidad, rows);
  renderImportPreview(entidad);
}

function buildSimpleImportPreview(entidad, rows){
  const aceptadosLote = [];
  const results = [];

  rows.forEach((cols, idx)=>{
    const fecha = normalizeImportDate(cols[0]);
    const inicio = normalizeImportTime(cols[1]);
    const fin = normalizeImportTime(cols[2]);

    if (!fecha || !inicio || !fin){
      results.push({idx, cols, status:"invalid", message:"Fecha u hora con formato inválido."});
      return;
    }

    const nuevo = { entidad, fecha, inicio, fin };
    if (entidad === "AUNA"){
      const s = (cols[3]||"").toLowerCase();
      nuevo.sede = s.includes("sur") ? "Sur" : "La 80";
    }

    const check = validarTurno(nuevo, null, aceptadosLote);
    if (!check.ok){
      results.push({idx, cols, turno:nuevo, status:"conflict", message:check.motivo});
      return;
    }
    aceptadosLote.push(nuevo);
    results.push({idx, cols, turno:nuevo, status:"ok", message:"Se importará"});
  });
  return results;
}

// Agrupa filas con la misma Fecha+Inicio+Fin en un solo turno NOEL con varias
// líneas de EPS (una por remitente).
function buildNoelImportPreview(rows){
  const groups = new Map();
  const order = [];

  rows.forEach((cols, idx)=>{
    const fecha = normalizeImportDate(cols[0]);
    const inicio = normalizeImportTime(cols[1]);
    const fin = normalizeImportTime(cols[2]);
    const valid = !!(fecha && inicio && fin);
    const key = valid ? `${fecha}|${inicio}|${fin}` : `__invalid_${idx}`;

    if (!groups.has(key)){
      groups.set(key, { idx, fecha, inicio, fin, valid, part:0, pol:0, eps:[] });
      order.push(key);
    }
    const g = groups.get(key);
    if (!valid) return;

    if (cols[3] !== undefined && cols[3] !== "") g.part = Number(cols[3]) || 0;
    if (cols[4] !== undefined && cols[4] !== "") g.pol = Number(cols[4]) || 0;
    const remNombre = (cols[5]||"").trim();
    const cantidad = Number(cols[6]) || 0;
    if (remNombre && cantidad > 0) g.eps.push({ remNombre, cantidad });
  });

  const aceptadosLote = [];
  const results = [];

  order.forEach(key=>{
    const g = groups.get(key);
    if (!g.valid){
      results.push({idx:g.idx, display:["","","","","","",""], status:"invalid", message:"Fecha u hora con formato inválido."});
      return;
    }

    const epsResuelto = [];
    const noEncontrados = [];
    for (const e of g.eps){
      const match = REMITENTES.find(r => r.nombre.toLowerCase() === e.remNombre.toLowerCase());
      if (match) epsResuelto.push({ remitenteId: match.id, nombre: match.nombre, tarifa: match.tarifa, cantidad: e.cantidad });
      else noEncontrados.push(e.remNombre);
    }
    const epsResumen = epsResuelto.map(d=>`${d.nombre} (${d.cantidad})`).join(", ") || "—";
    const display = [g.fecha, g.inicio, g.fin, String(g.part||0), String(g.pol||0), epsResumen, ""];

    if (noEncontrados.length){
      results.push({idx:g.idx, display, status:"invalid",
        message:`Remitente no encontrado en el maestro de tarifas: ${noEncontrados.join(", ")}. Agrégalo primero en "Tarifas y bloqueo CES".`});
      return;
    }

    const nuevo = { entidad:"NOEL", fecha:g.fecha, inicio:g.inicio, fin:g.fin, noelPart:g.part||0, noelPol:g.pol||0, epsDetalle: epsResuelto };
    const check = validarTurno(nuevo, null, aceptadosLote);
    if (!check.ok){
      results.push({idx:g.idx, display, turno:nuevo, status:"conflict", message:check.motivo});
      return;
    }
    aceptadosLote.push(nuevo);
    results.push({idx:g.idx, display, turno:nuevo, status:"ok", message:"Se importará"});
  });

  return results;
}

function renderImportPreview(entidad){
  const fmt = IMPORT_FORMATS[entidad];
  const okCount = importPreviewRows.filter(r=>r.status==="ok").length;
  const conflictCount = importPreviewRows.filter(r=>r.status==="conflict").length;
  const invalidCount = importPreviewRows.filter(r=>r.status==="invalid").length;

  const headCols = fmt.cols.map(c=>`<th>${c}</th>`).join("");
  const bodyRows = importPreviewRows.map(r=>{
    const values = r.display || fmt.cols.map((_,i)=> r.cols[i] ?? "");
    const cells = values.slice(0, fmt.cols.length).map(v=>`<td>${v}</td>`).join("");
    const badgeClass = r.status;
    const badgeText = r.status === "ok" ? "✓ Se importará" : r.status === "conflict" ? "⚠ Choque" : "✕ Inválido";
    return `<tr><td>${r.idx+1}</td>${cells}<td><span class="imp-status ${badgeClass}" title="${(r.message||"").replace(/"/g,"&quot;")}">${badgeText}</span></td></tr>`;
  }).join("");

  document.getElementById("imp-preview-table").innerHTML = `
    <thead><tr><th>#</th>${headCols}<th>Estado</th></tr></thead>
    <tbody>${bodyRows}</tbody>
  `;
  const wrap = document.getElementById("imp-preview-wrap");
  wrap.hidden = false;
  wrap.querySelector("h3").textContent =
    `Resultado: ${okCount} listos para importar · ${conflictCount} con choque · ${invalidCount} con formato inválido`;

  document.getElementById("btn-imp-confirm").disabled = okCount === 0;
}

async function commitImport(){
  const okRows = importPreviewRows.filter(r=>r.status === "ok");
  if (okRows.length === 0) return;
  try{
    const saved = await insertTurnosBulkDB(okRows.map(r=>r.turno));
    TURNOS.push(...saved);
    const skipped = importPreviewRows.length - okRows.length;
    showAlert(`Importación completa: ${saved.length} turno(s) agregado(s)${skipped ? `, ${skipped} omitido(s) por choque o formato` : ""}.`, "ok");
    renderAll();

    importPreviewRows = [];
    document.getElementById("imp-textarea").value = "";
    document.getElementById("imp-preview-wrap").hidden = true;
    document.getElementById("btn-imp-confirm").disabled = true;
    document.getElementById("dlg-import").close();
  }catch(e){
    showAlert("Error importando los turnos: " + e.message, "error");
  }
}

// ---------- Exportación cierre de mes ----------
function buildCloseOfMonth(){
  const month = document.getElementById("filter-month").value || new Date().toISOString().slice(0,7);
  const list = TURNOS.filter(t => t.fecha.slice(0,7) === month)
    .sort((a,b)=> turnoInterval(a).start - turnoInterval(b).start);

  const porEntidad = {CES:[], AUNA:[], NOEL:[]};
  for (const t of list) porEntidad[t.entidad].push(t);

  let out = `# Cierre de mes — ${month}\n\n`;

  // AUNA
  out += `## AUNA\n\n`;
  out += `| Fecha | Sede | Inicio | Fin | Horas Ord. | Horas Noc/Finde | Subtotal |\n`;
  out += `|---|---|---|---|---|---|---|\n`;
  let aunaTotal = 0;
  for (const t of porEntidad.AUNA){
    const {start,end} = turnoInterval(t);
    const b = computeAunaBilling(start,end);
    aunaTotal += b.subtotal;
    out += `| ${t.fecha} | ${t.sede||""} | ${t.inicio} | ${t.fin} | ${fmtHours(b.ordMin/60)} | ${fmtHours(b.nocMin/60)} | ${fmtMoney(b.subtotal)} |\n`;
  }
  out += `| **TOTAL AUNA** | | | | | | **${fmtMoney(aunaTotal)}** |\n\n`;

  // NOEL
  out += `## NOEL\n\n`;
  out += `| Fecha | Turno | Particular | Póliza | EPS (detalle por remitente) | Subtotal |\n`;
  out += `|---|---|---|---|---|---|\n`;
  let noelTotal = 0;
  for (const t of porEntidad.NOEL){
    const calc = calcularTurno(t);
    noelTotal += calc.subtotal;
    const epsTexto = (calc.epsDetalle||[]).map(d=>`${d.nombre} (${d.cantidad})`).join(", ") || "—";
    out += `| ${t.fecha} | ${t.inicio}-${t.fin} | ${t.noelPart||0} | ${t.noelPol||0} | ${epsTexto} | ${fmtMoney(calc.subtotal)} |\n`;
  }
  out += `| **TOTAL NOEL** | | | | | **${fmtMoney(noelTotal)}** |\n\n`;

  const epsPorRemitente = {};
  for (const t of porEntidad.NOEL){
    for (const d of calcularTurno(t).epsDetalle || []){
      const cur = epsPorRemitente[d.nombre] || {cantidad:0, subtotal:0};
      cur.cantidad += d.cantidad; cur.subtotal += d.cantidad*d.tarifa;
      epsPorRemitente[d.nombre] = cur;
    }
  }
  if (Object.keys(epsPorRemitente).length){
    out += `### NOEL — EPS por remitente\n\n`;
    out += `| Remitente | Pacientes | Subtotal |\n|---|---|---|\n`;
    for (const [nombre, v] of Object.entries(epsPorRemitente).sort((a,b)=>b[1].subtotal-a[1].subtotal)){
      out += `| ${nombre} | ${v.cantidad} | ${fmtMoney(v.subtotal)} |\n`;
    }
    out += `\n`;
  }

  // CES
  out += `## CES (registro de horas — cumplimiento contrato)\n\n`;
  out += `| Fecha | Inicio | Fin | Horas |\n`;
  out += `|---|---|---|---|\n`;
  let cesHoras = 0;
  for (const t of porEntidad.CES){
    const calc = calcularTurno(t);
    cesHoras += calc.horas;
    out += `| ${t.fecha} | ${t.inicio} | ${t.fin} | ${fmtHours(calc.horas)} |\n`;
  }
  out += `| **TOTAL HORAS CES** | | | **${fmtHours(cesHoras)}** |\n\n`;

  out += `## Resumen general\n\n`;
  out += `| Entidad | Subtotal |\n|---|---|\n`;
  out += `| AUNA | ${fmtMoney(aunaTotal)} |\n`;
  out += `| NOEL | ${fmtMoney(noelTotal)} |\n`;
  out += `| **TOTAL** | **${fmtMoney(aunaTotal+noelTotal)}** |\n`;

  return out;
}

function toCsv(){
  const month = document.getElementById("filter-month").value || new Date().toISOString().slice(0,7);
  const list = TURNOS.filter(t => t.fecha.slice(0,7) === month)
    .sort((a,b)=> turnoInterval(a).start - turnoInterval(b).start);
  const rows = [["Fecha","Entidad","Sede/Turno","Inicio","Fin","Horas","Particular","Poliza","EPS (detalle por remitente)","Subtotal"]];
  for (const t of list){
    const calc = calcularTurno(t);
    const epsTexto = (calc.epsDetalle||[]).map(d=>`${d.nombre} (${d.cantidad})`).join("; ");
    rows.push([
      t.fecha, t.entidad, t.sede||"", t.inicio, t.fin,
      fmtHours(calc.horas),
      t.noelPart||"", t.noelPol||"", epsTexto,
      calc.subtotal ? Math.round(calc.subtotal) : ""
    ]);
  }
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
}

function downloadFile(filename, content, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadExcel(){
  if (typeof XLSX === "undefined"){
    showAlert("No se pudo cargar la librería de Excel (sin conexión a internet). Usa CSV o Markdown mientras tanto.", "error");
    return;
  }
  const month = document.getElementById("filter-month").value || new Date().toISOString().slice(0,7);
  const list = TURNOS.filter(t => t.fecha.slice(0,7) === month)
    .sort((a,b)=> turnoInterval(a).start - turnoInterval(b).start);

  const rows = [["Fecha","Inicio","Fin","Entidad","Detalle","Subtotal"]];
  for (const t of list){
    const calc = calcularTurno(t);
    rows.push([t.fecha, t.inicio, t.fin, t.entidad, calc.detalle, Math.round(calc.subtotal || 0)]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{wch:12},{wch:8},{wch:8},{wch:9},{wch:60},{wch:14}];
  for (let r = 1; r < rows.length; r++){
    const cell = ws[XLSX.utils.encode_cell({r, c:5})];
    if (cell) cell.z = '"$"#,##0';
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Cierre ${month}`);
  XLSX.writeFile(wb, `cierre-mes-${month}.xlsx`, {cellStyles:true});
}

// ---------- Config UI ----------
function loadConfigIntoForm(){
  document.getElementById("cfg-ces-start").value = CONFIG.cesStart;
  document.getElementById("cfg-buffer").value = CONFIG.bufferMin;
  document.getElementById("cfg-noct-start").value = CONFIG.noctStart;
  document.getElementById("cfg-noct-end").value = CONFIG.noctEnd;
  document.getElementById("cfg-auna-ord").value = CONFIG.aunaOrd;
  document.getElementById("cfg-auna-noc").value = CONFIG.aunaNoc;
  document.getElementById("cfg-noel-part").value = CONFIG.noelPart;
  document.getElementById("cfg-noel-pol").value = CONFIG.noelPol;
}
function readConfigFromForm(){
  CONFIG = {
    cesStart: document.getElementById("cfg-ces-start").value,
    bufferMin: Number(document.getElementById("cfg-buffer").value || 0),
    noctStart: document.getElementById("cfg-noct-start").value,
    noctEnd: document.getElementById("cfg-noct-end").value,
    aunaOrd: Number(document.getElementById("cfg-auna-ord").value || 0),
    aunaNoc: Number(document.getElementById("cfg-auna-noc").value || 0),
    noelPart: Number(document.getElementById("cfg-noel-part").value || 0),
    noelPol: Number(document.getElementById("cfg-noel-pol").value || 0),
  };
}

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", ()=>{
  if (!sb){
    showLoginAlert("No se pudo cargar el sistema de acceso (revisa tu conexión a internet) y vuelve a intentar recargando la página.", "error");
    document.getElementById("btn-login").disabled = true;
    return;
  }

  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document.getElementById("btn-logout").addEventListener("click", handleLogout);
  sb.auth.onAuthStateChange((event, session)=>{
    if (session) enterApp(); else showLoginScreen();
  });

  document.getElementById("f-entidad").addEventListener("change", toggleFormFields);

  const dlgSettings = document.getElementById("dlg-settings");
  document.getElementById("btn-open-settings").addEventListener("click", ()=> dlgSettings.showModal());
  document.getElementById("btn-close-settings").addEventListener("click", ()=> dlgSettings.close());
  dlgSettings.addEventListener("click", (e)=>{ if (e.target === dlgSettings) dlgSettings.close(); });

  document.getElementById("btn-save-config").addEventListener("click", async ()=>{
    readConfigFromForm();
    try{
      await saveConfigDB();
      showAlert("Maestro de tarifas guardado.", "ok");
      renderAll();
      dlgSettings.close();
    }catch(e){
      showAlert("Error guardando el maestro de tarifas: " + e.message, "error");
    }
  });
  document.getElementById("btn-save-ces").addEventListener("click", async ()=>{
    readConfigFromForm();
    try{
      await saveConfigDB();
      showAlert("Configuración operativa (bloqueo CES) guardada.", "ok");
      renderAll();
      dlgSettings.close();
    }catch(e){
      showAlert("Error guardando la configuración: " + e.message, "error");
    }
  });

  document.getElementById("btn-add-turno").addEventListener("click", handleAddTurno);
  document.getElementById("filter-month").addEventListener("change", renderAll);

  document.getElementById("btn-noel-eps-add").addEventListener("click", addEpsFormRow);
  document.getElementById("btn-add-remitente").addEventListener("click", addRemitenteMaestroRow);
  document.getElementById("btn-save-remitentes").addEventListener("click", saveRemitentesMaestro);

  const dlgImport = document.getElementById("dlg-import");
  document.getElementById("btn-open-import").addEventListener("click", ()=>{
    updateImportFormatHint();
    dlgImport.showModal();
  });
  document.getElementById("btn-close-import").addEventListener("click", ()=> dlgImport.close());
  dlgImport.addEventListener("click", (e)=>{ if (e.target === dlgImport) dlgImport.close(); });
  document.getElementById("imp-entidad").addEventListener("change", ()=>{
    updateImportFormatHint();
    importPreviewRows = [];
    document.getElementById("imp-preview-wrap").hidden = true;
    document.getElementById("btn-imp-confirm").disabled = true;
  });
  document.getElementById("imp-file").addEventListener("change", (e)=>{
    if (e.target.files[0]) handleImportFile(e.target.files[0]);
  });
  document.getElementById("btn-imp-template").addEventListener("click", downloadImportTemplate);
  document.getElementById("btn-imp-preview").addEventListener("click", buildImportPreview);
  document.getElementById("btn-imp-confirm").addEventListener("click", commitImport);

  document.getElementById("cal-prev").addEventListener("click", ()=> shiftCalendarMonth(-1));
  document.getElementById("cal-next").addEventListener("click", ()=> shiftCalendarMonth(1));
  document.getElementById("cal-today").addEventListener("click", ()=>{
    calendarMonth = new Date().toISOString().slice(0,7);
    renderCalendar();
  });

  document.getElementById("btn-export-md").addEventListener("click", ()=>{
    document.getElementById("export-output").textContent = buildCloseOfMonth();
  });
  document.getElementById("btn-export-csv").addEventListener("click", ()=>{
    const month = document.getElementById("filter-month").value || new Date().toISOString().slice(0,7);
    downloadFile(`cierre-mes-${month}.csv`, toCsv(), "text/csv;charset=utf-8;");
  });
  document.getElementById("btn-export-xlsx").addEventListener("click", downloadExcel);
});
