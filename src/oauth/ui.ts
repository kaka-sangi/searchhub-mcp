// Server-rendered HTML for SearchHub MCP auth UI. Uses tagged template literals
// so we avoid pulling in a JSX SSR runtime — just returns strings that Hono
// sends through `c.html()`.

export type AuthorizeContext = {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  client_name?: string;
};

const APP_TITLE = "SearchHub";

const STYLES = `
:root {
  color-scheme: dark light;
  --bg: #0a0a0b;
  --bg-elev: #131316;
  --bg-elev-2: #1c1c21;
  --border: #2a2a31;
  --border-strong: #3a3a44;
  --text: #e7e7ea;
  --text-dim: #98989f;
  --text-faint: #6b6b75;
  --accent: #3ecf8e;
  --accent-hover: #4ce099;
  --accent-fg: #07140d;
  --danger: #f87171;
  --danger-bg: rgba(248,113,113,0.08);
  --danger-border: rgba(248,113,113,0.35);
  --warning: #fbbf24;
  --info: #60a5fa;
  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 14px;
  --shadow: 0 8px 32px rgba(0,0,0,0.5);
  --font-mono: 'Cascadia Code','JetBrains Mono','SF Mono','Consolas',ui-monospace,monospace;
  --font-sans: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fafafa;
    --bg-elev: #ffffff;
    --bg-elev-2: #f4f4f5;
    --border: #e4e4e7;
    --border-strong: #d4d4d8;
    --text: #18181b;
    --text-dim: #52525b;
    --text-faint: #a1a1aa;
    --accent: #10b981;
    --accent-hover: #059669;
    --accent-fg: #ffffff;
    --danger: #dc2626;
    --danger-bg: rgba(220,38,38,0.06);
    --danger-border: rgba(220,38,38,0.25);
    --shadow: 0 8px 32px rgba(0,0,0,0.08);
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh}
.shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--border);background:var(--bg-elev)}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--font-mono);font-weight:600;font-size:15px;letter-spacing:-0.01em}
.brand-mark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--accent),#14b8a6);display:grid;place-items:center;color:var(--accent-fg);font-family:var(--font-mono);font-weight:700;font-size:13px}
.brand-meta{font-size:12px;color:var(--text-faint);font-family:var(--font-mono)}
.main{display:grid;place-items:center;padding:32px 24px}
.card{width:100%;max-width:420px;background:var(--bg-elev);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow);overflow:hidden}
.card-header{padding:28px 28px 8px 28px}
.card-header h1{margin:0 0 6px 0;font-size:22px;font-weight:600;letter-spacing:-0.015em}
.card-header p{margin:0;color:var(--text-dim);font-size:14px}
.card-body{padding:20px 28px 28px 28px}
.field{display:block;margin-bottom:16px}
.field label{display:block;font-size:13px;font-weight:500;color:var(--text);margin-bottom:6px}
.field input{width:100%;padding:10px 12px;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elev-2);color:var(--text);font-family:var(--font-sans);font-size:14px;transition:border-color 0.15s,box-shadow 0.15s}
.field input::placeholder{color:var(--text-faint)}
.field input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(62,207,142,0.18)}
.field input[aria-invalid="true"]{border-color:var(--danger)}
.field-hint{font-size:12px;color:var(--text-dim);margin-top:4px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:11px 16px;border:1px solid transparent;border-radius:var(--radius);font-family:var(--font-sans);font-size:14px;font-weight:600;cursor:pointer;transition:background 0.15s,transform 0.05s;text-decoration:none}
.btn-primary{background:var(--accent);color:var(--accent-fg)}
.btn-primary:hover{background:var(--accent-hover)}
.btn-primary:active{transform:translateY(1px)}
.btn-primary:disabled{opacity:0.55;cursor:not-allowed}
.btn-ghost{background:transparent;color:var(--text);border-color:var(--border-strong)}
.btn-ghost:hover{background:var(--bg-elev-2)}
.alert{padding:10px 14px;border-radius:var(--radius);font-size:13px;margin-bottom:16px;border:1px solid}
.alert-error{background:var(--danger-bg);border-color:var(--danger-border);color:var(--danger)}
.alert-info{background:rgba(96,165,250,0.08);border-color:rgba(96,165,250,0.3);color:var(--info)}
.alert-warning{background:rgba(251,191,36,0.08);border-color:rgba(251,191,36,0.3);color:var(--warning)}
.alert ul{margin:4px 0 0 16px;padding:0}
.divider{display:flex;align-items:center;margin:18px 0;color:var(--text-faint);font-size:12px}
.divider::before,.divider::after{content:'';flex:1;border-top:1px solid var(--border)}
.divider span{padding:0 12px;font-family:var(--font-mono)}
.client-info{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:18px}
.client-icon{width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,#8b5cf6,#ec4899);display:grid;place-items:center;font-family:var(--font-mono);color:#fff;font-weight:700;font-size:14px;flex-shrink:0}
.client-meta{min-width:0;flex:1}
.client-name{font-weight:600;font-size:14px}
.client-id{font-family:var(--font-mono);font-size:11px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scope-list{list-style:none;padding:0;margin:0 0 18px 0}
.scope-list li{padding:4px 0;font-size:13px;color:var(--text-dim);display:flex;align-items:flex-start;gap:8px}
.scope-list li::before{content:'·';color:var(--accent);font-weight:700;flex-shrink:0}
.footer{padding:18px 24px;border-top:1px solid var(--border);text-align:center;font-size:12px;color:var(--text-faint);font-family:var(--font-mono)}
.link{color:var(--accent);text-decoration:none}
.link:hover{text-decoration:underline}
@media (prefers-reduced-motion: reduce){
  *,.btn,.field input{animation:none!important;transition:none!important}
}
.error-page{text-align:center;max-width:480px;margin:0 auto;padding-top:16px}
.error-code{font-family:var(--font-mono);font-size:64px;font-weight:700;color:var(--accent);margin:0;letter-spacing:-0.02em}
.error-title{margin:8px 0 12px 0;font-size:20px}
.error-desc{color:var(--text-dim);margin-bottom:24px}
@media (max-width:480px){.card{border-radius:var(--radius)}.card-header,.card-body{padding-left:20px;padding-right:20px}}
`;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;");

