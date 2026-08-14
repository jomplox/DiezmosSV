# Stripe para entregas de EE. UU.

Esta integración pertenece exclusivamente a la puerta **EE. UU. 501(c)(3)**. Wompi y la emisión DTE siguen siendo la única ruta de El Salvador; una entrega de Stripe nunca crea un `donation_intent`, nunca pasa por Wompi y nunca genera un CDE salvadoreño. El Paso 1 de la ruta SV no crea por adelantado ningún enlace Wompi: si el país elegido después es Estados Unidos, el asistente conserva el monto y tipo de entrega veraces, reinicia la frecuencia como Única y vuelve al Paso 1 explícito de EE. UU. Ninguna Checkout Session de Stripe se crea hasta que el donante confirma ese paso.

El navegador solicita una Checkout Session al Worker y monta Stripe Embedded Checkout dentro de la página. Stripe aloja, compone y actualiza el formulario completo en español, incluidos los campos, billeteras y métodos elegibles; la aplicación conserva el paso exterior de **Tipo de entrega** (Diezmo u Ofrenda), monto y frecuencia (Única o Mensual). La selección se incluye en la sesión y sus metadatos; el Worker no inventa una selección ausente. Stripe es el formulario predeterminado, pero el donante puede elegir **Dar con Givebutter — Formulario en inglés**. Esa acción desmonta por completo Stripe Embedded Checkout y monta la misma campaña Givebutter usada por el despliegue anterior, con monto y frecuencia precargados. Volver a Stripe desmonta Givebutter y reutiliza la misma Session. El cargador puro de Stripe.js solo se invoca dentro del formulario estadounidense real después de recibir una Session no simulada: el selector inicial, SV/Wompi, la simulación local, el resultado y el panel no insertan `js.stripe.com`. La confirmación no se infiere del regreso del navegador: `/donar/stripe/resultado` consulta el estado durable en D1, alimentado por un webhook firmado e idempotente. Una entrega mensual se registra una sola vez únicamente cuando `invoice.paid` y `invoice_payment.paid` aportan evidencia compatible, pagada y respaldada por PaymentIntent; ambos órdenes convergen en D1. Se administra mediante Stripe Billing Portal.

La campaña Givebutter es configuración pública vinculada al build: `VITE_GIVEBUTTER_CAMPAIGN` vive en el archivo privado de despliegue `0600` y `scripts/run-private-build.mjs` inyecta solamente ese slug. El wrapper rechaza valores vacíos, el placeholder o un valor que no sea un único segmento seguro. No codifique la campaña de un despliegue en el repositorio reutilizable. Ninguna clave ni configuración de Stripe se mueve a Vite.

Cada entrega estadounidense recibe un acuse inmediato 501(c)(3) en español, con la entidad legal, EIN, fecha, monto, tipo y frecuencia, y la declaración de que no se proporcionaron bienes ni servicios. La pantalla **Exportar** separa **El Salvador — CDE** de **EE. UU. — Stripe**: el segundo genera la **Constancia anual de donaciones — EE. UU.** a partir de entregas Stripe liquidadas, netas de reembolsos y agrupadas por el año calendario de `STRIPE_US_TIME_ZONE`. Es una constancia estadounidense, no un CDE ni un expediente fiscal salvadoreño; el carril SV sigue usando solamente CDE aceptados y su dossier existente.

## Por qué Embedded Checkout y no un Payment Link

Un Payment Link literal sirve para una donación única con monto elegido por el donante o para una suscripción de monto fijo, pero Stripe no admite donaciones recurrentes con monto libre en el mismo enlace. Esta aplicación necesita que el donante elija tanto el monto como **Única** o **Mensual**. Por eso el Worker crea una Checkout Session por intento con `ui_mode: "embedded_page"`: conserva el formulario alojado y actualizado por Stripe, admite ambos modos y mantiene nuestros identificadores, idempotencia, metadatos y webhook durable.

## Métodos dinámicos y exclusión de financiamiento

El Worker envía `payment_method_configuration` y deliberadamente **no** envía `payment_method_types`. Stripe puede mostrar tarjetas, Apple Pay, Google Pay, Link, ACH, Cash App Pay, Amazon Pay y cualquier método futuro que sea seguro para el donante y elegible para esa sesión, sin publicar código nuevo. Que un método esté activado no garantiza que aparezca: Stripe evalúa la capacidad de la cuenta, USD, monto, frecuencia única o mensual, país, dispositivo, navegador y billetera del donante.

