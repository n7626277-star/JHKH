const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const https = require('https');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const HF_TOKEN = process.env.HF_TOKEN; // טוקן חינמי מ-Hugging Face, נדרש לוידאו ומוזיקה

// רשימת כתובות שממנן מתקבלות בקשות. ברירת מחדל: רק אתה. אפשר להוסיף עוד כתובות
// מופרדות בפסיקים במשתנה הסביבה EXTRA_ALLOWED_SENDERS (מוגדר כ-Secret/Variable אופציונלי).
const EXTRA_ALLOWED = (process.env.EXTRA_ALLOWED_SENDERS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_SENDERS = [GMAIL_USER ? GMAIL_USER.toLowerCase() : '', ...EXTRA_ALLOWED].filter(Boolean);

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('חסרים GMAIL_USER או GMAIL_APP_PASSWORD ב-secrets של הריפו');
  process.exit(1);
}
if (!HF_TOKEN) {
  console.warn('אזהרה: חסר HF_TOKEN - בקשות וידאו/מוזיקה ייכשלו (תמונות עדיין יעבדו).');
}

// ---------- זיהוי כוונה + חילוץ פרומפט מדויק, באמצעות AI חינמי ----------
function classifyAndRefine(rawText) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'openai',
      messages: [
        {
          role: 'system',
          content:
            'You read an email (Hebrew or English) and figure out exactly what the sender wants generated. ' +
            'Respond ONLY with strict JSON, no markdown, no code fences, in this exact shape: ' +
            '{"type":"image"|"video"|"music","prompt":"<refined prompt in English, precise and specific, ready to feed into a generative AI model>"}. ' +
            'Infer type from context: words like "שיר"/"מוזיקה"/"song"/"music"/"melody" mean music; ' +
            'words like "סרטון"/"וידאו"/"video"/"clip"/"animation" mean video; otherwise default to image. ' +
            'Extract only the actual creative request - ignore greetings, signatures, and unrelated email text. ' +
            'Be faithful to every detail and constraint the sender mentioned (colors, style, objects, mood, number of items, etc).',
        },
        { role: 'user', content: rawText },
      ],
    });

    const options = {
      hostname: 'text.pollinations.ai',
      path: '/openai',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`  -> Pollinations text API החזיר קוד ${res.statusCode}. גוף התשובה: ${data.slice(0, 500)}`);
          reject(new Error(`שירות הזיהוי החזיר קוד ${res.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = (parsed.choices && parsed.choices[0] && parsed.choices[0].message.content) || '';
          const cleaned = content.replace(/```json|```/g, '').trim();
          console.log(`  -> תשובת ה-AI (גולמית): ${cleaned.slice(0, 300)}`);
          const result = JSON.parse(cleaned);
          if (!result.type || !result.prompt) throw new Error('פורמט לא תקין');
          resolve(result);
        } catch (err) {
          console.error(`  -> לא הצלחתי לפרש. גוף התשובה המלא שהתקבל: ${data.slice(0, 500)}`);
          reject(new Error('לא הצלחתי לפרש את תשובת ה-AI לזיהוי כוונה: ' + err.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- יצירת תמונה (Pollinations, חינמי לגמרי, בלי מפתח) ----------
function downloadImage(promptText) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(promptText);
    const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&model=flux&enhance=true`;
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

// ---------- יצירת וידאו/מוזיקה (Hugging Face, חינמי עם טוקן חינמי) ----------
function callHfInference(url, prompt, retriesLeft = 5) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ inputs: prompt });
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || '';

        if (contentType.includes('application/json')) {
          try {
            const errJson = JSON.parse(buffer.toString('utf8'));
            const isLoading = errJson.error && String(errJson.error).toLowerCase().includes('loading');
            if (isLoading && retriesLeft > 0) {
              const wait = Math.min(25000, (errJson.estimated_time || 15) * 1000);
              console.log(`  -> המודל בהאגינג פייס נטען, ממתין ${Math.round(wait / 1000)} שניות ומנסה שוב (${retriesLeft} ניסיונות נותרו)...`);
              setTimeout(() => {
                callHfInference(url, prompt, retriesLeft - 1).then(resolve).catch(reject);
              }, wait);
              return;
            }
            reject(new Error(`שגיאה משירות ה-AI: ${JSON.stringify(errJson)}`));
          } catch (e) {
            reject(new Error(`תשובה לא צפויה מהשירות: ${buffer.toString('utf8').slice(0, 200)}`));
          }
          return;
        }

        resolve(buffer);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function generateVideo(prompt) {
  return callHfInference('https://api-inference.huggingface.co/models/damo-vilab/text-to-video-ms-1.7b', prompt);
}

