# Manual del operador — ExamplePerson1

Esta guía es para la persona que administra el panel **ExamplePerson1** en el día a día
(tesorería o secretaría de la iglesia). No necesita conocimientos técnicos. Todas las
acciones descritas aquí se hacen desde el panel web; los nombres de botones y secciones
aparecen tal como los verá en pantalla.

> Este documento acompaña al [README](../README.md), que está dirigido a quien instala y
> despliega la aplicación.

---

## 1. Qué es el panel y los roles

ExamplePerson1 emite **Comprobantes de Donación Electrónicos (CDE)** ante el Ministerio de
Hacienda y envía por correo el comprobante en PDF al donante. El menú lateral tiene estas
secciones: **Documentos**, **Fallos**, **Contingencia**, **Auditoría**, **Usuarios**,
**Exportar** y **Configuración**. No todas aparecen para todos los usuarios: dependen de su
rol.

| Rol | Qué puede hacer |
|---|---|
| **Consulta** | Ver documentos, el historial de contingencias y la auditoría. |
| **Operador** | Además: emitir un CDE rápido, reenviar correos, reintentar fallos e invalidar. |
| **Administrador** | Además: crear usuarios y exportar el F960. |
| **Propietario** | Además: la sección **Configuración** (credenciales, ambiente, correo, alertas). |

Si olvidó su contraseña, en la pantalla de ingreso pulse **¿Olvidó su contraseña?** y siga
el enlace que llegará a su correo. Por seguridad, tras varios intentos fallidos el sistema
lo hará esperar unos minutos antes de reintentar.

La **Auditoría** ahora registra el usuario que realizó cada acción, su IP y el contexto de
la solicitud (ubicación, ISP, navegador, TLS/protocolo); pulse la flecha de una fila para
ver el detalle. Las entradas anteriores a esta versión no tienen IP ni contexto.

---

## 2. El flujo normal de una donación

Cuando un donante paga por **Wompi**, todo ocurre solo:

1. Wompi avisa al sistema del pago aprobado.
2. El sistema arma el CDE, lo firma y lo transmite al Ministerio de Hacienda.
3. Al recibir el **sello** de Hacienda, envía al donante su comprobante en PDF por correo.

Usted no tiene que hacer nada en el caso normal. En **Documentos** verá el CDE con el
estado **Aceptado** y su **Sello**. Solo intervenga si algo aparece en **Fallos**
(sección 6); los CDE **En trámite** se resuelven solos (sección 7).

---

## 3. Donaciones en línea (página /donar)

Además del enlace de pago fijo de Wompi, la aplicación publica una página **/donar**. Los datos del
donante se **dividen** entre el formulario y la pantalla de pago de Wompi:

- **Formulario /donar:** el **documento** fiscal y la **dirección** (departamento, municipio,
  distrito y complemento), además del teléfono opcional y el monto.
- **Pantalla de Wompi:** el **nombre** y el **correo**, que Wompi pide obligatoriamente en su propia
  pantalla de pago (no se pueden desactivar ni rellenar por adelantado).

Con esas dos fuentes el sistema arma el comprobante, así que el CDE sale con la información correcta
del donante sin que usted tenga que capturarla.

**Tipos de documento aceptados en /donar:** DUI (con validación del dígito verificador), Empresa,
Otro (texto libre), Pasaporte y Carnet de Residente (de 5 a 30 caracteres). Las empresas donan con
NIT y razón social: cuando el donante elige **Empresa**, el formulario le pide el **NIT de la
empresa** (14 dígitos) y la **razón social**, y es esa razón social (no el nombre de la tarjeta con
la que se pagó) la que aparece como donante en el comprobante. La opción se llama «Empresa» y no
«NIT» a propósito: muchas personas naturales todavía conservan un NIT personal antiguo, pero para
donar como persona natural el documento correcto es el DUI.

**Donantes en el extranjero:** el formulario tiene la casilla **«Resido en el extranjero»**. Al
marcarla, en lugar de departamento/municipio/distrito el donante elige su **país** y escribe su
dirección completa. El comprobante sale con esa dirección y el nombre del país, y Hacienda lo recibe
con los códigos oficiales para direcciones extranjeras. No requiere ninguna acción suya: es parte del
mismo flujo automático.

**Cómo funciona:**

1. El donante abre la página **/donar**, completa el documento y la dirección, y elige el monto.
2. El sistema valida los datos y genera un **enlace de pago de un solo uso** en Wompi.
3. En la pantalla de Wompi, el donante escribe su **nombre** y **correo** y paga.
4. Cuando el donante paga, Wompi avisa al sistema, que arma y transmite el CDE combinando el
   documento y la dirección del formulario con el nombre y el correo de Wompi; al recibir el sello de
   Hacienda, envía el comprobante por correo.