El propietario debe crear en la cuenta estadounidense conectada una configuración dedicada, por ejemplo `DiezmosSV - donaciones`, y:

1. Activar la configuración y habilitar todos los métodos de donación elegibles.
2. Desactivar **Affirm**, **Afterpay/Clearpay**, **Klarna**, **Scalapay**, **Sunbit**, **Zip** y cualquier BNPL o método de financiamiento presente o futuro.
3. Revisar por separado la vista de entrega única y la mensual; Stripe puede excluir métodos que no admiten recurrencia.
4. Copiar el identificador `pmc_…` a `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID`.
5. Guardar evidencia fechada de la configuración. El código impide una lista manual, pero la exclusión BNPL depende de esta configuración de cuenta.

El inventario de métodos y elegibilidad de la cuenta es información de despliegue temporal: no se versiona en este repositorio reutilizable. El propietario debe volver a verificarlo inmediatamente antes de cada lanzamiento y conservar la evidencia fechada en el expediente privado de la release.

Antes de probar billeteras en un host real, registre cada dominio de staging/producción en **Payment method domains** y compruebe su estado. Apple Pay no aparece en Embedded Checkout desde un dominio no registrado; la prueba también requiere HTTPS y un dispositivo/navegador compatible. `localhost` solo sirve para desarrollo y no sustituye la verificación del dominio desplegado.

