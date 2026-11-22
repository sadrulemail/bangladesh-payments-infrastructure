import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Operator } from "../chain/custody";
import { config } from "../config";
import { pool, query, queryOne } from "../db/pool";
import { route } from "../http/route";
import { notFound, tooManyRequests, unauthorised } from "../lib/errors";
import { hashPassphrase, verifyPassphrase } from "./passwords";
import { SignInThrottle } from "./throttle";

const signIn = z.object({
  username: z.string().trim().min(1).max(64),
  passphrase: z.string().min(1).max(256),
});

const OPERATOR_COLUMNS = "username, display_name, role, institution_id, address, key_index";

/** Failed attempts allowed per client address and username before sign-in pauses for the window. */
const SIGN_IN_ATTEMPTS = 5;
const SIGN_IN_WINDOW_MINUTES = 15;

const throttle = new SignInThrottle(SIGN_IN_ATTEMPTS, SIGN_IN_WINDOW_MINUTES * 60_000);

/** Hash checked when the username is unknown, so that answer takes as long as a wrong passphrase. */
let decoyHash: Promise<string> | undefined;
const decoy = () => (decoyHash ??= hashPassphrase(randomBytes(32).toString("base64")));

export function authRoutes(app: FastifyInstance): void {
  route(app, {
    method: "POST",
    url: "/v1/auth/sign-in",
    tag: "Session",
    summary: "Open a session",
    access: "public",
    body: signIn,
    handler: async ({ body, request }) => {
      const key = `${request.ip}|${body.username.toLowerCase()}`;
      const wait = throttle.retryAfter(key);
      if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        throw tooManyRequests(`Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} min.`, seconds);
      }

      const operator = await queryOne<Operator & { passwordHash: string }>(
        pool,
        `SELECT ${OPERATOR_COLUMNS}, password_hash FROM operators WHERE username = $1 AND active`,
        [body.username],
      );
      // The same answer, after the same work, for an unknown user and a wrong passphrase.
      const valid = await verifyPassphrase(body.passphrase, operator?.passwordHash ?? (await decoy()));
      if (!operator || !valid) {
        throttle.recordFailure(key);
        throw unauthorised("The username or passphrase is not correct");
      }
      throttle.recordSuccess(key);
      const { passwordHash: _passwordHash, ...profile } = operator;
      const token = app.jwt.sign({ sub: profile.username }, { expiresIn: `${config.auth.sessionHours}h` });
      return { token, operator: profile };
    },
  });

  route(app, {
    method: "GET",
    url: "/v1/auth/session",
    tag: "Session",
    summary: "Operator of the current session",
    access: "operator",
    handler: async ({ operator }) => operator,
  });

  route(app, {
    method: "GET",
    url: "/v1/auth/profiles",
    tag: "Session",
    summary: "Operator profiles for the sign-in page (private environments only)",
    access: "public",
    handler: async () => {
      if (!config.auth.operatorDirectory) throw notFound("The operator directory");
      return query(
        pool,
        `SELECT o.username, o.display_name, o.role, o.institution_id, i.name AS institution_name
           FROM operators o
           LEFT JOIN institutions i ON i.id = o.institution_id
          WHERE o.active
          ORDER BY o.key_index`,
      );
    },
  });
}
