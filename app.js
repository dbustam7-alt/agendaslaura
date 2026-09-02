/* Agenda Laura — lógica de validación, facturación y export */

const LS_TURNOS = "agendaLaura.turnos";
const LS_CONFIG = "agendaLaura.config";

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
  noelEps: 0,
};

let CONFIG = loadConfig();
let TURNOS = loadTurnos();

// ---------- Persistencia ----------
function loadConfig(){
  try{
    const raw = localStorage.getItem(LS_CONFIG);
    return raw ? {...DEFAULT_CONFIG, ...JSON.parse(raw)} : {...DEFAULT_CONFIG};
  }catch(e){ return {...DEFAULT_CONFIG}; }
}
function saveConfig(){ localStorage.setItem(LS_CONFIG, JSON.stringify(CONFIG)); }

function loadTurnos(){
  try{
    const raw = localStorage.getItem(LS_TURNOS);
    return raw ? JSON.parse(raw) : [];
  }catch(e){ return []; }
}
function saveTurnos(){ localStorage.setItem(LS_TURNOS, JSON.stringify(TURNOS)); }

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
function validarTurno(nuevo, excludeId){
  const {start, end} = turnoInterval(nuevo);

  // 1. Choque contra otros turnos ya registrados
  for (const t of TURNOS){
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
    const subtotal = (t.noelPart||0)*CONFIG.noelPart + (t.noelPol||0)*CONFIG.noelPol + (t.noelEps||0)*CONFIG.noelEps;
    const detalle = `Part ${t.noelPart||0} / Póliza ${t.noelPol||0} / EPS ${t.noelEps||0}`;
    return { horas, subtotal, detalle };
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
    btn.addEventListener("click", ()=>{
      TURNOS = TURNOS.filter(t=>t.id !== btn.dataset.del);
      saveTurnos();
      renderAll();
    });
  });
}

// ---------- Render: resumen financiero ----------
function renderResumen(){
  const list = getFilteredTurnos();
  const acc = {
    CES:{horas:0, subtotal:0},
    AUNA:{horas:0, subtotal:0, ordMin:0, nocMin:0},
    NOEL:{horas:0, subtotal:0, part:0, pol:0, eps:0},
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
      acc.NOEL.part += t.noelPart||0; acc.NOEL.pol += t.noelPol||0; acc.NOEL.eps += t.noelEps||0;
    }
  }
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
      <div class="row"><span>EPS</span><span>${acc.NOEL.eps} pac.</span></div>
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
    btn.addEventListener("click", ()=>{
      const t = TURNOS.find(x=>x.id === btn.dataset.del);
      if (!t) return;
      if (confirm(`¿Eliminar turno ${t.entidad} del ${t.fecha} (${t.inicio}–${t.fin})?`)){
        TURNOS = TURNOS.filter(x=>x.id !== btn.dataset.del);
        saveTurnos();
        renderAll();
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
}

function handleAddTurno(){
  const entidad = document.getElementById("f-entidad").value;
  const fecha = document.getElementById("f-fecha").value;
  const inicio = document.getElementById("f-inicio").value;
  const fin = document.getElementById("f-fin").value;

  if (!fecha || !inicio || !fin){
    showAlert("Completa fecha, hora de inicio y hora de fin.", "error");
    return;
  }

  const nuevo = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    entidad, fecha, inicio, fin,
  };
  if (entidad === "AUNA"){
    nuevo.sede = document.getElementById("f-sede").value;
  }
  if (entidad === "NOEL"){
    nuevo.noelPart = Number(document.getElementById("f-noel-part").value || 0);
    nuevo.noelPol = Number(document.getElementById("f-noel-pol").value || 0);
    nuevo.noelEps = Number(document.getElementById("f-noel-eps").value || 0);
  }

  const check = validarTurno(nuevo);
  if (!check.ok){
    showAlert(check.motivo, "error");
    return;
  }

  TURNOS.push(nuevo);
  saveTurnos();
  showAlert(`Turno ${entidad} registrado sin conflictos (${fecha} ${inicio}–${fin}).`, "ok");
  renderAll();
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
  out += `| Fecha | Turno | Particular | Póliza | EPS | Subtotal |\n`;
  out += `|---|---|---|---|---|---|\n`;
  let noelTotal = 0;
  for (const t of porEntidad.NOEL){
    const calc = calcularTurno(t);
    noelTotal += calc.subtotal;
    out += `| ${t.fecha} | ${t.inicio}-${t.fin} | ${t.noelPart||0} | ${t.noelPol||0} | ${t.noelEps||0} | ${fmtMoney(calc.subtotal)} |\n`;
  }
  out += `| **TOTAL NOEL** | | | | | **${fmtMoney(noelTotal)}** |\n\n`;

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
  const rows = [["Fecha","Entidad","Sede/Turno","Inicio","Fin","Horas","Particular","Poliza","EPS","Subtotal"]];
  for (const t of list){
    const calc = calcularTurno(t);
    rows.push([
      t.fecha, t.entidad, t.sede||"", t.inicio, t.fin,
      fmtHours(calc.horas),
      t.noelPart||"", t.noelPol||"", t.noelEps||"",
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
  ws["!cols"] = [{wch:12},{wch:8},{wch:8},{wch:9},{wch:42},{wch:14}];
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
  document.getElementById("cfg-noel-eps").value = CONFIG.noelEps;
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
    noelEps: Number(document.getElementById("cfg-noel-eps").value || 0),
  };
  saveConfig();
}

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", ()=>{
  loadConfigIntoForm();
  document.getElementById("f-fecha").value = new Date().toISOString().slice(0,10);
  document.getElementById("filter-month").value = new Date().toISOString().slice(0,7);

  document.getElementById("f-entidad").addEventListener("change", toggleFormFields);
  toggleFormFields();

  const dlgSettings = document.getElementById("dlg-settings");
  document.getElementById("btn-open-settings").addEventListener("click", ()=> dlgSettings.showModal());
  document.getElementById("btn-close-settings").addEventListener("click", ()=> dlgSettings.close());
  dlgSettings.addEventListener("click", (e)=>{ if (e.target === dlgSettings) dlgSettings.close(); });

  document.getElementById("btn-save-config").addEventListener("click", ()=>{
    readConfigFromForm();
    showAlert("Maestro de tarifas guardado.", "ok");
    renderAll();
    dlgSettings.close();
  });
  document.getElementById("btn-save-ces").addEventListener("click", ()=>{
    readConfigFromForm();
    showAlert("Configuración operativa (bloqueo CES) guardada.", "ok");
    renderAll();
    dlgSettings.close();
  });

  document.getElementById("btn-add-turno").addEventListener("click", handleAddTurno);
  document.getElementById("filter-month").addEventListener("change", renderAll);

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

  renderAll();
});
