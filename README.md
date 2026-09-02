# Agenda Laura — Asistente Clínico Operativo y Financiero

Aplicación web (cliente estático + backend en Supabase) para gestionar los turnos de un médico especialista en Medellín entre **CES**, **AUNA** y **NOEL**, validando choques de horario y calculando la facturación de cada entidad. El acceso requiere iniciar sesión — la agenda es compartida entre todas las personas autorizadas, no una copia por navegador.

## Uso rápido

Abre `index.html` en el navegador (no requiere instalación ni servidor propio) e inicia sesión con un correo autorizado. Los turnos y la configuración viven en una base de datos compartida (Supabase), no en `localStorage` — cualquier persona autorizada ve y edita la misma agenda desde cualquier dispositivo.

## 0. Autenticación y seguridad

- El acceso exige **correo y contraseña** verificados por un servidor (Supabase Auth) — no es un candado decorativo en el JS: sin sesión válida, la base de datos misma rechaza cualquier lectura o escritura (Row Level Security en las tablas `turnos` y `configuracion`, restringida al rol `authenticated`).
- La URL del proyecto y la **anon key** en `app.js` son públicas por diseño de Supabase: por sí solas no dan acceso a nada, la protección real es RLS + sesión autenticada. La **service role key** (esa sí se salta la seguridad) nunca debe copiarse aquí ni a ningún código de cliente.
- **Crear cuentas de acceso**: desde el [Dashboard de Supabase](https://supabase.com/dashboard) del proyecto → Authentication → Users → "Add user", con el correo y una contraseña temporal para cada persona autorizada. No hay flujo de auto-registro dentro de la app — solo quien administra el proyecto Supabase puede dar de alta cuentas nuevas.
- Botón "Cerrar sesión" en la barra superior una vez adentro.

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
- `index.html` — estructura, pantalla de login y formularios.
- `style.css` — estilos.
- `app.js` — login/logout, persistencia en Supabase, validación, cálculo de tarifas, render y exportación.

## Backend (Supabase)
Proyecto Supabase dedicado ("Agenda Laura") con dos tablas:
- `public.turnos` — un registro por turno (entidad, fecha, horas, sede/pacientes según entidad).
- `public.configuracion` — fila única con el maestro de tarifas y el bloqueo CES.

Ambas con Row Level Security activo: solo el rol `authenticated` puede leer o escribir. Cargar `index.html` con internet y sesión válida es todo lo que se necesita — no hay servidor propio que desplegar ni mantener.