const escapeAttr = (s: string): string => escapeHtml(s);

const shell = (body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex,nofollow">
<title>${APP_TITLE} · MCP Auth</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="brand"><div class="brand-mark">S</div><span>${APP_TITLE}</span></div>
    <div class="brand-meta">mcp · auth</div>
  </header>
  <main class="main">${body}</main>
  <footer class="footer"><span>SearchHub MCP · OAuth 2.1 · PKCE</span></footer>
</div>
</body>
</html>`;

const clientInitials = (name: string): string => {
  const parts = name.trim().split(/[\s_-]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || "?").toUpperCase();
};

const hiddenFields = (ctx: AuthorizeContext): string => {
  const out: string[] = [
    `<input type="hidden" name="client_id" value="${escapeAttr(ctx.client_id)}">`,
    `<input type="hidden" name="redirect_uri" value="${escapeAttr(ctx.redirect_uri)}">`,
    `<input type="hidden" name="scope" value="${escapeAttr(ctx.scope)}">`,
  ];
  if (ctx.state) out.push(`<input type="hidden" name="state" value="${escapeAttr(ctx.state)}">`);
  if (ctx.code_challenge) out.push(`<input type="hidden" name="code_challenge" value="${escapeAttr(ctx.code_challenge)}">`);
  if (ctx.code_challenge_method) out.push(`<input type="hidden" name="code_challenge_method" value="${escapeAttr(ctx.code_challenge_method)}">`);
  if (ctx.client_name) out.push(`<input type="hidden" name="client_name" value="${escapeAttr(ctx.client_name)}">`);
  return out.join("");
};

const scopesBlock = (scope: string): string => {
  if (!scope) return "";
  const items = scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join("");
  return `<ul class="scope-list">${items}</ul>`;
};

const clientBlock = (ctx: AuthorizeContext): string => {
  if (!ctx.client_name) return "";
  return `<div class="client-info">
    <div class="client-icon">${escapeHtml(clientInitials(ctx.client_name))}</div>
    <div class="client-meta">
      <div class="client-name">${escapeHtml(ctx.client_name)}</div>
      <div class="client-id" title="${escapeAttr(ctx.client_id)}">${escapeHtml(ctx.client_id)}</div>
    </div>
  </div>`;
};

type ErrorVariant = "denied" | "invalid" | "expired" | "generic";

export const renderAuthorizePage = (
  ctx: AuthorizeContext,
  error?: string,
  submittedUsername?: string,
  allowSignup = false,
): string => {
  let alertHtml = "";
  if (error) {
    if (/invalid|credentials|password|user/i.test(error)) {
      alertHtml = `<div class="alert alert-error" role="alert"><strong>Sign in failed.</strong> ${escapeHtml(error)} Check your username and password, then try again.</div>`;
    } else if (/expired|expire/i.test(error)) {
      alertHtml = `<div class="alert alert-warning" role="alert">${escapeHtml(error)}</div>`;
    } else if (/too many|rate/i.test(error)) {
      alertHtml = `<div class="alert alert-warning" role="alert"><strong>Too many attempts.</strong> ${escapeHtml(error)}</div>`;
    } else {
      alertHtml = `<div class="alert alert-error" role="alert">${escapeHtml(error)}</div>`;
    }
  }

  const invalid = error && /invalid|credentials|password|user|too many|rate/i.test(error) ? "true" : undefined;

  const body = `
<div class="card">
  <div class="card-header">
    <h1>Sign in</h1>
    <p>Sign in to continue to your MCP server.</p>
  </div>
  <div class="card-body">
    ${clientBlock(ctx)}
    ${scopesBlock(ctx.scope || "mcp:tools")}
    ${alertHtml}
    <form method="POST" action="/oauth/authorize" autocomplete="on" novalidate>
      ${hiddenFields(ctx)}
      <div class="field">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" required autocomplete="username" autofocus value="${escapeAttr(submittedUsername ?? "")}" placeholder="your-name" aria-invalid="${invalid ?? "false"}">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" placeholder="••••••••" aria-invalid="${invalid ?? "false"}">
        <div class="field-hint">Username is case-sensitive. Passwords are never logged.</div>
      </div>
      <button type="submit" class="btn btn-primary">Sign in</button>
    </form>
    ${allowSignup ? `<div class="divider"><span>or</span></div><a class="btn btn-ghost" href="/admin/signup">Create an account</a>` : ""}
  </div>
</div>`;

  return shell(body);
};

export const renderConsentPage = (
  ctx: AuthorizeContext & { user: { username: string } },
): string => {
  const body = `
<div class="card">
  <div class="card-header">
    <h1>Authorize access</h1>
    <p>Signed in as <strong>${escapeHtml(ctx.user.username)}</strong>. Confirm to grant access.</p>
  </div>
  <div class="card-body">
    ${clientBlock(ctx)}
    <p style="margin:0 0 8px 0;color:var(--text-dim);font-size:13px">This app will be able to:</p>
    ${scopesBlock(ctx.scope || "")}
    <form method="POST" action="/oauth/authorize/decision">
      ${hiddenFields(ctx)}
      <button type="submit" name="decision" value="allow" class="btn btn-primary">Allow</button>
    </form>
    <div style="height:8px"></div>
    <form method="POST" action="/oauth/authorize/decision">
      ${hiddenFields(ctx)}
      <button type="submit" name="decision" value="deny" class="btn btn-ghost">Deny</button>
    </form>
  </div>
</div>`;
  return shell(body);
};

export const renderSignupPage = (
  error?: string,
  signupEnabled = true,
): string => {
  const body = `
<div class="card">
  <div class="card-header">
    <h1>Create account</h1>
    <p>Register a new SearchHub MCP user.</p>
  </div>
  <div class="card-body">
    ${!signupEnabled ? `<div class="alert alert-error" role="alert">Signup is currently disabled by the operator.</div>` : ""}
    ${error ? `<div class="alert alert-error" role="alert">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/admin/signup" autocomplete="on">
      <div class="field">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" required minlength="3" maxlength="32" autocomplete="username" autofocus placeholder="your-name" pattern="[A-Za-z0-9._-]+">
        <div class="field-hint">3–32 chars. Letters, digits, dot, underscore, dash.</div>
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required minlength="12" autocomplete="new-password" placeholder="At least 12 characters">
        <div class="field-hint">Minimum 12 characters. Use a password manager.</div>
      </div>
      <button type="submit" class="btn btn-primary" ${signupEnabled ? "" : "disabled"}>Create account</button>
    </form>
    <div class="divider"><span>or</span></div>
    <a class="btn btn-ghost" href="/">Back to sign in</a>
  </div>
</div>`;
  return shell(body);
};

export const renderErrorPage = (
  variant: ErrorVariant,
  description?: string,
): string => {
  const cfg: Record<ErrorVariant, { code: string; title: string; desc: string }> = {
    denied: { code: "DENIED", title: "Access denied", desc: description ?? "You cancelled the authorization request." },
    invalid: { code: "400", title: "Bad request", desc: description ?? "The request was malformed or missing required parameters." },
    expired: { code: "EXPIRED", title: "Session expired", desc: description ?? "Please return to the application and try again." },
    generic: { code: "ERR", title: "Something went wrong", desc: description ?? "An unexpected error occurred. Try again or contact the operator." },
  };
  const c = cfg[variant];
  const body = `
<div class="card error-page">
  <div class="card-body">
    <p class="error-code">${escapeHtml(c.code)}</p>
    <h1 class="error-title">${escapeHtml(c.title)}</h1>
    <p class="error-desc">${escapeHtml(c.desc)}</p>
    <a class="btn btn-ghost" href="/">Return to sign in</a>
  </div>
</div>`;
  return shell(body);
};

export const renderSuccessPage = (username: string): string => {
  const body = `
<div class="card error-page">
  <div class="card-body">
    <p class="error-code">OK</p>
    <h1 class="error-title">Account created</h1>
    <p class="error-desc">Welcome, <strong>${escapeHtml(username)}</strong>. You can now return to your MCP client and sign in.</p>
    <a class="btn btn-primary" href="/">Sign in</a>
  </div>
</div>`;
  return shell(body);
};
