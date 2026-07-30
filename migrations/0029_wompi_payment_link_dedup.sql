-- Wompi exposes two transaction identifiers for the same successful payment:
-- the payment-link API/export uses a display id while the delayed webhook can use
-- an internal UUID. Dynamic donation links permit exactly one successful payment,
-- so their numeric link id is the stable fiscal idempotency key.
ALTER TABLE wompi_events ADD COLUMN payment_link_id INTEGER;

UPDATE wompi_events
   SET payment_link_id = CAST(
         COALESCE(
           json_extract(raw_body, '$.EnlacePago.Id'),
           json_extract(raw_body, '$.EnlacePago.id'),
           json_extract(raw_body, '$.enlacePago.Id'),
           json_extract(raw_body, '$.enlacePago.id')
         ) AS INTEGER
       )
 WHERE result = 'ExitosaAprobada'
   AND COALESCE(
         json_extract(raw_body, '$.EnlacePago.IdentificadorEnlaceComercio'),
         json_extract(raw_body, '$.EnlacePago.identificadorEnlaceComercio'),
         json_extract(raw_body, '$.enlacePago.IdentificadorEnlaceComercio'),
         json_extract(raw_body, '$.enlacePago.identificadorEnlaceComercio')
       ) LIKE 'di_%'
   AND CAST(
         COALESCE(
           json_extract(raw_body, '$.EnlacePago.Id'),
           json_extract(raw_body, '$.EnlacePago.id'),
           json_extract(raw_body, '$.enlacePago.Id'),
           json_extract(raw_body, '$.enlacePago.id')
         ) AS INTEGER
       ) > 0;

CREATE UNIQUE INDEX idx_wompi_events_payment_link_id
ON wompi_events(payment_link_id)
WHERE payment_link_id IS NOT NULL;