5. La página del donante muestra automáticamente la confirmación.

**Qué significa cada estado de una donación en línea** (los verá en la sección **Exportar**):

| Estado | Significado |
|---|---|
| **Pendiente** | Datos recibidos; se está generando el enlace de pago. |
| **Enlace creado** | El enlace de pago ya existe; se espera que el donante pague. |
| **Completada** | El pago se recibió y el CDE fue aceptado por Hacienda. Muestra su **Número de control**. |
| **Vencida** | El donante nunca pagó y el enlace expiró. No requiere ninguna acción. |

En la sección **Exportar** (rol Administrador o superior) verá la tarjeta **Donaciones en línea**
con las últimas donaciones recibidas por este medio: estado, monto, donante, fecha y, para las
**Completadas**, el número de control del CDE emitido. La columna **donante** se toma del nombre que
quedó en el CDE emitido (el que el donante escribió en Wompi), por lo que solo aparece en las
donaciones **Completadas**; en los demás estados verá «—». Cuando abra un CDE que provino de este
formulario, en su detalle aparecerá la etiqueta **«Datos del donante verificados en el formulario
de donación»**, que le indica que el documento y la dirección fueron capturados y validados por el
propio donante en el formulario, no tomados del aviso de pago.

**El enlace de pago fijo sigue funcionando.** Si un donante paga por el enlace estático de siempre
(sin pasar por /donar), el comprobante se emite igual, tomando los datos disponibles del aviso de
pago de Wompi. Esas donaciones no aparecen en la lista de **Donaciones en línea** porque no pasaron
por el formulario.

**Donantes en Estados Unidos (NO reciben CDE — es intencional).** Si en /donar el donante marca
«Resido en el extranjero» y elige **Estados Unidos**, desaparecen los campos fiscales salvadoreños y
la página muestra el formulario de **Givebutter** de *Friends of Misión ExampleOrganization (FMCE)*, la
entidad 501c3 estadounidense. Un contribuyente de EE. UU. necesita un recibo deducible en su país,
no un CDE salvadoreño, así que esas donaciones se procesan por completo en Givebutter: **no pasan por
Wompi, no generan una donación en línea, no aparecen en la lista de Exportar y no se emite ningún CDE.**
El propio Givebutter le envía al donante su recibo. Si el formulario incrustado no carga, el enlace
**«Done en GiveButter»** abre la página alojada de Givebutter en una pestaña nueva. Si algún donante
de EE. UU. le escribe preguntando por su CDE, la respuesta correcta es que su donación se procesó en
EE. UU. y su recibo proviene de Givebutter/FMCE, no del sistema salvadoreño.

> **Nota técnica (para quien instala):** la página /donar necesita dos secretos nuevos,
> `WOMPI_CLIENT_ID` y `WOMPI_CLIENT_SECRET`, que se obtienen del panel de Wompi en **Datos del
> negocio** y se configuran con `npx wrangler secret put WOMPI_CLIENT_ID --env staging|production`
> (y lo mismo para `WOMPI_CLIENT_SECRET`). El enlace de pago fijo no los necesita. Si algo en esta
> sección no funciona, contacte a soporte técnico.

---

## 4. CDE rápido para donaciones en persona

Para una donación recibida en efectivo o fuera de Wompi, use el panel **CDE rápido** que
aparece arriba en la sección **Documentos** (requiere rol Operador o superior):

1. Complete **Monto**, **Nombre o razón social**, el tipo y número de **Documento** del
   donante y, si lo tiene, **Correo** y **Teléfono**.
2. Pulse **Generar**. El sistema transmite el CDE al Ministerio de Hacienda y, si hay
   correo, lo envía al donante.

Si necesita editar campos avanzados (dirección, tipo de donación, unidad de medida, etc.),
pulse **CDE avanzado** y revise cada paso antes de generar.

---

## 5. Qué significa cada estado

Cada CDE muestra una etiqueta de color con su estado:

| Estado | Significado |
|---|---|
| **Pendiente** | Recién recibido; aún no se ha firmado ni transmitido. |
| **Firmado** | Firmado localmente, a la espera de transmitir a Hacienda. |
| **Transmitido** | Enviado a Hacienda; esperando respuesta. |
| **Aceptado** | Hacienda lo selló. Es el estado correcto y final. |
| **Rechazado** | Hacienda no lo aceptó. Aparecerá en **Fallos**. |
| **En trámite** | Hacienda no estaba disponible al emitir. El donante ya recibió su comprobante **transitorio** y el sistema reintenta la transmisión cada 15 minutos (sección 7). |
| **Contingencia** | Estado histórico del modelo anterior; ya no se emite en contingencia (sección 7). |
| **Fallido** | Ocurrió un error en el proceso. Aparecerá en **Fallos**. |
| **Invalidado** | El CDE fue anulado ante Hacienda con un evento firmado. |