function generateMusic(prompt) {
  return callHfInference('https://api-inference.huggingface.co/models/facebook/musicgen-small', prompt);
}

// ---------- עזרים כלליים ----------
function extractEmail(fromField) {
  if (Array.isArray(fromField) && fromField.length > 0) {
    return fromField[0].address;
  }
  return null;
}

async function getMessageText(client, uid) {
  const { content } = await client.download(uid);
  const parsed = await simpleParser(content);
  return (parsed.text || '').trim();
}

async function sendResultEmail(transporter, toAddress, prompt, fileBuffer, filename, mimeType) {
  await transporter.sendMail({
    from: GMAIL_USER,
    to: toAddress,
    subject: `מוכן: ${prompt}`.slice(0, 200),
    text: `הנה מה שנוצר עבור הבקשה שלך: "${prompt}"`,
    attachments: [
      {
        filename,
        content: fileBuffer,
        contentType: mimeType,
      },
    ],
  });
  console.log(`  -> נשלח מייל עם ${filename} אל ${toAddress}`);
}

// ---------- הלולאה הראשית ----------
async function main() {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    const unseenUids = await client.search({ seen: false });
    console.log(`נמצאו ${unseenUids ? unseenUids.length : 0} מיילים שלא נקראו בתיבה.`);

    if (!unseenUids || unseenUids.length === 0) {
      console.log('אין מיילים חדשים לעיבוד.');
      return;
    }

    for (const uid of unseenUids) {
      const message = await client.fetchOne(uid, { envelope: true });
      const subject = message.envelope.subject || '';
      const senderEmail = extractEmail(message.envelope.from);

      console.log(`נמצא מייל לא נקרא מ-${senderEmail}, נושא: "${subject}"`);

      if (!senderEmail || !ALLOWED_SENDERS.includes(senderEmail.toLowerCase())) {
        console.log('  -> מדלג: השולח לא ברשימת הכתובות המורשות (ALLOWED_SENDERS)');
        continue; // לא מסמנים כנקרא - זה לא קשור אלינו, שיישאר במצב הרגיל שלו
      }

      let bodyText = '';
      try {
        bodyText = await getMessageText(client, uid);
      } catch (err) {
        console.warn('  -> לא הצלחתי לקרוא את גוף ההודעה:', err.message);
      }

      const rawText = `נושא: ${subject}\n\n${bodyText}`.trim();

      let classification;
      try {
        classification = await classifyAndRefine(rawText);
        console.log(`  -> זוהה כ-"${classification.type}", פרומפט: "${classification.prompt}"`);
      } catch (err) {
        console.error('  -> שגיאה בזיהוי הבקשה, עובר לגיבוי (יצירת תמונה מהטקסט הגולמי):', err.message);
        classification = { type: 'image', prompt: rawText.slice(0, 300) };
      }

      try {
        let fileBuffer, filename, mimeType;

        if (classification.type === 'video') {
          fileBuffer = await generateVideo(classification.prompt);
          filename = 'video.mp4';
          mimeType = 'video/mp4';
        } else if (classification.type === 'music') {
          fileBuffer = await generateMusic(classification.prompt);
          filename = 'music.wav';
          mimeType = 'audio/wav';
        } else {
          fileBuffer = await downloadImage(classification.prompt);
          filename = 'image.png';
          mimeType = 'image/png';
        }

        await sendResultEmail(transporter, senderEmail, classification.prompt, fileBuffer, filename, mimeType);
      } catch (err) {
        console.error('  -> שגיאה ביצירה/שליחה:', err.message);
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