Referencias oficiales: [métodos dinámicos](https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods), [configuraciones de métodos](https://docs.stripe.com/payments/payment-method-configurations) y [dominios de métodos](https://docs.stripe.com/payments/payment-methods/pmd-registration).

## Configuración de sandbox

No cambiar ni modificar **live** hasta completar y documentar todo este bloque en sandbox.

1. En el sandbox de la cuenta estadounidense conectada, cree la configuración de métodos anterior y una configuración de Billing Portal que permita actualizar el método guardado y cancelar la entrega mensual. Mantenga el portal en español; el Worker solicita `locale: "es"`.
2. Cree una clave restringida `rk_test_…`. Conceda solamente:
   - **Checkout Sessions — Write**, para crear y recuperar la sesión de Embedded Checkout.
   - **Billing Portal — Write**, para crear una sesión de administración mensual.
   - El acceso mínimo de lectura que Stripe exija para **Customers** al crear el portal; si la operación funciona sin él, manténgalo en `None`.
   - Todo lo demás en `None`. No se necesita una clave `sk_…` ni capacidad de reembolsar. La clave restringida nunca llega al navegador.
3. Cree el endpoint `https://<host-staging>/webhooks/stripe`, fije su versión de API en
   `2026-07-29.dahlia` y seleccione estos eventos exactos:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `invoice_payment.paid`
   - `customer.subscription.deleted`
   - `charge.succeeded`
   - `charge.refunded`
4. Guarde como Cloudflare secret, nunca en Git ni en el bundle Vite:
   - `STRIPE_RESTRICTED_KEY=rk_test_…`
   - `STRIPE_PUBLISHABLE_KEY=pk_test_…`
   - `STRIPE_WEBHOOK_SECRET=whsec_…`
   - `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID=pmc_…`
   - `STRIPE_BILLING_PORTAL_CONFIGURATION_ID=bpc_…`
   - `STRIPE_US_LEGAL_NAME=<nombre legal exacto de la entidad estadounidense>`
   - `STRIPE_US_EIN=NN-NNNNNNN`
   - `STRIPE_US_PHONE=<teléfono público de la entidad estadounidense>`
   - `STRIPE_US_WEBSITE=https://…`
   - `STRIPE_US_MAILING_ADDRESS=<dirección postal; un renglón por línea>`
   - `STRIPE_US_SIGNER_NAME=<nombre del firmante autorizado>`
   - `STRIPE_US_SIGNER_TITLE=<cargo del firmante autorizado>`
5. Use el wrapper privado del repositorio para escribir cada valor de runtime; no ejecute Wrangler remoto sin ese wrapper. La clave publicable es segura para el navegador y el Worker la devuelve únicamente después de crear la sesión, pero sigue separada por ambiente y no se fija en el bundle. Los identificadores que no son credenciales también permanecen fuera del repositorio público porque identifican la cuenta y el despliegue.

`STRIPE_MOCK_MODE="1"` es una facilidad determinista para local y staging aislado. Está prohibido en producción y el Worker falla cerrado si intenta combinarlo con `APP_ENV=production`.

Si el runtime local de `workerd` no puede realizar HTTPS saliente, ejecute `npm run dev:stripe-api-proxy` y defina `STRIPE_API_PROXY_URL="http://127.0.0.1:8791"` en el archivo privado local. El Worker acepta ese puente únicamente con `APP_ENV=local` y un origen HTTP de loopback sin ruta ni credenciales; staging y producción lo rechazan.

La versión fijada por el SDK es `2026-07-29.dahlia`. Sandbox requiere el par `rk_test_…` / `pk_test_…`; producción requiere `rk_live_…` / `pk_live_…`. El Worker rechaza claves de ambientes opuestos, una clave amplia `sk_…`, un evento `livemode` incorrecto, una versión API distinta o una firma inválida.

Las claves restringidas reducen el alcance de una exposición y deben permanecer solo en el servidor. Consulte [claves de API](https://docs.stripe.com/keys) y [prácticas de seguridad](https://docs.stripe.com/keys-best-practices).

## Firma, idempotencia y datos durables

Stripe debe firmar el **cuerpo crudo** recibido en `/webhooks/stripe`; no se debe analizar ni reconstruir JSON antes de verificar la firma. Cada `event.id` se reclama en `stripe_webhook_events`, con reintento seguro y sin guardar el cuerpo crudo. Una reclamación de webhook o creación de Checkout abandonada se recupera después de una concesión de cinco minutos, conservando la misma identidad e idempotency key y con un máximo de tres intentos de creación. La identidad de sesión, ambiente, moneda USD, monto, frecuencia y metadatos `lane=eeuu_501c3` se validan antes de cambiar estado.

Un resultado ambiguo de red o `5xx` se reintenta con los mismos parámetros y la misma idempotency key; esa generación no rota automáticamente. Solo un rechazo `4xx` reconocido como definitivo antes de ejecutar la creación permite que un intento corregido avance la generación. Si Stripe devuelve una Session válida pero falla su primer enlace durable en D1, la ruta de estado recupera y adjunta esa misma Session por la identidad opaca de la reserva; un webhook firmado también la adjunta antes de aplicar el evento. Ambos caminos validan toda la identidad y rechazan una Session distinta.

Antes de la primera llamada al proveedor, D1 conserva una **huella SHA-256 no reversible** de los parámetros canónicos completos de la Session y de su identidad de creación: clave restringida, proxy local, clave publicable, ambiente y versión API. La huella incorpora también el nombre visible, origen, Payment Method Configuration e identificadores que formarán el cuerpo; no guarda ningún valor de clave ni permite reconstruirlo. En un resultado ambiguo, un reintento debe reproducir esa huella antes de reclamar la fila. Si la configuración o el branding cambia, el Worker no llama a Stripe, no incrementa el intento y mantiene la solicitud original como indeterminada. Un rechazo `4xx` definitivo es la única transición que puede fijar una huella corregida junto con una nueva generación.

Después de tres intentos ambiguos, la fila continúa **indeterminada** bajo la misma identidad, idempotency key y UUID del navegador; nunca responde como un caso terminal que autorice otra Session. Una entrega firmada que llegue más tarde por el webhook firmado todavía reconcilia esa misma identidad, adjunta la Session validada y hace converger el estado durable. Una carrera de reclamación siempre vuelve a leer D1 antes de responder, para no confundir una fila ya reclamada o adjuntada con el estado anterior.

Una entrega única se identifica por PaymentIntent. Cada entrega mensual se identifica por factura y exige un InvoicePayment pagado con `payment.type=payment_intent`; `invoice.paid` por sí solo no basta porque Stripe también lo emite cuando una factura se marca pagada fuera de banda. La pareja de evidencias produce exactamente un registro por renovación aunque Stripe reintente o entregue eventos fuera de orden. Los recibos 501(c)(3) se despachan con su propia cerca durable e idempotente; una reclamación anterior al envío puede recuperarse, pero un resultado ambiguo posterior al inicio del envío queda en `stripe_acknowledgment_deliveries.status='REVIEW'` en vez de arriesgar un duplicado. Los estados `FAILED` y `REVIEW` generan una alerta saneada y aparecen, sin identidad del donante, en **Configuración → Stripe EE. UU. → Constancias inmediatas** para que un `OWNER` confirme si el proveedor envió o no envió antes de permitir otro intento.

Las constancias anuales usan una cerca y una instantánea independientes. Una fila sin correo puede aparecer en la vista previa, pero no se envía. Un reembolso cambia la instantánea y permite una constancia corregida claramente identificada; un resultado desconocido después de iniciar un envío queda en revisión, no se reintenta como si no hubiese ocurrido.

## Configuración Stripe EE. UU. en el panel

Solo el rol **Propietario** usa **Configuración → Stripe EE. UU.**. El panel muestra presencia y estado operacional seguro; ningún secreto, ID de cuenta, cuerpo de webhook, ID de objeto Stripe, dato del donante ni detalle interno de error vuelve al navegador. **Configurado** significa únicamente que existe un valor en el runtime: no demuestra propiedad de la cuenta ni funcionamiento con Stripe. Solo una última entrega de webhook procesada y con `livemode` compatible permite el estado **Verificado por último evento procesado**.

Los valores son de reemplazo por escritura y se limpian al guardar; los vacíos no cambian el runtime. El único valor visible y editable es la zona IANA `STRIPE_US_TIME_ZONE`.

| Campo | Uso y manejo desde el panel |
|---|---|
| `STRIPE_RESTRICTED_KEY` | Clave restringida servidor-only; reemplazo de solo escritura. Debe ser `rk_test_…` o `rk_live_…` coherente con `APP_ENV` y la clave publicable. |
| `STRIPE_PUBLISHABLE_KEY` | Clave publicable por ambiente; reemplazo de solo escritura y estado solamente. |
| `STRIPE_WEBHOOK_SECRET` | Secreto activo `whsec_…`; estado solamente. No hay reemplazo directo. |
| `STRIPE_WEBHOOK_SECRET_NEXT` | Secreto `whsec_…` preparado, de solo escritura, para rotación escalonada. |
| `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` | ID `pmc_…`, de solo escritura y estado solamente; la aplicación no verifica su cuenta o propiedad. |
| `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` | ID `bpc_…`, de solo escritura y estado solamente; la aplicación no verifica su cuenta o propiedad. |
| `STRIPE_US_LEGAL_NAME` / `STRIPE_US_EIN` | Identidad exacta de la entidad estadounidense para acuses y constancias; reemplazo de solo escritura. |
| `STRIPE_US_TIME_ZONE` | Zona IANA de los años y fechas de constancias; valor visible y editable. |
| `STRIPE_US_PHONE` / `STRIPE_US_WEBSITE` / `STRIPE_US_MAILING_ADDRESS` | Bloque público de contacto impreso con la composición legal de los recibos y constancias; reemplazo de solo escritura. |
| `STRIPE_US_SIGNER_NAME` / `STRIPE_US_SIGNER_TITLE` | Representante autorizado impreso en el recibo inmediato; reemplazo de solo escritura. |

`APP_ENV`, el modo (`Simulado`, `Pruebas` o `Producción`) y el estado del proxy local son diagnósticos de solo lectura. `STRIPE_MOCK_MODE` y `STRIPE_API_PROXY_URL` son controles del despliegue/local y no se editan desde el navegador. Payment Method Configuration, Billing Portal y la exclusión de BNPL se administran en Stripe Dashboard por el propietario de la cuenta: el panel no tiene botones que pretendan cambiar Stripe.

El panel deriva y permite copiar la URL de webhook `<origen actual>/webhooks/stripe`. Su salud solo presenta el último instante recibido, tipo de evento, estado de procesamiento y coincidencia de `livemode`; **Sin eventos recibidos** no es un fallo. No afirma proveedor verificado para una configuración ID ni para una clave solo porque su prefijo sea válido.

Las rutas OWNER que implementan esta interfaz son:

- `GET /api/settings/stripe` — presencia segura, diagnóstico y salud resumida;
- `POST /api/settings/stripe` — reemplaza únicamente valores Stripe no vacíos y no-webhook;
- `POST /api/settings/stripe/webhook-secret/stage` — escribe solo `STRIPE_WEBHOOK_SECRET_NEXT`;
- `POST /api/settings/stripe/webhook-secret/promote` — promueve con un parche atómico que intercambia el secreto activo y el siguiente;
- `POST /api/settings/stripe/webhook-secret/cancel` — elimina solo el valor preparado.

Para una rotación, primero prepare `STRIPE_WEBHOOK_SECRET_NEXT`; mientras exista, la verificación acepta el secreto activo o el preparado sin revelar cuál coincidió. Después de que Stripe entregue y el panel muestre un evento compatible procesado, promover intercambia atómicamente el secreto activo y el siguiente: el preparado pasa a activo y el activo previo queda como siguiente para rollback. Cancele únicamente el valor preparado si se abandona el cambio. Si la mutación remota se confirma pero falla la actualización del panel, la interfaz conserva el éxito, muestra que el estado requiere conciliación y bloquea otra rotación hasta una actualización exitosa. Si falta el escritor o el resultado remoto de la mutación es desconocido, trate el resultado como incierto: no repita ni borre valores hasta que el propietario concilie el estado de Cloudflare. Las auditorías guardan solo nombres de variables y la acción; si esa escritura local falla después de la mutación remota, el Worker devuelve éxito con señal de auditoría degradada y emite un diagnóstico saneado.

## Verificación obligatoria antes de live

En un D1 nuevo y en una copia de upgrade que ya tenga registrada `0031`, ejecute los gates del repositorio y conserve la salida:

```sh
npm test
npm run build
npx playwright test e2e/donar.spec.ts
npm run migrations:check-immutability
npm run security:check-private-boundary
```

Después, en sandbox real:

- complete una entrega única con tarjeta y compruebe página en español, webhook, un `stripe_gifts` y un solo correo 501(c)(3);
- complete una mensual, confirme la factura inicial, abra Billing Portal, actualice el método guardado y cancele;
- pruebe al menos un método asíncrono elegible y observe `PENDING` hasta el evento final;
- reenvíe cada evento y confirme que no duplica entrega ni correo;
- entregue `invoice.paid` antes de `checkout.session.completed` y confirme convergencia;
- produzca una firma inválida, `livemode` incorrecto y monto/metadatos distintos; todos deben fallar cerrados;
- confirme visualmente español en `/donar`, Stripe Embedded Checkout y `/donar/stripe/resultado`;
- compruebe que no aparece ningún BNPL y que el navegador no envía una lista de métodos;
- ejecute una entrega Wompi de regresión y confirme que su DTE no cambió.

Solo después de esa evidencia y de una autorización explícita se repite la configuración con valores `rk_live_…`, `pk_live_…`, `whsec_…`, `pmc_…` y `bpc_…` independientes. Nunca copie secretos de sandbox a live. Haga una entrega live pequeña y autorizada, verifique el asiento durable y el recibo, y luego abra tráfico normal.

## Handoff del propietario y rollback

Pendiente del propietario del despliegue:

- crear las configuraciones sandbox/live de métodos y Portal;
- activar Cash App Pay solamente si Stripe confirma elegibilidad de la cuenta;
- confirmar el nombre legal, EIN, teléfono, sitio, dirección postal y firmante exactos que aparecerán en los PDF;
- crear y custodiar las claves restringidas, publicables y secretos de webhook;
- autorizar por escrito la prueba live y cualquier cambio de configuración live.

Para detener nuevas entregas sin perder la reconciliación, mantenga la revisión actual compatible con Stripe y configure `DONATION_INTAKE_DISABLED=true`. Ese interruptor bloquea la creación de Checkout nueva, pero debe conservar `/webhooks/stripe`, la consulta durable `/api/donations/stripe/session/`, `/api/donations/stripe/portal`, los acuses de recibo pendientes y la conciliación de constancias anuales.

Si el incidente exige desplegar código anterior, use solamente una revisión conocida compatible con Stripe que retenga esas rutas y tareas; nunca despliegue un SHA anterior a la integración Stripe mientras existan sesiones, facturas o suscripciones abiertas. Conserve las migraciones aditivas `0032` (tablas base), `0033` (tipo de entrega), `0034` (constancias anuales), `0035` (cronología monotónica del proveedor), `0036` (retención consistente), `0037` (seguridad de entregas), `0038` (cercas finales de integridad), `0039` (evidencia de contacto del donante), `0040` (evidencia no sensible del método realmente usado), `0041` (evidencia inmutable del correo anual) y `0042` (reclamo de la constancia anual para entregas anteriores a 0041), junto con todas sus filas. No elimine ni revierta esas migraciones: una reversión de código no revierte D1, webhooks, facturas, suscripciones, constancias ni evidencia de cronología. Mantenga la clave activa y el secreto de webhook operativo hasta conciliar sesiones abiertas y entregas mensuales. Desactivar una configuración o clave sin esa conciliación puede impedir renovaciones o administración de la persona donante.