---

## 6. Cuando aparece algo en Fallos

La sección **Fallos** reúne dos situaciones distintas:

- Una tarjeta **CDE NO CREADO** significa que el pago de Wompi sí llegó, pero el error
  ocurrió antes de crear el CDE. No es un CDE **Fallido** ni **Rechazado**: todavía no
  existe un comprobante que Hacienda pueda aceptar o rechazar. Lea el error exacto que
  muestra la tarjeta y pulse **Reintentar creación**.
- Un CDE **Fallido** ya existe, pero tuvo un error durante el proceso. Un CDE
  **Rechazado** también existe y Hacienda respondió que no lo aceptaba. Para estos casos,
  seleccione el documento en la lista y use el panel de detalle a la derecha.
- Un CDE **Aceptado** también aparece aquí cuando el comprobante fiscal quedó correcto
  pero su correo falló o quedó con resultado incierto. La fila muestra **Correo fallido**
  cuando el proveedor confirmó un fallo y **Correo por revisar** cuando el sistema no
  puede confirmar si el proveedor lo aceptó. El detalle explica si el envío se puede
  intentar otra vez con seguridad o necesita revisión.

En una tarjeta **CDE NO CREADO**, **Número reservado** significa que el sistema apartó ese
número para crear el mismo comprobante al reintentar; no significa que el CDE ya fue
emitido ni aceptado. **Número aún no asignado** significa que el error ocurrió antes de
reservarlo. No emita otro CDE para sustituir esa tarjeta.

Para un CDE **Fallido** o **Rechazado**:

- Pulse **Reintentar DTE** para volver a procesar el CDE. Es lo primero que debe intentar: la
  mayoría de fallos son temporales (Hacienda ocupada, corte de red) y se resuelven al
  reintentar.
- Si el correo al donante falló pero el CDE está **Aceptado**, corrija el correo con el
  lápiz junto a **Correo de envío** si hace falta y pulse **Reenviar ahora** dentro del
  aviso rojo. Púlselo una sola vez; si el sistema no puede confirmar el resultado
  anterior, el botón queda bloqueado para evitar dos correos y pide revisión manual.
  No intente sortear un aviso **Correo por revisar** con otro navegador o usuario.

**Cuándo escalar a soporte técnico:** si un mismo CDE sigue en **Fallido** o **Rechazado**
después de dos o tres reintentos, o si el mensaje de error menciona credenciales, firma o
certificado, no siga reintentando: contacte a soporte técnico (ver pie de página) e
indíquele el **Código de generación** del documento. Para un **CDE NO CREADO**, si el
mismo error de validación se repite después de **Reintentar creación**, no siga pulsando
el botón: contacte a soporte y comparta el error exacto de la tarjeta y el **Número
reservado**, si aparece.

---

## 7. Qué significa un CDE «En trámite»

Cuando Hacienda no está disponible, el sistema **no detiene el servicio**: firma el CDE de
forma normal, lo deja **En trámite** y **envía de inmediato al donante su comprobante
transitorio** por correo (el PDF indica sello «TRANSITORIO» y el mensaje aclara que es
provisional). Después, el sistema **reintenta la transmisión automáticamente cada 15
minutos**; cuando Hacienda responde y sella el CDE, el donante recibe un **segundo correo
con el comprobante definitivo** (con Sello de Recepción). El donante recibe dos correos:
es el comportamiento esperado, no un error.

**No cunda el pánico ni haga nada:** los reintentos son automáticos. Si Hacienda tarda más
de una hora, llegará una alerta operativa («Hacienda no disponible») a modo informativo.
Si al reintentar Hacienda **rechaza** el CDE, este pasa a **Fallos** y se maneja como
cualquier rechazo (sección 6).

**¿Y la sección Contingencia?** Quedó como **historial de solo lectura**. La normativa no
contempla contingencia para el CDE (la tabla de validaciones del evento de contingencia —
campo 35 — no admite el tipo 15), así que el sistema ya no abre periodos ni transmite
lotes de contingencia; los periodos antiguos siguen visibles para consulta. Si allí queda
algún CDE del modelo anterior sin sello, contacte a soporte técnico para reemitirlo.

### Resultado fiscal pendiente de conciliación

Esta advertencia significa que Hacienda pudo haber recibido una transmisión aunque la
respuesta no llegó al sistema. **No reintente, invalide ni reenvíe ese CDE.** Los botones y
las exportaciones que dependen de un estado fiscal definitivo quedan bloqueados para evitar
una segunda operación legal o un comprobante incorrecto. Anote el código de generación y
contacte a la persona que despliega la aplicación; debe seguir el procedimiento técnico
de [conciliación fiscal](fiscal-claim-reconciliation.md) con evidencia oficial de MH.

