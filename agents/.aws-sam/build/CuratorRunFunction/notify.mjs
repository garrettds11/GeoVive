// Status emails (build-order item 6 / readiness doc Section 9.6): one email per completed
// dataset/stage, never per-feature. No digesting or throttling -- Garrett reads these on his
// own timeline, however many pile up.

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({});
const FROM = "agents@geovive.link";
const TO = process.env.ADMIN_EMAIL || "admin@geovive.link";

export async function notify({ subject, bodyText, reasonCode }) {
  const fullSubject = reasonCode ? `[${reasonCode}] ${subject}` : subject;
  await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM,
    Destination: { ToAddresses: [TO] },
    Content: { Simple: { Subject: { Data: fullSubject }, Body: { Text: { Data: bodyText } } } }
  }));
}
