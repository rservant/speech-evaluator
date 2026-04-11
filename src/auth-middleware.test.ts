// Auth Middleware Tests — Issue #158 (Clerk migration)
// Verifies JWT verification, email allowlist, public path exemptions,
// and WebSocket upgrade auth using Clerk.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { createAuthMiddleware, verifyAndAuthorize } from "./auth-middleware.js";

// ─── Mock @clerk/express ────────────────────────────────────────────────────────

const mockGetAuth = vi.fn();
const mockClerkMiddleware = vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next());
const mockVerifyToken = vi.fn();

vi.mock("@clerk/express", () => ({
  getAuth: (...args: unknown[]) => mockGetAuth(...args),
  clerkMiddleware: () => mockClerkMiddleware(),
  verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────────

function mockRequest(overrides: Partial<Request> = {}): Request {
  return {
    path: "/",
    cookies: {},
    ...overrides,
  } as unknown as Request;
}

function mockResponse(): Response & { statusCode?: number; body?: string; redirectUrl?: string } {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as string | undefined,
    redirectUrl: undefined as string | undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
    redirect(url: string) {
      res.redirectUrl = url;
      return res;
    },
    json(data: unknown) {
      res.body = JSON.stringify(data);
      return res;
    },
  };
  return res as unknown as Response & { statusCode?: number; body?: string; redirectUrl?: string };
}

const allowedEmails = new Set(["alice@example.com", "bob@example.com"]);

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("Auth Middleware (Clerk)", () => {
  let middleware: ReturnType<typeof createAuthMiddleware>;

  beforeEach(() => {
    vi.clearAllMocks();
    middleware = createAuthMiddleware({ allowedEmails });
  });

  // ── Public Paths ──────────────────────────────────────────────────────────────

  describe("public paths bypass auth", () => {
    const publicPaths = ["/health", "/login.html", "/login.js", "/style.css", "/favicon.ico", "/analytics.js"];

    for (const path of publicPaths) {
      it(`allows ${path} without auth`, async () => {
        mockGetAuth.mockReturnValue({ userId: null });
        const req = mockRequest({ path });
        const res = mockResponse();
        const next = vi.fn();

        await middleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.redirectUrl).toBeUndefined();
        expect(res.statusCode).toBeUndefined();
      });
    }

    it("allows font paths without auth", async () => {
      mockGetAuth.mockReturnValue({ userId: null });
      const req = mockRequest({ path: "/fonts/Outfit-Regular.woff2" });
      const res = mockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  // ── No Token / Unauthenticated ────────────────────────────────────────────────

  describe("unauthenticated", () => {
    it("redirects to /login.html when Clerk finds no session", async () => {
      mockGetAuth.mockReturnValue({ userId: null });
      const req = mockRequest({ path: "/" });
      const res = mockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.redirectUrl).toBe("/login.html");
    });
  });

  // ── Valid Token, Not Allowlisted ──────────────────────────────────────────────

  describe("valid session but email not in allowlist", () => {
    it("returns 403 with access denied page", async () => {
      mockGetAuth.mockReturnValue({
        userId: "user-123",
        sessionClaims: { email: "stranger@example.com" },
      });
      const req = mockRequest({ path: "/" });
      const res = mockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("Access Denied");
      expect(res.body).toContain("stranger@example.com");
    });

    it("returns 403 when session has no email", async () => {
      mockGetAuth.mockReturnValue({
        userId: "user-123",
        sessionClaims: {},
      });
      const req = mockRequest({ path: "/" });
      const res = mockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Valid Token, Allowlisted ──────────────────────────────────────────────────

  describe("valid session and email in allowlist", () => {
    it("calls next() and attaches req.user", async () => {
      mockGetAuth.mockReturnValue({
        userId: "user-alice",
        sessionClaims: { email: "alice@example.com" },
      });
      const req = mockRequest({ path: "/" });
      const res = mockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({ email: "alice@example.com", uid: "user-alice" });
    });

    it("includes name and picture from session claims", async () => {
      mockGetAuth.mockReturnValue({
        userId: "user-alice",
        sessionClaims: {
          email: "alice@example.com",
          name: "Alice Smith",
          picture: "https://example.com/photo.jpg",
        },
      });
      const req = mockRequest({ path: "/" });
      const res = mockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({
        email: "alice@example.com",
        uid: "user-alice",
        name: "Alice Smith",
        picture: "https://example.com/photo.jpg",
      });
    });

    it("handles missing name and picture gracefully", async () => {
      mockGetAuth.mockReturnValue({
        userId: "user-bob",
        sessionClaims: { email: "bob@example.com" },
      });
      const req = mockRequest({ path: "/" });
      const res = mockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({
        email: "bob@example.com",
        uid: "user-bob",
      });
      expect(req.user?.name).toBeUndefined();
      expect(req.user?.picture).toBeUndefined();
    });

    it("handles case-insensitive email matching", async () => {
      mockGetAuth.mockReturnValue({
        userId: "user-alice",
        sessionClaims: { email: "Alice@Example.COM" },
      });
      const req = mockRequest({ path: "/" });
      const res = mockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual({ email: "alice@example.com", uid: "user-alice" });
    });
  });

  // ── Protected Routes ──────────────────────────────────────────────────────────

  describe("protected routes require auth", () => {
    const protectedPaths = ["/", "/index.html", "/api/upload"];

    for (const path of protectedPaths) {
      it(`requires auth for ${path}`, async () => {
        mockGetAuth.mockReturnValue({ userId: null });
        const req = mockRequest({ path });
        const res = mockResponse();
        const next = vi.fn();

        await middleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.redirectUrl).toBe("/login.html");
      });
    }
  });

  // ── Public Prefixes (#165) ─────────────────────────────────────────────────

  describe("public prefixes bypass auth (#165)", () => {
    const publicPrefixPaths = ["/js/app.js", "/js/websocket.js", "/share/abc123"];

    for (const path of publicPrefixPaths) {
      it(`allows ${path} without auth`, async () => {
        mockGetAuth.mockReturnValue({ userId: null });
        const req = mockRequest({ path });
        const res = mockResponse();
        const next = vi.fn();

        await middleware(req, res, next);

        expect(next).toHaveBeenCalled();
      });
    }
  });
});

// ─── WebSocket Auth (verifyAndAuthorize) ────────────────────────────────────────

describe("verifyAndAuthorize (Clerk)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns user info for valid, allowlisted token", async () => {
    mockVerifyToken.mockResolvedValueOnce({
      sub: "ws-user",
      email: "alice@example.com",
    });

    const result = await verifyAndAuthorize("valid-token", allowedEmails, "test-secret");
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("ws-user");
    expect(result!.email).toBe("alice@example.com");
  });

  it("returns null for valid token but non-allowlisted email", async () => {
    mockVerifyToken.mockResolvedValueOnce({
      sub: "ws-user",
      email: "hacker@evil.com",
    });

    const result = await verifyAndAuthorize("valid-token", allowedEmails, "test-secret");
    expect(result).toBeNull();
  });

  it("returns null for invalid token", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("Invalid token"));

    const result = await verifyAndAuthorize("bad-token", allowedEmails, "test-secret");
    expect(result).toBeNull();
  });

  it("returns null when token has no email", async () => {
    mockVerifyToken.mockResolvedValueOnce({
      sub: "ws-user",
    });

    const result = await verifyAndAuthorize("valid-token", allowedEmails, "test-secret");
    expect(result).toBeNull();
  });
});