---

## 8. Cómo y cuándo invalidar un CDE

Se invalida un CDE cuando la donación no debía comprobarse (por ejemplo, un dato equivocado
o una operación que se deja sin efecto). Reglas importantes:

- Solo se puede invalidar un CDE **Aceptado** y con **Sello**.
- Hay una **ventana legal**: hasta el **décimo día hábil del mes siguiente** al sello. El
  panel muestra el tiempo restante y bloquea el botón cuando la ventana cierra.
- Cuando Hacienda acepta la invalidación, **el donante recibe automáticamente un aviso por
  correo**.

Para invalidar: seleccione el CDE, pulse **Invalidar** y, en la ventana **Confirmar
invalidación**, elija el **Tipo de invalidación**:

- **2 - Rescindir la operación (dejar sin efecto el CDE)**: para dejar sin efecto la
  donación.
- **1 - Error en datos, con CDE de reemplazo ya emitido**: úselo solo si **primero** emitió
  el CDE correcto de reemplazo; deberá indicar su **Código de generación**.

Escriba el **Motivo** y pulse **Confirmar invalidación**. Esta acción no se puede deshacer
desde el panel.

---

## 9. Los correos de alerta

Si en **Configuración → Correo** hay un **Correo para avisos operativos**, esa dirección
recibirá automáticamente avisos cuando algo necesite atención:

| Alerta | Qué significa |
|---|---|
| **Hacienda no disponible** | Hay CDE **En trámite** desde hace más de una hora porque Hacienda no responde. Los donantes ya tienen su comprobante transitorio; el sistema sigue reintentando cada 15 minutos. |
| **Mensaje de emisión agotó reintentos** | El caso agotó sus intentos automáticos. Si corresponde a un evento o pago de Wompi sin documento, abra **Fallos → CDE NO CREADO**, revise el error exacto guardado (sin datos sensibles) y pulse **Reintentar creación**. Si corresponde a un CDE avanzado o ya existente, abra ese CDE fallido en **Fallos** y revise el error del documento. En ambos casos, si el mismo error de validación se repite, contacte a soporte en vez de seguir reintentando. |
| **Evento Wompi sin procesar** | Un pago de Wompi quedó estancado; el sistema intenta recuperarlo, pero conviene revisarlo. |
| **Certificado del firmador por vencer** | El certificado de firma de Hacienda está por vencer (avisos a 30, 14 y 3 días). Coordine su renovación con soporte técnico. |

Para configurar o cambiar esa dirección (rol Propietario): vaya a **Configuración → Correo**,
escriba el correo en **Correo para avisos operativos** y pulse **Guardar correo de alertas**.

El sistema evita repetir un aviso ya confirmado; si no puede confirmar si el proveedor lo aceptó,
deja el caso para revisión técnica en vez de enviarlo otra vez automáticamente.

Además del correo, soporte supervisa cada incidente en **Workers Observability** de Cloudflare con
el evento `operational_alert` y recibe la notificación mediante una política de **Cloudflare
Notifications**. Esa ruta es independiente del correo de la aplicación; si necesita atención
operativa, contacte a soporte para que revise ambas señales.

---

## 10. Exportar el F960

Para el informe **F960** y control interno, use la sección **Exportar** (rol Administrador o
superior):

1. Elija el rango con **Desde** y **Hasta**.
2. Verá una vista previa con el número de registros y el total.
3. Pulse **Descargar CSV** para el archivo del F960, o **XLSX de inspección** para una
   hoja de cálculo más detallada.

Solo se incluyen los CDE **Aceptados** del periodo elegido.

---

## 11. Revisión mensual (2 minutos)

Una vez al mes, dedique un par de minutos a confirmar que todo está en orden:

- [ ] **Fallos** está vacío (o cada caso ya fue reintentado/escalado).
- [ ] No hay CDE **En trámite** con más de un día (si los hay, Hacienda lleva mucho tiempo
      sin responder: contacte a soporte técnico).
- [ ] En **Configuración**, sección **Firmador del Ministerio de Hacienda**, el certificado
      aparece vigente (en verde), no por vencer.
- [ ] La exportación mensual de retención se completó (si tiene dudas, confírmelo con
      soporte técnico).

---

### Soporte técnico

Ante cualquier error que no se resuelva reintentando, o mensajes sobre credenciales, firma o
certificados, contacte a soporte técnico:

**[ Soporte técnico: agregar nombre, correo y teléfono de contacto ]**
