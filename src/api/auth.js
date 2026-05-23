'use strict';

const crypto = require('crypto');
const { 
  generateRegistrationOptions, 
  verifyRegistrationResponse, 
  generateAuthenticationOptions, 
  verifyAuthenticationResponse 
} = require('@simplewebauthn/server');
const { authStore } = require('../stores');
const { 
  ADMIN_UI_PATH, ADMIN_AUTH_TOKEN, 
  ADMIN_UI_RP_ID: RP_ID, ADMIN_UI_ORIGIN: ORIGIN 
} = require('../config');
const { escapeHtml } = require('../utils');

const RP_NAME = 'Codex Worker Admin';

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function renderLoginPage() {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin Login - Codex Worker</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css" />
  <script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
  <style>
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f4f7f6; }
    article { width: 100%; max-width: 400px; }
    .error { color: #d81b60; margin-bottom: 1rem; display: none; }
  </style>
</head>
<body>
  <article>
    <header>
      <strong>管理員登錄</strong>
    </header>
    <p>請使用您的 FIDO 安全密鑰 (USB 或 NFC) 進行認證。</p>
    <div id="error-msg" class="error"></div>
    <button id="login-btn" onclick="doLogin()">使用 FIDO 登錄</button>
    <footer class="muted" style="font-size: 0.8rem; text-align: center;">
      Codex Worker Admin Interface
    </footer>
  </article>

  <script>
    const { startAuthentication } = SimpleWebAuthnBrowser;

    async function doLogin() {
      const btn = document.getElementById('login-btn');
      const errEl = document.getElementById('error-msg');
      errEl.style.display = 'none';
      btn.ariaBusy = 'true';
      btn.disabled = true;

      try {
        const optionsRes = await fetch('${ADMIN_UI_PATH}/webauthn/login-options');
        const options = await optionsRes.json();

        if (options.error) throw new Error(options.error);

        const authResp = await startAuthentication(options);

        // Include challenge in the request
        const verifyBody = { ...authResp, challenge: options.challenge };

        const verifyRes = await fetch('${ADMIN_UI_PATH}/webauthn/login-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(verifyBody),
        });

        const verification = await verifyRes.json();

        if (verification.verified) {
          window.location.href = '${ADMIN_UI_PATH}/';
        } else {
          throw new Error(verification.error || '認證失敗');
        }
      } catch (err) {
        console.error(err);
        errEl.textContent = '錯誤: ' + err.message;
        errEl.style.display = 'block';
      } finally {
        btn.ariaBusy = 'false';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
}

async function handleLoginOptions(req, res) {
  const userID = 'admin'; // Single admin role
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: (await authStore.listCredentials()).map(cred => ({
      id: cred.id,
      type: 'public-key',
      transports: JSON.parse(cred.transports || '[]'),
    })),
    userVerification: 'preferred',
  });

  // Ensure challenge is a Base64URL string (handling Uint8Array if necessary)
  if (options.challenge && typeof options.challenge !== 'string') {
    options.challenge = Buffer.from(options.challenge).toString('base64url');
  }

  await authStore.saveChallenge(options.challenge, userID, Date.now() + 60000);
  sendJson(res, 200, options);
}

async function handleLoginVerify(req, res, body) {
  const expectedChallenge = await authStore.getChallenge(body.challenge);
  if (!expectedChallenge) {
    return sendJson(res, 400, { verified: false, error: 'Challenge not found or expired' });
  }
  await authStore.deleteChallenge(body.challenge);

  const credential = await authStore.getCredential(body.id);
  if (!credential) {
    return sendJson(res, 400, { verified: false, error: 'Credential not found' });
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: expectedChallenge.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: credential.id,
        credentialPublicKey: Buffer.from(credential.publicKey, 'base64url'),
        counter: credential.counter,
      },
      requireUserVerification: false,
    });

    if (verification.verified) {
      await authStore.updateCounter(credential.id, verification.authenticationInfo.newCounter);
      
      // Create session
      const sessionId = crypto.randomBytes(32).toString('hex');
      await authStore.saveSession(sessionId, 'admin', Date.now() + 24 * 3600 * 1000); // 24h
      
      res.setHeader('Set-Cookie', `admin_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict`);
      sendJson(res, 200, { verified: true });
    } else {
      sendJson(res, 400, { verified: false, error: 'Verification failed' });
    }
  } catch (error) {
    console.error(error);
    sendJson(res, 400, { verified: false, error: error.message });
  }
}

async function handleRegisterOptions(req, res) {
  const userID = 'admin';
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(userID), 
    userName: 'admin',
    userDisplayName: 'System Admin',
    attestationType: 'none',
    excludeCredentials: (await authStore.listCredentials()).map(cred => ({
      id: cred.id,
      type: 'public-key',
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      requireResidentKey: false,
      userVerification: 'discouraged',
    },
  });

  // Ensure binary fields are Base64URL strings for the browser
  if (options.challenge && typeof options.challenge !== 'string') {
    options.challenge = Buffer.from(options.challenge).toString('base64url');
  }
  if (options.user && options.user.id && typeof options.user.id !== 'string') {
    options.user.id = Buffer.from(options.user.id).toString('base64url');
  }

  await authStore.saveChallenge(options.challenge, userID, Date.now() + 60000);
  sendJson(res, 200, options);
}

async function handleRegisterVerify(req, res, body) {
  const expectedChallenge = await authStore.getChallenge(body.challenge);
  if (!expectedChallenge) {
    return sendJson(res, 400, { verified: false, error: 'Challenge not found or expired' });
  }
  await authStore.deleteChallenge(body.challenge);

  try {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: expectedChallenge.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (verification.verified) {
      const { registrationInfo } = verification;
      const { credentialPublicKey, credentialID, counter } = registrationInfo;

      await authStore.saveCredential({
        id: credentialID,
        publicKey: Buffer.from(credentialPublicKey).toString('base64url'),
        counter,
        transports: body.response.transports,
      });

      sendJson(res, 200, { verified: true });
    } else {
      sendJson(res, 400, { verified: false, error: 'Verification failed' });
    }
  } catch (error) {
    console.error(error);
    sendJson(res, 400, { verified: false, error: error.message });
  }
}

async function isSessionAuthorized(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k) cookies[k] = decodeURIComponent(v);
  });
  
  const sessionId = cookies.admin_session;
  if (!sessionId) return false;
  
  const session = await authStore.getSession(sessionId);
  if (!session) return false;
  
  if (session.expires_at < Date.now()) {
    await authStore.deleteSession(sessionId);
    return false;
  }
  
  return true;
}

module.exports = {
  renderLoginPage,
  handleLoginOptions,
  handleLoginVerify,
  handleRegisterOptions,
  handleRegisterVerify,
  isSessionAuthorized,
};
