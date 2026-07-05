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
| **Consulta** | Ver documentos, contingencia y la auditoría. |
| **Operador** | Además: emitir un CDE rápido, reenviar correos, reintentar fallos e invalidar. |
| **Administrador** | Además: crear usuarios, abrir contingencia y exportar el F960. |
| **Propietario** | Además: la sección **Configuración** (credenciales, ambiente, correo, alertas). |

Si olvidó su contraseña, en la pantalla de ingreso pulse **¿Olvidó su contraseña?** y siga
el enlace que llegará a su correo. Por seguridad, tras varios intentos fallidos el sistema
lo hará esperar unos minutos antes de reintentar.

---

## 2. El flujo normal de una donación

Cuando un donante paga por **Wompi**, todo ocurre solo:

1. Wompi avisa al sistema del pago aprobado.
2. El sistema arma el CDE, lo firma y lo transmite al Ministerio de Hacienda.
3. Al recibir el **sello** de Hacienda, envía al donante su comprobante en PDF por correo.

Usted no tiene que hacer nada en el caso normal. En **Documentos** verá el CDE con el
estado **Aceptado** y su **Sello**. Solo intervenga si algo aparece en **Fallos** o si se
abre una **Contingencia** (secciones 5 y 6).

---

## 3. CDE rápido para donaciones en persona

Para una donación recibida en efectivo o fuera de Wompi, use el panel **CDE rápido** que
aparece arriba en la sección **Documentos** (requiere rol Operador o superior):

1. Complete **Monto**, **Nombre o razón social**, el tipo y número de **Documento** del
   donante y, si lo tiene, **Correo** y **Teléfono**.
2. Pulse **Generar**. El sistema transmite el CDE al Ministerio de Hacienda y, si hay
   correo, lo envía al donante.

Si necesita editar campos avanzados (dirección, tipo de donación, unidad de medida, etc.),
pulse **CDE avanzado** y revise cada paso antes de generar.

---

## 4. Qué significa cada estado

Cada CDE muestra una etiqueta de color con su estado:

| Estado | Significado |
|---|---|
| **Pendiente** | Recién recibido; aún no se ha firmado ni transmitido. |
| **Firmado** | Firmado localmente, a la espera de transmitir a Hacienda. |
| **Transmitido** | Enviado a Hacienda; esperando respuesta. |
| **Aceptado** | Hacienda lo selló. Es el estado correcto y final. |
| **Rechazado** | Hacienda no lo aceptó. Aparecerá en **Fallos**. |
| **Contingencia** | Emitido mientras Hacienda no estaba disponible; se transmitirá luego. |
| **Fallido** | Ocurrió un error en el proceso. Aparecerá en **Fallos**. |
| **Invalidado** | El CDE fue anulado ante Hacienda con un evento firmado. |

---

## 5. Cuando aparece algo en Fallos

La sección **Fallos** lista los CDE con errores o rechazos que requieren su atención.
Seleccione el documento en la lista y, en el panel de detalle a la derecha:

- Pulse **Reintentar** para volver a procesar el CDE. Es lo primero que debe intentar: la
  mayoría de fallos son temporales (Hacienda ocupada, corte de red) y se resuelven al
  reintentar.
- Si el correo al donante falló pero el CDE está **Aceptado**, corrija el correo con el
  lápiz junto a **Correo de envío** y pulse **Reenviar correo**.

**Cuándo escalar a soporte técnico:** si un mismo CDE sigue en **Fallido** o **Rechazado**
después de dos o tres reintentos, o si el mensaje de error menciona credenciales, firma o
certificado, no siga reintentando: contacte a soporte técnico (ver pie de página) e
indíquele el **Código de generación** del documento.

---

## 6. Qué significa una Contingencia abierta

Una **Contingencia** significa que Hacienda no estuvo disponible y el sistema emitió los CDE
de forma local para no detener el servicio. **No cunda el pánico:** los comprobantes son
válidos y el sistema reintenta transmitirlos automáticamente cada 15 minutos.

En la sección **Contingencia** verá el periodo activo, los **CDE pendientes** y los plazos.
El evento de contingencia tiene un **plazo legal de 72 horas** para regularizarse ante
Hacienda; el panel muestra ese plazo. Normalmente no debe hacer nada: el barrido automático
transmite los pendientes en cuanto Hacienda responde.

Si desea forzar el proceso sin esperar al barrido, pulse **Procesar pendientes**. Solo un
Administrador o Propietario puede **Abrir contingencia** manualmente (indicando tipo y
motivo); en el uso normal esto no es necesario.

---

## 7. Cómo y cuándo invalidar un CDE

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

## 8. Los correos de alerta

Si en **Configuración → Correo** hay un **Correo para avisos operativos**, esa dirección
recibirá automáticamente avisos cuando algo necesite atención:

| Alerta | Qué significa |
|---|---|
| **Contingencia abierta** | Hacienda no estuvo disponible y se abrió un periodo de contingencia. Revise la sección **Contingencia**. |
| **Mensaje de emisión agotó reintentos** | Un CDE no se pudo procesar tras varios intentos automáticos. Revise **Fallos**. |
| **Evento Wompi sin procesar** | Un pago de Wompi quedó estancado; el sistema intenta recuperarlo, pero conviene revisarlo. |
| **Certificado del firmador por vencer** | El certificado de firma de Hacienda está por vencer (avisos a 30, 14 y 3 días). Coordine su renovación con soporte técnico. |

Para configurar o cambiar esa dirección (rol Propietario): vaya a **Configuración → Correo**,
escriba el correo en **Correo para avisos operativos** y pulse **Guardar correo de alertas**.

---

## 9. Exportar el F960

Para el informe **F960** y control interno, use la sección **Exportar** (rol Administrador o
superior):

1. Elija el rango con **Desde** y **Hasta**.
2. Verá una vista previa con el número de registros y el total.
3. Pulse **Descargar CSV** para el archivo del F960, o **XLSX de inspección** para una
   hoja de cálculo más detallada.

Solo se incluyen los CDE **Aceptados** del periodo elegido.

---

## 10. Revisión mensual (2 minutos)

Una vez al mes, dedique un par de minutos a confirmar que todo está en orden:

- [ ] **Fallos** está vacío (o cada caso ya fue reintentado/escalado).
- [ ] No hay ninguna **Contingencia** abierta sin resolver.
- [ ] En **Configuración**, sección **Firmador del Ministerio de Hacienda**, el certificado
      aparece vigente (en verde), no por vencer.
- [ ] La exportación mensual de retención se completó (si tiene dudas, confírmelo con
      soporte técnico).

---

### Soporte técnico

Ante cualquier error que no se resuelva reintentando, o mensajes sobre credenciales, firma o
certificados, contacte a soporte técnico:

**[ Soporte técnico: agregar nombre, correo y teléfono de contacto ]**
