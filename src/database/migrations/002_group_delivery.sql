ALTER TABLE queue_jobs ADD COLUMN whatsapp_message_id VARCHAR(128);
CREATE UNIQUE INDEX idx_queue_whatsapp_key ON queue_jobs(destination_jid, whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;
ALTER TABLE queue_jobs DROP CONSTRAINT queue_jobs_status_check;
ALTER TABLE queue_jobs ADD CONSTRAINT queue_jobs_status_check CHECK
  (status IN ('pending','processing','sent','failed','dead_letter','awaiting_receipt','delivered'));
