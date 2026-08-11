# Stripe para entregas de EE. UU.

Esta integración pertenece exclusivamente a la puerta **EE. UU. 501(c)(3)**. Wompi y la emisión DTE siguen siendo la única ruta de El Salvador; una entrega de Stripe nunca crea un `donation_intent`, nunca pasa por Wompi y nunca genera un CDE salvadoreño.

El navegador solicita una Checkout Session al Worker y monta Stripe Embedded Checkout dentro de la página. Stripe aloja, compone y actualiza el formulario completo en español, incluidos los campos, billeteras y métodos elegibles; la aplicación solo controla el paso de monto/frecuencia y el marco exterior. La confirmación no se infiere del regreso del navegador: `/donar/stripe/resultado` consulta el estado durable en D1, alimentado por un webhook firmado e idempotente. Las entregas mensuales se registran una vez por `invoice.paid` y se administran mediante Stripe Billing Portal.

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
   - `charge.refunded`
4. Guarde como Cloudflare secret, nunca en Git ni en el bundle Vite:
   - `STRIPE_RESTRICTED_KEY=rk_test_…`
   - `STRIPE_PUBLISHABLE_KEY=pk_test_…`
   - `STRIPE_WEBHOOK_SECRET=whsec_…`
   - `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID=pmc_…`
   - `STRIPE_BILLING_PORTAL_CONFIGURATION_ID=bpc_…`
   - `STRIPE_US_LEGAL_NAME=<nombre legal exacto de la entidad estadounidense>`
   - `STRIPE_US_EIN=NN-NNNNNNN`
5. Use el wrapper privado del repositorio para escribir cada valor de runtime; no ejecute Wrangler remoto sin ese wrapper. La clave publicable es segura para el navegador y el Worker la devuelve únicamente después de crear la sesión, pero sigue separada por ambiente y no se fija en el bundle. Los identificadores que no son credenciales también permanecen fuera del repositorio público porque identifican la cuenta y el despliegue.

`STRIPE_MOCK_MODE="1"` es una facilidad determinista para local y staging aislado. Está prohibido en producción y el Worker falla cerrado si intenta combinarlo con `APP_ENV=production`.

Si el runtime local de `workerd` no puede realizar HTTPS saliente, ejecute `npm run dev:stripe-api-proxy` y defina `STRIPE_API_PROXY_URL="http://127.0.0.1:8791"` en el archivo privado local. El Worker acepta ese puente únicamente con `APP_ENV=local` y un origen HTTP de loopback sin ruta ni credenciales; staging y producción lo rechazan.

La versión fijada por el SDK es `2026-07-29.dahlia`. Sandbox requiere el par `rk_test_…` / `pk_test_…`; producción requiere `rk_live_…` / `pk_live_…`. El Worker rechaza claves de ambientes opuestos, una clave amplia `sk_…`, un evento `livemode` incorrecto, una versión API distinta o una firma inválida.

Las claves restringidas reducen el alcance de una exposición y deben permanecer solo en el servidor. Consulte [claves de API](https://docs.stripe.com/keys) y [prácticas de seguridad](https://docs.stripe.com/keys-best-practices).

## Firma, idempotencia y datos durables

Stripe debe firmar el **cuerpo crudo** recibido en `/webhooks/stripe`; no se debe analizar ni reconstruir JSON antes de verificar la firma. Cada `event.id` se reclama en `stripe_webhook_events`, con reintento seguro y sin guardar el cuerpo crudo. Una reclamación de webhook o creación de Checkout abandonada se recupera después de una concesión de cinco minutos, conservando la misma identidad e idempotency key y con un máximo de tres intentos de creación. La identidad de sesión, ambiente, moneda USD, monto, frecuencia y metadatos `lane=eeuu_501c3` se validan antes de cambiar estado.

Una entrega única se identifica por PaymentIntent. Cada entrega mensual se identifica por factura, de modo que `invoice.paid` produce exactamente un registro por renovación aunque Stripe reintente o entregue eventos fuera de orden. Los recibos 501(c)(3) se despachan con su propia cerca durable e idempotente; una reclamación anterior al envío puede recuperarse, pero un resultado ambiguo posterior al inicio del envío queda en `stripe_acknowledgment_deliveries.status='REVIEW'` en vez de arriesgar un duplicado. El operador debe conciliar manualmente cualquier fila `REVIEW` con el proveedor de correo antes de decidir una nueva entrega.

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
- confirmar el nombre legal y EIN exactos que aparecerán en el recibo;
- crear y custodiar las claves restringidas, publicables y secretos de webhook;
- autorizar por escrito la prueba live y cualquier cambio de configuración live.

Para rollback, bloquee nuevas entregas, revierta el Worker al SHA anterior y conserve la migración `0032` y sus filas: una reversión de código no revierte D1, webhooks, facturas ni suscripciones. Mantenga `/webhooks/stripe` y Billing Portal accesibles hasta conciliar sesiones abiertas y entregas mensuales. Desactivar una configuración o clave sin esa conciliación puede impedir renovaciones o administración del donante.
