# Agenda Laura — Asistente Clínico Operativo y Financiero

Aplicación web (100% cliente, sin backend) para gestionar los turnos de un médico especialista en Medellín entre **CES**, **AUNA** y **NOEL**, validando choques de horario y calculando la facturación de cada entidad.

## Uso rápido

Abre `index.html` en el navegador (no requiere instalación ni servidor). Los datos se guardan automáticamente en `localStorage` del navegador.

## Reglas implementadas

### 1. Disponibilidad y bloqueos
- **CES**: bloqueo estricto Lunes a Jueves, 07:00–11:00, a partir del **1 de octubre de 2026** (configurable). Ningún otro turno puede solaparse con este bloque ni con el "tiempo de traslado" configurable (buffer en minutos antes/después).
- **AUNA**: turnos por horas, cualquier día/horario.
- **NOEL**: turnos variables, registrados con conteo de pacientes por tipo.
- Antes de guardar cualquier turno, la app valida solapamientos contra:
  - Otros turnos ya registrados (cualquier entidad) el mismo día.
  - El bloque fijo de CES (incluyendo el buffer de traslado), si aplica la fecha.
  - Si hay choque, el turno se **rechaza** y se muestra el conflicto exacto.

### 2. Facturación
- **AUNA**:
  - Nocturno (rango configurable, por defecto 19:00–07:00) o fin de semana (sábado 00:00 a domingo 23:59): **$87.000/hora**.
  - Ordinario (lunes a viernes, horario diurno): **$85.000/hora**.
  - El cálculo parte el turno en segmentos por minuto (cruces de medianoche, entrada/salida de fin de semana, entrada/salida del rango nocturno) y aplica la tarifa que corresponda a cada segmento.
- **NOEL**:
  - Por cada turno: N° pacientes Particular, Póliza y EPS.
  - Tarifas por tipo configurables en "Configuración".
  - Subtotal = (Particular × tarifa) + (Póliza × tarifa) + (EPS × tarifa).
- **CES**:
  - Solo registro de horas trabajadas dentro del bloque, para control de cumplimiento del contrato vinculado (no genera facturación por hora en esta app).

### 3. Comportamiento de salida
Cada vez que se registra un turno o se consulta el balance, la app muestra:
1. Alerta de solapamiento (si la hubo, antes de rechazar).
2. Agenda consolidada en tabla cronológica (con filtro por mes).
3. Resumen financiero detallado por entidad (horas/pacientes, subtotal).

### 4. Exportación / cierre de mes
Botón "Cierre de mes" genera un bloque Markdown (tabla) discriminado por AUNA, NOEL y CES, listo para copiar a Excel/CSV, y permite descargarlo como `.csv`.

## Estructura de archivos
- `index.html` — estructura y formularios.
- `style.css` — estilos.
- `app.js` — lógica de validación, cálculo de tarifas, render y exportación.
