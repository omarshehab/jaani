const express = require('express');
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let google;
try {
  // Lazy-load to keep backend booting even if dependency not installed yet.
  ({ google } = require('googleapis'));
} catch (e) {
  google = null;
}

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const FRONTEND_ALLOWED_ORIGINS = (
  process.env.FRONTEND_ALLOWED_ORIGINS
  || process.env.FRONTEND_URL
  || 'http://localhost:3000,http://127.0.0.1:3000'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

const TOKEN_STORE_PATH = process.env.JAANI_GMAIL_TOKEN_STORE_PATH
  || process.env.GMAIL_TOKEN_STORE_PATH
  || path.join(os.homedir(), '.jaani', 'gmail_tokens.json');

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecodeToString(input) {
  if (!input) return '';
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function sanitizeHeaderValue(value) {
  if (value == null) return '';
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function wrapBase64(b64) {
  const cleaned = String(b64).replace(/\s+/g, '');
  const lines = [];
  for (let i = 0; i < cleaned.length; i += 76) {
    lines.push(cleaned.slice(i, i + 76));
  }
  return lines.join('\r\n');
}

function ensureGoogleApis(res) {
  if (!google) {
    res.status(500).json({
      success: false,
      error: 'googleapis dependency is not installed on the backend',
      hint: 'Run `npm install googleapis` inside the backend folder',
    });
    return false;
  }
  return true;
}

function ensureOAuthEnv(res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5005/api/gmail/oauth2callback';

  if (!clientId || !clientSecret) {
    res.status(500).json({
      success: false,
      error: 'Missing Google OAuth env vars',
      required: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      optional: ['GOOGLE_REDIRECT_URI', 'FRONTEND_URL'],
    });
    return null;
  }

  return { clientId, clientSecret, redirectUri };
}

function createOAuthClient(overrideRedirectUri) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    overrideRedirectUri ||
    process.env.GOOGLE_REDIRECT_URI ||
    'http://localhost:5005/api/gmail/oauth2callback';
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function readTokenStore() {
  try {
    if (!fs.existsSync(TOKEN_STORE_PATH)) return {};
    const raw = fs.readFileSync(TOKEN_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writeTokenStore(store) {
  const dir = path.dirname(TOKEN_STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${TOKEN_STORE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpPath, TOKEN_STORE_PATH);
}

function saveTokensForEmail(email, tokens) {
  const key = String(email || '').toLowerCase();
  if (!key) return;
  const store = readTokenStore();
  store[key] = {
    ...store[key],
    tokens,
    updatedAt: new Date().toISOString(),
  };
  writeTokenStore(store);
}

function getTokensForEmail(email) {
  const key = String(email || '').toLowerCase();
  if (!key) return null;
  const store = readTokenStore();
  return store[key]?.tokens || null;
}

function deleteTokensForEmail(email) {
  const key = String(email || '').toLowerCase();
  if (!key) return;
  const store = readTokenStore();
  if (store[key]) {
    delete store[key];
    writeTokenStore(store);
  }
}

async function getAuthedGmailClient(senderEmail) {
  const oauth2Client = createOAuthClient();
  const tokens = getTokensForEmail(senderEmail);
  if (!tokens) {
    const err = new Error('NOT_CONNECTED');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', (newTokens) => {
    const merged = { ...oauth2Client.credentials, ...newTokens };
    saveTokensForEmail(senderEmail, merged);
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  return { gmail, oauth2Client };
}

function buildMimeMessage({
  from,
  to,
  cc,
  bcc,
  subject,
  bodyText,
  bodyHtml,
  attachments,
}) {
  const mixedBoundary = `mixed_${crypto.randomBytes(8).toString('hex')}`;
  const altBoundary = `alt_${crypto.randomBytes(8).toString('hex')}`;

  const headers = [];
  if (from) headers.push(`From: ${sanitizeHeaderValue(from)}`);
  if (to) headers.push(`To: ${sanitizeHeaderValue(to)}`);
  if (cc) headers.push(`Cc: ${sanitizeHeaderValue(cc)}`);
  if (bcc) headers.push(`Bcc: ${sanitizeHeaderValue(bcc)}`);
  headers.push(`Subject: ${sanitizeHeaderValue(subject)}`);
  headers.push('MIME-Version: 1.0');
  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

  const parts = [];
  parts.push(headers.join('\r\n'));
  parts.push('');

  // Alternative body
  parts.push(`--${mixedBoundary}`);
  parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  parts.push('');

  const plain = bodyText || (bodyHtml ? bodyHtml.replace(/<[^>]*>/g, ' ') : '');
  const html = bodyHtml || (bodyText ? `<pre>${bodyText}</pre>` : '');

  parts.push(`--${altBoundary}`);
  parts.push('Content-Type: text/plain; charset="UTF-8"');
  parts.push('Content-Transfer-Encoding: base64');
  parts.push('');
  parts.push(wrapBase64(Buffer.from(plain, 'utf8').toString('base64')));
  parts.push('');

  parts.push(`--${altBoundary}`);
  parts.push('Content-Type: text/html; charset="UTF-8"');
  parts.push('Content-Transfer-Encoding: base64');
  parts.push('');
  parts.push(wrapBase64(Buffer.from(html, 'utf8').toString('base64')));
  parts.push('');

  parts.push(`--${altBoundary}--`);
  parts.push('');

  // Attachments
  for (const file of attachments || []) {
    const filename = sanitizeHeaderValue(file.originalname || 'attachment');
    const contentType = sanitizeHeaderValue(file.mimetype || 'application/octet-stream');
    const b64 = file.buffer ? Buffer.from(file.buffer).toString('base64') : '';

    parts.push(`--${mixedBoundary}`);
    parts.push(`Content-Type: ${contentType}; name="${filename}"`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(`Content-Disposition: attachment; filename="${filename}"`);
    parts.push('');
    parts.push(wrapBase64(b64));
    parts.push('');
  }

  parts.push(`--${mixedBoundary}--`);
  parts.push('');

  return parts.join('\r\n');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 10,
  },
});

router.get('/status', async (req, res) => {
  if (!ensureGoogleApis(res)) return;
  const senderEmail = String(req.query.email || '').trim();
  if (!senderEmail) {
    return res.status(400).json({ success: false, error: 'Missing ?email=' });
  }

  try {
    const { gmail } = await getAuthedGmailClient(senderEmail);
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const authedEmail = profile?.data?.emailAddress || null;

    if (!authedEmail) {
      return res.json({ success: true, connected: false, email: null });
    }

    return res.json({
      success: true,
      connected: true,
      requestedEmail: senderEmail,
      email: authedEmail,
      matchesRequested:
        authedEmail.toLowerCase() === senderEmail.toLowerCase(),
    });
  } catch (e) {
    if (String(e?.message || '').includes('invalid_grant')) {
      deleteTokensForEmail(senderEmail);
    }
    return res.json({ success: true, connected: false, email: null });
  }
});

router.get('/auth-url', (req, res) => {
  if (!ensureGoogleApis(res)) return;
  const env = ensureOAuthEnv(res);
  if (!env) return;

  const requestedEmail = String(req.query.email || '').trim();
  const forceConsent = String(req.query.force || '').toLowerCase() === 'true' || String(req.query.force) === '1';

  const oauth2Client = createOAuthClient();

  const state = base64UrlEncode(
    JSON.stringify({
      requestedEmail: requestedEmail || null,
      nonce: crypto.randomBytes(12).toString('hex'),
      ts: Date.now(),
    })
  );

  const alreadyConnected = requestedEmail ? Boolean(getTokensForEmail(requestedEmail)) : false;

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GMAIL_SCOPES,
    include_granted_scopes: true,
    prompt: forceConsent || !alreadyConnected ? 'consent' : undefined,
    state,
  });

  res.json({ success: true, url, redirectUri: env.redirectUri });
});

router.get('/oauth2callback', async (req, res) => {
  if (!ensureGoogleApis(res)) return;
  const env = ensureOAuthEnv(res);
  if (!env) return;

  const { code, state } = req.query;
  if (!code) {
    return res.status(400).send('Missing code');
  }

  let requestedEmail = null;
  try {
    const decoded = base64UrlDecodeToString(state);
    const parsed = JSON.parse(decoded || '{}');
    requestedEmail = parsed?.requestedEmail || null;
  } catch (e) {
    requestedEmail = null;
  }

  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const authedEmail = profile?.data?.emailAddress;

    if (!authedEmail) {
      return res.status(500).send('Could not verify Gmail account email');
    }

    saveTokensForEmail(authedEmail, tokens);

    const payload = {
      type: 'gmail_auth_success',
      email: authedEmail,
      requestedEmail,
      matchesRequested: requestedEmail
        ? authedEmail.toLowerCase() === requestedEmail.toLowerCase()
        : true,
    };
    const allowedOriginsForClient = FRONTEND_ALLOWED_ORIGINS;

    // Post message back to opener and close popup
    // Helmet CSP in the main server blocks inline scripts; override for this callback page.
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    res.set('Content-Type', 'text/html');
    res.send(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Gmail Connected</title></head>
  <body>
    <script>
      (function(){
        try {
          var payload = ${JSON.stringify(payload)};
          if (window.opener && window.opener !== window) {
            var allowed = ${JSON.stringify(allowedOriginsForClient)};
            var sent = false;
            for (var i = 0; i < allowed.length; i++) {
              try {
                window.opener.postMessage(payload, allowed[i]);
                sent = true;
              } catch (postErr) {}
            }
            if (!sent) {
              window.opener.postMessage(payload, ${JSON.stringify(FRONTEND_URL)});
            }
          }
        } catch (e) {}
        window.close();
      })();
    </script>
    <p>Gmail connected. You can close this window.</p>
  </body>
</html>`);
  } catch (e) {
    console.error('Gmail OAuth callback error:', e);
    res.status(500).send('OAuth error: ' + (e?.message || 'unknown'));
  }
});

// Optional: Frontend-driven auth-code exchange.
// NOTE: Some OAuth flows (PKCE) may require code_verifier; this endpoint supports classic server-side code exchange.
router.post('/exchange-code', express.json(), async (req, res) => {
  if (!ensureGoogleApis(res)) return;
  const env = ensureOAuthEnv(res);
  if (!env) return;

  const authCode = String(req.body?.authCode || '').trim();
  if (!authCode) {
    return res.status(400).json({ success: false, error: 'authCode is required' });
  }

  try {
    // Critical: When using @react-oauth/google with flow: 'auth-code', the redirect_uri used
    // during the frontend popup is 'postmessage'. The backend must match this to exchange the code.
    // If we use the server redirect URI (localhost:5005), Google will reject with redirect_uri_mismatch.
    const oauth2Client = createOAuthClient('postmessage');
    const { tokens } = await oauth2Client.getToken(authCode);
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const authedEmail = profile?.data?.emailAddress;

    if (!authedEmail) {
      return res.status(500).json({ success: false, error: 'Could not verify Gmail account email' });
    }

    saveTokensForEmail(authedEmail, tokens);

    return res.json({
      success: true,
      email: authedEmail,
      message: 'Gmail connected successfully',
    });
  } catch (e) {
    console.error('Error exchanging auth code:', e);
    return res.status(500).json({
      success: false,
      error: 'Failed to exchange auth code',
      message: e?.message,
    });
  }
});

router.post('/create-draft', upload.array('files', 10), async (req, res) => {
  if (!ensureGoogleApis(res)) return;

  const senderEmail = String(req.body.sender_email || '').trim();
  const to = String(req.body.to || '').trim();
  const cc = String(req.body.cc || '').trim();
  const bcc = String(req.body.bcc || '').trim();
  const subject = String(req.body.subject || '').trim();
  const bodyHtml = String(req.body.body_html || '').toString();
  const bodyText = String(req.body.body_text || '').toString();

  if (!senderEmail) {
    return res.status(400).json({ success: false, error: 'sender_email is required' });
  }
  if (!to || !subject || (!bodyHtml && !bodyText)) {
    return res.status(400).json({ success: false, error: 'to, subject, and body are required' });
  }

  try {
    const { gmail } = await getAuthedGmailClient(senderEmail);

    const mime = buildMimeMessage({
      from: senderEmail,
      to,
      cc,
      bcc,
      subject,
      bodyText,
      bodyHtml,
      attachments: req.files || [],
    });

    const raw = base64UrlEncode(Buffer.from(mime, 'utf8'));

    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw },
      },
    });

    const draftId = draft?.data?.id || null;
    const messageId = draft?.data?.message?.id || null;

    res.json({
      success: true,
      draftId,
      messageId,
      draftsUrl: 'https://mail.google.com/mail/u/0/#drafts',
      gmailUrl: 'https://mail.google.com/mail/u/0/#drafts',
      // Prioritize #drafts view with compose param for drafts
      composeUrl: draftId 
        ? `https://mail.google.com/mail/u/0/#drafts?compose=${encodeURIComponent(draftId)}`
        : messageId
          ? `https://mail.google.com/mail/u/0/#inbox?compose=${encodeURIComponent(messageId)}`
          : 'https://mail.google.com/mail/u/0/#drafts',
    });
  } catch (e) {
    if (String(e?.message || '').includes('NOT_CONNECTED')) {
      return res.status(401).json({ success: false, error: 'Gmail not connected for this sender_email' });
    }
    if (String(e?.message || '').includes('invalid_grant')) {
      deleteTokensForEmail(senderEmail);
      return res.status(401).json({
        success: false,
        error: 'Gmail authorization expired. Please reconnect Gmail and try again.',
      });
    }
    const googleMessage = e?.response?.data?.error?.message;
    console.error('Error creating draft:', googleMessage || e?.message || e);
    return res.status(500).json({
      success: false,
      error: 'Failed to create draft',
      message: googleMessage || e?.message,
    });
  }
});

router.post('/send', upload.array('files', 10), async (req, res) => {
  if (!ensureGoogleApis(res)) return;

  const senderEmail = String(req.body.sender_email || '').trim();
  const to = String(req.body.to || '').trim();
  const cc = String(req.body.cc || '').trim();
  const bcc = String(req.body.bcc || '').trim();
  const subject = String(req.body.subject || '').trim();
  const bodyHtml = String(req.body.body_html || '').toString();
  const bodyText = String(req.body.body_text || '').toString();

  if (!senderEmail) {
    return res.status(400).json({ success: false, error: 'sender_email is required' });
  }
  if (!to || !subject || (!bodyHtml && !bodyText)) {
    return res.status(400).json({ success: false, error: 'to, subject, and body are required' });
  }

  try {
    const { gmail } = await getAuthedGmailClient(senderEmail);

    const mime = buildMimeMessage({
      from: senderEmail,
      to,
      cc,
      bcc,
      subject,
      bodyText,
      bodyHtml,
      attachments: req.files || [],
    });

    const raw = base64UrlEncode(Buffer.from(mime, 'utf8'));

    const sent = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
      },
    });

    res.json({
      success: true,
      messageId: sent?.data?.id || null,
      threadId: sent?.data?.threadId || null,
      gmailUrl: 'https://mail.google.com/mail/u/0/#sent',
    });
  } catch (e) {
    if (String(e?.message || '').includes('NOT_CONNECTED')) {
      return res.status(401).json({ success: false, error: 'Gmail not connected for this sender_email' });
    }
    if (String(e?.message || '').includes('invalid_grant')) {
      deleteTokensForEmail(senderEmail);
      return res.status(401).json({
        success: false,
        error: 'Gmail authorization expired. Please reconnect Gmail and try again.',
      });
    }
    const googleMessage = e?.response?.data?.error?.message;
    console.error('Error sending email:', googleMessage || e?.message || e);
    return res.status(500).json({
      success: false,
      error: 'Failed to send email',
      message: googleMessage || e?.message,
    });
  }
});

module.exports = router;
