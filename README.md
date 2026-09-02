# Agenda Laura — Asistente Clínico Operativo y Financiero

Aplicación web (cliente estático + backend en Supabase) para gestionar los turnos de un médico especialista en Medellín entre distintas **entidades** (contratantes/aseguradoras), validando choques de horario y calculando la facturación de cada una. El acceso requiere iniciar sesión — la agenda es compartida entre todas las personas autorizadas, no una copia por navegador.

## Uso rápido

Abre `index.html` en el navegador (no requiere instalación ni servidor propio) e inicia sesión con un correo autorizado. Los turnos y la configuración viven en una base de datos compartida (Supabase), no en `localStorage` — cualquier persona autorizada ve y edita la misma agenda desde cualquier dispositivo.

## 0. Autenticación y seguridad

- El acceso exige **correo y contraseña** verificados por un servidor (Supabase Auth) — no es un candado decorativo en el JS: sin sesión válida, la base de datos misma rechaza cualquier lectura o escritura (Row Level Security en todas las tablas, restringida al rol `authenticated`).
- La URL del proyecto y la **anon key** en `app.js` son públicas por diseño de Supabase: por sí solas no dan acceso a nada, la protección real es RLS + sesión autenticada. La **service role key** (esa sí se salta la seguridad) nunca debe copiarse aquí ni a ningún código de cliente.
- **Crear cuentas de acceso**: desde el [Dashboard de Supabase](https://supabase.com/dashboard) del proyecto → Authentication → Users → "Add user", con el correo y una contraseña temporal para cada persona autorizada. No hay flujo de auto-registro dentro de la app — solo quien administra el proyecto Supabase puede dar de alta cuentas nuevas.
- Botón "Cerrar sesión" en la barra superior una vez adentro.

## 1. Sistema de entidades (genérico y editable)

Cada institución/contrato es una **entidad** que se administra desde "⚙️ Entidades y tarifas" dentro de la app — no hay nombres fijos en el código. Al crear una entidad se elige uno de tres **tipos**, que define cómo se valida y se factura:

- **Por franja horaria** (`franja_fija`): bloque semanal fijo (días de la semana + hora inicio/fin + buffer de traslado en minutos + fecha desde la que aplica). Ningún otro turno puede solaparse con ese bloque (incluyendo el buffer). No genera facturación — es control de cumplimiento de un contrato con horas fijas (ej. un contrato tipo CES).
- **Por hora** (`por_hora`): tarifa por hora ordinaria vs. nocturna/fin de semana, con rango nocturno configurable. El cálculo parte el turno en segmentos por minuto (cruces de medianoche, entrada/salida de fin de semana, entrada/salida del rango nocturno) y aplica la tarifa que corresponda a cada segmento (ej. un contrato tipo AUNA).
- **Por agenda** (`por_agenda`): turnos variables facturados por **remitente** (EPS, aseguradora, medicina prepagada, Particular, Póliza...), cada uno con su propia tarifa por paciente/visita, administrable en "Remitentes por agenda" (ej. un contrato tipo NOEL).

El **tipo no se puede cambiar** una vez creada la entidad (cambiarlo corrompería la validación/facturación de los turnos ya registrados); nombre, color y los parámetros de configuración sí son editables en cualquier momento. Una entidad se **desactiva** en vez de eliminarse si ya tiene turnos o remitentes asociados, para no perder el histórico.

## 2. Reglas implementadas

### Disponibilidad y bloqueos
- Antes de guardar cualquier turno, la app valida solapamientos contra:
  - Otros turnos ya registrados (cualquier entidad) el mismo día.
  - El bloque fijo de **cada** entidad "por franja horaria" activa (incluyendo su buffer de traslado propio).
  - Si hay choque, el turno se **rechaza** y se muestra el conflicto exacto (con qué entidad y en qué rango).

### Facturación
- **Por hora**: nocturno (rango configurable) o fin de semana completo: tarifa nocturna. Ordinario (resto de horas): tarifa ordinaria.
- **Por agenda**: subtotal = suma de (cantidad × tarifa) de cada remitente registrado en el turno.
- **Por franja horaria**: solo registro de horas dentro del bloque, para control de cumplimiento (no genera facturación).

### Comportamiento de salida
Cada vez que se registra un turno o se consulta el balance, la app muestra:
1. Alerta de solapamiento (si la hubo, antes de rechazar).
2. Agenda consolidada en tabla cronológica (con filtro por mes).
3. Resumen financiero detallado por entidad (horas/pacientes, subtotal).

### Importador masivo
Desde "📥 Importar masivo" se pega o sube un CSV/Excel por entidad. El formato de columnas se adapta al tipo de la entidad elegida (fecha/horas simples para franja fija y por hora, más sede para por hora; fecha/horas + remitente + cantidad para por agenda, agrupando filas con la misma fecha/hora en un solo turno con varios remitentes).

### Exportación / cierre de mes
La sección "Cierre de mes" permite descargar el mes filtrado en la agenda como `.csv` o `.xlsx` (Fecha, Entidad, Sede, Inicio, Fin, Horas, Detalle y Subtotal).

## Estructura de archivos
- `index.html` — estructura, pantalla de login y formularios.
- `style.css` — estilos.
- `app.js` — login/logout, persistencia en Supabase, validación, cálculo de tarifas, render y exportación.

## Backend (Supabase)
Proyecto Supabase dedicado ("Agenda Laura") con estas tablas:
- `public.entidades` — una fila por entidad (nombre, tipo, color, configuración en JSON, orden, activa).
- `public.remitentes` — remitentes de las entidades "por agenda" (nombre, tarifa, entidad a la que pertenece).
- `public.turnos` — un registro por turno (entidad, fecha, horas, sede si aplica).
- `public.turno_detalle` — líneas de remitente/cantidad de los turnos de entidades "por agenda".

Todas con Row Level Security activo: solo el rol `authenticated` puede leer o escribir. Cargar `index.html` con internet y sesión válida es todo lo que se necesita — no hay servidor propio que desplegar ni mantener.
