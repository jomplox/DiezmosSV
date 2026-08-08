UPDATE wompi_events
   SET payment_link_id = NULL
 WHERE payment_link_id IS NOT NULL
   AND result = 'ExitosaAprobada'
   AND CAST(
         COALESCE(
           json_extract(raw_body, '$.EnlacePago.Id'),
           json_extract(raw_body, '$.EnlacePago.id'),
           json_extract(raw_body, '$.enlacePago.Id'),
           json_extract(raw_body, '$.enlacePago.id')
         ) AS INTEGER
       ) > 0
   AND CAST(
         COALESCE(
           json_extract(raw_body, '$.EnlacePago.Id'),
           json_extract(raw_body, '$.EnlacePago.id'),
           json_extract(raw_body, '$.enlacePago.Id'),
           json_extract(raw_body, '$.enlacePago.id')
         ) AS INTEGER
       ) = payment_link_id
   AND COALESCE(
         json_extract(raw_body, '$.EnlacePago.IdentificadorEnlaceComercio'),
         json_extract(raw_body, '$.EnlacePago.identificadorEnlaceComercio'),
         json_extract(raw_body, '$.enlacePago.IdentificadorEnlaceComercio'),
         json_extract(raw_body, '$.enlacePago.identificadorEnlaceComercio')
       ) LIKE 'di_%'
   AND COALESCE(
         json_extract(raw_body, '$.EnlacePago.IdentificadorEnlaceComercio'),
         json_extract(raw_body, '$.EnlacePago.identificadorEnlaceComercio'),
         json_extract(raw_body, '$.enlacePago.IdentificadorEnlaceComercio'),
         json_extract(raw_body, '$.enlacePago.identificadorEnlaceComercio')
       ) NOT GLOB 'di_*';
