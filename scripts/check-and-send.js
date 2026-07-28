const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const https = require('https');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// המילה/קידומת בנושא המייל שמפעילה את התהליך. אפשר לשנות לפי הצורך.
const SUBJECT_PREFIX = 'תמונה:';

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('חסרים GMAIL_USER או GMAIL_APP_PASSWORD ב-secrets של הריפו');
  process.exit(1);
}

function downloadImage(promptText) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(promptText);
    const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true`;
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`שירות יצירת התמונה החזיר קוד ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

function extractEmail(fromField) {
  if (Array.isArray(fromField) && fromField.length > 0) {
    return fromField[0].address;
  }
  return null;
}

async function sendResultEmail(transporter, toAddress, prompt, imageBuffer) {
  await transporter.sendMail({
    from: GMAIL_USER,
    to: toAddress,
    subject: `התמונה שלך מוכנה: ${prompt}`,
    text: `הנה התמונה שנוצרה עבור הבקשה: "${prompt}"`,
    attachments: [
      {
        filename: 'image.png',
        content: imageBuffer,
      },
    ],
  });
  console.log(`נשלח מייל עם תמונה אל ${toAddress}`);
}

async function main() {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
    logger: false,
  });

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    const unseenUids = await client.search({ seen: false });

    console.log(`נמצאו ${unseenUids ? unseenUids.length : 0} מיילים שלא נקראו בתיבה.`);

    if (!unseenUids || unseenUids.length === 0) {
      console.log('אין מיילים חדשים לעיבוד. (אם שלחת מייל בדיקה - ודא שהוא עדיין מסומן כ"לא נקרא"/מודגש בג\'ימייל)');
      return;
    }

    for (const uid of unseenUids) {
      const message = await client.fetchOne(uid, { envelope: true });
      const subject = message.envelope.subject || '';

      console.log(`נמצא מייל לא נקרא, נושא: "${subject}"`);

      if (!subject.startsWith(SUBJECT_PREFIX)) {
        console.log(`  -> מדלג: הנושא לא מתחיל ב-"${SUBJECT_PREFIX}"`);
        continue;
      }

      const prompt = subject.slice(SUBJECT_PREFIX.length).trim();
      const senderEmail = extractEmail(message.envelope.from);

      if (!prompt || !senderEmail) {
        console.warn(`דילוג על הודעה uid=${uid} - חסר פרומפט או כתובת שולח`);
        continue;
      }

      console.log(`מעבד בקשה מ-${senderEmail}: "${prompt}"`);

      try {
        const imageBuffer = await downloadImage(prompt);
        await sendResultEmail(transporter, senderEmail, prompt, imageBuffer);
      } catch (err) {
        console.error(`שגיאה בעיבוד הבקשה מ-${senderEmail}:`, err.message);
      }

      await client.messageFlagsAdd(uid, ['\\Seen']);
    }
  } finally {
    lock.release();
    await client.logout();
  }
}

main().catch((err) => {
  console.error('שגיאה כללית:', err);
  process.exit(1);
});
