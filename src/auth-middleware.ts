// Auth Middleware — Clerk JWT verification + email allowlist (#158)

import type { Request, Response, NextFunction } from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { verifyToken } from "@clerk/express";

// Extend Express Request to carry authenticated user info
declare global {
  namespace Express {
    interface Request {
      user?: { email: string; uid: string; name?: string; picture?: string };
    }
  }
}

/** Routes that bypass authentication entirely */
const PUBLIC_PATHS = [
  "/health",
  "/login.html",
  "/login.js",
  "/style.css",
  "/favicon.ico",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/logo-taverns.png",
  "/api/config",
  "/api/version",
  "/audio-worklet.js",
  "/analytics.js",
];

/** Prefixes that bypass authentication (fonts, JS modules, etc.) */
const PUBLIC_PREFIXES = [
  "/fonts/",
  "/js/",
  "/share/",
];

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.includes(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export interface AuthMiddlewareOptions {
  /** Set of allowed email addresses (lowercase) */
  allowedEmails: Set<string>;
}

/**
 * Creates Clerk-powered Express middleware that:
 * 1. Applies Clerk's clerkMiddleware() to parse session cookies/headers
 * 2. Exempts public paths (health, login page, static assets)
 * 3. Checks the authenticated user's email against the allowlist
 * 4. Attaches req.user on success, redirects to /login.html on failure
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const { allowedEmails } = options;

  // Clerk's middleware handles cookie parsing and JWT verification
  const clerkMw = clerkMiddleware();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // First, run Clerk middleware to populate req.auth
    await new Promise<void>((resolve) => {
      clerkMw(req, res, () => resolve());
    });

    // Skip auth for public paths
    if (isPublicPath(req.path)) {
      next();
      return;
    }

    const auth = getAuth(req);

    if (!auth.userId) {
      // Not authenticated — redirect to login
      res.redirect("/login.html");
      return;
    }

    // Clerk stores email in session claims. We need to check the allowlist.
    // The email comes from the session claims via Clerk's `sessionClaims`.
    const claims = auth.sessionClaims as Record<string, unknown> | undefined;
    const email = (
      claims?.email as string ??
      claims?.primary_email_address as string ??
      ""
    ).toLowerCase();

    if (!email || !allowedEmails.has(email)) {
      // Valid Clerk user but not on the allowlist
      res.status(403).send(accessDeniedHTML(email));
      return;
    }

    // Attach user info to request
    req.user = {
      email,
      uid: auth.userId,
      ...(claims?.name ? { name: claims.name as string } : {}),
      ...(claims?.picture ? { picture: claims.picture as string } : {}),
    };
    next();
  };
}

/**
 * Verifies a Clerk session token and checks the email against the allowlist.
 * Used for WebSocket upgrade authentication.
 * Returns true if valid and allowed, false otherwise.
 */
export async function verifyAndAuthorize(
  token: string,
  allowedEmails: Set<string>,
  secretKey?: string,
): Promise<{ userId: string; email: string } | null> {
  try {
    const decoded = await verifyToken(token, {
      secretKey: secretKey ?? process.env.CLERK_SECRET_KEY ?? "",
    });
    const email = (decoded.email as string ?? "").toLowerCase();
    if (!email || !allowedEmails.has(email)) return null;
    return { userId: decoded.sub, email };
  } catch {
    return null;
  }
}

function accessDeniedHTML(email?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied - AI Speech Evaluator</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <style>
    .access-denied {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      text-align: center;
      padding: 2rem;
    }
    .access-denied h1 {
      font-size: 2rem;
      margin-bottom: 1rem;
      color: var(--red-primary);
    }
    .access-denied p {
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }
    .access-denied .email {
      font-family: monospace;
      color: var(--text-primary);
      background: var(--bg-card);
      padding: 0.25rem 0.75rem;
      border-radius: 6px;
    }
    .access-denied .actions {
      margin-top: 2rem;
      display: flex;
      gap: 1rem;
    }
    .access-denied .btn-back {
      padding: 0.75rem 1.5rem;
      border-radius: 12px;
      border: none;
      background: var(--bg-card);
      color: var(--text-primary);
      font-family: 'Outfit', sans-serif;
      font-size: 0.9rem;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s;
    }
    .access-denied .btn-back:hover {
      background: var(--bg-elevated);
    }
  </style>
</head>
<body>
  <div class="access-denied">
    <h1>🔒 Access Denied</h1>
    <p>Your account is not authorized to use this application.</p>
    ${email ? `<p>Signed in as <span class="email">${email}</span></p>` : ""}
    <p>Contact the administrator to request access.</p>
    <div class="actions">
      <a href="/login.html" class="btn-back">Sign in with a different account</a>
    </div>
  </div>
</body>
</html>`;
}
