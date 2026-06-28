ALTER TABLE email_deliveries ADD COLUMN email_type TEXT;
ALTER TABLE email_deliveries ADD COLUMN document_status_at_send TEXT;
ALTER TABLE email_deliveries ADD COLUMN template_version TEXT;
ALTER TABLE email_deliveries ADD COLUMN pdf_renderer_version TEXT;
ALTER TABLE email_deliveries ADD COLUMN pdf_sha256 TEXT;
ALTER TABLE email_deliveries ADD COLUMN dte_json_sha256 TEXT;
ALTER TABLE email_deliveries ADD COLUMN provider_delivery_id TEXT;
