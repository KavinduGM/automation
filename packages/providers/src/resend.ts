import { Resend } from "resend";
import { env, logger } from "@ca/shared";

let _client: Resend | null = null;
function client(): Resend {
  if (_client) return _client;
  const key = env().RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set");
  _client = new Resend(key);
  return _client;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<{ id?: string }> {
  if (!env().RESEND_API_KEY) {
    logger.warn({ to: input.to, subject: input.subject }, "email.skipped_no_key");
    return {};
  }
  const res = await client().emails.send({
    from: env().RESEND_FROM,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
  });
  if (res.error) throw new Error(`resend: ${res.error.message}`);
  logger.info({ id: res.data?.id, subject: input.subject }, "email.sent");
  return { id: res.data?.id };
}
